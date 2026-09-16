# 实时聊天室项目：完整流程与任务书

> 本文档为项目总纲与 14 天任务表。
> 详细技术设计见 [`design.md`](./design.md)。

---

## 0. 在电脑上继续的方法

1. 电脑登录同一个 DeepSeek 账号，历史对话一般会自动同步。
2. 如果没同步，就把这份文档复制到电脑。
3. 在电脑新建文件夹：

```text
chat-app/
  server/
  public/
  design.md
  README.md
```

4. 把本文件保存为 `README.md`。
5. 在电脑 DeepSeek 新对话里发送：

```text
继续实时聊天室项目，从第 0 阶段开始，按 README.md 推进。
先帮我检查 design.md 应该怎么写。
```

---

## 1. 项目目标

做一个带登录的实时聊天室网站。

最终效果：

- 打开网站，可以注册、登录
- 登录后进入聊天大厅
- 你发一条消息，另一个浏览器窗口能立刻看到
- 刷新页面，历史消息还在
- 右边显示当前在线用户
- 支持多个聊天房间
- 支持私聊
- 手机浏览器也能用
- 最后部署到公网

---

## 2. 技术栈

- 前端：HTML + CSS + JavaScript
- 后端：Node.js + Express
- 实时通信：Socket.IO
- 数据库：SQLite
- 登录：JWT + bcrypt 密码加密
- 部署：Render 或 Railway

---

## 3. 你能学到什么

1. 前后端怎么分离
2. 怎么写 REST API
3. 数据库表怎么设计
4. 密码为什么不能明文存
5. Token 登录鉴权怎么做
6. WebSocket 和普通 HTTP 有什么区别
7. 消息怎么实时推送
8. 前端怎么管理登录状态和消息列表
9. 项目怎么部署上线

---

## 4. 设计文档 design.md 模板

### 4.1 页面

- 注册页
- 登录页
- 聊天大厅
- 私聊窗口

### 4.2 数据库表

#### users

- id
- username
- password_hash
- avatar
- created_at

#### rooms

- id
- name
- created_at

#### messages

- id
- room_id
- sender_id
- content
- type
- created_at

#### private_messages

- id
- sender_id
- receiver_id
- content
- created_at

### 4.3 REST API

```text
POST /api/register      注册
POST /api/login         登录
GET  /api/rooms         获取房间列表
GET  /api/messages      获取历史消息
GET  /api/me            获取当前用户
```

### 4.4 Socket.IO 事件

客户端发：

```text
join_room
send_message
private_message
```

服务端发：

```text
online_users
new_message
history_messages
error
```

---

## 5. 开发流程

### 第 0 阶段：环境准备

装好：

1. Node.js
2. VS Code
3. Git
4. Chrome
5. Postman 或 Thunder Client
6. DB Browser for SQLite

检查：

```bash
node -v
npm -v
git --version
```

创建项目目录：

```text
chat-app/
  server/
  public/
  design.md
  README.md
```

### 第 1 阶段：先设计，不写代码

写 `design.md`，必须包含：

- 页面
- 数据库表
- REST API
- Socket.IO 事件

### 第 2 阶段：搭后端骨架

```bash
cd chat-app
npm init -y
npm install express socket.io sqlite3 bcrypt jsonwebtoken cors dotenv
npm install -D nodemon
```

创建：

```text
server/index.js
server/db.js
server/auth.js
server/routes/
server/sockets/
```

先让后端跑起来：

```js
const express = require('express')
const app = express()

app.get('/', (req, res) => {
  res.send('聊天室后端运行中')
})

app.listen(3000, () => {
  console.log('http://localhost:3000')
})
```

验收：浏览器打开 `localhost:3000` 能看到文字。

### 第 3 阶段：数据库

在 `db.js` 里连接 SQLite，建 4 张表：

- users
- rooms
- messages
- private_messages

插入默认房间：

```text
学习区
游戏区
闲聊区
```

验收：用 DB Browser 能看到表和默认房间。

### 第 4 阶段：注册登录

后端做：

1. `POST /api/register`
   - 检查用户名是否存在
   - bcrypt 加密密码
   - 写入数据库

2. `POST /api/login`
   - 查用户
   - bcrypt 比对密码
   - 生成 JWT
   - 返回 token

3. 写鉴权中间件
   - 从请求头拿 token
   - 验证 token
   - 把用户信息挂到 `req.user`

验收：Postman 能注册、登录，拿到 token。

### 第 5 阶段：前端登录注册

在 `public` 里做：

```text
login.html
register.html
chat.html
css/style.css
js/auth.js
js/chat.js
```

流程：

1. 注册页提交到 `/api/register`
2. 登录页提交到 `/api/login`
3. 登录成功，把 token 存进 `localStorage`
4. 跳转到 `chat.html`
5. 没 token 就踢回登录页

验收：能注册、登录、跳转，刷新后还在登录状态。

### 第 6 阶段：Socket.IO 实时聊天

后端：

```js
const io = require('socket.io')(server)
io.on('connection', socket => {
  console.log('有人连接')
})
```

前端：

```js
const socket = io()
socket.emit('join_room', { roomId: 1 })
socket.on('new_message', msg => {
  // 渲染消息
})
```

实现：

1. 用户进入房间
2. 发送消息
3. 服务端广播给同房间所有人
4. 消息写入数据库

验收：两个浏览器窗口能实时聊天。

### 第 7 阶段：历史消息和在线用户

1. 进入房间时，请求 `/api/messages?roomId=1`
2. 把历史消息渲染出来
3. 服务端维护在线用户列表
4. 有人加入或离开，广播 `online_users`

验收：

- 刷新后历史消息还在
- 右边显示在线用户
- 关掉一个窗口，在线列表减少

### 第 8 阶段：多房间和私聊

多房间：

- 前端显示房间列表
- 点击切换房间
- Socket 重新 `join_room`

私聊：

- 点击在线用户
- 打开私聊窗口
- 发送 `private_message`
- 服务端只推给接收者

验收：能切换房间，能一对一私聊。

### 第 9 阶段：测试和优化

测试：

- 密码是否加密
- 未登录能不能进聊天室
- 两个用户能不能同时发消息
- 刷新后消息是否丢失
- 手机浏览器能不能用
- 断网重连后能不能继续

优化：

- 消息时间显示
- 自己的消息靠右
- 别人的消息靠左
- 回车发送
- 滚动到底部
- 错误提示

### 第 10 阶段：部署上线

1. 代码推到 GitHub
2. 用 Render 或 Railway 部署
3. 配置环境变量：
   - `JWT_SECRET`
   - `PORT`
4. 数据库先用 SQLite，部署时注意持久化
5. 写 `README.md`：
   - 项目介绍
   - 技术栈
   - 怎么本地运行
   - 截图
   - 在线地址

验收：公网能打开，两个设备能聊天。

---

## 6. 14 天任务表

| 天数 | 任务 |
|---|---|
| Day 1 | 环境 + 设计文档 |
| Day 2 | Express 骨架 |
| Day 3 | SQLite 建表 |
| Day 4 | 注册登录接口 |
| Day 5 | 前端注册登录 |
| Day 6 | JWT 鉴权 |
| Day 7 | Socket.IO 连接 |
| Day 8 | 公共聊天室 |
| Day 9 | 历史消息 |
| Day 10 | 在线用户 |
| Day 11 | 多房间 |
| Day 12 | 私聊 |
| Day 13 | 测试 + 手机适配 |
| Day 14 | 部署 + README |

---

## 7. 必须补的知识

如果卡住，按这个顺序补：

1. JS 异步：Promise、async/await、fetch
2. Node 基础：模块、npm、Express 路由、中间件
3. SQL 基础：建表、插入、查询、外键
4. HTTP：状态码、JSON、CORS
5. WebSocket：和普通 HTTP 的区别
6. 安全：bcrypt、JWT、环境变量

---

## 8. 最终验收清单

- [ ] 能注册
- [ ] 能登录
- [ ] 密码加密
- [ ] 未登录不能聊天
- [ ] 实时收发消息
- [ ] 刷新后消息还在
- [ ] 在线用户实时变化
- [ ] 多房间
- [ ] 私聊
- [ ] 手机能用
- [ ] 部署到公网
- [ ] README 完整

---

## 9. 第一个任务

先做第 0 阶段 + 第 1 阶段：

1. 建好 `chat-app` 目录
2. 写 `design.md`
3. 把页面、表、API、Socket 事件列出来

做完把 `design.md` 发给我，我帮你检查，然后带你做第 2 阶段。

---

## 10. 给电脑 DeepSeek 的启动指令

复制下面这段，发到电脑 DeepSeek：

```text
继续实时聊天室项目。
我已经把完整流程保存为 README.md。
现在从第 0 阶段开始。
请先帮我检查 design.md 应该怎么写，
然后带我完成第 2 阶段：搭 Express 后端骨架。
```

---

## 11. 环境检查结果（2026-09-15 本机实测）

| 项目 | 状态 | 版本 / 路径 |
|---|---|---|
| Node.js | ✅ 已装 | v24.21.0 — `C:\Users\Administrator\AppData\Local\Programs\nodejs\` |
| npm | ✅ 已装 | 11.19.0 |
| Git | ✅ 已装 | 2.55.0.windows.5 — `C:\Users\Administrator\AppData\Local\Programs\Git\cmd\` |
| 项目目录 | ✅ 已建 | `C:\Users\Administrator\Desktop\1\chat-app\` |
| VS Code | ⬜ 待确认 | 未检测 |
| Chrome | ⬜ 待确认 | 未检测 |
| DB Browser for SQLite | ⬜ 待确认 | 第 3 阶段前装好即可 |

> 注意：Node / Git 装完写入的是**用户环境变量 PATH**，如果你在装之前就开着的命令行窗口，需要**新开一个窗口**才能读到。
