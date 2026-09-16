/**
 * config.js —— 环境配置集中管理
 *
 * 为什么要把配置抽出来单独一个文件？
 *
 *   因为"本地开发"和"线上部署"的差异全在配置上：
 *     本地  → CORS 随便开、端口 3000、数据库放项目根目录
 *     线上  → CORS 必须收紧、端口由平台注入、数据库要放持久卷
 *
 *   如果这些差异散落在 index.js / db.js / sockets 各处，
 *   部署时就要满项目找 `process.env.XXX`，改漏一个就会出问题。
 *   集中在这里，部署前只需要看这一个文件。
 *
 * ⚠️ 部署相关的几个坑，都在这个文件里处理了：
 *   1. PORT 必须读环境变量 —— Render/Railway/Heroku 都会注入自己的端口，
 *      写死 3000 会导致平台健康检查失败（之前踩过这个坑）。
 *   2. 检测到在云平台上运行时，自动切到"生产模式"，收紧 CORS。
 *   3. 数据库路径要能通过环境变量指定（线上挂持久卷要用）。
 */

require('dotenv').config();

const path = require('path');

/* ============================================================
 * 一、运行环境判定
 * ============================================================ */

/**
 * 怎么判断"当前是不是部署在云平台上"？
 *
 * 这些小技巧都是各平台的惯例（没有官方标准，但大家都在用）：
 *   - NODE_ENV=production      —— 通用约定，我们自己在部署时也会设
 *   - RENDER                   —— Render 自动注入
 *   - RAILWAY_ENVIRONMENT      —— Railway 自动注入
 *   - DYNO                     —— Heroku 自动注入
 *   - FLY_APP_NAME             —— Fly.io
 *   - 有 PORT 但没设 NODE_ENV  —— 大概率是平台注入的端口，也算线上
 *
 * 为什么要自动检测而不是让用户手动设？
 *   因为漏设 NODE_ENV 是很常见的部署事故 ——
 *   结果就是线上跑着开发配置（CORS 全开、错误信息全暴露）。
 *   自动检测多一层保险。
 */
const IS_CLOUD =
  process.env.NODE_ENV === 'production' ||
  !!process.env.RENDER ||
  !!process.env.RAILWAY_ENVIRONMENT ||
  !!process.env.DYNO ||
  !!process.env.FLY_APP_NAME ||
  !!process.env.WEBSITE_SITE_NAME; // Azure

const IS_PROD = IS_CLOUD;

/* ============================================================
 * 二、端口
 * ============================================================ */

/**
 * ⚠️ 这里的 `process.env.PORT` 不能省！
 *
 * 云平台会注入 PORT 环境变量，并把这个端口作为健康检查的入口。
 * 如果代码里写死 3000，平台访问它注入的端口会连不上，
 * 报错大概是「service did not become reachable on port XXXX within 60s」。
 */
const PORT = Number(process.env.PORT) || 3000;

/* ============================================================
 * 三、CORS 白名单
 * ============================================================ */

/**
 * 允许跨域的来源列表。
 *
 * 【安全说明】为什么不能一直用 `*`？
 *   本项目前后端同源部署（Express 同时托管 public/ 和 API），
 *   正常访问根本用不到 CORS。开着 `*` 的风险是：
 *   别人可以在自己的网站上用 JavaScript 调你的接口
 *   （虽然因为要带 Authorization 头、且 token 存在 localStorage 里，
 *    攻击者拿不到 token，但"完全不设防"本身就是坏习惯）。
 *
 * 配置方式（在平台的 Environment Variables 里设）：
 *   ALLOWED_ORIGINS=https://你的域名.onrender.com,https://你的自定义域名.com
 *
 * 本地开发不设这个变量，默认放开，方便用 Live Server 之类调试。
 */
function parseOrigins(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const ALLOWED_ORIGINS = parseOrigins(process.env.ALLOWED_ORIGINS);

/**
 * 生成 CORS 配置对象
 *
 * 逻辑：
 *   - 本地开发（未检测到云平台）：放开所有来源
 *   - 线上 + 配了白名单：只允许白名单里的
 *   - 线上 + 没配白名单：放开，但打印警告（避免直接把服务卡死）
 */
function corsOptions() {
  // 本地开发：全放开
  if (!IS_PROD) {
    return {
      origin: true,        // 回显请求的 Origin，等价于宽松允许
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    };
  }

  // 线上但没配白名单：放行但警告
  if (ALLOWED_ORIGINS.length === 0) {
    console.warn(
      '[config] ⚠️  检测到线上环境但未设置 ALLOWED_ORIGINS，CORS 将放开所有来源。\n' +
        '         建议在平台环境变量里设置 ALLOWED_ORIGINS=https://你的域名'
    );
    return {
      origin: true,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    };
  }

  // 线上 + 有白名单：严格检查
  return {
    origin(origin, callback) {
      // 没有 Origin 头的请求（同源请求、curl、健康检查）直接放行。
      // 注意：同源部署时浏览器的 fetch 也可能不带 Origin，
      // 卡这一条会导致自己的前端调不通自己的后端。
      if (!origin) return callback(null, true);

      if (ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }

      console.warn(`[config] CORS 拒绝来源: ${origin}`);
      return callback(null, false); // 用 false 而不是 Error，避免变成 500
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  };
}

/* ============================================================
 * 四、数据库路径
 * ============================================================ */

/**
 * SQLite 数据库文件路径。
 *
 * 【部署时的关键问题】免费平台的容器文件系统是**临时的** ——
 * 每次重新部署 / 重启服务，容器里的文件全部重置，数据库就没了。
 *
 * 三种应对方式：
 *   1. 挂持久卷（Render Disk / Railway Volume），把 DB_PATH 指到卷的挂载点
 *      例：DB_PATH=/data/chat.db（/data 是卷的挂载点）
 *   2. 换成云数据库（Postgres / MySQL）—— 要改 queries.js 和 db.js，工作量大
 *   3. 接受数据丢失 —— 只是演示的话可以接受，但要心里有数
 *
 * 这里默认放在项目根目录的 chat.db（本地开发方便）。
 *
 * ⚠️ 一定要 path.resolve 成绝对路径，不能留着 './chat.db'。
 *    相对路径是按"进程的工作目录"解析的，而不是按代码文件位置。
 *    本地 `npm start` 时工作目录正好是项目根目录，看不出问题；
 *    但线上平台常常从别的目录拉起进程，相对路径就会在
 *    奇怪的地方新建一个空数据库 —— 表现为"数据全丢了"。
 */
const DB_PATH = path.resolve(__dirname, '..', process.env.DB_PATH || './chat.db');

/* ============================================================
 * 五、其他
 * ============================================================ */

/** 单条消息最大长度（前后端保持一致） */
const MAX_MESSAGE_LENGTH = 2000;

/** 历史消息单次最多返回条数 */
const MAX_MESSAGE_LIMIT = 100;
const DEFAULT_MESSAGE_LIMIT = 50;

module.exports = {
  IS_PROD,
  IS_CLOUD,
  PORT,
  ALLOWED_ORIGINS,
  corsOptions,
  DB_PATH,
  MAX_MESSAGE_LENGTH,
  MAX_MESSAGE_LIMIT,
  DEFAULT_MESSAGE_LIMIT,
};
