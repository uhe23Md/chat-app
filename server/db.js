/**
 * db.js —— SQLite 数据库连接与初始化
 *
 * 职责：
 *   1. 打开（或创建）SQLite 数据库文件
 *   2. 建表（幂等，重复运行不会出错）
 *   3. 插入默认房间
 *   4. 导出 db 实例供其他模块使用
 *
 * 【技术选型说明】
 * 用的是 Node.js 24 内置的 `node:sqlite` 模块，不是第三方包。
 *
 * 为什么不用 better-sqlite3 / sqlite3？
 *   它们是"原生模块"（C++ 写的 .node 二进制），必须和 Node 的 ABI 版本严格对应。
 *   本机 Node 是 v24（NODE_MODULE_VERSION 137），而 npm 从缓存/镜像装到的
 *   预编译二进制是给 Node 22 编的（127），一加载就报 ERR_DLOPEN_FAILED；
 *   想从源码编译又需要 Visual Studio C++ 生成工具（约 6GB，且要管理员权限）。
 *
 *   `node:sqlite` 是 Node 官方内置的，随 Node 一起发布 —— 不需要装、不需要编译、
 *   不可能出现版本冲突，而且是同步 API（和 better-sqlite3 手感几乎一样）。
 *
 * ⚠️ 注意：`node:sqlite` 需要 Node.js >= 22.5，且目前是实验性特性，
 *    启动时会打印一条 ExperimentalWarning，**这是正常的，不影响使用**。
 *    如果将来要部署到 Node 20 的环境，需要改回 better-sqlite3 或 sqlite3。
 */

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// 数据库文件路径统一由 config.js 决定（读 process.env.DB_PATH，默认 ./chat.db）
// config.js 里已经用 path.resolve 转成绝对路径了，
// 避免"启动目录不同就找不到数据库"的坑 —— 线上平台的工作目录常常不是项目根目录。
const config = require('./config');
const DB_PATH = config.DB_PATH;

// 确保数据库文件所在目录存在（首次运行时目录可能还没有）
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// 打开数据库（文件不存在会自动创建）
const db = new DatabaseSync(DB_PATH);

// 开启 WAL 模式：读写并发性能更好，聊天室这种"一边读一边写"的场景收益明显
db.exec('PRAGMA journal_mode = WAL;');

// 开启外键约束。SQLite 默认是关闭的，不开启的话 FOREIGN KEY 写了也白写
db.exec('PRAGMA foreign_keys = ON;');

/**
 * 建表
 * 全部用 IF NOT EXISTS，所以这个函数随便重复调用都安全。
 * 表结构定义详见 design.md 第 3.2 节。
 */
function initSchema() {
  db.exec(`
    -- 用户表
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      avatar        TEXT    DEFAULT NULL,
      created_at    TEXT    NOT NULL
    );

    -- 房间表
    CREATE TABLE IF NOT EXISTS rooms (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL UNIQUE,
      created_at TEXT    NOT NULL
    );

    -- 公共房间消息表
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id    INTEGER NOT NULL REFERENCES rooms(id),
      sender_id  INTEGER NOT NULL REFERENCES users(id),
      content    TEXT    NOT NULL,
      type       TEXT    NOT NULL DEFAULT 'text',
      created_at TEXT    NOT NULL
    );

    -- 私聊消息表
    CREATE TABLE IF NOT EXISTS private_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id   INTEGER NOT NULL REFERENCES users(id),
      receiver_id INTEGER NOT NULL REFERENCES users(id),
      content     TEXT    NOT NULL,
      created_at  TEXT    NOT NULL
    );

    -- 索引：消息表将来数据最多，按 room_id 查询是最频繁的操作
    CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, id);
    -- 私聊查询要同时匹配"我发给谁"和"谁发给我"，建联合索引
    CREATE INDEX IF NOT EXISTS idx_pm_pair ON private_messages(sender_id, receiver_id, id);
  `);
}

/**
 * 插入默认房间
 *
 * 【node:sqlite 与 better-sqlite3 的 API 差异，这里踩到了】
 *   better-sqlite3：`db.transaction(fn)` 返回一个可调用的包装函数
 *   node:sqlite   ：没有这个辅助方法，要用裸 SQL 的 BEGIN / COMMIT / ROLLBACK
 * 好在事务本来就是 SQL 层面的东西，手写反而更透明。
 *
 * INSERT OR IGNORE：房间名有 UNIQUE 约束，已存在时静默跳过，
 * 所以重启服务不会重复插入，也不会报错。
 */
function seedRooms() {
  const insertRoom = db.prepare(
    'INSERT OR IGNORE INTO rooms (name, created_at) VALUES (?, ?)'
  );
  const now = new Date().toISOString();

  const defaultRooms = ['学习区', '游戏区', '闲聊区'];

  // 手动开启事务：三条插入要么全成功要么全失败，一致性更好
  db.exec('BEGIN');
  try {
    for (const name of defaultRooms) {
      insertRoom.run(name, now);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---- 初始化 ----
initSchema();
seedRooms();

// 打印一下当前库里的房间，方便确认初始化成功了
const roomCount = db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n;
console.log(`[db] 数据库就绪: ${DB_PATH}`);
console.log(`[db] 当前房间数: ${roomCount}`);

module.exports = db;
