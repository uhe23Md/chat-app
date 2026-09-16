/**
 * rooms.routes.js —— 房间相关接口
 *
 * 目前只有一个：GET /api/rooms —— 拿全部房间列表。
 * 前端用它渲染左侧的房间列表。
 *
 * 响应格式遵循项目统一约定：
 *   成功 → { ok: true,  data: ... }
 *   失败 → { ok: false, error: '中文错误提示' }
 * 这个约定在 api.js 里被统一解析，前端拿到的是 data 部分。
 */

const express = require('express');
const { requireAuth } = require('../auth');
const queries = require('../queries');

const router = express.Router();

/**
 * GET /api/rooms
 * 获取全部房间
 *
 * 需要登录。为什么要加 requireAuth？
 *   虽然房间名本身不算敏感信息，但"谁能看到聊天室全貌"应该跟着登录态走。
 *   而且前端所有页面都基于登录态，多一个匿名可访问的接口没有意义。
 */
router.get('/rooms', requireAuth, (req, res) => {
  const rooms = queries.listRooms();

  res.json({
    ok: true,
    data: rooms,
  });
});

module.exports = router;
