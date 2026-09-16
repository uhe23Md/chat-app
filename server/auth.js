/**
 * auth.js —— 密码加密 与 JWT 令牌
 *
 * 这个文件是项目的安全核心，只做三件事：
 *   1. hashPassword / verifyPassword —— 密码的加密与比对
 *   2. signToken / verifyToken       —— 登录令牌的签发与校验
 *   3. requireAuth                   —— Express 鉴权中间件
 *
 * ============================================================
 * 为什么密码不能明文存？为什么不能简单地把密码"加密"？
 * ============================================================
 * 哈希（hash）是单向的：能从密码算出哈希，但没法从哈希反推密码。
 * 但"单向"还不够 —— 如果只是简单哈希，黑客可以拿一张预先算好的
 * "常用密码 → 哈希"对照表（彩虹表）直接反查，`123456` 一眼就被认出来。
 *
 * 所以 bcrypt 干了两件事：
 *   1. 加盐（salt）：给每个密码混入一段随机字符串，同样的密码
 *      在不同用户那里算出的哈希完全不同，彩虹表全部失效。
 *   2. 慢哈希：故意把计算变得很慢（cost 参数控制）。正常登录时
 *      多花 100 毫秒没感觉，但黑客想暴力枚举几亿个密码就等到天荒地老。
 *
 * 注意：盐值不需要我们单独存 —— bcrypt 把盐直接编进了哈希字符串本身，
 * 所以 `$2a$10$xxxxx...` 这一串里已经包含了版本、cost、盐和结果。
 * 比对时 bcrypt.compare 会自己从里面把盐取出来。
 * ============================================================
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// 从环境变量读密钥。这行如果拿不到值，说明 .env 没加载成功，
// 那就是严重配置错误 —— 用一个默认值会让 JWT 形同虚设，必须直接崩掉。
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    '[auth] 缺少 JWT_SECRET！请检查项目根目录的 .env 文件是否存在且包含 JWT_SECRET。'
  );
}

// cost 轮数：10 是社区公认的平衡点（约几十毫秒）。
// 数值每加 1，计算量翻倍。调到 12 以上会让登录明显变慢，没必要。
const SALT_ROUNDS = 10;

// 令牌有效期
const TOKEN_EXPIRES_IN = '7d';

/**
 * 加密密码
 * @param {string} plainPassword 用户输入的明文密码
 * @returns {Promise<string>} bcrypt 哈希字符串（可直接存库）
 *
 * 为什么是 async？bcrypt 的哈希计算故意设计得很慢，
 * 同步版本会卡住整个 Node 的事件循环（那一刻所有请求都得等），
 * 所以这里用异步版本。这个差异很关键，别图省事用 hashSync。
 */
async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

/**
 * 比对密码
 * @param {string} plainPassword 用户这次输入的明文密码
 * @param {string} hash 数据库里存的哈希字符串
 * @returns {Promise<boolean>} 密码是否正确
 */
async function verifyPassword(plainPassword, hash) {
  return bcrypt.compare(plainPassword, hash);
}

/**
 * 签发 JWT
 * @param {{id:number, username:string}} user 用户信息
 * @returns {string} token
 *
 * 载荷里只放 id 和 username —— 绝不放密码、邮箱这类敏感信息。
 * JWT 的内容是可以被任何人解开的（它只是 Base64 编码，不是加密），
 * 签名保证的是"没被篡改"，不是"别人看不到"。
 */
function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRES_IN }
  );
}

/**
 * 校验 JWT
 * @param {string} token
 * @returns {{id:number, username:string, iat:number, exp:number}}
 * @throws 令牌无效或过期时抛异常
 */
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/**
 * Express 鉴权中间件
 *
 * 用法：app.get('/api/me', requireAuth, handler)
 *      加了 requireAuth 的路由，没登录根本进不来。
 *
 * 它做的事：
 *   1. 从请求头拿 Authorization，格式必须是 "Bearer <token>"
 *   2. 校验 token
 *   3. 通过 → 把用户信息挂到 req.user，然后 next() 交给真正的处理函数
 *      不通过 → 直接返回 401，请求到此为止
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  // 格式检查：必须是 "Bearer " 开头
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      ok: false,
      error: '未登录，请先登录',
    });
  }

  // 切出 token 本体（"Bearer " 是 7 个字符）
  const token = authHeader.slice(7).trim();
  if (!token) {
    return res.status(401).json({ ok: false, error: '未登录，请先登录' });
  }

  try {
    // 验证签名 + 检查过期时间。过期或伪造都会在这里抛异常。
    const payload = verifyToken(token);
    req.user = { id: payload.id, username: payload.username };
    next();
  } catch (err) {
    // 区分一下错误类型，方便前端做处理：
    // 过期 → 前端应该清掉本地 token 并跳登录页
    // 其他 → 同样按未登录处理
    const message =
      err.name === 'TokenExpiredError' ? '登录已过期，请重新登录' : '登录状态无效，请重新登录';

    return res.status(401).json({ ok: false, error: message });
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  requireAuth,
};
