/**
 * verify-tunnel.cjs —— 验证公网隧道上的实时聊天功能
 *
 * 这是最关键的一步：隧道能返回网页 ≠ 聊天能工作。
 * 聊天依赖 WebSocket 长连接，而隧道/反代对 WebSocket 的支持
 * 往往需要额外配置。只有真正连上并收发消息，才算验证通过。
 *
 * 用法：node deploy/verify-tunnel.cjs <公网地址>
 */

const path = require('path');
const fs = require('fs');

const BASE = process.argv[2];
if (!BASE) {
  console.error('用法: node deploy/verify-tunnel.cjs https://xxx.trycloudflare.com');
  process.exit(1);
}

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;

function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ${C.green('PASS')}  ${name}${detail ? `  ${C.dim('(' + detail + ')')}` : ''}`); }
  else { failed++; console.log(`  ${C.red('FAIL')}  ${name}${detail ? `  ${C.dim('(' + detail + ')')}` : ''}`); }
}

function section(t) { console.log(`\n${C.bold('【' + t + '】')}`); }

async function req(url, opts = {}, timeoutMs = 30000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, headers: res.headers, body };
  } finally { clearTimeout(timer); }
}

/**
 * 等 DNS / 边缘节点就绪。
 *
 * 为什么需要这个？隧道刚建好的瞬间，trycloudflare 的域名在 DNS 里
 * 可能还没解析出来，直接请求会拿到 ENOTFOUND（不是 4xx/5xx，而是
 * 根本没连上）。这是**正常现象**，不是隧道坏了——Cloudflare 需要
 * 几秒钟把新域名推到边缘节点。所以先轮询等到能连上，再开始正式验证。
 *
 * 最多等 60 秒，每 2 秒试一次。
 */
async function waitReady(maxSeconds = 60) {
  process.stdout.write(`  ${C.dim('等待公网地址就绪（DNS 生效通常需要几秒）...')}\n`);
  const deadline = Date.now() + maxSeconds * 1000;
  let attempt = 0;
  let lastErr = '';
  while (Date.now() < deadline) {
    attempt++;
    try {
      const res = await fetch(`${BASE}/api/health`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 200) {
        console.log(`  ${C.green('就绪')}  ${C.dim(`第 ${attempt} 次尝试成功`)}\n`);
        return true;
      }
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e.cause?.code || e.message;
    }
    process.stdout.write(`  ${C.dim(`  第 ${attempt} 次未就绪（${lastErr}），2 秒后重试...`)}\n`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`  ${C.red(`等待 ${maxSeconds} 秒仍未就绪，最后错误：${lastErr}`)}\n`);
  return false;
}

(async () => {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${C.bold('公网隧道验证')}`);
  console.log(`  ${BASE}`);
  console.log(`${'═'.repeat(60)}\n`);

  // 0. 先等地址可用，否则后面全是因为 DNS 没生效而失败，看不出真实问题
  const ready = await waitReady();
  if (!ready) {
    console.log(`  ${C.red('地址一直连不上，后面的验证没有意义，先退出。')}`);
    console.log(`  ${C.dim('排查方向：隧道进程还活着吗？本机服务在 3000 端口吗？')}\n`);
    process.exit(1);
  }

  // 1. 基础连通性
  section('1. 基础连通性');
  const health = await req(`${BASE}/api/health`);
  ok('健康检查返回 200', health.status === 200, `HTTP ${health.status}`);
  ok('后端响应正常', health.body?.ok === true);

  const loginPage = await req(`${BASE}/login.html`);
  ok('登录页可访问', loginPage.status === 200);

  const chatPage = await req(`${BASE}/chat.html`);
  ok('聊天页可访问', chatPage.status === 200);

  // 2. 注册登录
  section('2. 注册与登录');
  const uname = 'tun' + String(Date.now()).slice(-6);
  const pass = 'tunnel123456';

  const reg = await req(`${BASE}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: uname, password: pass }),
  });
  ok('能注册新用户', reg.body?.ok === true, reg.body?.error || uname);

  const login = await req(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: uname, password: pass }),
  });
  const token = login.body?.data?.token;
  ok('能登录拿到 token', !!token, token ? `${token.length} 字符` : login.body?.error);

  // 第二个用户，用于测试实时收发
  const uname2 = 'tun' + String(Date.now()).slice(-6) + 'b';
  await req(`${BASE}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: uname2, password: pass }),
  });
  const login2 = await req(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: uname2, password: pass }),
  });
  const token2 = login2.body?.data?.token;
  const id2 = login2.body?.data?.user?.id;
  ok('第二个用户登录成功', !!token2);

  // 3. WebSocket ★ 核心
  section('3. WebSocket 实时连接（关键）');
  const { io } = require(path.resolve(__dirname, '..', 'node_modules', 'socket.io-client'));

  function connect(token, label) {
    return new Promise((resolve, reject) => {
      const s = io(BASE, {
        auth: { token },
        transports: ['websocket'],   // 强制用 WebSocket，不用 polling 降级
        reconnection: false,
        timeout: 20000,
      });
      const timer = setTimeout(() => { s.close(); reject(new Error(label + ' 连接超时')); }, 25000);
      s.on('connected', () => { clearTimeout(timer); resolve(s); });
      s.on('connect_error', (e) => { clearTimeout(timer); s.close(); reject(new Error(label + ': ' + e.message)); });
    });
  }

  let s1 = null, s2 = null;
  try {
    s1 = await connect(token, '用户1');
    ok('用户1 WebSocket 连接成功', s1.connected, 'transports=websocket');
    s2 = await connect(token2, '用户2');
    ok('用户2 WebSocket 连接成功', s2.connected);

    // 拿房间
    const rooms = await req(`${BASE}/api/rooms`, { headers: { Authorization: `Bearer ${token}` } });
    const roomId = rooms.body?.data?.[0]?.id;
    ok('能获取房间列表', !!roomId, `roomId=${roomId}`);

    const join = (sock, rid) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('join 超时')), 12000);
      sock.emit('join_room', { roomId: rid }, (r) => { clearTimeout(t); r?.ok ? resolve(r) : reject(new Error(r?.error)); });
    });

    await join(s1, roomId);
    await join(s2, roomId);
    ok('两个用户都加入房间', true);

    // 实时收发
    const msgText = '隧道验证消息 ' + Date.now();
    const recv = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('收不到消息')), 20000);
      s2.once('new_message', (m) => { clearTimeout(t); resolve(m); });
    });

    const sent = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('发送超时')), 12000);
      s1.emit('send_message', { roomId, content: msgText }, (r) => { clearTimeout(t); resolve(r); });
    });
    ok('发送消息收到 ack', sent?.ok === true, sent?.error);

    const got = await recv.catch((e) => ({ error: e.message }));
    ok('★ 对方实时收到消息（WebSocket 双向通）', got?.content === msgText, got?.error || `"${got?.content}"`);

    // 私聊
    const pmText = '隧道私聊 ' + Date.now();
    const pmRecv = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('私聊收不到')), 20000);
      s2.once('new_private_message', (m) => { clearTimeout(t); resolve(m); });
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('私聊发送超时')), 12000);
      s1.emit('private_message', { toUserId: id2, content: pmText }, (r) => { clearTimeout(t); r?.ok ? resolve(r) : reject(new Error(r?.error)); });
    });
    const pmGot = await pmRecv.catch((e) => ({ error: e.message }));
    ok('★ 私聊实时到达', pmGot?.content === pmText, pmGot?.error || `"${pmGot?.content}"`);

    // 持久化
    await new Promise((r) => setTimeout(r, 500));
    const hist = await req(`${BASE}/api/messages?roomId=${roomId}&limit=20`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ok('消息已存入数据库', (hist.body?.data || []).some((m) => m.content === msgText));

  } catch (err) {
    ok('WebSocket 测试流程', false, err.message);
  } finally {
    if (s1) s1.close();
    if (s2) s2.close();
  }

  // 汇总
  console.log(`\n${'═'.repeat(60)}`);
  if (failed === 0) {
    console.log(`  ${C.green(C.bold('✅ 全部通过：' + passed + ' 项'))}`);
    console.log(`\n  ${C.bold('这个链接可以直接发给别人了：')}`);
    console.log(`  ${C.cyan(BASE)}`);
  } else {
    console.log(`  ${C.yellow('通过 ' + passed + ' 项，失败 ' + failed + ' 项')}`);
  }
  console.log(`${'═'.repeat(60)}\n`);

  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('脚本异常:', e);
  process.exit(1);
});
