/* ============================================================
 * chat.js —— 聊天页逻辑
 *
 * 职责划分（很重要，别搞混）：
 *   REST（api.js）  → 拉数据：房间列表、历史消息、私聊记录
 *   Socket          → 收实时：新消息、在线用户变化
 *
 * 所以你会看到两种"发消息"的路径：
 *   - 拉历史：API.getMessages(roomId)
 *   - 发消息：socket.emit('send_message', ...)
 * 这是刻意设计的，理由见 design.md 第 5 节。
 *
 * ============================================================
 * ⚠️ 安全铁律：渲染用户内容一律用 textContent
 * ============================================================
 * 用户发的消息可能包含 <script>alert(1)</script> 这种内容。
 * 如果用 innerHTML 渲染，这段脚本就会在**每个看到这条消息的人**的浏览器里执行
 * ——这就是存储型 XSS，是聊天类应用最典型的漏洞。
 *
 * textContent 会把内容当纯文本对待，标签只是普通字符，不会被解析执行。
 * 本文件里所有渲染用户输入的地方都是 textContent，一处例外都没有。
 * ============================================================ */

(function () {
  'use strict';

  /* ==========================================================
   * 一、DOM 引用
   *
   * 统一在这里取一次，避免散落在各处 getElementById
   * （既慢又容易打错 id）。
   * ========================================================== */

  const $ = (id) => document.getElementById(id);

  const el = {
    // 顶栏
    connStatus: $('connStatus'),
    connText: $('connText'),
    myAvatar: $('myAvatar'),
    myName: $('myName'),
    logoutBtn: $('logoutBtn'),
    sidebarToggle: $('sidebarToggle'),
    onlineToggle: $('onlineToggle'),

    // 房间
    sidebar: $('sidebar'),
    roomList: $('roomList'),
    roomName: $('roomName'),
    roomCount: $('roomCount'),

    // 消息
    messages: $('messages'),
    messageInput: $('messageInput'),
    sendBtn: $('sendBtn'),
    composerHint: $('composerHint'),

    // 在线用户
    onlinePanel: $('onlinePanel'),
    onlineList: $('onlineList'),
    onlineCount: $('onlineCount'),
    drawerMask: $('drawerMask'),

    // 私聊弹窗
    pmModal: $('pmModal'),
    pmClose: $('pmClose'),
    pmAvatar: $('pmAvatar'),
    pmTitle: $('pmTitle'),
    pmMessages: $('pmMessages'),
    pmInput: $('pmInput'),
    pmSendBtn: $('pmSendBtn'),
    pmHint: $('pmHint'),
  };

  /* ==========================================================
   * 二、全局状态
   * ========================================================== */

  const state = {
    me: null,             // 当前登录用户 { id, username, avatar }
    rooms: [],            // 房间列表
    currentRoomId: null,  // 当前所在房间
    onlineUsers: [],      // 当前房间在线用户
    socket: null,         // socket 实例
    connected: false,

    // 私聊相关
    pm: {
      open: false,
      userId: null,       // 正在和谁聊
      username: '',
      avatar: null,
    },
  };

  /* ==========================================================
   * 三、工具函数
   * ========================================================== */

  /**
   * 生成头像文字（用户名第一个字符）
   *
   * 为什么要 slice(0, 1) 而不是 charAt(0)？
   *   对于 emoji 和部分汉字，charAt 可能会截断到半个字符（代理对问题）。
   *   用 Array.from 按"字符"而不是"码元"来取，才是安全的做法。
   */
  function avatarText(username) {
    if (!username) return '?';
    return Array.from(username)[0].toUpperCase();
  }

  /**
   * 把 ISO 时间格式化成「HH:MM」
   * 只显示时分，聊天场景够用了。今天的消息不显示日期。
   */
  function formatTime(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';

      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');

      // 不是今天就带上日期，避免"昨天 14:30"看起来像今天的
      const today = new Date();
      const isToday =
        d.getFullYear() === today.getFullYear() &&
        d.getMonth() === today.getMonth() &&
        d.getDate() === today.getDate();

      if (isToday) return `${hh}:${mm}`;
      return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
    } catch {
      return '';
    }
  }

  /**
   * 根据用户名生成一个稳定的颜色（用于头像底色）
   *
   * 思路：把用户名所有字符的编码加起来取模，映射到色相环上。
   * 这样同一个人每次进来颜色都一样，不同人颜色不同，很好认。
   */
  function avatarColor(username) {
    const palette = [
      '#4f6ef7', '#7c5cf7', '#d946a0', '#e0574f',
      '#e08b2f', '#2fa06a', '#2f8fb5', '#6b7280',
    ];
    if (!username) return palette[0];

    let sum = 0;
    for (const ch of username) sum += ch.codePointAt(0);
    return palette[sum % palette.length];
  }

  /** 滚动消息区到底部 */
  function scrollToBottom(container) {
    // 用 requestAnimationFrame 等一帧，确保新元素已经完成布局，
    // 否则 scrollHeight 算的还是旧值，会滚不到真正底部
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }

  /** 判断滚动条是否已经贴着底部（差 60px 以内都算） */
  function isAtBottom(container) {
    return container.scrollHeight - container.scrollTop - container.clientHeight < 60;
  }

  /** 设置输入框下方的提示文字 */
  function setHint(node, text, isWarn = false) {
    node.textContent = text || '';
    node.classList.toggle('warn', !!isWarn);
  }

  /**
   * 让 textarea 高度随内容自动增长
   *
   * 原理：先把高度重置为 auto，这样 scrollHeight 才会等于"真实内容高度"；
   * 如果直接读 scrollHeight，它只会越来越大（因为元素高度还撑着）。
   * 上限 120px 在 CSS 里用 max-height 控制，这里只管设置。
   */
  function autoGrow(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  }

  /* ==========================================================
   * 四、渲染：房间列表
   * ========================================================== */

  function renderRooms() {
    el.roomList.textContent = '';

    if (state.rooms.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '暂无房间';
      el.roomList.appendChild(empty);
      return;
    }

    for (const room of state.rooms) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'room-item' + (room.id === state.currentRoomId ? ' active' : '');
      btn.dataset.roomId = room.id;

      const hash = document.createElement('span');
      hash.className = 'hash';
      hash.textContent = '#';

      const name = document.createElement('span');
      name.className = 'name';
      // 房间名来自数据库，理论上可控，但仍然用 textContent 保持一致习惯
      name.textContent = room.name;

      btn.appendChild(hash);
      btn.appendChild(name);

      btn.addEventListener('click', () => switchRoom(room.id));
      el.roomList.appendChild(btn);
    }
  }

  /** 只更新选中态，不重建整个列表（切换房间时更流畅） */
  function updateRoomActive() {
    for (const btn of el.roomList.querySelectorAll('.room-item')) {
      const id = Number(btn.dataset.roomId);
      btn.classList.toggle('active', id === state.currentRoomId);
    }
  }

  /* ==========================================================
   * 五、渲染：消息
   * ========================================================== */

  /**
   * 创建一条消息的 DOM 节点
   *
   * @param {{id:number, content:string, createdAt:string, sender:object}} msg
   * @param {boolean} isSelf 是不是自己发的（决定靠左还是靠右）
   */
  function createMessageNode(msg, isSelf) {
    const wrap = document.createElement('div');
    wrap.className = 'msg' + (isSelf ? ' self' : '');
    // 记下消息 id，去重时要用
    wrap.dataset.msgId = msg.id;

    // ---- 头像 ----
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = avatarText(msg.sender.username);
    avatar.style.background = avatarColor(msg.sender.username);
    // 头像本身不是必须的信息，读屏软件跳过它，避免重复念用户名
    avatar.setAttribute('aria-hidden', 'true');

    // ---- 右侧内容区 ----
    const body = document.createElement('div');
    body.className = 'msg-body';

    const meta = document.createElement('div');
    meta.className = 'msg-meta';

    const name = document.createElement('span');
    name.className = 'msg-name';
    name.textContent = msg.sender.username;

    const time = document.createElement('span');
    time.textContent = formatTime(msg.createdAt);

    meta.appendChild(name);
    meta.appendChild(time);

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    // ★ 关键：textContent，不是 innerHTML
    bubble.textContent = msg.content;

    body.appendChild(meta);
    body.appendChild(bubble);

    wrap.appendChild(avatar);
    wrap.appendChild(body);

    return wrap;
  }

  /** 创建一条系统提示消息（居中灰字） */
  function createSystemNode(text) {
    const div = document.createElement('div');
    div.className = 'msg-system';
    div.textContent = text;
    return div;
  }

  /** 清空消息区并显示空状态 */
  function showEmptyMessages(text) {
    el.messages.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.id = 'messagesEmpty';

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = '💬';

    empty.appendChild(icon);
    empty.appendChild(document.createTextNode(text || '还没有消息，说点什么吧'));
    el.messages.appendChild(empty);
  }

  /**
   * 追加一条消息到消息区
   * @returns {boolean} 是否真的插入了（重复消息会跳过）
   */
  function appendMessage(msg) {
    // 去重：同一条消息可能同时通过 ack 回调和 socket 广播到达。
    // 靠 data-msg-id 判断，已经渲染过的就跳过。
    if (el.messages.querySelector(`[data-msg-id="${msg.id}"]`)) {
      return false;
    }

    // 如果当前只有"空状态"占位，先清掉
    const empty = el.messages.querySelector('.empty-state');
    if (empty) empty.remove();

    const isSelf = state.me && msg.sender.id === state.me.id;
    const node = createMessageNode(msg, isSelf);

    // 判断插入前是不是已经在底部，决定要不要自动滚下去
    const stick = isAtBottom(el.messages);

    el.messages.appendChild(node);

    // 只有原本就在底部才自动滚动 —— 如果用户正在往上翻历史记录，
    // 突然被拽到底部会非常烦人。
    if (stick) scrollToBottom(el.messages);

    return true;
  }

  /* ==========================================================
   * 六、渲染：在线用户
   * ========================================================== */

  function renderOnlineUsers(users) {
    state.onlineUsers = users;
    el.onlineList.textContent = '';
    el.onlineCount.textContent = users.length ? `(${users.length})` : '';

    if (users.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.style.padding = '20px 0';
      empty.style.fontSize = '12px';
      empty.textContent = '这个房间还没人';
      el.onlineList.appendChild(empty);
      return;
    }

    for (const user of users) {
      const isMe = state.me && user.id === state.me.id;

      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'online-user';

      // 头像 + 在线小绿点
      const wrap = document.createElement('div');
      wrap.className = 'avatar-wrap';

      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = avatarText(user.username);
      avatar.style.background = avatarColor(user.username);

      const dot = document.createElement('span');
      dot.className = 'dot';

      wrap.appendChild(avatar);
      wrap.appendChild(dot);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = user.username;

      item.appendChild(wrap);
      item.appendChild(name);

      if (isMe) {
        const tag = document.createElement('span');
        tag.className = 'self-tag';
        tag.textContent = '我';
        item.appendChild(tag);
        // 自己不能和自己私聊，所以不绑点击事件
      } else {
        // 点头像 → 打开私聊弹窗
        item.addEventListener('click', () => openPrivateChat(user));
      }

      el.onlineList.appendChild(item);
    }
  }

  /* ==========================================================
   * 七、连接状态提示
   * ========================================================== */

  function setConnection(connected, text) {
    state.connected = connected;
    el.connStatus.classList.toggle('offline', !connected);
    el.connText.textContent = text || (connected ? '已连接' : '未连接');
  }

  /* ==========================================================
   * 八、房间切换
   * ========================================================== */

  async function switchRoom(roomId) {
    if (roomId === state.currentRoomId) return;

    const room = state.rooms.find((r) => r.id === roomId);
    if (!room) return;

    const prevRoomId = state.currentRoomId;
    state.currentRoomId = roomId;

    // 立即更新 UI（乐观更新），不用等服务端 ack
    el.roomName.textContent = room.name;
    updateRoomActive();
    closeDrawers();

    // 清空消息区，显示加载中
    showEmptyMessages('正在加载历史消息…');

    // 通知服务端切换房间
    if (state.socket && state.connected) {
      state.socket.emit('join_room', { roomId }, (res) => {
        if (res && res.ok === false) {
          setHint(el.composerHint, res.error || '切换房间失败', true);
          // 失败了就退回原来的房间，别让界面和服务端状态不一致
          if (prevRoomId != null) {
            state.currentRoomId = prevRoomId;
            const prev = state.rooms.find((r) => r.id === prevRoomId);
            if (prev) {
              el.roomName.textContent = prev.name;
              updateRoomActive();
            }
          }
        }
      });
    }

    // 拉这个房间的历史消息（REST）
    try {
      const messages = await API.getMessages(roomId, { limit: 50 });

      el.messages.textContent = '';

      if (messages.length === 0) {
        showEmptyMessages('还没有消息，说点什么吧');
      } else {
        const frag = document.createDocumentFragment();
        for (const msg of messages) {
          const isSelf = state.me && msg.sender.id === state.me.id;
          frag.appendChild(createMessageNode(msg, isSelf));
        }
        el.messages.appendChild(frag);
        scrollToBottom(el.messages);
      }
    } catch (err) {
      showEmptyMessages('历史消息加载失败：' + err.message);
    }
  }

  /* ==========================================================
   * 九、发送公共消息
   * ========================================================== */

  function sendMessage() {
    if (!state.socket || !state.connected) {
      setHint(el.composerHint, '还没连上服务器，请稍候', true);
      return;
    }

    const content = el.messageInput.value.trim();

    if (!content) {
      setHint(el.composerHint, '消息不能为空', true);
      return;
    }

    if (!state.currentRoomId) {
      setHint(el.composerHint, '请先选择一个房间', true);
      return;
    }

    // 发送时禁用按钮，防止连点发出多条
    el.sendBtn.disabled = true;

    state.socket.emit(
      'send_message',
      { roomId: state.currentRoomId, content },
      (res) => {
        el.sendBtn.disabled = false;

        if (res && res.ok) {
          // 成功：清空输入框、恢复高度
          // 注意这里**不需要**手动往列表里插消息 ——
          // 服务端会广播 new_message 给房间所有人（包括自己），
          // 由那个事件统一渲染，多个标签页才能保持一致。
          el.messageInput.value = '';
          autoGrow(el.messageInput);
          updateCharCount();
          setHint(el.composerHint, '');
          el.messageInput.focus();
        } else {
          setHint(el.composerHint, (res && res.error) || '发送失败，请重试', true);
        }
      }
    );
  }

  /* ==========================================================
   * 十、私聊
   * ========================================================== */

  /** 创建私聊消息节点（复用公共消息的样式，只是判断 isSelf 的方式不同） */
  function createPrivateNode(msg) {
    return createMessageNode(msg, state.me && msg.sender.id === state.me.id);
  }

  /** 打开私聊弹窗 */
  async function openPrivateChat(user) {
    state.pm.open = true;
    state.pm.userId = user.id;
    state.pm.username = user.username;
    state.pm.avatar = user.avatar;

    el.pmTitle.textContent = user.username;
    el.pmAvatar.textContent = avatarText(user.username);
    el.pmAvatar.style.background = avatarColor(user.username);

    // 弹窗里的消息清空，显示加载中
    el.pmMessages.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'empty-state';
    loading.textContent = '正在加载聊天记录…';
    el.pmMessages.appendChild(loading);

    el.pmModal.classList.add('show');

    // 拉历史私聊记录
    try {
      const data = await API.getPrivateMessages(user.id, { limit: 50 });
      const messages = data.messages || [];

      el.pmMessages.textContent = '';

      if (messages.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        const icon = document.createElement('span');
        icon.className = 'icon';
        icon.textContent = '✉️';
        empty.appendChild(icon);
        empty.appendChild(document.createTextNode(`还没有和 ${user.username} 的聊天记录`));
        el.pmMessages.appendChild(empty);
      } else {
        const frag = document.createDocumentFragment();
        for (const msg of messages) frag.appendChild(createPrivateNode(msg));
        el.pmMessages.appendChild(frag);
        scrollToBottom(el.pmMessages);
      }
    } catch (err) {
      el.pmMessages.textContent = '';
      const errBox = document.createElement('div');
      errBox.className = 'empty-state';
      errBox.textContent = '加载失败：' + err.message;
      el.pmMessages.appendChild(errBox);
    }

    // 输入框聚焦。移动端自动聚焦会顶起键盘，这里只在桌面端做。
    if (window.innerWidth > 768) {
      el.pmInput.focus();
    }
  }

  /** 关闭私聊弹窗 */
  function closePrivateChat() {
    state.pm.open = false;
    state.pm.userId = null;
    el.pmModal.classList.remove('show');
    setHint(el.pmHint, '');
  }

  /** 追加一条私聊消息（只在弹窗开着、且是当前对话对象时渲染） */
  function appendPrivateMessage(msg) {
    // 判断这条消息是否属于当前打开的对话
    const isCurrentConversation =
      state.pm.open &&
      state.pm.userId != null &&
      ((msg.sender.id === state.pm.userId && msg.receiver.id === state.me.id) ||
        (msg.sender.id === state.me.id && msg.receiver.id === state.pm.userId));

    if (!isCurrentConversation) {
      // 不是当前对话 —— 弹窗里不显示，但给个提示告诉用户"有人给你发消息了"。
      // 第 9 阶段可以升级成未读小红点。
      if (msg.sender.id !== state.me.id) {
        setHint(el.composerHint, `💬 ${msg.sender.username} 给你发了私聊，点右侧在线列表查看`, false);
      }
      return;
    }

    const empty = el.pmMessages.querySelector('.empty-state');
    if (empty) empty.remove();

    const stick = isAtBottom(el.pmMessages);
    el.pmMessages.appendChild(createPrivateNode(msg));
    if (stick) scrollToBottom(el.pmMessages);
  }

  /** 发送私聊 */
  function sendPrivateMessage() {
    if (!state.socket || !state.connected) {
      setHint(el.pmHint, '还没连上服务器，请稍候', true);
      return;
    }

    const toUserId = state.pm.userId;
    if (!toUserId) return;

    const content = el.pmInput.value.trim();
    if (!content) {
      setHint(el.pmHint, '消息不能为空', true);
      return;
    }

    el.pmSendBtn.disabled = true;

    state.socket.emit('private_message', { toUserId, content }, (res) => {
      el.pmSendBtn.disabled = false;

      if (res && res.ok) {
        // 和公共消息一样：发送方当前窗口靠 ack 渲染，
        // 因为服务端推送时明确排除了发起这次请求的 socket（避免重复）
        if (res.data) appendPrivateMessage(res.data);

        el.pmInput.value = '';
        autoGrow(el.pmInput);

        // 对方不在线时给个提示，用户心里有数
        if (res.delivered === false) {
          setHint(el.pmHint, '对方当前不在线，消息已保存', false);
        } else {
          setHint(el.pmHint, '');
        }

        el.pmInput.focus();
      } else {
        setHint(el.pmHint, (res && res.error) || '发送失败，请重试', true);
      }
    });
  }

  /* ==========================================================
   * 十一、字符计数
   * ========================================================== */

  const MAX_LEN = 2000;

  function updateCharCount() {
    const len = el.messageInput.value.length;
    // 快到上限（剩 100 字）才提醒，平时不显示，免得干扰
    if (len > MAX_LEN - 100) {
      setHint(el.composerHint, `${len} / ${MAX_LEN}`, len >= MAX_LEN);
    } else if (!el.composerHint.textContent || /^\d+ \/ \d+$/.test(el.composerHint.textContent)) {
      setHint(el.composerHint, '');
    }
  }

  /* ==========================================================
   * 十二、移动端抽屉
   * ========================================================== */

  function closeDrawers() {
    el.sidebar.classList.remove('open');
    el.onlinePanel.classList.remove('open');
    el.drawerMask.classList.remove('show');
  }

  function toggleDrawer(which) {
    const target = which === 'sidebar' ? el.sidebar : el.onlinePanel;
    const other = which === 'sidebar' ? el.onlinePanel : el.sidebar;

    const willOpen = !target.classList.contains('open');

    other.classList.remove('open');
    target.classList.toggle('open', willOpen);
    el.drawerMask.classList.toggle('show', willOpen);
  }

  /* ==========================================================
   * 十三、Socket 连接
   * ========================================================== */

  function connectSocket() {
    const token = API.getToken();

    if (!token) {
      API.redirectToLogin();
      return;
    }

    // token 通过 auth 字段传，不放 query（query 会进服务器日志和浏览器历史）
    const socket = io({
      auth: { token },
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    state.socket = socket;

    /* ---------- 连接成功 ---------- */
    socket.on('connect', () => {
      setConnection(true, '已连接');

      // ⚠️ 重连成功后必须重新 join_room！
      // 服务端内存里的房间成员表已经把这个连接清掉了（因为是新 socket.id），
      // 不重新加入的话，会收不到任何消息。
      if (state.currentRoomId != null) {
        socket.emit('join_room', { roomId: state.currentRoomId });
      } else if (state.rooms.length > 0) {
        // 首次连接：进入第一个房间
        switchRoom(state.rooms[0].id);
      }
    });

    /* ---------- 连接断开 ---------- */
    socket.on('disconnect', (reason) => {
      setConnection(false, '连接已断开，重连中…');
      console.warn('[socket] 断开:', reason);
    });

    /* ---------- 连接失败 ---------- */
    socket.on('connect_error', (err) => {
      const msg = err && err.message ? err.message : '连接失败';

      // token 过期/无效 → 清登录态并踢回登录页
      if (/登录已过期|登录状态无效|未登录/.test(msg)) {
        setConnection(false, '登录已失效');
        API.clearAuth();
        setTimeout(() => API.redirectToLogin(), 800);
        return;
      }

      setConnection(false, '连接失败，重连中…');
    });

    /* ---------- 在线用户变化 ---------- */
    socket.on('online_users', (payload) => {
      // 只处理当前房间的（服务端切房间时也会广播旧房间，但那是发给旧房间的人的）
      if (payload.roomId !== state.currentRoomId) return;
      renderOnlineUsers(payload.users || []);
    });

    /* ---------- 新公共消息 ---------- */
    socket.on('new_message', (msg) => {
      if (msg.roomId !== state.currentRoomId) return;
      appendMessage(msg);
    });

    /* ---------- 新私聊消息 ---------- */
    socket.on('new_private_message', (msg) => {
      // 服务端只推给收发双方，所以这里不用再判断权限，直接渲染
      appendPrivateMessage(msg);
    });

    /* ---------- 服务端统一错误 ---------- */
    socket.on('error', (payload) => {
      console.error('[socket error]', payload);
      const text = (payload && payload.message) || '发生错误';
      setHint(el.composerHint, text, true);
      if (state.pm.open) setHint(el.pmHint, text, true);
    });
  }

  /* ==========================================================
   * 十四、事件绑定
   * ========================================================== */

  function bindEvents() {
    /* ---------- 发送消息 ---------- */
    el.sendBtn.addEventListener('click', sendMessage);

    el.messageInput.addEventListener('keydown', (e) => {
      // Enter 发送，Shift+Enter 换行。
      // 这是聊天软件的通行约定，一定要支持 Shift+Enter，
      // 否则用户没法输入多行消息。
      if (e.key === 'Enter' && !e.shiftKey) {
        // 中文输入法正在选字时，Enter 是"确认候选词"的意思，
        // 不应该触发发送。isComposing 就是判断这个的。
        if (e.isComposing) return;

        e.preventDefault();
        sendMessage();
      }
    });

    el.messageInput.addEventListener('input', () => {
      autoGrow(el.messageInput);
      updateCharCount();
    });

    /* ---------- 私聊 ---------- */
    el.pmSendBtn.addEventListener('click', sendPrivateMessage);

    el.pmInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        if (e.isComposing) return;
        e.preventDefault();
        sendPrivateMessage();
      }
    });

    el.pmInput.addEventListener('input', () => autoGrow(el.pmInput));

    el.pmClose.addEventListener('click', closePrivateChat);

    // 点遮罩关闭
    el.pmModal.addEventListener('click', (e) => {
      if (e.target === el.pmModal) closePrivateChat();
    });

    // Esc 关闭弹窗
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.pm.open) closePrivateChat();
    });

    /* ---------- 移动端抽屉 ---------- */
    el.sidebarToggle.addEventListener('click', () => toggleDrawer('sidebar'));
    el.onlineToggle.addEventListener('click', () => toggleDrawer('online'));
    el.drawerMask.addEventListener('click', closeDrawers);

    // 点了房间列表里的房间就自动关抽屉（移动端体验）
    el.roomList.addEventListener('click', () => {
      if (window.innerWidth <= 768) closeDrawers();
    });

    /* ---------- 退出登录 ---------- */
    el.logoutBtn.addEventListener('click', () => {
      if (!confirm('确定要退出登录吗？')) return;
      // 先断开连接再清状态，避免断开时又触发重连
      if (state.socket) state.socket.disconnect();
      API.logout(); // 内部会清 localStorage 并跳转到登录页
    });

    /* ---------- 窗口尺寸变化 ---------- */
    window.addEventListener('resize', () => {
      // 从移动端拖宽到桌面端时，抽屉状态要清掉，
      // 否则侧栏会带着 .open 类，在桌面上布局可能异常
      if (window.innerWidth > 768) closeDrawers();
    });
  }

  /* ==========================================================
   * 十五、初始化
   * ========================================================== */

  async function init() {
    /* ---------- 1. 检查登录态 ---------- */
    const token = API.getToken();
    if (!token) {
      API.redirectToLogin();
      return;
    }

    // 先用本地缓存顶上，界面不至于空着
    const cached = API.getUser();
    if (cached) {
      state.me = cached;
      el.myName.textContent = cached.username;
      el.myAvatar.textContent = avatarText(cached.username);
      el.myAvatar.style.background = avatarColor(cached.username);
    }

    /* ---------- 2. 验证 token 是否还有效 ---------- */
    try {
      const me = await API.getMe();
      state.me = me;
      API.setUser(me); // 刷新一下缓存（用户名可能在别处改过）
      el.myName.textContent = me.username;
      el.myAvatar.textContent = avatarText(me.username);
      el.myAvatar.style.background = avatarColor(me.username);
    } catch (err) {
      // API 层已经处理了 401（清 token + 跳登录页），这里不用再做什么
      console.warn('[init] 获取用户信息失败:', err.message);
      return;
    }

    /* ---------- 3. 拉房间列表 ---------- */
    try {
      state.rooms = await API.getRooms();
      renderRooms();
    } catch (err) {
      el.roomList.textContent = '';
      const errBox = document.createElement('div');
      errBox.className = 'empty-state';
      errBox.style.padding = '20px 0';
      errBox.style.fontSize = '12px';
      errBox.textContent = '房间加载失败';
      el.roomList.appendChild(errBox);
      return;
    }

    /* ---------- 4. 绑定事件 + 连 Socket ---------- */
    bindEvents();
    connectSocket();

    // 输入框初始高度
    autoGrow(el.messageInput);
  }

  // DOM 就绪后启动。脚本放在 body 末尾，理论上 DOM 已经好了，
  // 但为保险起见还是判一下 readyState。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
