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
  console.log(`  健康检查: /api/health`);
  console.log('========================================');
  console.log('');
});

// 优雅退出：Ctrl+C 时关掉数据库连接，避免 WAL 文件残留
process.on('SIGINT', () => {
  console.log('\n正在关闭服务...');
  server.close(() => process.exit(0));
});
