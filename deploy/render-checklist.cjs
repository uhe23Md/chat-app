/**
 * render-checklist.cjs —— 生成 Render 部署所需的全部信息
 *
 * 用法：node deploy/render-checklist.cjs
 *
 * 作用：把在 Render 网页上需要填的每一项都准备好，包括随机 JWT_SECRET，
 *      直接复制粘贴即可，不用来回翻文档。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 生成一个真正的随机密钥（不是假的占位符）
const jwtSecret = crypto.randomBytes(48).toString('hex');

// 读一下项目信息，让清单更准确
let pkg = {};
try {
  pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
} catch { /* ignore */ }

const nodeVersion = '24.14.1';

const line = '─'.repeat(64);

console.log(`
${line}
  Render 部署清单
${line}

  打开 https://render.com → 用 GitHub 账号登录 → New + → Web Service
  选 "Build and deploy from a Git repository" → 选中你的 chat-app 仓库

${line}
  第 1 部分：基本信息（照着填）
${line}

  Name              chat-app
  Region            Singapore          ← 离国内最近，延迟最低
  Branch            main
  Root Directory    ${'（留空）'.padEnd(20)}← 不要填，代码就在仓库根目录
  Runtime           Node
  Build Command     npm install
  Start Command     npm start
  Instance Type     Free               ← 免信用卡

${line}
  第 2 部分：环境变量（点 Advanced → Add Environment Variable）
${line}

  一条一条加，Key 和 Value 分别对应：

  ┌─ Key: NODE_ENV
  └─ Value: production

  ┌─ Key: NODE_VERSION
  └─ Value: ${nodeVersion}

  ┌─ Key: JWT_SECRET
  └─ Value: 下面这一整行（随机生成的，不要改）

${jwtSecret}

  ⚠️ 这个密钥只用于线上。它和你本地 .env 里的那个是两回事，不要混用。
     重新生成它会让所有已登录用户掉线（旧 token 验签失败），这是正常的。

${line}
  第 3 部分：部署完成后（可选但推荐）
${line}

  服务跑起来后，Render 会给你一个域名，形如：
      https://chat-app-xxxx.onrender.com

  找到真实域名后，再加一条环境变量把 CORS 收紧：

  ┌─ Key: ALLOWED_ORIGINS
  └─ Value: https://chat-app-xxxx.onrender.com
              （换成你的真实域名，不要带结尾的斜杠）

  加完 Render 会自动重新部署。启动日志里的 CORS 那行会从
  "⚠️ 未配置白名单" 变成 "已配置白名单 1 条"。

${line}
  验证部署成功
${line}

  看 Render 的 Logs 面板，出现下面这段就说明配置全对：

      [db] 数据库就绪: /opt/render/project/src/chat.db
      [db] 当前房间数: 3
      [socket] Socket.IO 实时层已就绪
      ========================================
        聊天室后端已启动 [线上模式]
        端口: 10000
      ========================================

  ⚠️ 重点是两处：
     [线上模式]  ← 如果显示 [本地模式]，说明 NODE_ENV 没设上
     端口: 10000 ← 如果显示 3000，说明 PORT 处理有问题

  然后浏览器打开 https://你的域名/api/health，
  看到 {"ok":true,...} 就成功了。

${line}
  关于 Node 版本的说明
${line}

  NODE_VERSION 填 ${nodeVersion}，原因有两个：

  1. 本项目用了 Node 内置的 node:sqlite 模块，需要 Node 22.5 以上。
     Render 当前默认是 24.14.1，理论上不设也行，
     但默认版本会随时间变化，显式锁住最稳。

  2. 和本地开发环境保持一致（本机是 v${process.versions.node}）。
     本地线上同版本，能避免"本地能跑、线上报错"这类最难查的问题。

${line}
  如果出问题
${line}

  完整故障排查见 部署指南.md 第四节，覆盖：
    · 启动失败 Cannot find module 'node:sqlite'
    · 构建成功但健康检查失败
    · 页面能打开但登录报错
    · 消息发出去对方收不到
    · 重新部署后数据全没了（预期行为，见下）

  ⚠️ 必须提前知道：免费套餐的容器文件系统是临时的，
     每次重新部署，用户和消息都会重置。演示够用，别放重要数据。

${line}
`);
