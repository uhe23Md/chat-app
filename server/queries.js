/**
 * queries.js —— 数据访问层（所有 SQL 都集中在这里）
 *
 * 为什么要单独抽一层，而不是在路由和 Socket 里各写一遍 SQL？
 *
 *   1. 同一条查询会被两处用到 —— 比如"按 id 取消息"，REST 拉历史要用，
 *      Socket 发完消息读回完整记录也要用。写两遍就有两个地方可能改漏。
 *   2. 行 → JSON 的字段映射（snake_case 转 camelCase）需要统一。
 *      数据库里是 sender_id / created_at，前端要的是 senderId / createdAt，
 *      这个转换逻辑散落各处最容易出现"某个接口少了 username"这种 bug。
 *   3. 将来要换成 PostgreSQL，只改这一个文件。
 *
 * ⚠️ 安全约定：本文件所有 SQL 一律用 `?` 占位符传参，**绝不拼接字符串**。
 *    SQL 注入的经典案例就是把用户输入拼进 SQL：
 *      `SELECT * FROM users WHERE name = '${input}'`  ← 输入 `' OR '1'='1` 就完蛋
 *    参数化查询把"SQL 结构"和"数据"彻底分开，数据永远被当成数据。
 */

const db = require('./db');

/* ============================================================
 * 行 → JSON 的映射
 * ============================================================ */

/**
 * 把数据库的 message 行转成前端要的格式
 *
 * 数据库返回的是扁平的一行：
 *   { id, room_id, content, type, created_at, sender_id, username, avatar }
 * 前端要的是带嵌套 sender 对象的结构：
 *   { id, roomId, content, type, createdAt, sender: { id, username, avatar } }
 *
 * 注意 sender.avatar 用的是 `?? null` 而不是 `|| null`：
 * 虽然这里效果一样，但 `??` 只在 null/undefined 时兜底，
 * 空字符串 '' 会被保留 —— 将来如果有"空头像"这种合法值就不会被误吞。
 */
function mapMessageRow(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    content: row.content,
    type: row.type,
    createdAt: row.created_at,
    sender: {
      id: row.sender_id,
      username: row.username,
      avatar: row.avatar ?? null,
    },
  };
}

function mapPrivateMessageRow(row) {
  return {
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    sender: {
      id: row.sender_id,
      username: row.sender_username,
      avatar: row.sender_avatar ?? null,
    },
    receiver: {
      id: row.receiver_id,
      username: row.receiver_username,
      avatar: row.receiver_avatar ?? null,
    },
  };
}

/* ============================================================
 * 预编译语句
 *
 * db.prepare() 会把 SQL 编译成"语句对象"并缓存起来。
 * 之后每次 .all() / .get() / .run() 都复用这份编译结果，
 * 比每次重新 prepare 快得多。所以放在模块顶层只 prepare 一次。
 *
 * 命名都带用途前缀，方便查找，比如 getMessagesByRoom 表示"按房间取消息"。
 * ============================================================ */

/* ---------- rooms ---------- */

const stmtRoomList = db.prepare('SELECT id, name FROM rooms ORDER BY id ASC');
const stmtRoomById = db.prepare('SELECT id, name FROM rooms WHERE id = ?');

/* ---------- messages（公共房间） ---------- */

/**
 * 取某房间的消息，按 id 倒序（即最新在前），拿前 limit 条。
 *
 * 为什么用倒序取？
 *   因为要取"最近 50 条"，正序取就会拿到"最早 50 条"，那是错的。
 *   但前端希望拿到的是从旧到新的顺序（直接 append 到列表末尾），
 *   所以取出来之后要在 JS 里 reverse() 一次。这个转换在下面函数里做了。
 *
 *   `?` 出现两次对应两个参数：先 before（分页游标），再 limit。
 *   注意 SQL 里参数是按出现顺序绑定的，别搞反。
 */
const stmtMessagesByRoom = db.prepare(`
  SELECT
    m.id, m.room_id, m.content, m.type, m.created_at,
    u.id AS sender_id, u.username, u.avatar
  FROM messages m
  JOIN users u ON u.id = m.sender_id
  WHERE m.room_id = ?
    AND (? IS NULL OR m.id < ?)
  ORDER BY m.id DESC
  LIMIT ?
`);

/** 按 id 取单条消息（Socket 发完消息后读回完整记录用） */
const stmtMessageById = db.prepare(`
  SELECT
    m.id, m.room_id, m.content, m.type, m.created_at,
    u.id AS sender_id, u.username, u.avatar
  FROM messages m
  JOIN users u ON u.id = m.sender_id
  WHERE m.id = ?
`);

const stmtInsertMessage = db.prepare(
  'INSERT INTO messages (room_id, sender_id, content, type, created_at) VALUES (?, ?, ?, ?, ?)'
);

/* ---------- private_messages（私聊） ---------- */

/**
 * 取两个用户之间的私聊记录。
 *
 * 条件 `(a=? AND b=?) OR (a=? AND b=?)` 的意思是"我发给他的"和"他发给我的"都要，
 * 这样双方向的消息才是完整的一段对话。
 * 参数要传四遍同样的两个 id（顺序：我他、他我），看着啰嗦但这是 SQL 的写法。
 */
const stmtPrivateBetween = db.prepare(`
  SELECT
    pm.id, pm.content, pm.created_at,
    pm.sender_id, pm.receiver_id,
    su.username AS sender_username,   su.avatar AS sender_avatar,
    ru.username AS receiver_username, ru.avatar AS receiver_avatar
  FROM private_messages pm
  JOIN users su ON su.id = pm.sender_id
  JOIN users ru ON ru.id = pm.receiver_id
  WHERE (pm.sender_id = ? AND pm.receiver_id = ?)
     OR (pm.sender_id = ? AND pm.receiver_id = ?)
  ORDER BY pm.id DESC
  LIMIT ?
`);

const stmtPrivateById = db.prepare(`
  SELECT
    pm.id, pm.content, pm.created_at,
    pm.sender_id, pm.receiver_id,
    su.username AS sender_username,   su.avatar AS sender_avatar,
    ru.username AS receiver_username, ru.avatar AS receiver_avatar
  FROM private_messages pm
  JOIN users su ON su.id = pm.sender_id
  JOIN users ru ON ru.id = pm.receiver_id
  WHERE pm.id = ?
`);

const stmtInsertPrivate = db.prepare(
  'INSERT INTO private_messages (sender_id, receiver_id, content, created_at) VALUES (?, ?, ?, ?)'
);

/* ---------- users ---------- */

const stmtUserById = db.prepare('SELECT id, username, avatar FROM users WHERE id = ?');

/* ============================================================
 * 内部工具函数
 *
 * 这两个读回函数定义在模块作用域内（而不是挂在导出对象上当方法），
 * 是为了避免 `this` 绑定的坑：
 *   如果写成 module.exports.getMessageById，然后在 insertMessage 里用
 *   `this.getMessageById(...)`，那么一旦调用方写
 *     const { insertMessage } = require('./queries')
 *     insertMessage(1, 2, 'hi')
 *   `this` 就变成 undefined，直接报错。
 * 直接引用模块内的函数则没有这个问题，怎么调用都对。
 * ============================================================ */

/** 取单条公共消息（完整格式） */
function getMessageById(id) {
  const row = stmtMessageById.get(id);
  return row ? mapMessageRow(row) : null;
}

/** 取单条私聊消息（完整格式） */
function getPrivateMessageById(id) {
  const row = stmtPrivateById.get(id);
  return row ? mapPrivateMessageRow(row) : null;
}

/* ============================================================
 * 对外接口
 * ============================================================ */

module.exports = {
  /* ---------- 房间 ---------- */

  /** 全部房间列表 */
  listRooms() {
    return stmtRoomList.all();
  },

  /** 按 id 取房间，不存在返回 undefined */
  getRoomById(roomId) {
    return stmtRoomById.get(roomId);
  },

  /* ---------- 公共消息 ---------- */

  /**
   * 取某房间的历史消息
   * @param {number} roomId
   * @param {{before?: number, limit?: number}} opts
   * @returns {Array} 从旧到新排列的消息数组
   */
  getMessages(roomId, { before = null, limit = 50 } = {}) {
    // 分页游标用 null 表示"从头（最新）开始"
    const rows = stmtMessagesByRoom.all(roomId, before, before, limit);
    // 倒序取出来的，反转成从旧到新，前端直接 append
    return rows.reverse().map(mapMessageRow);
  },

  /** 取单条消息（完整格式，用于 Socket 推送） */
  getMessageById,

  /**
   * 写入一条公共消息
   * @returns {object} 写入后的完整消息（带自增 id 和时间）
   */
  insertMessage(roomId, senderId, content, type = 'text') {
    const createdAt = new Date().toISOString();

    // node:sqlite 的 run() 返回 { changes, lastInsertRowid }
    // lastInsertRowid 可能是 BigInt，转成 Number 才能安全 JSON 序列化
    const result = stmtInsertMessage.run(roomId, senderId, content, type, createdAt);
    const newId = Number(result.lastInsertRowid);

    // 读回完整记录：不要自己拼对象。因为 username/avatar 要 JOIN 才有，
    // 自己拼容易漏字段，而且读回的是"数据库里真实的样子"，更可信。
    return getMessageById(newId);
  },

  /* ---------- 私聊 ---------- */

  /** 取两人之间的私聊记录，从旧到新 */
  getPrivateMessages(userA, userB, { limit = 50 } = {}) {
    const rows = stmtPrivateBetween.all(userA, userB, userB, userA, limit);
    return rows.reverse().map(mapPrivateMessageRow);
  },

  /** 写入一条私聊消息，返回完整记录 */
  insertPrivateMessage(senderId, receiverId, content) {
    const createdAt = new Date().toISOString();
    const result = stmtInsertPrivate.run(senderId, receiverId, content, createdAt);
    const newId = Number(result.lastInsertRowid);

    return getPrivateMessageById(newId);
  },

  /** 取单条私聊消息（完整格式） */
  getPrivateMessageById,

  /* ---------- 用户 ---------- */

  getUserById(id) {
    return stmtUserById.get(id);
  },

  /* ---------- 原始 db（备用，尽量走上面的封装） ---------- */
  raw: db,
};
