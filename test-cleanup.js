/**
 * test-cleanup.js —— 清理测试数据
 *
 * 测试脚本每次运行都会注册几个账号（sockA.../sockB.../sockC...），
 * 还会往房间里塞几十条消息。跑十几次之后数据库里就全是垃圾，
 * 而且会干扰下次测试（比如历史消息条数断言）。
 *
 * 这个模块负责把"测试造出来的东西"删干净：
 *   1. 消息表里 sender 是测试账号的
 *   2. 私聊表里收发双方任意一方是测试账号的
 *   3. 用户表里的测试账号
 *
 * 判定标准：用户名以 sock / 验收 / 前端测试 / 流程测试 开头。
 *
 * ⚠️ 删除顺序很重要：
 *   messages 和 private_messages 都有指向 users 的外键约束，
 *   如果先删 user，会因为"还有消息引用这个用户"而报错（外键约束开启时）。
 *   所以必须按"先子表（消息）后父表（用户）"的顺序删。
 */

const queries = require('./server/queries');

/** 测试账号的用户名前缀 */
const TEST_PREFIXES = [
  'sockA',    // test-socket.js 造的账号
  'sockB',
  'sockC',
  'e2eA',     // .verify/verify-stage6.cjs 造的账号
  'e2eB',
  '验收',      // 手工验收时用的
  '前端测试',
  '流程测试',
];

/**
 * 清理测试数据
 * @returns {number} 删掉的用户数
 */
function cleanupTestData() {
  const db = queries.raw;

  // 用 LIKE 拼出条件。这里的值是我们自己写死的常量，不涉及用户输入，
  // 但仍然走参数化 —— 形成习惯，免得哪天不小心把变量拼进去。
  const where = TEST_PREFIXES.map(() => 'username LIKE ?').join(' OR ');
  const patterns = TEST_PREFIXES.map((p) => p + '%');

  const users = db.prepare(`SELECT id FROM users WHERE ${where}`).all(...patterns);
  if (users.length === 0) return 0;

  const ids = users.map((u) => u.id);
  const placeholders = ids.map(() => '?').join(',');

  // 手动事务：三条 DELETE 要么全成要么全不成，避免删一半留下孤儿数据
  db.exec('BEGIN');
  try {
    // 1. 先删消息（子表）
    db.prepare(`DELETE FROM messages WHERE sender_id IN (${placeholders})`).run(...ids);

    // 2. 私聊：发送方或接收方命中都要删
    db.prepare(
      `DELETE FROM private_messages WHERE sender_id IN (${placeholders}) OR receiver_id IN (${placeholders})`
    ).run(...ids, ...ids);

    // 3. 最后删用户（父表）
    db.prepare(`DELETE FROM users WHERE id IN (${placeholders})`).run(...ids);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return ids.length;
}

module.exports = { cleanupTestData, TEST_PREFIXES };

// 允许直接运行：node test-cleanup.js
if (require.main === module) {
  require('dotenv').config();
  const n = cleanupTestData();
  console.log(`已清理 ${n} 个测试账号及其消息`);
}
