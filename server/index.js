/**
 * index.js —— 服务端入口
 *
 * 启动流程：
 *   1. 加载 .env 环境变量
 *   2. 初始化数据库（require db.js 就会自动建表）
 *   3. 创建 Express 应用，挂中间件和路由
 *   4. 用 Express 应用创建 HTTP server
 *   5. 把 Socket.IO 挂到同一个 HTTP server 上
 *   6. 监听端口
 *
 * 为什么要手动 createServer(app)，而不是直接 app.listen()？
 *   因为 Socket.IO 需要接管 HTTP server 的 upgrade 请求来做 WebSocket 握手。
 *   如果直接 app.listen()，拿到的是一个已经在监听的 server，Socket.IO 再挂上去
 *   虽然也能用，但写法和责任划分不清楚。显式创建 server 更标准，
 *   顺便也统一了"HTTP 和 WebSocket 走同一个端口"这件事 —— 部署时只暴露一个端口。
 */

// 1. 加载环境变量（必须放在最前面，后面的模块要用 process.env）
require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

// 2. 初始化数据库（require 时就会执行建表 + 插入默认房间）
require('./db');

// 3. 读取环境配置（端口 / CORS 白名单 / 云端判定）
// 单独抽一个 config.js 的原因：这些值在"本机"和"线上"表现不同，
// 集中在一处判断，比在 index.js 里散着一堆 process.env 好排查。
const { PORT, IS_CLOUD, ALLOWED_ORIGINS, corsOptions } = require('./config');

// 3. 创建 Express 应用
const app = express();

// ---- 全局中间件 ----

// 解析 JSON 请求体：没有这行，req.body 永远是 undefined
app.use(express.json());

// 解析表单提交（HTML form 的默认提交方式）
app.use(express.urlencoded({ extended: true }));

// CORS：本项目前后端同源部署，本来不需要，但开发时用 Live Server
// 打开前端就需要它。线上则按 ALLOWED_ORIGINS 白名单收紧，
// 具体策略见 config.js 里的 corsOptions()。
app.use(cors(corsOptions()));

// ---- 安全响应头 ----
// 为什么手动加这几行、而不是装 helmet？
//   1) helmet 默认开的东西太多（CSP 默认策略会挡住内联脚本），
//      对这个项目来说是过度配置，反而要一条条关掉；
//   2) 我们只需要 4 个头，手写清楚每一条在防什么，比读 helmet 文档省事。
//
// 注意 X-Frame-Options 用 SAMEORIGIN 而不是 DENY：
// 以后若要嵌入自己的页面（比如做个 iframe 预览）还能用。
app.use((req, res, next) => {
  // 禁止浏览器"猜"Content-Type。不加这条的话，一个上传的 .txt
  // 可能被猜成 HTML 然后当脚本执行（MIME sniffing 攻击）。
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // 禁止被别家网站用 iframe 嵌套 —— 防点击劫持
  // （把你的登录页套在恶意页面的透明层下面，骗用户点）
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  // 跨站跳转时不要带上完整 URL 作为 Referer，
  // 避免把聊天室地址、房间 id 这类信息泄露给第三方站点
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // 明确告诉浏览器：这个站的资源只走 HTTPS（对本地 http 访问无影响）
  // max-age 先设 6 小时而不是一年 —— 万一将来要回退成 HTTP，不至于把自己锁死
  if (IS_CLOUD) {
    res.setHeader('Strict-Transport-Security', 'max-age=21600');
  }

  next();
});

// 简单的请求日志，方便调试时看清谁在调什么接口
app.use((req, res, next) => {
  const time = new Date().toLocaleTimeString('zh-CN');
  console.log(`[${time}] ${req.method} ${req.url}`);
  next();
});

// ---- 静态文件托管 ----
// 把 public/ 目录暴露出去，这样浏览器能直接访问 /login.html、/css/style.css
app.use(express.static(path.resolve(__dirname, '..', 'public')));

// ---- 路由挂载 ----
// 第 4 阶段：注册 / 登录 / 当前用户
app.use('/api', require('./routes/auth.routes'));

// 第 6 阶段：房间列表 / 历史消息 / 私聊记录
app.use('/api', require('./routes/rooms.routes'));
app.use('/api', require('./routes/messages.routes'));

// 测试用的临时首页（第 5 阶段做好前端后可以删掉这个路由）
// 注意：如果 public/index.html 存在，静态中间件会先命中它，这个路由不会执行。
// 所以这里用一个独立路径来做后端自检。
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    data: {
      message: '聊天室后端运行中',
      time: new Date().toISOString(),
      node: process.version,
    },
  });
});

// ---- 404 与错误处理 ----
// 所有 API 请求没匹配上路由时，返回 JSON 而不是 Express 默认的 HTML
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: '接口不存在' });
});

// 统一错误处理中间件（四个参数是 Express 识别错误处理器的标志）
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ ok: false, error: '服务器内部错误' });
});

// 4. 创建 HTTP server
const server = http.createServer(app);

// 5. 挂载 Socket.IO
// CORS 同样交给 config 统一决策 —— HTTP 和 WebSocket 用同一套白名单，
// 否则会出现"REST 能调、socket 连不上"这种很隐蔽的故障。
const io = new Server(server, {
  cors: corsOptions(),
});

// 把所有实时逻辑（鉴权 + 事件处理）交给 sockets/index.js。
// 这样 index.js 只负责"组装"，具体业务逻辑各自待在对应文件里，
// 以后要改事件不用在入口文件里翻来找去。
require('./sockets')(io);

// 6. 监听端口
// 监听 0.0.0.0 而不是默认的 localhost：容器环境下只绑 127.0.0.1
// 会导致容器外的健康检查连不上，平台判定"服务未就绪"然后反复重启。
server.listen(PORT, '0.0.0.0', () => {
  const mode = IS_CLOUD ? '线上' : '本地';
  const corsDesc = ALLOWED_ORIGINS.length
    ? `已配置白名单 ${ALLOWED_ORIGINS.length} 条`
    : IS_CLOUD
      ? '⚠️  未配置白名单，当前放行所有来源'
      : '开发模式，放行所有来源';

  console.log('');
  console.log('========================================');
  console.log(`  聊天室后端已启动 [${mode}模式]`);
  console.log(`  端口: ${PORT}`);
  console.log(`  CORS: ${corsDesc}`);
  console.log(`  安全头: nosniff / SAMEORIGIN / Referrer-Policy${IS_CLOUD ? ' / HSTS' : ''}`);
  console.log(`  健康检查: /api/health`);
  console.log('========================================');
  console.log('');
});

// 优雅退出：Ctrl+C 时关掉数据库连接，避免 WAL 文件残留
process.on('SIGINT', () => {
  console.log('\n正在关闭服务...');
  server.close(() => process.exit(0));
});
