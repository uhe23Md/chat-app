/**
 * verify-deploy.cjs —— 线上模式（模拟云端环境）端到端验证
 *
 * 为什么需要这个脚本？
 *   部署到云平台后，最容易出问题的不是业务逻辑，而是"环境差异"：
 *     1. 端口不是 3000 而是平台注入的 PORT
 *     2. CORS 从全开变成白名单
 *     3. NODE_ENV=production 改变了行为
 *   这三件事在本地默认跑法下完全测不到。
 *
 *   所以这个脚本**用线上参数启动服务**（NODE_ENV=production + 自定义 PORT +
 *   ALLOWED_ORIGINS 白名单），然后跑一遍核心业务链路。
 *   本地全过 = 部署上去大概率也没问题。
 *
 * 用法：
 *   node .verify/verify-deploy.cjs
 *
 * 前置：不需要手动启服务，脚本自己会起（用 PORT=10000 避免和开发服务冲突）
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 10000;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.resolve(__dirname, '..');
// 用独立的测试库，不污染开发库
const TEST_DB = path.join(ROOT, '.verify-deploy-test.db');
const FAKE_ORIGIN = 'https://chat-app-demo.onrender.com';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
  }
}

function section(title) {
  console.log(`\n【${title}】`);
}

/** 带超时的 fetch，避免请求挂死拖垮整个脚本 */
async function req(url, opts = {}, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    let body = null;
    const text = await res.text();
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, headers: res.headers, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 启动一个测试账号，返回 { token, id, username, password }
 *
 * ⚠️ 注意两个接口的响应结构不一样，别抄错：
 *   POST /api/register → { ok, data: { id, username, avatar, createdAt } }   ← 扁平
 *   POST /api/login    → { ok, data: { token, user: { id, username, avatar } } } ← 嵌套
 */
async function makeUser(prefix, n) {
  const username = `${prefix}${n}`;
  const password = 'cloud123456';

  const reg = await req(`${BASE}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!reg.body?.ok) {
    throw new Error(`注册 ${username} 失败: ${reg.body?.error}`);
  }

  const login = await req(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!login.body?.ok) {
    throw new Error(`登录 ${username} 失败: ${login.body?.error}`);
  }

  return {
    token: login.body.data.token,
    id: login.body.data.user.id,        // ← id 在 data.user 里
    username: login.body.data.user.username,
    password,
  };
}

async function main() {
  console.log('========================================');
  console.log('  线上模式部署验证');
  console.log(`  模拟环境: NODE_ENV=production, PORT=${PORT}`);
  console.log(`  CORS 白名单: ${FAKE_ORIGIN}`);
  console.log('========================================');

  // 清理上次残留的测试库
  for (const suffix of ['', '-shm', '-wal']) {
    const p = TEST_DB + suffix;
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }

  // ---- 用线上参数启动服务 ----
  console.log('\n[启动] 以线上模式拉起服务...');
  const server = spawn('node', ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      JWT_SECRET: 'verify-deploy-secret-do-not-use-in-prod',
      ALLOWED_ORIGINS: FAKE_ORIGIN,
      DB_PATH: TEST_DB,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d.toString(); });
  server.stderr.on('data', (d) => { serverLog += d.toString(); });

  // 等服务起来（轮询健康检查，最多 15 秒）
  let up = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await req(`${BASE}/api/health`, {}, 2000);
      if (r.status === 200) { up = true; break; }
    } catch { /* 还没起来，继续等 */ }
  }

  if (!up) {
    console.error('\n❌ 服务启动失败，日志如下：\n');
    console.error(serverLog);
    server.kill();
    process.exit(1);
  }

  try {
    // ============================================================
    section('1. 云端环境识别');
    // ============================================================
    ok('服务已启动并响应健康检查', up);
    ok('日志判定为「线上模式」', serverLog.includes('[线上模式]'),
      serverLog.includes('[线上模式]') ? '环境检测生效' : '看到的是本地模式');
    ok('端口读到了注入的 PORT 而非 3000', serverLog.includes(`端口: ${PORT}`),
      `期望 ${PORT}`);
    ok('CORS 白名单被识别', serverLog.includes('已配置白名单'),
      (serverLog.match(/CORS: (.+)/) || [])[1] || '');

    // ============================================================
    section('2. 健康检查与静态资源');
    // ============================================================
    const health = await req(`${BASE}/api/health`);
    ok('GET /api/health 返回 200', health.status === 200, `HTTP ${health.status}`);
    ok('健康检查返回 ok:true', health.body?.ok === true);

    const loginPage = await req(`${BASE}/login.html`);
    ok('登录页可访问', loginPage.status === 200, `HTTP ${loginPage.status}`);

    const socketJs = await req(`${BASE}/socket.io/socket.io.js`);
    ok('Socket.IO 客户端脚本可访问', socketJs.status === 200, `HTTP ${socketJs.status}`);

    // ============================================================
    section('3. CORS 白名单行为');
    // ============================================================
    const allowed = await req(`${BASE}/api/health`, {
      headers: { Origin: FAKE_ORIGIN },
    });
    ok('白名单内的来源被放行',
      allowed.headers.get('access-control-allow-origin') === FAKE_ORIGIN,
      allowed.headers.get('access-control-allow-origin') || '(无该响应头)');

    const evil = await req(`${BASE}/api/health`, {
      headers: { Origin: 'https://evil-site.com' },
    });
    ok('白名单外的来源不发 CORS 放行头',
      evil.headers.get('access-control-allow-origin') === null,
      'evil-site.com');

    const noOrigin = await req(`${BASE}/api/health`);
    ok('无 Origin 头的请求（同源/健康检查）正常响应',
      noOrigin.status === 200, `HTTP ${noOrigin.status}`);

    const preflight = await req(`${BASE}/api/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: FAKE_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    ok('预检请求 OPTIONS 返回 2xx',
      preflight.status >= 200 && preflight.status < 300, `HTTP ${preflight.status}`);
    ok('预检响应带 allow-methods',
      !!preflight.headers.get('access-control-allow-methods'));

    // ============================================================
    section('4. 注册与登录');
    // ============================================================
    const alice = await makeUser('deployA', Date.now() % 100000);
    ok('注册新用户成功', !!alice.id, `id=${alice.id}`);
    ok('登录拿到 token', !!alice.token, `长度 ${alice.token?.length}`);
    ok('token 是 JWT 三段式', (alice.token || '').split('.').length === 3);

    const me = await req(`${BASE}/api/me`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    ok('用 token 能拿到自己的信息', me.body?.data?.username === alice.username,
      me.body?.data?.username);

    ok('无 token 访问受保护接口返回 401', (await req(`${BASE}/api/me`)).status === 401);

    const bob = await makeUser('deployB', Date.now() % 100000);
    ok('第二个用户注册成功', !!bob.id, `id=${bob.id}`);

    // ============================================================
    section('5. 房间与历史消息');
    // ============================================================
    const rooms = await req(`${BASE}/api/rooms`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    ok('能拉到房间列表', rooms.body?.ok === true);
    ok('默认房间已初始化（3 个）', rooms.body?.data?.length === 3,
      rooms.body?.data?.map((r) => r.name).join('/'));

    const room1 = rooms.body?.data?.[0]?.id;
    const hist = await req(`${BASE}/api/messages?roomId=${room1}&limit=10`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    ok('能拉取历史消息', hist.body?.ok === true,
      `roomId=${room1}, ${hist.body?.data?.length} 条`);

    const badRoom = await req(`${BASE}/api/messages?roomId=99999`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    ok('不存在的房间返回 404', badRoom.status === 404, `HTTP ${badRoom.status}`);

    // ============================================================
    section('6. Socket.IO 实时连接（部署关键项）');
    // ============================================================
    // 这一节最重要：WebSocket 在生产环境下走的是另一种传输路径，
    // 很多部署问题（反代不支持 upgrade、CORS 配错）只有在这里才暴露。
    const { io } = require('socket.io-client');

    const connectUser = (token, label) =>
      new Promise((resolve, reject) => {
        // 关键：用 auth 传 token（服务端从 handshake.auth 读），
        // 同时带上 extraHeaders 的 Origin，模拟真实浏览器跨域场景
        const s = io(BASE, {
          auth: { token },
          transports: ['websocket'],
          extraHeaders: { Origin: FAKE_ORIGIN },
          reconnection: false,
        });
        const timer = setTimeout(() => {
          s.close();
          reject(new Error(`${label} 连接超时`));
        }, 8000);
        s.on('connected', () => { clearTimeout(timer); resolve(s); });
        s.on('connect_error', (err) => {
          clearTimeout(timer);
          s.close();
          reject(new Error(`${label} 连接失败: ${err.message}`));
        });
      });

    let sa = null;
    let sb = null;
    let carolSock = null;
    try {
      sa = await connectUser(alice.token, 'alice');
      ok('alice 通过 WebSocket 连接成功', !!sa.connected, 'transport=websocket');

      sb = await connectUser(bob.token, 'bob');
      ok('bob 通过 WebSocket 连接成功', !!sb.connected);

      // 两人加入同一房间
      const join = (sock, roomId) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('join_room 超时')), 5000);
          sock.emit('join_room', { roomId }, (res) => {
            clearTimeout(t);
            if (res?.ok) resolve(res);
            else reject(new Error(res?.error || '加入失败'));
          });
        });

      const ja = await join(sa, room1);
      ok('alice 加入房间成功', ja.ok === true);
      await join(sb, room1);

      // 在线列表推送
      //
      // 【为什么这么写】online_users 只在"房间成员真的变化"时才广播。
      // 让已在房间的 alice 重复 join_room 不会触发（服务端做了幂等处理），
      // 所以必须引入一个"新成员" —— 这里连第三个人 carol 进来。
      const carol = await makeUser('deployC', (Date.now() + 7) % 100000);
      const onlineList = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), 6000);
        sb.once('online_users', (data) => { clearTimeout(t); resolve(data); });

        // carol 加入后，房间里的 alice / bob 都会收到新的在线列表
        connectUser(carol.token, 'carol')
          .then((sc) => {
            carolSock = sc;
            return join(sc, room1);
          })
          .catch(() => { /* 连接失败则由超时兜底 */ });
      });
      ok('收到在线用户列表推送',
        onlineList && Array.isArray(onlineList.users),
        onlineList ? `${onlineList.users?.length} 人在线: ${onlineList.users.map((u) => u.username).join('/')}` : '未收到');
      ok('在线列表包含刚加入的 carol',
        !!onlineList?.users?.some((u) => u.username === carol.username),
        carol.username);
      ok('在线列表按用户去重（同一人只出现一次）',
        onlineList ? new Set(onlineList.users.map((u) => u.id)).size === onlineList.users.length : false);

      // 实时收发
      const recvPromise = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('实时消息超时')), 6000);
        sb.once('new_message', (m) => { clearTimeout(t); resolve(m); });
      });

      const sendRes = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('send_message 超时')), 5000);
        sa.emit('send_message', { roomId: room1, content: '部署验证消息' }, (res) => {
          clearTimeout(t);
          resolve(res);
        });
      });
      ok('发消息收到 ack 成功', sendRes?.ok === true);

      const received = await recvPromise.catch((e) => ({ error: e.message }));
      ok('对方实时收到了消息',
        received?.content === '部署验证消息',
        received?.error || `"${received?.content}"`);
      ok('收到的消息带发送者信息',
        received?.sender?.username === alice.username,
        received?.sender?.username);
      ok('收到的消息带服务端时间戳', !!received?.createdAt);

      // 消息落库（刷新不丢）
      await new Promise((r) => setTimeout(r, 300));
      const afterSend = await req(`${BASE}/api/messages?roomId=${room1}&limit=10`, {
        headers: { Authorization: `Bearer ${alice.token}` },
      });
      const found = (afterSend.body?.data || []).some(
        (m) => m.content === '部署验证消息'
      );
      ok('消息已持久化到数据库（刷新页面不丢）', found,
        `库里共 ${afterSend.body?.data?.length} 条`);

      // 私聊
      const pmPromise = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('私聊超时')), 6000);
        sb.once('new_private_message', (m) => { clearTimeout(t); resolve(m); });
      });
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('私聊 ack 超时')), 5000);
        sa.emit('private_message', { toUserId: bob.id, content: '部署验证私聊' }, (res) => {
          clearTimeout(t);
          if (res?.ok) resolve(res);
          else reject(new Error(res?.error));
        });
      }).then(() => ok('私聊发送成功', true)).catch((e) => ok('私聊发送成功', false, e.message));

      const pm = await pmPromise.catch((e) => ({ error: e.message }));
      ok('对方收到私聊', pm?.content === '部署验证私聊', pm?.error || `"${pm?.content}"`);

      // 未鉴权连接应被拒绝
      const badConn = await new Promise((resolve) => {
        const s = io(BASE, {
          auth: { token: 'fake.invalid.token' },
          transports: ['websocket'],
          reconnection: false,
        });
        const t = setTimeout(() => { s.close(); resolve('timeout'); }, 5000);
        s.on('connect_error', (err) => { clearTimeout(t); s.close(); resolve(err.message); });
        s.on('connected', () => { clearTimeout(t); s.close(); resolve('BYPASSED'); });
      });
      ok('伪造 token 的 WebSocket 连接被拒绝', badConn !== 'BYPASSED',
        String(badConn).slice(0, 40));
    } finally {
      if (sa) sa.close();
      if (sb) sb.close();
      if (carolSock) carolSock.close();
    }

    // ============================================================
    section('7. 数据持久化路径');
    // ============================================================
    ok('数据库文件建在 DB_PATH 指定的位置', fs.existsSync(TEST_DB),
      path.basename(TEST_DB));

  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 500));
    // 清理测试库
    for (const suffix of ['', '-shm', '-wal']) {
      const p = TEST_DB + suffix;
      try { if (fs.existsSync(p)) fs.rmSync(p, { force: true }); } catch { /* ignore */ }
    }
  }

  // ---- 汇总 ----
  console.log('\n==========================================================');
  console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) {
    console.log('\n  失败项：');
    for (const f of failures) console.log(`    - ${f}`);
  }
  console.log('==========================================================\n');

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\n脚本异常:', err);
  process.exit(1);
});
