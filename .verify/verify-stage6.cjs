/**
 * verify-stage6.cjs —— 第 6 阶段端到端验证（真实浏览器）
 *
 * 这个脚本要回答的核心问题：
 *   「一个浏览器窗口发消息，另一个窗口能不能立刻看到？」
 * 这是整个项目的验收标准，必须用**两个真实的浏览器实例**来测，
 * 不能只靠 Node 端的 socket.io-client（那只验证了服务端）。
 *
 * 【关键设计】为什么用 launchBrowser 而不是 withEdge？
 *   withEdge 是"起浏览器 → 跑一段 → 关掉"的一次性封装。
 *   但本测试需要在两个窗口之间来回操作十几轮，
 *   两个浏览器必须**同时长期存活**。
 *   withEdge 一返回就把浏览器杀了，后续操作全会 CDP timeout。
 *   所以这里用 launchBrowser 手动管理生命周期，最后统一 close。
 *
 * 用法：node verify-stage6.cjs
 */

const { withEdge, launchBrowser, sleep } = require('./_cdp.cjs');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:3000';
const OUT = path.join(__dirname, 'shots');

fs.mkdirSync(OUT, { recursive: true });

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

/* ============================================================
 * 准备测试账号（走真实注册接口）
 * ============================================================ */

async function req(pathname, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, body: json };
}

async function createUser(prefix) {
  const stamp = String(Date.now()).slice(-8);
  const rand = String(Math.floor(Math.random() * 100)).padStart(2, '0');
  const username = `${prefix}${stamp}${rand}`;
  const password = 'test123456';

  const reg = await req('/api/register', { method: 'POST', body: { username, password } });
  if (reg.status !== 201) throw new Error('注册失败: ' + JSON.stringify(reg.body));

  const login = await req('/api/login', { method: 'POST', body: { username, password } });
  if (login.status !== 200) throw new Error('登录失败: ' + JSON.stringify(login.body));

  return { token: login.body.data.token, user: login.body.data.user, username, password };
}

/* ============================================================
 * 页面内注入 / 读取的代码片段
 * ============================================================ */

/**
 * 注入登录态 + 错误收集器。
 *
 * 为什么直接往 localStorage 塞 token，而不是走登录页表单？
 *   登录流程第 5 阶段已经有 52 项断言覆盖了，这里专注测聊天功能。
 *   但发送消息仍然走真实的 DOM 操作，不绕过 UI。
 */
function injectBootstrap(token, user) {
  return `
    localStorage.setItem('token', ${JSON.stringify(token)});
    localStorage.setItem('user', ${JSON.stringify(JSON.stringify(user))});

    // 收集页面里的 JS 报错，测试结束前读出来
    window.__errors = [];
    window.addEventListener('error', function (e) {
      window.__errors.push(String(e.message));
    });
    window.addEventListener('unhandledrejection', function (e) {
      window.__errors.push('unhandled: ' + String(e.reason));
    });

    window.__injected = true;
    return true;
  `;
}

/** 在页面里通过真实 UI 发消息（填字 + 点按钮） */
const SEND_FROM_PAGE = (content) => `
  const input = document.getElementById('messageInput');
  if (!input) return { ok: false, error: '找不到输入框' };
  input.value = ${JSON.stringify(content)};
  input.dispatchEvent(new Event('input', { bubbles: true }));

  const btn = document.getElementById('sendBtn');
  if (!btn) return { ok: false, error: '找不到发送按钮' };
  btn.click();
  return { ok: true };
`;

/** 读页面消息列表 */
const READ_MESSAGES = `
  const nodes = document.querySelectorAll('#messages .msg:not(.msg-system)');
  return Array.from(nodes).map(function (n) {
    const name = n.querySelector('.msg-name');
    const bubble = n.querySelector('.msg-bubble');
    return {
      id: Number(n.dataset.msgId),
      name: name ? name.textContent : '',
      text: bubble ? bubble.textContent : '',
      self: n.classList.contains('self'),
    };
  });
`;

/** 读在线用户列表 */
const READ_ONLINE = `
  const nodes = document.querySelectorAll('#onlineList .online-user');
  return Array.from(nodes).map(function (n) {
    const name = n.querySelector('.name');
    return name ? name.textContent : '';
  });
`;

/** 读连接状态 */
const READ_CONN = `
  const s = document.getElementById('connStatus');
  return {
    offline: s ? s.classList.contains('offline') : null,
    text: document.getElementById('connText') ? document.getElementById('connText').textContent : '',
  };
`;

/** 读私聊弹窗里的消息 */
const READ_PM = `
  const nodes = document.querySelectorAll('#pmMessages .msg:not(.msg-system)');
  return Array.from(nodes).map(function (n) {
    const b = n.querySelector('.msg-bubble');
    return { text: b ? b.textContent : '', self: n.classList.contains('self') };
  });
`;

/* ============================================================
 * 小工具
 * ============================================================ */

/** 轮询直到条件满足，返回最后一次读到的值 */
async function poll(cdp, expr, verifySelector, predicate, { tries = 40, gap = 250 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await cdp.eval(expr, { verifySelector, attempts: 3 });
    if (predicate(last)) return { hit: true, value: last };
    await sleep(gap);
  }
  return { hit: false, value: last };
}

/** 在某个窗口里打开和指定用户的私聊（点在线列表里的那一项） */
function clickOnlineUser(cdp, username) {
  return cdp.eval(
    `const items = Array.from(document.querySelectorAll('#onlineList .online-user'));
     const target = items.find(function (n) {
       const name = n.querySelector('.name');
       return name && name.textContent === ${JSON.stringify(username)};
     });
     if (!target) return { ok: false, error: '没找到该用户', names: items.length };
     target.click();
     return { ok: true };`,
    { verifySelector: '#onlineList', attempts: 8 }
  );
}

/* ============================================================
 * 主流程
 * ============================================================ */

async function main() {
  console.log('第 6 阶段端到端验证（双浏览器实时通信）');
  console.log('目标:', BASE);

  /* ---------- 准备账号 ---------- */
  console.log('\n准备测试账号...');
  const alice = await createUser('e2eA');
  const bob = await createUser('e2eB');
  console.log(`  alice=#${alice.user.id} ${alice.username}`);
  console.log(`  bob  =#${bob.user.id} ${bob.username}`);

  const roomsRes = await req('/api/rooms', { token: alice.token });
  const rooms = roomsRes.body.data;
  const room1 = rooms[0];
  const room2 = rooms[1];

  /* ==========================================================
   * 启动两个浏览器（长期共存）
   * ========================================================== */
  console.log('\n启动两个浏览器实例...');
  const A = await launchBrowser({ port: 9311 });
  const B = await launchBrowser({ port: 9312 });
  console.log('  A / B 就绪');

  try {
    /* ========================================================
     * 场景 1：两个窗口都进入聊天页
     * ======================================================== */
    section('1. 聊天页加载与初始化');

    // A 进登录页写登录态 → 再进聊天页
    await A.cdp.navigate(BASE + '/login.html', 900);
    await A.cdp.eval(injectBootstrap(alice.token, alice.user), {
      verifySelector: '#loginForm',
      attempts: 10,
    });
    await A.cdp.navigate(BASE + '/chat.html', 3000);

    await B.cdp.navigate(BASE + '/login.html', 900);
    await B.cdp.eval(injectBootstrap(bob.token, bob.user), {
      verifySelector: '#loginForm',
      attempts: 10,
    });
    await B.cdp.navigate(BASE + '/chat.html', 3000);

    const domA = await A.cdp.eval(
      `return {
         hasMsgArea: !!document.getElementById('messages'),
         hasInput: !!document.getElementById('messageInput'),
         hasSendBtn: !!document.getElementById('sendBtn'),
         hasOnlineList: !!document.getElementById('onlineList'),
         roomItems: document.querySelectorAll('#roomList .room-item').length,
         myName: document.getElementById('myName') ? document.getElementById('myName').textContent : '',
       };`,
      { verifySelector: '#messageInput', attempts: 25 }
    );

    ok(domA.hasInput && domA.hasSendBtn, '输入框和发送按钮存在');
    ok(domA.hasMsgArea, '消息区存在');
    ok(domA.hasOnlineList, '在线用户面板存在');
    ok(domA.roomItems >= 3, '房间列表渲染出来了', `(${domA.roomItems} 个房间)`);
    ok(domA.myName === alice.username, '顶栏显示当前用户名', `(${domA.myName})`);

    // 等两个窗口的 socket 都连上
    const connA = await poll(A.cdp, READ_CONN, '#connStatus', (v) => v && v.offline === false, {
      tries: 25,
      gap: 400,
    });
    const connB = await poll(B.cdp, READ_CONN, '#connStatus', (v) => v && v.offline === false, {
      tries: 25,
      gap: 400,
    });
    ok(connA.hit, 'A 的 Socket 已连接', `(${connA.value ? connA.value.text : '?'})`);
    ok(connB.hit, 'B 的 Socket 已连接', `(${connB.value ? connB.value.text : '?'})`);

    // 房间名
    const roomNameA = await A.cdp.eval(`return document.getElementById('roomName').textContent;`, {
      verifySelector: '#roomName',
      attempts: 10,
    });
    ok(roomNameA && roomNameA !== '请选择房间', '自动进入了第一个房间', `(#${roomNameA})`);

    // 两个窗口互见
    const onlineA = await poll(A.cdp, READ_ONLINE, '#onlineList', (v) => v && v.includes(bob.username), {
      tries: 30,
      gap: 400,
    });
    const onlineB = await poll(B.cdp, READ_ONLINE, '#onlineList', (v) => v && v.includes(alice.username), {
      tries: 30,
      gap: 400,
    });

    ok(onlineA.hit, 'A 的在线列表里看到 B', `(${(onlineA.value || []).join(', ')})`);
    ok(onlineB.hit, 'B 的在线列表里看到 A', `(${(onlineB.value || []).join(', ')})`);
    ok(
      onlineA.value && onlineA.value.length === 2,
      'A 看到正好 2 人在线',
      `(${(onlineA.value || []).join(', ')})`
    );

    // 页面无报错
    const errorsA = await A.cdp.eval(`return window.__errors || [];`, {
      verifySelector: '#messages',
      attempts: 3,
    });
    ok(!errorsA || errorsA.length === 0, '页面没有 JS 报错', errorsA && errorsA.length ? `(${errorsA.join(' | ')})` : '');

    await A.cdp.shot(path.join(OUT, 's6-1-chat-loaded.png'));
    console.log('  -> 截图 s6-1-chat-loaded.png');

    /* ========================================================
     * 场景 2：★ 核心 —— A 发消息，B 立刻收到
     * ======================================================== */
    section('2. ★ 核心：A 发消息，B 立刻收到');

    const msg1 = 'A 发的第一条消息 ' + Date.now();

    const sendRes = await A.cdp.eval(SEND_FROM_PAGE(msg1), {
      verifySelector: '#sendBtn',
      attempts: 5,
    });
    ok(sendRes && sendRes.ok, 'A 通过点击发送按钮发出消息');

    // B 等消息出现
    const bGot = await poll(
      B.cdp,
      READ_MESSAGES,
      '#messages',
      (v) => v && v.some((m) => m.text === msg1),
      { tries: 45, gap: 200 }
    );
    ok(bGot.hit, '★ B 窗口立刻收到 A 的消息', bGot.hit ? `("${msg1}")` : '（9 秒内没收到）');

    if (bGot.hit) {
      const m = bGot.value.find((x) => x.text === msg1);
      ok(m.name === alice.username, 'B 看到的消息发送者正确', `(${m.name})`);
      ok(m.self === false, '这条消息在 B 那边显示为「别人的」（靠左）');
      ok(Number.isFinite(m.id) && m.id > 0, '消息带自增 id', `(id=${m.id})`);
    }

    // A 自己那边也要显示
    const aGot = await poll(
      A.cdp,
      READ_MESSAGES,
      '#messages',
      (v) => v && v.some((m) => m.text === msg1),
      { tries: 30, gap: 200 }
    );
    ok(aGot.hit, 'A 自己那边也显示了这条消息');

    if (aGot.hit) {
      const m = aGot.value.find((x) => x.text === msg1);
      ok(m.self === true, 'A 那边这条消息显示为「自己的」（靠右）');
      if (bGot.hit) {
        const bm = bGot.value.find((x) => x.text === msg1);
        ok(m.id === bm.id, '两边拿到的是同一条消息（id 一致）', `(id=${m.id})`);
      }
    }

    // 输入框应该被清空
    const inputVal = await A.cdp.eval(`return document.getElementById('messageInput').value;`, {
      verifySelector: '#messageInput',
      attempts: 3,
    });
    ok(inputVal === '', '发送后 A 的输入框自动清空');

    /* ---------- B 回复 ---------- */
    const msg2 = 'B 回复的消息 ' + Date.now();
    const sendRes2 = await B.cdp.eval(SEND_FROM_PAGE(msg2), {
      verifySelector: '#sendBtn',
      attempts: 5,
    });
    ok(sendRes2 && sendRes2.ok, 'B 通过点击发送按钮回复');

    const aGot2 = await poll(
      A.cdp,
      READ_MESSAGES,
      '#messages',
      (v) => v && v.some((m) => m.text === msg2),
      { tries: 45, gap: 200 }
    );
    ok(aGot2.hit, '★ A 窗口立刻收到 B 的回复', aGot2.hit ? `("${msg2}")` : '（9 秒内没收到）');

    /* ---------- 两边内容一致 ---------- */
    const finalA = await A.cdp.eval(READ_MESSAGES, { verifySelector: '#messages', attempts: 3 });
    const finalB = await B.cdp.eval(READ_MESSAGES, { verifySelector: '#messages', attempts: 3 });

    ok(finalA.length === finalB.length, '两个窗口的消息条数一致', `(A=${finalA.length} B=${finalB.length})`);
    ok(
      JSON.stringify(finalA.map((m) => m.text)) === JSON.stringify(finalB.map((m) => m.text)),
      '两个窗口的消息内容与顺序完全一致'
    );

    await A.cdp.shot(path.join(OUT, 's6-2-window-a.png'));
    await B.cdp.shot(path.join(OUT, 's6-2-window-b.png'));
    console.log('  -> 截图 s6-2-window-a.png / s6-2-window-b.png');

    /* ========================================================
     * 场景 3：刷新后历史消息还在
     * ======================================================== */
    section('3. 刷新后历史消息还在');

    await B.cdp.navigate(BASE + '/chat.html', 3200);

    const afterReload = await poll(
      B.cdp,
      READ_MESSAGES,
      '#messages',
      (v) => v && v.some((m) => m.text === msg1),
      { tries: 45, gap: 250 }
    );

    ok(afterReload.hit, '★ 刷新后能看到之前发的消息（从数据库读回）', `(${(afterReload.value || []).length} 条)`);

    const reloadedTexts = ((afterReload.value || []).map((m) => m.text));
    ok(reloadedTexts.includes(msg2), '刷新后 B 自己发的那条也还在');
    ok(reloadedTexts.includes(msg1), '刷新后 A 发的那条也在');

    // 刷新后应该重新连接并在在线列表里
    const onlineAfterReload = await poll(
      B.cdp,
      READ_ONLINE,
      '#onlineList',
      (v) => v && v.includes(alice.username),
      { tries: 30, gap: 400 }
    );
    ok(onlineAfterReload.hit, '刷新重连后在线列表恢复正常', `(${(onlineAfterReload.value || []).join(', ')})`);

    await B.cdp.shot(path.join(OUT, 's6-3-after-reload.png'));
    console.log('  -> 截图 s6-3-after-reload.png');

    /* ========================================================
     * 场景 4：在线用户实时更新 / 多连接去重
     * ======================================================== */
    section('4. 在线用户实时更新与去重');

    // A 那边现在应该仍能看到 B（B 刷新后重连了）
    const aSeesB = await poll(
      A.cdp,
      READ_ONLINE,
      '#onlineList',
      (v) => v && v.includes(bob.username),
      { tries: 30, gap: 400 }
    );
    ok(aSeesB.hit, 'B 刷新重连后，A 的在线列表里仍有 B', `(${(aSeesB.value || []).join(', ')})`);

    // 从 Node 端再起一个 bob 的连接，验证去重
    const { io } = require('socket.io-client');
    const tempSocket = io(BASE, {
      auth: { token: bob.token },
      transports: ['websocket'],
      reconnection: false,
    });

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('临时连接超时')), 6000);
      tempSocket.on('connect', () => {
        clearTimeout(t);
        resolve();
      });
      tempSocket.on('connect_error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });

    await new Promise((resolve) => {
      tempSocket.emit('join_room', { roomId: room1.id }, () => resolve());
    });
    await sleep(900);

    const onlineAfterTemp = await A.cdp.eval(READ_ONLINE, { verifySelector: '#onlineList', attempts: 3 });
    ok(
      onlineAfterTemp.length === 2,
      'bob 多开一个连接时，在线列表仍显示 2 人（按用户去重）',
      `(${onlineAfterTemp.join(', ')})`
    );

    // 关掉临时连接，bob 的浏览器窗口还在，所以列表不变
    tempSocket.close();
    await sleep(1200);
    const onlineAfterClose = await A.cdp.eval(READ_ONLINE, { verifySelector: '#onlineList', attempts: 3 });
    ok(
      onlineAfterClose.includes(bob.username),
      '关掉额外连接后 bob 仍在列表（浏览器窗口还开着）',
      `(${onlineAfterClose.join(', ')})`
    );

    /* ========================================================
     * 场景 5：私聊
     * ======================================================== */
    section('5. 私聊');

    const opened = await clickOnlineUser(A.cdp, bob.username);
    ok(opened && opened.ok, 'A 点击在线用户打开私聊');

    const pmShown = await poll(
      A.cdp,
      `const m = document.getElementById('pmModal');
       return {
         show: m ? m.classList.contains('show') : false,
         title: document.getElementById('pmTitle') ? document.getElementById('pmTitle').textContent : '',
       };`,
      '#pmModal',
      (v) => v && v.show,
      { tries: 25, gap: 250 }
    );
    ok(pmShown.hit, '私聊弹窗打开了');
    ok(pmShown.value && pmShown.value.title === bob.username, '弹窗标题是对方名字', `(${pmShown.value ? pmShown.value.title : ''})`);

    // A 发私聊
    const pmText = 'A 的悄悄话 ' + Date.now();
    const pmSend = await A.cdp.eval(
      `const input = document.getElementById('pmInput');
       if (!input) return { ok: false, error: '找不到私聊输入框' };
       input.value = ${JSON.stringify(pmText)};
       input.dispatchEvent(new Event('input', { bubbles: true }));
       const btn = document.getElementById('pmSendBtn');
       if (!btn) return { ok: false, error: '找不到私聊发送按钮' };
       btn.click();
       return { ok: true };`,
      { verifySelector: '#pmInput', attempts: 5 }
    );
    ok(pmSend && pmSend.ok, 'A 发送私聊消息');

    const pmInA = await poll(
      A.cdp,
      READ_PM,
      '#pmMessages',
      (v) => v && v.some((m) => m.text === pmText),
      { tries: 30, gap: 250 }
    );
    ok(pmInA.hit, 'A 的私聊窗口里显示了自己发出的消息');

    // B 弹窗没开，应该收到提示
    const bNotified = await poll(
      B.cdp,
      `const h = document.getElementById('composerHint'); return h ? h.textContent : '';`,
      '#composerHint',
      (v) => typeof v === 'string' && v.includes(alice.username),
      { tries: 30, gap: 250 }
    );
    ok(bNotified.hit, 'B 收到私聊提示（弹窗未开时提示用户）', bNotified.hit ? `("${bNotified.value}")` : '');

    // B 打开和 A 的私聊
    const openedB = await clickOnlineUser(B.cdp, alice.username);
    ok(openedB && openedB.ok, 'B 打开与 A 的私聊');

    const bSeesPm = await poll(
      B.cdp,
      READ_PM,
      '#pmMessages',
      (v) => v && v.some((m) => m.text === pmText),
      { tries: 35, gap: 250 }
    );
    ok(bSeesPm.hit, '★ B 打开私聊后能看到 A 发来的私聊');

    if (bSeesPm.hit) {
      const m = bSeesPm.value.find((x) => x.text === pmText);
      ok(m.self === false, 'B 那边这条私聊显示为「别人的」');
    }

    // B 回复
    const pmReply = 'B 的回复 ' + Date.now();
    await B.cdp.eval(
      `const input = document.getElementById('pmInput');
       input.value = ${JSON.stringify(pmReply)};
       input.dispatchEvent(new Event('input', { bubbles: true }));
       document.getElementById('pmSendBtn').click();
       return true;`,
      { verifySelector: '#pmInput', attempts: 5 }
    );

    const aGotReply = await poll(
      A.cdp,
      READ_PM,
      '#pmMessages',
      (v) => v && v.some((m) => m.text === pmReply),
      { tries: 35, gap: 250 }
    );
    ok(aGotReply.hit, '★ A 实时收到 B 的私聊回复');

    await A.cdp.shot(path.join(OUT, 's6-4-private-chat.png'));
    console.log('  -> 截图 s6-4-private-chat.png');

    /* ========================================================
     * 场景 6：切换房间
     * ======================================================== */
    section('6. 切换房间');

    // 关掉私聊弹窗
    await A.cdp.eval(`const b = document.getElementById('pmClose'); if (b) b.click(); return true;`, {
      verifySelector: '#pmClose',
      attempts: 3,
    });
    await sleep(400);

    const switched = await A.cdp.eval(
      `const items = Array.from(document.querySelectorAll('#roomList .room-item'));
       if (items.length < 2) return { ok: false, error: '房间不够' };
       items[1].click();
       return { ok: true, target: items[1].textContent };`,
      { verifySelector: '#roomList', attempts: 8 }
    );
    ok(switched && switched.ok, 'A 点击切换到第二个房间', `(${switched.target})`);

    const roomChanged = await poll(
      A.cdp,
      `const items = Array.from(document.querySelectorAll('#roomList .room-item'));
       const active = items.find(function (n) { return n.classList.contains('active'); });
       return {
         name: document.getElementById('roomName').textContent,
         activeText: active ? active.textContent : '',
       };`,
      '#roomName',
      (v) => v && v.name !== room1.name,
      { tries: 25, gap: 300 }
    );
    ok(roomChanged.hit, '房间标题已更新', `(→ #${roomChanged.value ? roomChanged.value.name : '?'})`);

    // 新房间看不到旧房间的消息
    await sleep(900);
    const newRoomMsgs = await A.cdp.eval(READ_MESSAGES, { verifySelector: '#messages', attempts: 3 });
    ok(
      !newRoomMsgs.some((m) => m.text === msg1),
      '切换后看不到旧房间的消息（房间隔离）',
      `(新房间 ${newRoomMsgs.length} 条)`
    );

    // A 在新房间，在线列表只剩自己
    const newRoomOnline = await poll(
      A.cdp,
      READ_ONLINE,
      '#onlineList',
      (v) => v && v.length === 1 && v[0] === alice.username,
      { tries: 25, gap: 300 }
    );
    ok(newRoomOnline.hit, '新房间的在线列表只有 A 自己', `(${(newRoomOnline.value || []).join(', ')})`);

    // B 在旧房间，应该看到 A 离开了
    const bSeesLeave = await poll(
      B.cdp,
      READ_ONLINE,
      '#onlineList',
      (v) => v && v.length === 1 && v[0] === bob.username,
      { tries: 25, gap: 300 }
    );
    ok(
      bSeesLeave.hit,
      '★ A 切走后 B 的在线列表实时变成只剩自己',
      `(${(bSeesLeave.value || []).join(', ')})`
    );

    await A.cdp.shot(path.join(OUT, 's6-5-switch-room.png'));
    console.log('  -> 截图 s6-5-switch-room.png');

    /* ========================================================
     * 场景 7：XSS 防护
     * ======================================================== */
    section('7. XSS 防护（前端渲染）');

    // A 切回 room1，这样 B 能收到
    await A.cdp.eval(
      `const items = Array.from(document.querySelectorAll('#roomList .room-item'));
       if (items[0]) items[0].click();
       return true;`,
      { verifySelector: '#roomList', attempts: 5 }
    );
    await sleep(1200);

    const xssPayload =
      '<img src=x onerror="window.__xssFired=true"><script>window.__xssFired2=true</script>';

    await B.cdp.eval(SEND_FROM_PAGE(xssPayload), { verifySelector: '#sendBtn', attempts: 5 });

    // 等 A 收到并渲染
    const rendered = await poll(
      A.cdp,
      READ_MESSAGES,
      '#messages',
      (v) => v && v.some((m) => m.text.includes('onerror')),
      { tries: 40, gap: 250 }
    );
    ok(rendered.hit, '含 HTML 的消息能正常渲染出来');

    if (rendered.hit) {
      const m = rendered.value.find((x) => x.text.includes('onerror'));
      ok(m.text === xssPayload, '内容以纯文本显示（标签没被解析成 HTML）');
    }

    // 关键：页面里不能真的生成 img/script 元素
    const xssCheck = await A.cdp.eval(
      `const bubbles = document.querySelectorAll('#messages .msg-bubble');
       let imgs = 0, scripts = 0;
       bubbles.forEach(function (b) {
         imgs += b.querySelectorAll('img').length;
         scripts += b.querySelectorAll('script').length;
       });
       return {
         injectedImgs: imgs,
         injectedScripts: scripts,
         xssFired: window.__xssFired === true,
         xssFired2: window.__xssFired2 === true,
       };`,
      { verifySelector: '#messages', attempts: 3 }
    );

    ok(xssCheck.injectedImgs === 0, '消息里没有生成真实的 <img> 元素');
    ok(xssCheck.injectedScripts === 0, '消息里没有生成真实的 <script> 元素');
    ok(xssCheck.xssFired === false, 'onerror 没有被执行');
    ok(xssCheck.xssFired2 === false, '内联 script 没有被执行');
    console.log(
      `  （注入检查: img=${xssCheck.injectedImgs} script=${xssCheck.injectedScripts} 触发=${xssCheck.xssFired || xssCheck.xssFired2}）`
    );

    /* ========================================================
     * 场景 8：Enter 发送 / Shift+Enter 换行
     * ======================================================== */
    section('8. 键盘操作');

    // 测试 Shift+Enter 应该换行不发送
    const beforeCount = (await A.cdp.eval(READ_MESSAGES, { verifySelector: '#messages', attempts: 3 })).length;

    await A.cdp.eval(
      `const input = document.getElementById('messageInput');
       input.focus();
       input.value = '第一行';
       input.dispatchEvent(new Event('input', { bubbles: true }));
       // 模拟 Shift+Enter
       const ev = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
       input.dispatchEvent(ev);
       return { value: input.value };`,
      { verifySelector: '#messageInput', attempts: 3 }
    );

    await sleep(600);
    const afterShiftEnter = (await A.cdp.eval(READ_MESSAGES, { verifySelector: '#messages', attempts: 3 })).length;
    ok(afterShiftEnter === beforeCount, 'Shift+Enter 不会发送消息（留给换行用）');

    // 清空输入框
    await A.cdp.eval(
      `const input = document.getElementById('messageInput');
       input.value = '';
       input.dispatchEvent(new Event('input', { bubbles: true }));
       return true;`,
      { verifySelector: '#messageInput', attempts: 3 }
    );

    // 测正常 Enter 应该发送
    const enterText = 'Enter 键发送测试 ' + Date.now();
    await A.cdp.eval(
      `const input = document.getElementById('messageInput');
       input.focus();
       input.value = ${JSON.stringify(enterText)};
       input.dispatchEvent(new Event('input', { bubbles: true }));
       const ev = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false, bubbles: true, cancelable: true });
       input.dispatchEvent(ev);
       return true;`,
      { verifySelector: '#messageInput', attempts: 3 }
    );

    const enterSent = await poll(
      A.cdp,
      READ_MESSAGES,
      '#messages',
      (v) => v && v.some((m) => m.text === enterText),
      { tries: 25, gap: 250 }
    );
    ok(enterSent.hit, 'Enter 键能发送消息');

    /* ========================================================
     * 场景 9：空消息不发送
     * ======================================================== */
    section('9. 空消息拦截');

    const countBeforeEmpty = (await A.cdp.eval(READ_MESSAGES, { verifySelector: '#messages', attempts: 3 }))
      .length;

    await A.cdp.eval(
      `const input = document.getElementById('messageInput');
       input.value = '    ';
       input.dispatchEvent(new Event('input', { bubbles: true }));
       document.getElementById('sendBtn').click();
       return true;`,
      { verifySelector: '#sendBtn', attempts: 3 }
    );
    await sleep(800);

    const countAfterEmpty = (await A.cdp.eval(READ_MESSAGES, { verifySelector: '#messages', attempts: 3 }))
      .length;
    ok(countAfterEmpty === countBeforeEmpty, '纯空格消息不会被发送');

    const hintText = await A.cdp.eval(
      `const h = document.getElementById('composerHint'); return h ? h.textContent : '';`,
      { verifySelector: '#composerHint', attempts: 3 }
    );
    ok(/不能为空/.test(hintText), '给出了「不能为空」的提示', `("${hintText}")`);

    // 清空
    await A.cdp.eval(
      `const input = document.getElementById('messageInput');
       input.value = '';
       input.dispatchEvent(new Event('input', { bubbles: true }));
       return true;`,
      { verifySelector: '#messageInput', attempts: 3 }
    );
  } finally {
    /* ---------- 无论成败都要关掉两个浏览器 ---------- */
    await A.close();
    await B.close();
    console.log('\n两个浏览器实例已关闭');
  }

  /* ==========================================================
   * 场景 10：移动端布局（单独起一个浏览器，用手机视口）
   * ========================================================== */
  section('10. 移动端布局');

  await withEdge(
    async (cdp) => {
      await cdp.setViewport(390, 844, true);
      await cdp.navigate(BASE + '/login.html', 1000);
      await cdp.eval(
        `localStorage.setItem('token', ${JSON.stringify(alice.token)});
         localStorage.setItem('user', ${JSON.stringify(JSON.stringify(alice.user))});
         return true;`,
        { verifySelector: '#loginForm', attempts: 10 }
      );
      await cdp.navigate(BASE + '/chat.html', 3200);

      await poll(cdp, READ_CONN, '#connStatus', (v) => v && v.offline === false, {
        tries: 25,
        gap: 400,
      });

      const layout = await cdp.eval(
        `const sidebar = document.getElementById('sidebar');
         const toggle = document.getElementById('sidebarToggle');
         const input = document.getElementById('messageInput');
         const cs = getComputedStyle(input);

         return {
           viewportW: window.innerWidth,
           sidebarPosition: sidebar ? getComputedStyle(sidebar).position : '',
           toggleVisible: toggle ? getComputedStyle(toggle).display : '',
           inputFontSize: cs.fontSize,
           bodyScrollW: document.body.scrollWidth,
         };`,
        { verifySelector: '#messageInput', attempts: 20 }
      );

      ok(layout.viewportW === 390, '视口宽 390', `(${layout.viewportW})`);
      ok(layout.toggleVisible === 'flex', '汉堡菜单按钮显示了（移动端专属）');
      ok(layout.sidebarPosition === 'fixed', '房间列表变成了抽屉（position: fixed）');
      ok(
        parseFloat(layout.inputFontSize) >= 16,
        '输入框字号 >= 16px（防止 iOS 自动缩放）',
        `(${layout.inputFontSize})`
      );
      ok(layout.bodyScrollW <= 390, '没有横向溢出', `(scrollWidth=${layout.bodyScrollW})`);

      // 打开抽屉
      await cdp.eval(`document.getElementById('sidebarToggle').click(); return true;`, {
        verifySelector: '#sidebarToggle',
        attempts: 3,
      });
      await sleep(700);

      const drawerOpen = await cdp.eval(
        `const sidebar = document.getElementById('sidebar');
         const mask = document.getElementById('drawerMask');
         return {
           open: sidebar ? sidebar.classList.contains('open') : false,
           maskShown: mask ? mask.classList.contains('show') : false,
         };`,
        { verifySelector: '#sidebar', attempts: 3 }
      );
      ok(drawerOpen.open, '点汉堡按钮能把房间抽屉拉出来');
      ok(drawerOpen.maskShown, '抽屉打开时遮罩也显示了');

      await cdp.shot(path.join(OUT, 's6-6-mobile-drawer.png'));
      console.log('  -> 截图 s6-6-mobile-drawer.png');

      // 点遮罩关闭
      await cdp.eval(`document.getElementById('drawerMask').click(); return true;`, {
        verifySelector: '#drawerMask',
        attempts: 3,
      });
      await sleep(600);

      const drawerClosed = await cdp.eval(
        `const sidebar = document.getElementById('sidebar');
         return sidebar ? !sidebar.classList.contains('open') : false;`,
        { verifySelector: '#sidebar', attempts: 3 }
      );
      ok(drawerClosed, '点遮罩能关掉抽屉');

      // 移动端聊天气泡宽度
      const bubbleWidth = await cdp.eval(
        `const msgs = document.querySelectorAll('#messages .msg');
         if (msgs.length === 0) return { count: 0 };
         const w = msgs[0].getBoundingClientRect().width;
         return { count: msgs.length, width: Math.round(w), ratio: +(w / 390).toFixed(2) };`,
        { verifySelector: '#messages', attempts: 3 }
      );
      if (bubbleWidth.count > 0) {
        ok(bubbleWidth.ratio <= 0.95, '消息气泡宽度适配移动端（不超过屏宽 95%）', `(${bubbleWidth.width}px, ${bubbleWidth.ratio * 100}%)`);
      }
    },
    null,
    { port: 9313, bootWait: 1000 }
  );

  /* ==========================================================
   * 场景 11：未登录访问 chat.html 会被踢走
   * ========================================================== */
  section('11. 未登录访问保护');

  await withEdge(
    async (cdp) => {
      await cdp.navigate(BASE + '/login.html', 1000);
      await cdp.eval(`localStorage.clear(); return true;`, {
        verifySelector: '#loginForm',
        attempts: 10,
      });

      await cdp.navigate(BASE + '/chat.html', 2500);

      const redirected = await poll(
        cdp,
        `return location.pathname;`,
        null,
        (v) => typeof v === 'string' && v.includes('login'),
        { tries: 25, gap: 300 }
      );

      ok(redirected.hit, '未登录访问 /chat.html 被跳转到登录页', `(${redirected.value})`);
    },
    null,
    { port: 9314, bootWait: 1000 }
  );

  /* ==========================================================
   * 汇总
   * ========================================================== */
  console.log('\n' + '='.repeat(58));
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log('='.repeat(58));

  // 清理测试数据。
  // 注意路径：本脚本在 .verify/ 目录下，test-cleanup.js 在项目根目录，
  // 所以是 '../test-cleanup'。用 __dirname 拼绝对路径，
  // 这样不管从哪个目录启动脚本都能正确 require 到。
  if (process.env.KEEP_TEST_DATA !== '1') {
    try {
      const cleanupPath = path.join(__dirname, '..', 'test-cleanup.js');
      const { cleanupTestData } = require(cleanupPath);
      const n = cleanupTestData();
      console.log(`  （已清理 ${n} 个测试账号及其消息）`);
    } catch (err) {
      console.log('  （清理跳过：' + err.message + '）');
    }
  }

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n验证脚本异常终止:', err);
  process.exit(1);
});
