/**
 * auth.routes.js —— 注册 / 登录 / 获取当前用户
 *
 * 三个接口：
 *   POST /api/register   注册
 *   POST /api/login      登录
 *   GET  /api/me         获取当前用户（需要登录）
 *
 * 接口约定见 design.md 第 4.2 节。
 *
 * 【统一响应格式】
 *   成功：{ ok: true,  data: {...} }
 *   失败：{ ok: false, error: "中文提示" }
 * 这样前端只用判断 res.ok（业务字段）就能分支，不用去猜各种返回结构。
 */

const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword, signToken, requireAuth } = require('../auth');

const router = express.Router();

// ---- 参数校验规则 ----
// 抽成常量，改规则时只改一处
const USERNAME_MIN = 3;
const USERNAME_MAX = 20;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 64;

/**
 * 校验注册/登录的输入
 * @returns {string|null} 错误提示，通过校验则返回 null
 */
function validateCredentials(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') {
    return '用户名和密码必须是字符串';
  }

  const trimmedUsername = username.trim();

  if (!trimmedUsername || !password) {
    return '用户名和密码不能为空';
  }
  if (trimmedUsername.length < USERNAME_MIN || trimmedUsername.length > USERNAME_MAX) {
    return `用户名长度需为 ${USERNAME_MIN}-${USERNAME_MAX} 个字符`;
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return `密码长度需为 ${PASSWORD_MIN}-${PASSWORD_MAX} 个字符`;
  }
  // 用户名只允许字母、数字、下划线、中文 —— 避免奇怪的字符带来显示和安全问题
  if (!/^[\w\u4e00-\u9fa5]+$/.test(trimmedUsername)) {
    return '用户名只能包含字母、数字、下划线或中文';
  }

  return null;
}

/* ============================================================
 * POST /api/register —— 注册
 * ============================================================ */
router.post('/register', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};

    // 1. 参数校验
    const validationError = validateCredentials(username, password);
    if (validationError) {
      return res.status(400).json({ ok: false, error: validationError });
    }

    const finalUsername = username.trim();

    // 2. 检查用户名是否已存在
    const existing = db
      .prepare('SELECT id FROM users WHERE username = ?')
      .get(finalUsername);

    if (existing) {
      // 409 Conflict 是"资源冲突"的标准状态码，比 400 更准确
      return res.status(409).json({ ok: false, error: '该用户名已被注册' });
    }

    // 3. 加密密码（异步，故意慢）
    const passwordHash = await hashPassword(password);

    // 4. 写入数据库
    const now = new Date().toISOString();
    // run() 返回 { changes, lastInsertRowid }
    const result = db
      .prepare(
        'INSERT INTO users (username, password_hash, avatar, created_at) VALUES (?, ?, ?, ?)'
      )
      .run(finalUsername, passwordHash, null, now);

    // 5. 返回新用户信息
    // ⚠️ 绝对不能把 password_hash 返回给前端，哪怕前端用不上
    res.status(201).json({
      ok: true,
      data: {
        id: Number(result.lastInsertRowid),
        username: finalUsername,
        avatar: null,
        createdAt: now,
      },
    });
  } catch (err) {
    // 兜底：如果两步之间刚好有并发注册撞上 UNIQUE 约束，会走到这里
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ ok: false, error: '该用户名已被注册' });
    }
    next(err); // 交给 index.js 里的统一错误处理
  }
});

/* ============================================================
 * POST /api/login —— 登录
 * ============================================================ */
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};

    // 这里不做详细的格式校验 —— 登录时输入什么是用户的自由，
    // 反正查不到就是失败。只在类型明显不对时挡一下。
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ ok: false, error: '用户名和密码不能为空' });
    }

    // 1. 按用户名查用户
    const user = db
      .prepare('SELECT id, username, password_hash, avatar FROM users WHERE username = ?')
      .get(username.trim());

    // 2. 用户不存在 或 密码不对 —— 都返回同样的提示
    //
    // ⚠️ 这里是有意为之的安全设计：
    // 如果"用户不存在"提示"用户不存在"，"密码错误"提示"密码错误"，
    // 攻击者就能靠反复试错来判断哪些用户名是真实存在的（撞库探测的前置步骤）。
    // 统一提示后，攻击者无法区分这两种情况。
    if (!user) {
      // 即使用户不存在，也走一次密码比对，让响应时间接近，
      // 避免通过"响应快慢"来侧信道判断用户是否存在。
      await verifyPassword(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
      return res.status(401).json({ ok: false, error: '用户名或密码错误' });
    }

    const isPasswordValid = await verifyPassword(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ ok: false, error: '用户名或密码错误' });
    }

    // 3. 签发 token
    const token = signToken({ id: user.id, username: user.username });

    // 4. 返回 token 和用户信息（同样不含 password_hash）
    res.json({
      ok: true,
      data: {
        token,
        user: {
          id: user.id,
          username: user.username,
          avatar: user.avatar,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ============================================================
 * GET /api/me —— 获取当前用户
 *
 * 前端每次打开 chat.html 都会先调这个接口，
 * 用来验证 localStorage 里的 token 是否还有效。
 *   - 返回 200 → token 有效，正常进入聊天页
 *   - 返回 401 → token 过期/伪造，清掉本地 token 跳登录页
 * ============================================================ */
router.get('/me', requireAuth, (req, res, next) => {
  try {
    // req.user 是 requireAuth 中间件挂上去的，只含 id 和 username
    // 这里再回数据库查一次，确保用户真实存在（比如账号已被删除的情况）
    const user = db
      .prepare('SELECT id, username, avatar, created_at FROM users WHERE id = ?')
      .get(req.user.id);

    if (!user) {
      return res.status(401).json({ ok: false, error: '用户不存在，请重新登录' });
    }

    res.json({
      ok: true,
      data: {
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
