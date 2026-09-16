/**
 * messages.routes.js —— 消息查询接口
 *
 * 两个接口：
 *   GET /api/messages          —— 某房间的历史消息（公共聊天记录）
 *   GET /api/private-messages  —— 我和某人的私聊记录
 *
 * 【为什么历史消息走 REST，而新消息走 Socket？】
 * 这两种需求形态完全不同：
 *   - 拉历史：一次性请求-响应，拉完就结束。走 HTTP 有明确状态码、能缓存、
 *     用 curl 就能调试，出错了一眼看出是 400 还是 500。
 *   - 收新消息：服务端主动推、长连接、不知道什么时候来。这才需要 WebSocket。
 * 硬把历史消息塞进 Socket 事件里，等于把"查询"包装成"订阅"，
 * 调试起来会很难受（回调里拿错误，还没有状态码）。
 *
 * 【分页设计】
 * 用 `before` 而不是 `offset`：
 *   offset 分页在"边聊边翻"的场景下会错位 —— 你翻页的瞬间别人发了新消息，
 *   后面所有消息的序号都往后挪了一位，第二页会出现第一页看过的内容。
 *   before（游标 = 看到的最小消息 id）不会错位，因为 id 是稳定不变的。
 */

const express = require('express');
const { requireAuth } = require('../auth');
const queries = require('../queries');
const { MAX_MESSAGE_LIMIT: MAX_LIMIT, DEFAULT_MESSAGE_LIMIT: DEFAULT_LIMIT } = require('../config');

const router = express.Router();

/**
 * 把 query 里的 limit 解析成安全的整数
 *
 * 为什么要这么谨慎？
 *   URL 参数天生是字符串，用户可以传任何东西：
 *     ?limit=abc        → parseInt 得到 NaN
 *     ?limit=-5         → 负数
 *     ?limit=999999999  → 超大值，一次查出全表，能把内存吃满
 *   所以必须做"兜底 + 夹紧"两步，最后一定落在 [1, MAX_LIMIT] 区间内。
 */
function parseLimit(raw, fallback = DEFAULT_LIMIT) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_LIMIT);
}

/**
 * 把 query 里的 id 解析成正整数，失败返回 null
 * 用于 roomId / before / withUserId 这类"必须是数字"的参数
 */
function parseId(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * GET /api/messages?roomId=1&limit=50&before=123
 * 获取某房间的历史消息
 *
 * 返回的消息按时间从旧到新排列（数据库里是倒序取的，queries 层已经反转好了），
 * 前端拿到直接往列表后面 append 就行，不用再排序。
 */
router.get('/messages', requireAuth, (req, res) => {
  const roomId = parseId(req.query.roomId);

  if (!roomId) {
    return res.status(400).json({ ok: false, error: '缺少有效的 roomId 参数' });
  }

  // 房间不存在时给个明确的 404，否则返回空数组会让前端以为是"这个房间还没人说话"
  const room = queries.getRoomById(roomId);
  if (!room) {
    return res.status(404).json({ ok: false, error: '房间不存在' });
  }

  const limit = parseLimit(req.query.limit);
  // before 是可选的：没传就是 null，表示从最新的开始取
  const before = req.query.before ? parseId(req.query.before) : null;

  const messages = queries.getMessages(roomId, { before, limit });

  res.json({
    ok: true,
    data: messages,
  });
});

/**
 * GET /api/private-messages?withUserId=5&limit=50
 * 获取当前登录用户与某人之间的私聊记录
 *
 * 【权限要点】只能查"和自己有关"的对话。
 *   这里刻意没有提供 `userId` 参数去指定"查谁的私聊" —— 那会造成越权：
 *   任何登录用户都能拉别人的私聊记录。
 *   对话的一方永远是 req.user.id（从 token 里来的，客户端伪造不了），
 *   另一方才是传入的 withUserId。
 */
router.get('/private-messages', requireAuth, (req, res) => {
  const withUserId = parseId(req.query.withUserId);

  if (!withUserId) {
    return res.status(400).json({ ok: false, error: '缺少有效的 withUserId 参数' });
  }

  // 对方必须真实存在，否则给个明确提示
  const other = queries.getUserById(withUserId);
  if (!other) {
    return res.status(404).json({ ok: false, error: '用户不存在' });
  }

  const limit = parseLimit(req.query.limit);
  const messages = queries.getPrivateMessages(req.user.id, withUserId, { limit });

  res.json({
    ok: true,
    data: {
      withUser: other,
      messages,
    },
  });
});

module.exports = router;
