/**
 * test-socket.js —— Socket.IO 实时层验收测试
 *
 * 用真实的 socket.io-client 连到服务端，模拟多个用户同时在线，
 * 验证"一个窗口发消息、另一个窗口立刻收到"这个核心能力。
 *
 * 用法：npm run test:socket
 *
 * 为什么要在 Node 里测而不是直接开浏览器手动点？
 *   因为"实时推送"最难查的就是时序问题：
 *   - 消息有没有真的推到另一个客户端（不是自己发自己收）
 *   - 私聊有没有漏给别人
 *   - 多标签页场景下"真的离线"判定对不对
 *   这些用手点很难覆盖，写成断言才能每次都跑一遍。
 */

require('dotenv').config();

const { io } = require('socket.io-client');

const BASE = process.env.TEST_BASE || 'http://localhost:3000';

/* ============================================================
 * 测试工具
 * ============================================================ */

let pass = 0;
let fail = 0;

function ok(cond, label, extra = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`);
  }
}

function section(name) {
  console.log(`\n【${name}】`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 简易 HTTP 请求（用来注册/登录拿 token） */
async function req(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 忽略 */
  }
  return { status: res.status, body: json };
}

/** 注册 + 登录一个用户，返回 { token, user } */
async function createUser(prefix) {
  // 用户名长度限制是 3-20 字符，所以这里不能拼太长：
  // 用时间戳的后 8 位 + 两位随机，够唯一且不会超长。
  // 例：sockA + 46690225 + 37 = 15 字符
  const stamp = String(Date.now()).slice(-8);
  const rand = String(Math.floor(Math.random() * 100)).padStart(2, '0');
  const username = `${prefix}${stamp}${rand}`;
  const password = 'test123456';

  const reg = await req('/api/register', { method: 'POST', body: { username, password } });
  if (reg.status !== 201) throw new Error('注册失败: ' + JSON.stringify(reg.body));

  const login = await req('/api/login', { method: 'POST', body: { username, password } });
  if (login.status !== 200) throw new Error('登录失败: ' + JSON.stringify(login.body));

  return { token: login.body.data.token, user: login.body.data.user, username };
}

/**
 * 连一个 socket 客户端
 * @returns {Promise<object>} 已连接的 socket
 */
function connect(token, opts = {}) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false, // 测试里不自动重连，避免干扰断言
      ...opts,
    });

    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('连接超时'));
    }, 6000);

    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });
  });
}

/** 等某个事件，超时抛错 */
function waitFor(socket, event, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`等待事件 ${event} 超时`));
    }, timeout);

    function handler(payload) {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }

    socket.on(event, handler);
  });
}

/** 收集某个事件的所有触发（用来断言"不该收到"的情况） */
function collect(socket, event) {
  const bucket = [];
  socket.on(event, (p) => bucket.push(p));
  return bucket;
}

/**
 * 发事件并等 ack 回调
 * 注意要加超时 —— 如果服务端没实现 ack，这个 Promise 永远不会 resolve
 */
function emitAck(socket, event, payload, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} 的 ack 超时`)), timeout);
    socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

/* ============================================================
 * 主测试流程
 * ============================================================ */

async function main() {
  console.log('Socket.IO 实时层验收测试');
  console.log('目标服务:', BASE);

  /* ---------- 准备账号 ---------- */
  console.log('\n准备测试账号...');
  const alice = await createUser('sockA');
  const bob = await createUser('sockB');
  const carol = await createUser('sockC');
  console.log(`  alice=#${alice.user.id} bob=#${bob.user.id} carol=#${carol.user.id}`);

  const roomsRes = await req('/api/rooms', { token: alice.token });
  const rooms = roomsRes.body.data;
  const room1 = rooms[0].id;
  const room2 = rooms[1].id;
  console.log(`  房间: ${rooms.map((r) => r.id + ':' + r.name).join(', ')}`);

  /* ==========================================================
   * 1. 鉴权
   * ========================================================== */
  section('1. 连接鉴权');

  // 不带 token
  let noTokenRejected = false;
  let noTokenMsg = '';
  try {
    const s = await connect(undefined);
    s.close();
  } catch (err) {
    noTokenRejected = true;
    noTokenMsg = err.message;
  }
  ok(noTokenRejected, '没带 token 连不上', `(${noTokenMsg})`);
  ok(/未登录/.test(noTokenMsg), '错误提示是「未登录」');

  // 伪造 token
  let badTokenRejected = false;
  let badTokenMsg = '';
  try {
    const s = await connect('this.is.not.a.valid.jwt');
    s.close();
  } catch (err) {
    badTokenRejected = true;
    badTokenMsg = err.message;
  }
  ok(badTokenRejected, '伪造的 token 连不上', `(${badTokenMsg})`);

  // 正常 token
  const sa = await connect(alice.token);
  ok(sa.connected, '正常 token 可以连上');

  /* ==========================================================
   * 2. 加入房间 + 在线列表
   * ========================================================== */
  section('2. 加入房间与在线用户');

  const ack1 = await emitAck(sa, 'join_room', { roomId: room1 });
  ok(ack1 && ack1.ok === true, 'join_room 返回成功', `(${JSON.stringify(ack1.data)})`);

  // 加入不存在的房间
  const ackBad = await emitAck(sa, 'join_room', { roomId: 999999 });
  ok(ackBad && ackBad.ok === false, '加入不存在的房间被拒绝', `(${ackBad.error})`);

  // 加入非法 roomId
  const ackInvalid = await emitAck(sa, 'join_room', { roomId: 'abc' });
  ok(ackInvalid && ackInvalid.ok === false, 'roomId 非法被拒绝', `(${ackInvalid.error})`);

  const sb = await connect(bob.token);
  const onlineAtB = waitFor(sa, 'online_users'); // alice 应该会收到"bob 来了"
  await emitAck(sb, 'join_room', { roomId: room1 });
  const onlinePayload = await onlineAtB;

  ok(onlinePayload.roomId === room1, 'online_users 带的 roomId 正确');
  ok(
    onlinePayload.users.length === 2,
    'alice 看到 2 个在线用户',
    `(${onlinePayload.users.map((u) => u.username).join(', ')})`
  );
  ok(
    onlinePayload.users.some((u) => u.id === alice.user.id) &&
      onlinePayload.users.some((u) => u.id === bob.user.id),
    '在线列表包含 alice 和 bob'
  );
  ok(
    onlinePayload.users.every((u) => u.username && 'avatar' in u),
    '每个在线用户都有 username 和 avatar 字段'
  );

  /* ==========================================================
   * 3. 公共消息实时推送（核心！）
   * ========================================================== */
  section('3. 公共消息实时推送（核心能力）');

  // bob 监听新消息，alice 发一条
  const bobGotMsg = waitFor(sb, 'new_message');
  const aliceAck = await emitAck(sa, 'send_message', { roomId: room1, content: '你好，我是 alice' });
  const received = await bobGotMsg;

  ok(aliceAck.ok === true, 'alice 发送成功');
  ok(received.content === '你好，我是 alice', 'bob 立刻收到消息', `("${received.content}")`);
  ok(received.sender.id === alice.user.id, '消息的 sender 是 alice', `(${received.sender.username})`);
  ok(received.sender.username === alice.username, 'sender.username 正确');
  ok(typeof received.id === 'number' && received.id > 0, '消息带自增 id', `(id=${received.id})`);
  ok(typeof received.createdAt === 'string', '消息带时间戳', `(${received.createdAt})`);
  ok(received.roomId === room1, '消息的 roomId 正确');

  // 发送者自己也应该收到（保证多窗口一致）
  const aliceSelfMsg = waitFor(sa, 'new_message');
  await emitAck(sa, 'send_message', { roomId: room1, content: '自己也应该收到' });
  const selfReceived = await aliceSelfMsg;
  ok(selfReceived.content === '自己也应该收到', '发送者自己也能收到广播（多窗口一致）');

  /* ==========================================================
   * 4. 房间隔离
   * ========================================================== */
  section('4. 房间隔离');

  // carol 在房间 2，不应该收到房间 1 的消息
  const sc = await connect(carol.token);
  await emitAck(sc, 'join_room', { roomId: room2 });
  const carolMsgs = collect(sc, 'new_message');
  const carolOnline = collect(sc, 'online_users');

  await emitAck(sa, 'send_message', { roomId: room1, content: '这条只有房间1的人能收到' });
  await sleep(600);

  ok(carolMsgs.length === 0, '在别的房间的人收不到本房间消息', `(收到 ${carolMsgs.length} 条)`);
  ok(
    carolOnline.length === 0,
    '别的房间的在线变化不会推给这里',
    `(收到 ${carolOnline.length} 次)`
  );

  /* ==========================================================
   * 5. 消息内容校验
   * ========================================================== */
  section('5. 消息内容校验');

  const emptyAck = await emitAck(sa, 'send_message', { roomId: room1, content: '   ' });
  ok(emptyAck.ok === false && /不能为空/.test(emptyAck.error), '纯空格消息被拒绝', `(${emptyAck.error})`);

  const emptyAck2 = await emitAck(sa, 'send_message', { roomId: room1, content: '' });
  ok(emptyAck2.ok === false, '空字符串被拒绝', `(${emptyAck2.error})`);

  const numAck = await emitAck(sa, 'send_message', { roomId: room1, content: 12345 });
  ok(numAck.ok === false, '非字符串内容被拒绝', `(${numAck.error})`);

  const longAck = await emitAck(sa, 'send_message', {
    roomId: room1,
    content: 'x'.repeat(2001),
  });
  ok(longAck.ok === false && /太长/.test(longAck.error), '超长消息被拒绝', `(${longAck.error})`);

  // 边界：正好 2000 应该通过
  const exactAck = await emitAck(sa, 'send_message', {
    roomId: room1,
    content: 'y'.repeat(2000),
  });
  ok(exactAck.ok === true, '正好 2000 字符可以通过');

  // 不在房间里发消息（alice 已经切到 room1，这里假装发到 room2）
  const wrongRoomAck = await emitAck(sa, 'send_message', { roomId: room2, content: '越权发送' });
  ok(
    wrongRoomAck.ok === false && /不在这个房间/.test(wrongRoomAck.error),
    '不能往自己不在的房间发消息（防越权）',
    `(${wrongRoomAck.error})`
  );

  /* ==========================================================
   * 6. 私聊
   * ========================================================== */
  section('6. 私聊');

  const bobGotPm = waitFor(sb, 'new_private_message');
  const pmAck = await emitAck(sa, 'private_message', { toUserId: bob.user.id, content: '悄悄话' });
  const pmReceived = await bobGotPm;

  ok(pmAck.ok === true, 'alice 发私聊成功');
  ok(pmReceived.content === '悄悄话', 'bob 收到私聊', `("${pmReceived.content}")`);
  ok(pmReceived.sender.id === alice.user.id, '私聊 sender 正确');
  ok(pmReceived.receiver.id === bob.user.id, '私聊 receiver 正确');
  ok(pmAck.delivered === true, 'ack 里 delivered=true（对方在线）');

  // carol 不应该收到私聊
  const carolPms = collect(sc, 'new_private_message');
  await emitAck(sa, 'private_message', { toUserId: bob.user.id, content: '这条 carol 不该看到' });
  await sleep(600);
  ok(carolPms.length === 0, '私聊不会泄漏给第三方', `(carol 收到 ${carolPms.length} 条)`);

  // 不能给自己发
  const selfPmAck = await emitAck(sa, 'private_message', {
    toUserId: alice.user.id,
    content: '自己给自己',
  });
  ok(selfPmAck.ok === false, '不能给自己发私聊', `(${selfPmAck.error})`);

  // 发给不存在的人
  const ghostPmAck = await emitAck(sa, 'private_message', {
    toUserId: 999999,
    content: '发给空气',
  });
  ok(ghostPmAck.ok === false && /不存在/.test(ghostPmAck.error), '发给不存在的用户被拒绝', `(${ghostPmAck.error})`);

  // 私聊内容校验
  const pmEmpty = await emitAck(sa, 'private_message', { toUserId: bob.user.id, content: '  ' });
  ok(pmEmpty.ok === false, '空私聊被拒绝', `(${pmEmpty.error})`);

  /* ==========================================================
   * 7. 多标签页（同一用户多个连接）
   * ========================================================== */
  section('7. 多标签页场景');

  // 同一个人再开一个连接（第二个标签页）
  const sa2 = await connect(alice.token);
  const onlineAtB2 = waitFor(sb, 'online_users');
  await emitAck(sa2, 'join_room', { roomId: room1 });
  const onlineAfter2 = await onlineAtB2;

  ok(onlineAfter2.users.length === 2, 'alice 开两个窗口，在线列表仍是 2 人（去重）',
    `(${onlineAfter2.users.map((u) => u.username).join(', ')})`);

  // 关掉其中一个窗口，不应该从在线列表消失
  const onlineAtB3 = waitFor(sb, 'online_users', 2500).catch(() => null);
  sa2.close();
  const afterClose = await onlineAtB3;
  if (afterClose) {
    ok(afterClose.users.length === 2, 'alice 关掉一个窗口后仍在在线列表里（另一个窗口还在）');
  } else {
    ok(true, 'alice 关掉一个窗口后没触发「有人离开」广播（正确，因为还有连接）');
  }

  // 第二个窗口发的消息，第一个窗口也应该收到
  const sa2b = await connect(alice.token);
  await emitAck(sa2b, 'join_room', { roomId: room1 });
  const aliceWindow1Got = waitFor(sa, 'new_message');
  await emitAck(sa2b, 'send_message', { roomId: room1, content: '第二个窗口发的' });
  const win1Msg = await aliceWindow1Got;
  ok(win1Msg.content === '第二个窗口发的', '同一用户不同窗口之间消息互通');

  // 全部关闭后才算离线
  const offlineNotice = waitFor(sb, 'online_users', 4000).catch(() => null);
  sa.close();
  sa2b.close();
  const offlinePayload = await offlineNotice;
  ok(
    offlinePayload && offlinePayload.users.length === 1 && offlinePayload.users[0].id === bob.user.id,
    'alice 所有窗口都关掉后才从在线列表消失',
    offlinePayload ? `(剩 ${offlinePayload.users.map((u) => u.username).join(', ')})` : '(没收到广播)'
  );

  /* ==========================================================
   * 8. 切房间
   * ========================================================== */
  section('8. 切换房间');

  const sa3 = await connect(alice.token);
  await emitAck(sa3, 'join_room', { roomId: room1 });

  // 切到房间 2，房间 1 的 bob 应该收到"人少了"
  const bobSeenLeave = waitFor(sb, 'online_users');
  const ackSwitch = await emitAck(sa3, 'join_room', { roomId: room2 });
  const leavePayload = await bobSeenLeave;
  ok(ackSwitch.ok === true, '切房间成功', `(→ ${ackSwitch.data.name})`);
  ok(leavePayload.users.length === 1, '原房间的在线列表减少了', `(剩 ${leavePayload.users.length} 人)`);

  // 切过去之后，新房间的消息能收到、旧房间的收不到
  const newRoomMsgs = collect(sa3, 'new_message');
  await emitAck(sb, 'send_message', { roomId: room1, content: '旧房间的消息' });
  await emitAck(sc, 'send_message', { roomId: room2, content: '新房间的消息' });
  await sleep(700);

  ok(newRoomMsgs.length === 1, '切房间后只收到新房间的消息', `(收到 ${newRoomMsgs.length} 条)`);
  ok(
    newRoomMsgs[0] && newRoomMsgs[0].content === '新房间的消息',
    '收到的确实是新房间那条'
  );

  /* ==========================================================
   * 9. 历史消息持久化（REST）
   * ========================================================== */
  section('9. 历史消息持久化');

  const hist = await req(`/api/messages?roomId=${room1}&limit=50`, { token: alice.token });
  const histMsgs = hist.body.data;
  ok(histMsgs.length > 0, '能拉到房间 1 的历史消息', `(${histMsgs.length} 条)`);

  const hasAliceMsg = histMsgs.some((m) => m.content === '你好，我是 alice');
  ok(hasAliceMsg, '刚才发的消息能从数据库里读回来（刷新页面不丢）');

  // 顺序必须是从旧到新
  const ids = histMsgs.map((m) => m.id);
  const sortedAsc = [...ids].sort((a, b) => a - b);
  ok(JSON.stringify(ids) === JSON.stringify(sortedAsc), '历史消息按时间从旧到新排列');

  // 每条消息结构完整
  ok(
    histMsgs.every((m) => m.id && m.content && m.createdAt && m.sender && m.sender.username),
    '每条历史消息结构完整'
  );

  // 私聊历史
  const pmHist = await req(`/api/private-messages?withUserId=${bob.user.id}&limit=50`, {
    token: alice.token,
  });
  const pmList = pmHist.body.data.messages;
  ok(pmList.length > 0, '能拉到私聊历史', `(${pmList.length} 条)`);
  ok(
    pmList.some((p) => p.content === '悄悄话'),
    '刚才的私聊能从数据库读回来'
  );

  /* ==========================================================
   * 10. XSS 内容原样存取
   * ========================================================== */
  section('10. 特殊字符与 XSS 内容');

  // 注意：前面第 8 节让 alice 切到了 room2，而 bob 还在 room1。
  // 想验证"bob 收到 alice 发的消息"，必须让两人在同一个房间 ——
  // 这里把 bob 也切到 room2，否则等事件会一直超时（这个坑我在写测试时踩过一次）。
  await emitAck(sb, 'join_room', { roomId: room2 });

  const xssContent = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
  const sbGotXss = waitFor(sb, 'new_message');
  await emitAck(sa3, 'send_message', { roomId: room2, content: xssContent });
  const xssMsg = await sbGotXss;

  ok(xssMsg.content === xssContent, 'HTML 标签原样存储（服务端不转义，前端用 textContent 防注入）');
  ok(
    typeof xssMsg.content === 'string' && xssMsg.content.includes('<script>'),
    '内容里的 <script> 没有被吃掉'
  );

  // 换行和 emoji 也要能原样存取
  const trickyContent = '第一行\n第二行\t制表符 😀🎉';
  const sbGotTricky = waitFor(sb, 'new_message');
  await emitAck(sa3, 'send_message', { roomId: room2, content: trickyContent });
  const trickyMsg = await sbGotTricky;
  ok(trickyMsg.content === trickyContent, '换行/制表符/emoji 原样保存');

  /* ---------- 清理 ---------- */
  sa3.close();
  sb.close();
  sc.close();

  /* ---------- 汇总 ---------- */
  console.log('\n' + '='.repeat(58));
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log('='.repeat(58));

  // 顺手清理这次测试造出来的账号和消息，避免数据库越跑越脏。
  // 注意：清理放在最后，而且失败不影响测试结论（只是卫生问题）。
  if (process.env.KEEP_TEST_DATA !== '1') {
    try {
      const { cleanupTestData } = require('./test-cleanup');
      const n = cleanupTestData();
      console.log(`  （已清理 ${n} 个测试账号及其消息）`);
    } catch (err) {
      console.log('  （测试数据清理跳过：' + err.message + '）');
    }
  }

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n测试脚本异常终止:', err);
  process.exit(1);
});
