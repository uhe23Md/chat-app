# 实时聊天室 · 设计文档 design.md

> 版本：v1.0
> 日期：2026-09-15
> 状态：第 1 阶段交付物（只设计，不写代码）

---

## 0. 一句话说明

一个带登录鉴权的多房间实时聊天室：Node.js + Express 提供 REST API，Socket.IO 负责实时推送，SQLite 存数据，JWT 管登录态。

---

## 1. 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                    浏览器（public/）                      │
│  login.html  register.html  chat.html                    │
│  ┌──────────────┐        ┌─────────────────────┐        │
│  │  fetch()     │        │  Socket.IO Client   │        │
│  │  REST 调用   │        │  WebSocket 长连接    │        │
│  └──────┬───────┘        └──────────┬──────────┘        │
└─────────┼───────────────────────────┼───────────────────┘
          │ HTTP + JSON               │ WebSocket + JSON
          ▼                           ▼
┌─────────────────────────────────────────────────────────┐
│                  Node.js 服务端（server/）                │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Express 路由  │  │ 鉴权中间件    │  │ Socket.IO     │  │
│  │ routes/*.js  │──│ auth.js      │──│ sockets/*.js  │  │
│  └──────┬───────┘  └──────────────┘  └───────┬───────┘  │
│         └──────────────┬──────────────────────┘          │
│                        ▼                                 │
│                  ┌───────────┐                           │
│                  │  db.js    │  SQLite                   │
│                  └─────┬─────┘                           │
└────────────────────────┼─────────────────────────────────┘
                         ▼
                  ┌─────────────┐
                  │ chat.db     │  4 张表
                  └─────────────┘
```

**两条通道的分工（这是全项目最核心的概念）：**

| | REST API（HTTP） | Socket.IO（WebSocket） |
|---|---|---|
| 谁主动 | 浏览器主动问，服务端答 | 服务端可以主动推 |
| 生命周期 | 一问一答，答完就断 | 建立后一直连着 |
| 用来干 | 注册、登录、拉历史、拉房间 | 收新消息、在线用户变化 |
| 类比 | 打电话问一句挂掉 | 一直开着的对讲机 |

---

## 2. 页面设计

### 2.1 页面清单

| 页面 | 文件 | 是否需要登录 | 职责 |
|---|---|---|---|
| 注册页 | `public/register.html` | 否 | 提交用户名/密码，成功后跳登录页 |
| 登录页 | `public/login.html` | 否 | 提交用户名/密码，拿到 token 存 localStorage，跳聊天页 |
| 聊天大厅 | `public/chat.html` | **是** | 三栏：房间列表 / 消息区 / 在线用户 |
| 私聊窗口 | 复用 `chat.html` 内的模块 | **是** | 点在线用户弹出，独立消息流 |
| 入口页 | `public/index.html` | 否 | 简单跳转：有 token 去 chat，没有去 login |

### 2.2 聊天大厅布局（桌面端）

```
┌────────────┬────────────────────────────────┬──────────────┐
│  房间列表   │          消息区                 │   在线用户    │
│            │                                │              │
│ # 学习区    │  ┌──────────────────────────┐  │ ● 小明        │
│ # 游戏区    │  │ 小明：有人在吗            │  │ ● 小红        │
│ # 闲聊区    │  └──────────────────────────┘  │ ● 我(自己)    │
│            │        ┌──────────────────────┐  │              │
│            │        │      我：在的  ┃右对齐 │  │              │
│            │        └──────────────────────┘  │              │
│            │                                │              │
│            ├────────────────────────────────┤              │
│            │ [输入框...............] [发送]  │              │
└────────────┴────────────────────────────────┴──────────────┘
```

### 2.3 移动端适配（< 768px）

- 三栏 → 单栏堆叠
- 房间列表收起为顶部横向滚动条
- 在线用户收起为顶部头像条 / 侧滑抽屉
- 输入框固定在底部，`position: fixed` + `env(safe-area-inset-bottom)`
- `meta viewport` 必须写：`width=device-width, initial-scale=1, maximum-scale=1`

### 2.4 页面状态流转

```
未登录 ──[注册成功]──> 登录页 ──[登录成功]──> 聊天大厅
   ▲                      ▲                    │
   │                      │                    │
   └────[token 失效/过期]──┴────────────────────┘
```

**关键规则：** 每个受保护页面加载时，第一步读 `localStorage.token`，没有就 `location.href = '/login.html'`。

---

## 3. 数据库设计

### 3.1 表关系图（ER）

```
┌──────────┐                         ┌──────────┐
│  users   │                         │  rooms   │
│──────────│                         │──────────│
│ id    PK │                         │ id    PK │
│ username │                         │ name     │
│ pass_hash│                         │ created_at│
│ avatar   │                         └────┬─────┘
│ created_at│                            │
└────┬─────┘                             │
     │                                   │
     │  ┌────────────────────────────────┘
     │  │
     │  ▼
┌────┴───────────────┐
│     messages       │
│────────────────────│
│ id          PK     │
│ room_id     FK → rooms.id
│ sender_id   FK → users.id
│ content            │
│ type               │
│ created_at         │
└────────────────────┘

┌────────────────────┐
│  private_messages  │
│────────────────────│
│ id          PK     │
│ sender_id   FK → users.id
│ receiver_id FK → users.id
│ content            │
│ created_at         │
└────────────────────┘
```

### 3.2 表结构明细

#### users（用户表）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK, AUTOINCREMENT | 主键 |
| username | TEXT | UNIQUE, NOT NULL | 用户名，登录用 |
| password_hash | TEXT | NOT NULL | **bcrypt 哈希，绝不存明文** |
| avatar | TEXT | DEFAULT NULL | 头像 URL／emoji，可空 |
| created_at | TEXT | NOT NULL | ISO8601 字符串 |

> 注意：SQLite 没有原生 DATETIME 类型，用 `TEXT` 存 ISO8601（`new Date().toISOString()`）最省事，排序也正确。

#### rooms（房间表）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK, AUTOINCREMENT | 主键 |
| name | TEXT | UNIQUE, NOT NULL | 房间名 |
| created_at | TEXT | NOT NULL | ISO8601 |

初始化数据：`学习区` / `游戏区` / `闲聊区`

#### messages（公共房间消息表）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK, AUTOINCREMENT | 主键 |
| room_id | INTEGER | NOT NULL, FK→rooms(id) | 所属房间 |
| sender_id | INTEGER | NOT NULL, FK→users(id) | 发送者 |
| content | TEXT | NOT NULL | 消息正文 |
| type | TEXT | DEFAULT 'text' | `text` / `image` / `system` |
| created_at | TEXT | NOT NULL | ISO8601 |

#### private_messages（私聊消息表）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | INTEGER | PK, AUTOINCREMENT | 主键 |
| sender_id | INTEGER | NOT NULL, FK→users(id) | 发送者 |
| receiver_id | INTEGER | NOT NULL, FK→users(id) | 接收者 |
| content | TEXT | NOT NULL | 消息正文 |
| created_at | TEXT | NOT NULL | ISO8601 |

### 3.3 建表 SQL（第 3 阶段直接抄）

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  avatar        TEXT    DEFAULT NULL,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    INTEGER NOT NULL REFERENCES rooms(id),
  sender_id  INTEGER NOT NULL REFERENCES users(id),
  content    TEXT    NOT NULL,
  type       TEXT    NOT NULL DEFAULT 'text',
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS private_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id   INTEGER NOT NULL REFERENCES users(id),
  receiver_id INTEGER NOT NULL REFERENCES users(id),
  content     TEXT    NOT NULL,
  created_at  TEXT    NOT NULL
);

-- 索引：这两张表将来数据最多，按查询条件建索引
CREATE INDEX IF NOT EXISTS idx_messages_room    ON messages(room_id, id);
CREATE INDEX IF NOT EXISTS idx_pm_pair          ON private_messages(sender_id, receiver_id, id);
```

### 3.4 常用查询（写代码时会用到）

```sql
-- 拉某房间最近 50 条（倒序取再翻转，避免全表扫描）
SELECT m.id, m.content, m.type, m.created_at,
       u.id AS sender_id, u.username, u.avatar
FROM messages m
JOIN users u ON u.id = m.sender_id
WHERE m.room_id = ?
ORDER BY m.id DESC
LIMIT 50;

-- 拉两个人的私聊记录（A→B 和 B→A 都要）
SELECT * FROM private_messages
WHERE (sender_id = ? AND receiver_id = ?)
   OR (sender_id = ? AND receiver_id = ?)
ORDER BY id DESC
LIMIT 50;
```

---

## 4. REST API 设计

### 4.1 统一约定

- 前缀一律 `/api`
- 请求/响应体都是 JSON，`Content-Type: application/json`
- 需要登录的接口，请求头带：`Authorization: Bearer <token>`
- 响应格式固定：

```json
// 成功
{ "ok": true, "data": { ... } }

// 失败
{ "ok": false, "error": "用户名已存在" }
```

- 状态码：`200` 成功 / `201` 创建成功 / `400` 参数错误 / `401` 未登录或 token 失效 / `403` 无权限 / `409` 冲突（如用户名重复）/ `500` 服务端错误

### 4.2 接口清单

#### POST /api/register — 注册

**无需登录**

请求：
```json
{ "username": "xiaoming", "password": "123456" }
```

成功 `201`：
```json
{ "ok": true, "data": { "id": 1, "username": "xiaoming" } }
```

失败：
- `400` 用户名或密码为空 / 用户名长度不在 3–20
- `400` 密码长度小于 6
- `409` 用户名已存在

**服务端要做的事：**
1. 校验参数
2. `SELECT` 查用户名是否已存在
3. `bcrypt.hash(password, 10)` 加密
4. `INSERT INTO users`
5. 返回新用户信息（**绝不返回 password_hash**）

---

#### POST /api/login — 登录

**无需登录**

请求：
```json
{ "username": "xiaoming", "password": "123456" }
```

成功 `200`：
```json
{
  "ok": true,
  "data": {
    "token": "eyJhbGciOi...",
    "user": { "id": 1, "username": "xiaoming", "avatar": null }
  }
}
```

失败：
- `401` 用户名或密码错误（**统一提示，不区分**，防止撞库探测用户名是否存在）

**服务端要做的事：**
1. 按 username 查用户，查不到也返回 401
2. `bcrypt.compare(password, user.password_hash)`
3. 比对通过 → `jwt.sign({ id, username }, JWT_SECRET, { expiresIn: '7d' })`
4. 返回 token + 用户信息

---

#### GET /api/me — 获取当前用户

**需要登录**

响应头：`Authorization: Bearer <token>`

成功 `200`：
```json
{ "ok": true, "data": { "id": 1, "username": "xiaoming", "avatar": null } }
```

失败 `401`：token 缺失/伪造/过期

**用途：** 前端每次打开 `chat.html` 先调一次，验证 token 还有效。

---

#### GET /api/rooms — 获取房间列表

**需要登录**

成功 `200`：
```json
{
  "ok": true,
  "data": [
    { "id": 1, "name": "学习区" },
    { "id": 2, "name": "游戏区" },
    { "id": 3, "name": "闲聊区" }
  ]
}
```

---

#### GET /api/messages — 获取历史消息

**需要登录**

查询参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| roomId | 是 | 房间 ID |
| before | 否 | 消息 ID，取比它更早的（分页用） |
| limit | 否 | 默认 50，最大 100 |

示例：`GET /api/messages?roomId=1&limit=50`

成功 `200`：
```json
{
  "ok": true,
  "data": [
    {
      "id": 12,
      "roomId": 1,
      "content": "有人在吗",
      "type": "text",
      "createdAt": "2026-09-15T08:30:00.000Z",
      "sender": { "id": 1, "username": "xiaoming", "avatar": null }
    }
  ]
}
```

> **注意返回顺序：** 数据库里 `ORDER BY id DESC` 取，返回给前端前 `reverse()` 一次，让前端拿到的是从旧到新，直接 append 即可。

---

#### GET /api/private-messages — 获取私聊记录

**需要登录**

| 参数 | 必填 | 说明 |
|---|---|---|
| withUserId | 是 | 对方用户 ID |
| limit | 否 | 默认 50 |

成功 `200`：结构与 `/api/messages` 类似，`sender` 字段为发送者信息。

---

### 4.3 鉴权中间件设计（auth.js 核心逻辑说明）

```
function auth(req, res, next):
  1. 从 req.headers.authorization 取字符串
  2. 判断是否以 "Bearer " 开头，不是 → 401
  3. 切出 token
  4. jwt.verify(token, JWT_SECRET)
     ├─ 抛错（过期/伪造）→ 401
     └─ 成功 → req.user = { id, username }，next()
```

**Socket.IO 的鉴权不一样：** WebSocket 握手时没有 `Authorization` 头方便传，做法是在连接时通过 `socket.handshake.auth.token` 传 token，服务端在 `io.use()` 中间件里 `jwt.verify`，验不过直接拒绝连接。

---

## 5. Socket.IO 事件设计

### 5.1 连接流程

```
客户端连接时带 token：
  io({ auth: { token: localStorage.getItem('token') } })

服务端：
  io.use((socket, next) => { 验 token，通过则 socket.user = payload; next() })
       ↓
  io.on('connection', socket => { ... })
```

### 5.2 客户端 → 服务端（emit）

#### `join_room`

切换房间时发。服务端负责离开旧房间、加入新房间、更新在线列表。

```js
socket.emit('join_room', { roomId: 2 }, (ack) => { /* 可选回调 */ })
```

服务端响应动作：
1. 离开之前所有 `room:*` 房间
2. `socket.join('room:' + roomId)`
3. 更新该房间在线用户
4. 向该房间广播 `online_users`
5. 可选：广播一条 `system` 类型消息「xxx 加入了房间」

#### `send_message`

在公共房间发消息。

```js
socket.emit('send_message', { roomId: 2, content: '大家好' })
```

服务端响应动作：
1. 校验 content 非空、长度 ≤ 2000
2. `INSERT INTO messages`
3. 读回完整记录（带自增 id 和时间）
4. 向 `room:2` 广播 `new_message`

#### `private_message`

发私聊。

```js
socket.emit('private_message', { toUserId: 5, content: '在吗' })
```

服务端响应动作：
1. 校验
2. 写入 `private_messages`
3. **只推给接收者 + 发送者自己**（各端一个 socket），不广播给其他人
4. 事件名同样是 `new_private_message`

#### `typing`（可选，第 9 阶段加）

```js
socket.emit('typing', { roomId: 2 })
```

---

### 5.3 服务端 → 客户端（on）

#### `online_users`

房间在线用户变化时推送（有人进来/离开/切房间）。

```json
{
  "roomId": 2,
  "users": [
    { "id": 1, "username": "xiaoming", "avatar": null },
    { "id": 5, "username": "xiaohong", "avatar": null }
  ]
}
```

> **服务端要维护的数据结构（关键）：**
> ```js
> // userId -> Set<socketId>  一个人可能开多个标签页
> const onlineUsers = new Map()
> // socketId -> { userId, username, roomId }
> const socketMeta = new Map()
> ```
> 判断"用户真的离线"要看他的 Set 是否空了，不能一断 socket 就认为人走了。

#### `new_message`

公共房间新消息。

```json
{
  "id": 13,
  "roomId": 2,
  "content": "大家好",
  "type": "text",
  "createdAt": "2026-09-15T08:31:00.000Z",
  "sender": { "id": 1, "username": "xiaoming", "avatar": null }
}
```

#### `new_private_message`

私聊新消息，只发给收发双方。

```json
{
  "id": 3,
  "content": "在吗",
  "createdAt": "2026-09-15T08:32:00.000Z",
  "sender":   { "id": 1, "username": "xiaoming" },
  "receiver": { "id": 5, "username": "xiaohong" }
}
```

#### `history_messages`

> ⚠️ **设计决策：** 原模板里把历史消息放在 Socket 事件里。我建议**改成走 REST**（`GET /api/messages`）。
> 理由：历史消息是"一次性拉取"的请求-响应模式，天然适合 HTTP；走 REST 更好调试、能走缓存、出错有明确状态码。
> 如果后面你更想用 Socket 版，保留这个事件名即可：`socket.emit('get_history', {roomId}, ack)` → 服务端通过 ack 回调返回，比单独 `history_messages` 事件更干净。

#### `error`

服务端出错统一推这个。

```json
{ "message": "消息内容不能为空", "code": "EMPTY_CONTENT" }
```

前端收到后在消息区顶部弹一条红色提示。

### 5.4 断线重连

Socket.IO 自带重连，配置：

```js
io({
  auth: { token },
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000
})
```

前端监听：

```js
socket.on('connect', () => { /* 重连成功：重新 join_room + 重新拉历史 */ })
socket.on('disconnect', () => { /* 顶栏显示「连接已断开，重连中...」 */ })
```

**重连后必须做的事：** 重新 `join_room`，因为服务端内存里的房间成员表已经把你清掉了。

---

## 6. 安全设计要点

| 风险 | 应对 |
|---|---|
| 密码泄露 | bcrypt 哈希（cost 10），**永不存明文、永不返回给前端** |
| 撞库探测用户名 | 登录失败统一返回「用户名或密码错误」 |
| Token 被伪造 | JWT 用 HS256 签名，密钥放 `.env` 的 `JWT_SECRET`，不进 Git |
| Token 永久有效 | `expiresIn: '7d'` |
| SQL 注入 | **全部用参数化查询** `db.run(sql, [a, b])`，绝不字符串拼接 |
| 未登录偷聊天 | REST 走 `auth` 中间件，Socket 走 `io.use()` 中间件 |
| XSS（消息里塞 `<script>`） | 前端渲染消息**用 `textContent` 而不是 `innerHTML`**，或先转义 |
| 私聊被偷看 | 服务端只推给收发双方，且校验 `toUserId` 存在 |
| 密钥进仓库 | `.gitignore` 加 `.env`、`node_modules/`、`chat.db` |

### `.env` 示例

```env
PORT=3000
JWT_SECRET=换成你自己的随机长字符串_别用这个
DB_PATH=./chat.db
```

---

## 7. 项目文件结构（对应实现）

```
chat-app/
├── .env                    # 环境变量（不进 Git）
├── .gitignore
├── package.json
├── design.md               # 本文档
├── README.md               # 项目说明（第 10 阶段完善）
├── chat.db                 # SQLite 数据库文件（不进 Git）
│
├── server/
│   ├── index.js            # 入口：Express + HTTP server + Socket.IO 挂载
│   ├── db.js               # SQLite 连接 + 建表 + 默认房间
│   ├── auth.js             # JWT 签发/校验 + Express 鉴权中间件
│   ├── routes/
│   │   ├── auth.routes.js  # /api/register  /api/login  /api/me
│   │   ├── rooms.routes.js # /api/rooms
│   │   └── messages.routes.js # /api/messages  /api/private-messages
│   └── sockets/
│       ├── index.js        # io 初始化 + io.use 鉴权 + connection 入口
│       ├── chat.js         # join_room / send_message
│       ├── private.js      # private_message
│       └── presence.js     # 在线用户表维护（onlineUsers / socketMeta）
│
└── public/
    ├── index.html          # 入口跳转
    ├── login.html
    ├── register.html
    ├── chat.html
    ├── css/
    │   └── style.css
    └── js/
        ├── api.js          # fetch 封装（自动带 token、统一错误处理）
        ├── auth.js         # 登录注册页逻辑
        └── chat.js         # 聊天页逻辑：Socket + 消息渲染 + 房间切换 + 私聊
```

---

## 8. 关键实现决策（提前定好，避免返工）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 数据库驱动 | `sqlite3`（原始模板指定） | 教学友好，能看清 SQL。**若想要更简洁的同步写法，可换 `better-sqlite3`**，API 更直观且更快，代价是装的时候需要编译 |
| 时间存储 | TEXT + ISO8601 | SQLite 无原生日期类型，字符串排序即时间排序 |
| 历史消息通道 | REST，不用 Socket | 请求-响应模式天然适合 HTTP，好调试 |
| 房间成员维护 | 内存 Map | 单机部署够用；将来多实例再换 Redis |
| 前后端是否分离 | 不分离，Express 直接 `static` 托管 `public/` | 省掉跨域配置，部署简单 |
| token 存放 | `localStorage` | 简单；生产环境更推荐 httpOnly Cookie（会被 CSRF 影响，需要额外防护，本项目从简） |
| 消息渲染防 XSS | `textContent` | 一行代码解决，比 innerHTML 安全 |

---

## 9. 分阶段验收对照

| 阶段 | 验收标准 | 对应本文章节 |
|---|---|---|
| 第 2 阶段 | `localhost:3000` 返回「聊天室后端运行中」 | §7 文件结构 |
| 第 3 阶段 | DB Browser 能看到 4 张表 + 3 个默认房间 | §3.3 |
| 第 4 阶段 | Postman 能注册、登录、拿到 token | §4.2 |
| 第 5 阶段 | 能注册登录跳转，刷新后仍是登录态 | §2.4 |
| 第 6 阶段 | 两个浏览器窗口实时聊天 | §5.2 §5.3 |
| 第 7 阶段 | 刷新后历史还在；在线列表实时变 | §3.4 §5.3 |
| 第 8 阶段 | 能切房间、能一对一私聊 | §5.2 |
| 第 9 阶段 | 手机能用；断网重连能恢复 | §2.3 §5.4 |
| 第 10 阶段 | 公网可访问 | §6 |

---

## 10. 待确认事项

1. **数据库驱动**：用 `sqlite3` 还是换成 `better-sqlite3`？（建议后者，写起来少一层回调）
2. **历史消息通道**：同意改成 REST 吗？（建议同意）
3. **是否需要头像上传**：`users.avatar` 先留空，第 9 阶段再补；还是现在就要做？
4. **是否需要注册邀请码**：公网部署后容易被机器人注册，可以加一个简单邀请码。

---

*本文档随开发推进持续更新。*
