/**
 * sockets/index.js —— Socket.IO 实时通信层
 *
 * 这是整个项目最核心的文件。REST 负责"拉取数据"，这里负责"实时推送"。
 *
 * ============================================================
 * 一、整体结构
 * ============================================================
 *
 *   客户端连接（带 token）
 *        ↓
 *   io.use(...)  鉴权中间件 —— token 不对直接拒绝，连不上
 *        ↓
 *   io.on('connection')  鉴权通过
 *        ↓
 *   客户端 emit 事件  →  服务端处理，写库，广播
 *
 * ============================================================
 * 二、要维护的两张内存表（关键设计）
 * ============================================================
 *
 *   onlineUsers: Map<userId, Set<socketId>>
 *     为什么值是 Set 而不是单个 id？
 *     因为一个人可以同时开很多个标签页 / 手机 + 电脑一起开。
 *     如果只存一个 id，后打开的会覆盖先打开的，
 *     关掉其中一个窗口，服务端就会以为"这个人下线了"，把另一个窗口也踢出在线列表。
 *     用 Set 记录他所有的连接，"真的离线"的判定条件是 **Set 变成空的**。
 *
 *   socketMeta: Map<socketId, { userId, username, roomId }>
 *     反查表。收到一个 socket 的事件时，需要知道"这是谁、在哪个房间"。
 *     断开连接时靠它找到该从哪个房间的在线列表里移除谁。
 *
 * ⚠️ 这两张表存在**进程内存**里。意味着：
 *   - 重启服务，在线状态全部清空（可接受，反正客户端会自动重连）
 *   - 将来要多进程/多机部署，得换成 Redis 适配器（socket.io-redis-adapter），
 *     否则 A 机器上的用户看不到 B 机器上的在线用户。现阶段单进程完全够用。
 *
 * ============================================================
 * 三、事件清单
 * ============================================================
 *
 *   客户端 → 服务端：
 *     join_room      { roomId }             切房间
 *     send_message   { roomId, content }    发公共消息
 *     private_message{ toUserId, content }  发私聊
 *     (ack 回调)     处理成功/失败都回调，前端据此清输入框、显示错误
 *
 *   服务端 → 客户端：
 *     online_users        当前房间在线用户列表
 *     new_message         新公共消息
 *     new_private_message 新私聊（只给收发双方）
 *     error               统一错误通知
 */

const { verifyToken } = require('../auth');
const queries = require('../queries');
const { MAX_MESSAGE_LENGTH } = require('../config');

/* ============================================================
 * 业务约束
 * ============================================================ */

/** 消息类型，目前只支持纯文本（将来可以扩展图片等） */
const DEFAULT_TYPE = 'text';

/* ============================================================
 * 内存状态
 * ============================================================ */

/** userId -> Set<socketId>：某用户当前打开的所有连接 */
const onlineUsers = new Map();

/** socketId -> { userId, username, roomId }：反查连接对应的身份与房间 */
const socketMeta = new Map();

/* ============================================================
 * 工具函数
 * ============================================================ */

/** 房间名 → Socket.IO 的 room 频道名。加前缀避免和 socket.id 之类的名字冲突 */
function roomChannel(roomId) {
  return `room:${roomId}`;
}

/**
 * 给"某个用户的所有连接"发消息
 *
 * 用途：私聊。因为接收者可能开了三个标签页，
 * 三个窗口都应该收到同一条私聊消息，所以是"给这个人的所有 socket 发"。
 *
 * @returns {number} 实际发出的连接数（0 表示对方不在线）
 */
function emitToUser(io, userId, event, payload) {
  const socketIds = onlineUsers.get(userId);
  if (!socketIds || socketIds.size === 0) return 0;

  let sent = 0;
  for (const sid of socketIds) {
    // 用 io.to(socketId) 定向发送。
    // 每个 socket 加入时会自动进入一个以自己 id 命名的房间，这是 Socket.IO 的内置行为。
    io.to(sid).emit(event, payload);
    sent++;
  }
  return sent;
}

/**
 * 计算某房间的在线用户列表（去重）
 *
 * 为什么要去重？同一个人开了两个标签页都在同一房间，
 * 在线列表里只应该出现一次。
 *
 * 实现：从 socketMeta 里筛出该房间的所有连接，
 * 用 Map 按 userId 归并（Map 的 key 天然唯一）。
 *
 * 关于 avatar：
 *   JWT 载荷里只有 id 和 username（这是故意的，token 别塞太多东西），
 *   所以头像得从数据库读。但每广播一次在线列表就查一遍库有点浪费，
 *   于是读到之后**缓存回 socketMeta**，同一连接后续就直接用缓存。
 *   头像目前没有修改功能，缓存不会失效，这个优化是安全的。
 */
function getRoomOnlineUsers(roomId) {
  const byId = new Map();

  for (const meta of socketMeta.values()) {
    if (meta.roomId !== roomId) continue;

    // 同一个用户只记一次
    if (byId.has(meta.userId)) continue;

    // 首次遇到这个连接时把头像补齐并缓存
    if (meta.avatar === undefined) {
      const u = queries.getUserById(meta.userId);
      meta.avatar = u ? u.avatar ?? null : null;
    }

    byId.set(meta.userId, {
      id: meta.userId,
      username: meta.username,
      avatar: meta.avatar,
    });
  }

  // 按用户名排一下，让列表顺序稳定（否则顺序随机跳动，看着很乱）
  return [...byId.values()].sort((a, b) => a.username.localeCompare(b.username, 'zh-CN'));
}

/** 向某房间广播在线用户列表 */
function broadcastOnlineUsers(io, roomId) {
  const users = getRoomOnlineUsers(roomId);
  io.to(roomChannel(roomId)).emit('online_users', { roomId, users });
}

/**
 * 校验消息内容
 * @returns {{ok: true, content: string} | {ok: false, code: string, message: string}}
 */
function validateContent(raw) {
  // 类型检查放在最前面：如果客户端传了个对象或数字，
  // 后面调用 trim() 会直接抛异常，整个事件处理就崩了。
  if (typeof raw !== 'string') {
    return { ok: false, code: 'INVALID_CONTENT', message: '消息内容格式不正确' };
  }

  // 前后空白去掉。全是空格的"空消息"也不该发出去
  const content = raw.trim();

  if (!content) {
    return { ok: false, code: 'EMPTY_CONTENT', message: '消息内容不能为空' };
  }

  // 注意：长度按"去空白后"算，防止用户靠打一堆空格绕过限制
  if (content.length > MAX_MESSAGE_LENGTH) {
    return {
      ok: false,
      code: 'CONTENT_TOO_LONG',
      message: `消息太长了，最多 ${MAX_MESSAGE_LENGTH} 个字符`,
    };
  }

  return { ok: true, content };
}

/* ============================================================
 * 主入口
 * ============================================================ */

/**
 * 把 Socket.IO 的所有逻辑挂到 io 实例上
 * @param {import('socket.io').Server} io
 */
module.exports = function setupSocket(io) {
  /* ----------------------------------------------------------
   * 一、连接鉴权中间件
   *
   * io.use() 的中间件在每次连接握手时执行，比 connection 更早。
   * 这里拒绝掉，客户端会收到 connect_error，根本进不到业务逻辑。
   *
   * token 从哪来？客户端连接时通过 auth 字段传：
   *   io('http://...', { auth: { token: localStorage.getItem('token') } })
   * 服务端用 socket.handshake.auth.token 取。
   *
   * 为什么不用 query 参数（?token=xxx）？
   *   因为 query 会出现在服务器访问日志、浏览器历史里，token 会泄漏。
   *   auth 字段走的是握手包体，不落日志，更安全。
   * ---------------------------------------------------------- */
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;

    if (!token) {
      // next(err) 传 Error 对象，客户端会触发 connect_error 并拿到 message
      return next(new Error('未登录，请先登录'));
    }

    try {
      const payload = verifyToken(token);

      // 挂到 socket 上，后面所有事件处理都能直接取用
      socket.user = { id: payload.id, username: payload.username };

      next();
    } catch (err) {
      // 过期和伪造分开提示，前端好做区分处理（过期就跳登录页）
      const message =
        err.name === 'TokenExpiredError' ? '登录已过期，请重新登录' : '登录状态无效，请重新登录';
      next(new Error(message));
    }
  });

  /* ----------------------------------------------------------
   * 二、连接建立后的处理
   * ---------------------------------------------------------- */
  io.on('connection', (socket) => {
    const { id: userId, username } = socket.user;

    console.log(`[socket] 连接: ${username}(#${userId}) socket=${socket.id}`);

    // ---- 登记到内存表 ----
    // 第一次见到这个用户就建个空 Set
    if (!onlineUsers.has(userId)) {
      onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId).add(socket.id);

    // roomId 先留 null，等客户端发 join_room 再填。
    // avatar 也先留 undefined —— 发送者在鉴权那一刻的 JWT 里没有头像字段，
    // 等真正需要展示（进房间时）再从数据库读一次。
    socketMeta.set(socket.id, { userId, username, roomId: null, avatar: undefined });

    /* ==========================================================
     * 事件一：join_room —— 切换房间
     * ========================================================== */
    socket.emit('connected', { userId, username });

    socket.on('join_room', (payload, ack) => {
      // 参数容错：客户端可能不传 ack，用可选调用
      const reply = typeof ack === 'function' ? ack : () => {};

      try {
        const roomId = Number(payload?.roomId);

        if (!Number.isInteger(roomId) || roomId <= 0) {
          return reply({ ok: false, error: '房间 ID 无效' });
        }

        // 房间必须真实存在，不能随便 join 一个不存在的房间
        const room = queries.getRoomById(roomId);
        if (!room) {
          return reply({ ok: false, error: '房间不存在' });
        }

        const meta = socketMeta.get(socket.id);
        if (!meta) {
          // 理论上不会发生，但状态表被意外清空时要有兜底
          return reply({ ok: false, error: '连接状态异常，请刷新页面' });
        }

        const oldRoomId = meta.roomId;

        // 同一个房间重复 join 就直接返回，不用折腾
        if (oldRoomId === roomId) {
          // 但还是把最新的在线列表回给他，保证状态同步
          socket.emit('online_users', {
            roomId,
            users: getRoomOnlineUsers(roomId),
          });
          return reply({ ok: true, data: { roomId, name: room.name } });
        }

        // 1. 离开旧房间
        if (oldRoomId != null) {
          socket.leave(roomChannel(oldRoomId));
          // 注意：这里不能直接删 socketMeta，因为人还在线，只是换了个房间。
          // 只把 meta.roomId 指向新房间即可。
        }

        // 2. 加入新房间
        socket.join(roomChannel(roomId));
        meta.roomId = roomId;

        // 3. 通知**旧房间**的人：有人走了（必须在 meta 更新之后广播，
        //    否则旧房间的列表里还会算上这个已经离开的人）
        if (oldRoomId != null && oldRoomId !== roomId) {
          broadcastOnlineUsers(io, oldRoomId);
        }

        // 4. 通知**新房间**的人：有人来了
        broadcastOnlineUsers(io, roomId);

        console.log(`[socket] ${username} 进入房间「${room.name}」(#${roomId})`);
        reply({ ok: true, data: { roomId, name: room.name } });
      } catch (err) {
        console.error('[socket] join_room 出错', err);
        reply({ ok: false, error: '加入房间失败，请重试' });
      }
    });

    /* ==========================================================
     * 事件二：send_message —— 在公共房间发消息
     * ========================================================== */
    socket.on('send_message', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};

      try {
        const meta = socketMeta.get(socket.id);
        if (!meta) {
          return reply({ ok: false, error: '连接状态异常，请刷新页面' });
        }

        const roomId = Number(payload?.roomId);

        if (!Number.isInteger(roomId) || roomId <= 0) {
          return reply({ ok: false, error: '房间 ID 无效' });
        }

        // 【重要】必须以服务端记录的房间为准，不能信客户端传来的 roomId。
        // 否则用户可以"人在 A 房间、却把消息发到 B 房间"，绕过房间隔离。
        if (meta.roomId !== roomId) {
          return reply({ ok: false, error: '你不在这个房间里，请先切换房间' });
        }

        const check = validateContent(payload?.content);
        if (!check.ok) {
          // 同时推一个 error 事件，前端在消息区顶部弹红条
          socket.emit('error', { code: check.code, message: check.message });
          return reply({ ok: false, error: check.message, code: check.code });
        }

        // 写库。insertMessage 会读回完整记录（带自增 id、时间、sender 信息）
        const message = queries.insertMessage(roomId, meta.userId, check.content, DEFAULT_TYPE);

        // 广播给房间里的所有人（包括发送者自己）。
        // 为什么包括自己？这样发送方不用自己往列表里插一条，
        // 统一由服务端推送来渲染，多个标签页也能保持一致。
        io.to(roomChannel(roomId)).emit('new_message', message);

        reply({ ok: true, data: message });
      } catch (err) {
        console.error('[socket] send_message 出错', err);
        socket.emit('error', { code: 'SEND_FAILED', message: '发送失败，请重试' });
        reply({ ok: false, error: '发送失败，请重试' });
      }
    });

    /* ==========================================================
     * 事件三：private_message —— 私聊
     * ========================================================== */
    socket.on('private_message', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};

      try {
        const meta = socketMeta.get(socket.id);
        if (!meta) {
          return reply({ ok: false, error: '连接状态异常，请刷新页面' });
        }

        const toUserId = Number(payload?.toUserId);

        if (!Number.isInteger(toUserId) || toUserId <= 0) {
          return reply({ ok: false, error: '接收者 ID 无效' });
        }

        // 不能给自己发私聊
        if (toUserId === meta.userId) {
          return reply({ ok: false, error: '不能给自己发私聊' });
        }

        // 接收者必须真实存在
        const receiver = queries.getUserById(toUserId);
        if (!receiver) {
          return reply({ ok: false, error: '对方用户不存在' });
        }

        const check = validateContent(payload?.content);
        if (!check.ok) {
          socket.emit('error', { code: check.code, message: check.message });
          return reply({ ok: false, error: check.message, code: check.code });
        }

        // 写库
        const message = queries.insertPrivateMessage(meta.userId, toUserId, check.content);

        /* 【安全要点】只推给收发的双方，绝不广播给其他人。
         *
         * 接收方：可能开了多个窗口，全部都推
         * 发送方：除了当前这个 socket，他别的窗口也该看到自己发的消息
         *         （当前 socket 由下面的 reply 处理，避免重复渲染两条）
         */
        const delivered = emitToUser(io, toUserId, 'new_private_message', message);

        // 给发送者的其他窗口也推一份（排除当前这个 socket）
        const senderSockets = onlineUsers.get(meta.userId);
        if (senderSockets) {
          for (const sid of senderSockets) {
            if (sid === socket.id) continue; // 当前窗口靠 ack 回调处理
            io.to(sid).emit('new_private_message', message);
          }
        }

        reply({
          ok: true,
          data: message,
          // 告诉前端对方在不在线，界面上可以提示"对方当前不在线"
          delivered: delivered > 0,
        });
      } catch (err) {
        console.error('[socket] private_message 出错', err);
        socket.emit('error', { code: 'SEND_FAILED', message: '发送失败，请重试' });
        reply({ ok: false, error: '发送失败，请重试' });
      }
    });

    /* ==========================================================
     * 事件四：断开连接 —— 清理状态
     * ========================================================== */
    socket.on('disconnect', (reason) => {
      console.log(`[socket] 断开: ${username}(#${userId}) socket=${socket.id} 原因=${reason}`);

      const meta = socketMeta.get(socket.id);
      // 先取出房间号再删，否则删完就找不到了
      const roomId = meta ? meta.roomId : null;

      socketMeta.delete(socket.id);

      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);

        // 【关键】只有这个用户的所有连接都断了，才算真的离线。
        // 他可能另一个标签页还开着，那种情况下不能从在线列表里移除。
        if (sockets.size === 0) {
          onlineUsers.delete(userId);
          console.log(`[socket] ${username} 已完全离线`);

          // 通知他所在房间：有人真的走了
          if (roomId != null) {
            broadcastOnlineUsers(io, roomId);
          }
        } else {
          console.log(`[socket] ${username} 还有 ${sockets.size} 个连接在线，不移除`);
        }
      }
    });
  });

  /* ----------------------------------------------------------
   * 三、对外暴露一些内部信息（调试用）
   *
   * 挂在 io 上而不是再开接口，避免把在线用户列表暴露成公开 API。
   * 只有服务端代码（比如自检脚本）能读到。
   * ---------------------------------------------------------- */
  io.debugState = () => ({
    onlineUserCount: onlineUsers.size,
    socketCount: socketMeta.size,
    onlineUsers: [...onlineUsers.entries()].map(([uid, set]) => ({
      userId: uid,
      connections: set.size,
    })),
    sockets: [...socketMeta.values()],
  });

  console.log('[socket] Socket.IO 实时层已就绪');
};
