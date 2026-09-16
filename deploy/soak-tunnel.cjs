/**
 * soak-tunnel.cjs —— 公网地址的持续稳定性测试
 *
 * 为什么要单独测这个？
 * 前面的 verify-tunnel.cjs 验证的是"功能对不对"，只在几十秒内快速跑一遍。
 * 但它回答不了"能不能挂着用一下午"——而后者才是"发给别人看"真正需要的。
 *
 * 这个脚本做三件事：
 *   1) 保持 WebSocket 连接 3 分钟，期间每 30 秒发一条消息验证链路没断
 *   2) 记录断线次数和重连耗时
 *   3) 统计延迟分布（中位数 / 最大）
 *
 * 用法：node deploy/soak-tunnel.cjs <公网地址> [测试分钟数]
 */

const { io } = require('socket.io-client');

const BASE = process.argv[2];
const MINUTES = Number(process.argv[3]) || 3;

if (!BASE) {
  console.error('用法: node deploy/soak-tunnel.cjs https://xxx.trycloudflare.com [分钟数]');
  process.exit(1);
}

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

async function req(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

(async () => {
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  ${C.bold('公网地址稳定性测试')}  ${C.dim(`持续 ${MINUTES} 分钟`)}`);
  console.log(`  ${BASE}`);
  console.log(`${'═'.repeat(62)}\n`);

  // ---- 准备两个用户 ----
  const stamp = String(Date.now()).slice(-6);
  const u1 = { username: `soak1_${stamp}`, password: 'soaktest123456' };
  const u2 = { username: `soak2_${stamp}`, password: 'soaktest123456' };

  for (const u of [u1, u2]) {
    await req('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(u),
    });
    const r = await req('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(u),
    });
    u.token = r.body?.data?.token;
    u.id = r.body?.data?.user?.id;
    if (!u.token) {
      console.log(`${C.red('登录失败，无法继续')}  ${JSON.stringify(r.body)}`);
      process.exit(1);
    }
  }
  console.log(`  用户就绪：${u1.username} / ${u2.username}\n`);

  // ---- 建立 WebSocket 连接 ----
  const stats = {
    reconnects: 0,
    disconnects: 0,
    sends: 0,
    received: 0,
    latencies: [],
    errors: [],
  };

  const sockets = [];
  const connected = new Set();

  function makeSocket(user, label) {
    const s = io(BASE, {
      auth: { token: user.token },
      transports: ['websocket'],       // 强制 WebSocket，和真实浏览器行为一致
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    s.on('connect', () => {
      connected.add(label);
      if (sockets.filter((x) => x.connected).length === 2) {
        // 用默认房间
      }
    });
    s.on('disconnect', (reason) => {
      connected.delete(label);
      stats.disconnects++;
      console.log(`  ${C.yellow('断线')}  ${label} 原因=${reason}`);
    });
    s.io.on('reconnect', () => {
      stats.reconnects++;
      console.log(`  ${C.green('重连成功')}  ${label}`);
    });
    s.on('connect_error', (e) => {
      stats.errors.push(e.message);
      console.log(`  ${C.red('连接错误')}  ${label}: ${e.message}`);
    });
    s.on('new_message', (m) => {
      stats.received++;
      if (m && m._sentAt) {
        stats.latencies.push(Date.now() - m._sentAt);
      }
    });

    sockets.push(s);
    return s;
  }

  const [s1, s2] = [
    makeSocket(u1, 'user1'),
    makeSocket(u2, 'user2'),
  ];

  // 等连接建立
  await new Promise((resolve) => {
    const t = setInterval(() => {
      if (s1.connected && s2.connected) { clearInterval(t); resolve(); }
    }, 200);
    setTimeout(() => { clearInterval(t); resolve(); }, 30000);
  });

  if (!s1.connected || !s2.connected) {
    console.log(`  ${C.red('初始连接就没建起来，后面的稳定性测试没意义')}`);
    process.exit(1);
  }
  console.log(`  ${C.green('两名用户 WebSocket 已连接')}  ${C.dim('(transports=websocket)')}`);

  // 加入房间
  await new Promise((resolve) => {
    let done = 0;
    const check = () => { if (++done === 2) resolve(); };
    s1.emit('join_room', { roomId: 1 }, check);
    s2.emit('join_room', { roomId: 1 }, check);
    setTimeout(resolve, 8000);
  });
  console.log(`  ${C.green('两人已加入房间')}\n`);

  // ---- 心跳循环 ----
  const totalMs = MINUTES * 60 * 1000;
  const intervalMs = 30 * 1000;
  const rounds = Math.floor(totalMs / intervalMs);
  const startAt = Date.now();

  console.log(`${C.bold('开始心跳测试')}  ${C.dim(`每 30 秒发一轮，共 ${rounds} 轮`)}\n`);

  for (let i = 1; i <= rounds; i++) {
    const before = stats.received;

    await new Promise((resolve) => {
      s1.emit('send_message', {
        roomId: 1,
        content: `心跳 #${i}  ${Date.now()}`,
        _sentAt: Date.now(),
      }, () => resolve());
      setTimeout(resolve, 6000);
    });

    // 留点时间让对方收到
    await new Promise((r) => setTimeout(r, 1200));

    const got = stats.received > before;
    const elapsed = ((Date.now() - startAt) / 1000).toFixed(0);
    const alive = s1.connected && s2.connected;

    const statusIcon = got && alive ? C.green('OK') : C.yellow('注意');
    console.log(
      `  [${String(elapsed).padStart(5)}s] 第 ${String(i).padStart(2)}/${rounds} 轮  ` +
      `${statusIcon}  ` +
      `${C.dim(`收到=${stats.received} 断线=${stats.disconnects} 重连=${stats.reconnects}`)}`
    );

    if (i < rounds) await new Promise((r) => setTimeout(r, intervalMs - 1200));
  }

  // ---- 汇总 ----
  const lat = stats.latencies.slice().sort((a, b) => a - b);
  const median = lat.length ? lat[Math.floor(lat.length / 2)] : null;
  const max = lat.length ? lat[lat.length - 1] : null;
  const min = lat.length ? lat[0] : null;

  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  ${C.bold('汇总')}`);
  console.log(`${'═'.repeat(62)}`);
  console.log(`  初始连接          ${C.green('成功')}`);
  console.log(`  最终连接状态      ${s1.connected && s2.connected ? C.green('双方都在线') : C.red('有掉线')}`);
  console.log(`  经历轮次          ${rounds}`);
  console.log(`  断线次数          ${stats.disconnects === 0 ? C.green('0') : C.yellow(String(stats.disconnects))}`);
  console.log(`  重连次数          ${stats.reconnects === 0 ? C.green('0') : C.yellow(String(stats.reconnects))}`);
  console.log(`  成功收到消息      ${stats.received} 条`);
  if (median !== null) {
    console.log(`  消息延迟          中位数 ${median}ms / 最小 ${min}ms / 最大 ${max}ms`);
  }
  if (stats.errors.length) {
    console.log(`  连接错误          ${C.red(String(stats.errors.length))} 次`);
    stats.errors.slice(0, 3).forEach((e) => console.log(`    ${C.dim(e)}`));
  }

  console.log('');
  const healthy = stats.disconnects === 0 && s1.connected && s2.connected && stats.received >= rounds;
  if (healthy) {
    console.log(`  ${C.green('✅ 稳定性测试通过')}`);
    console.log(`  ${C.dim('WebSocket 长连接全程未断，可以挂着正常使用。')}`);
  } else if (stats.reconnects > 0 && s1.connected && s2.connected) {
    console.log(`  ${C.yellow('⚠️ 有断线但自动重连成功')}`);
    console.log(`  ${C.dim('用户侧基本无感，前端有断线重连机制。')}`);
  } else {
    console.log(`  ${C.red('❌ 稳定性有问题，需要排查')}`);
  }
  console.log(`${'═'.repeat(62)}\n`);

  sockets.forEach((s) => s.close());
  process.exit(healthy ? 0 : 1);
})();
