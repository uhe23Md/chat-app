/**
 * test-auth.js —— 第 4 阶段接口自动化验收脚本
 *
 * 依次测试：
 *   1. 注册新用户              → 期望 201
 *   2. 用同样的用户名再注册一次  → 期望 409（用户名冲突）
 *   3. 密码太短                → 期望 400
 *   4. 用户名为空              → 期望 400
 *   5. 用正确密码登录           → 期望 200，拿到 token
 *   6. 用错误密码登录           → 期望 401
 *   7. 用不存在的用户名登录      → 期望 401（提示应与上一条完全相同）
 *   8. 带 token 访问 /api/me    → 期望 200
 *   9. 不带 token 访问 /api/me  → 期望 401
 *  10. 带伪造 token 访问 /api/me → 期望 401
 *  11. 查数据库确认密码是哈希，不是明文
 */

const BASE = 'http://localhost:3000';

// 用时间戳生成随机用户名，避免重复运行时撞上"用户名已存在"
const TEST_USER = `测试用户${Date.now().toString().slice(-6)}`;
const TEST_PASS = 'test123456';

let passed = 0;
let failed = 0;

/** 发一个请求，返回 { status, body } */
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  return { status: res.status, body: json };
}

/** 断言并打印结果 */
function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  ✅ ${label}  →  ${actual}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}  →  实际 ${actual}，期望 ${expected}`);
  }
}

async function main() {
  console.log(`\n测试用户: ${TEST_USER} / ${TEST_PASS}\n`);
  console.log('─'.repeat(60));

  // ---- 1. 注册 ----
  console.log('\n【1】注册新用户');
  const reg = await req('POST', '/api/register', {
    body: { username: TEST_USER, password: TEST_PASS },
  });
  check('状态码', reg.status, 201);
  check('返回 ok=true', reg.body?.ok, true);
  check('返回用户名正确', reg.body?.data?.username, TEST_USER);
  check('未泄露密码字段', reg.body?.data?.password_hash, undefined);
  console.log(`     返回: ${JSON.stringify(reg.body)}`);

  // ---- 2. 重复注册 ----
  console.log('\n【2】重复用户名注册');
  const reg2 = await req('POST', '/api/register', {
    body: { username: TEST_USER, password: TEST_PASS },
  });
  check('状态码', reg2.status, 409);
  console.log(`     提示: ${reg2.body?.error}`);

  // ---- 3. 密码太短 ----
  console.log('\n【3】密码太短（3位）');
  const reg3 = await req('POST', '/api/register', {
    body: { username: `短密码${Date.now().toString().slice(-4)}`, password: '123' },
  });
  check('状态码', reg3.status, 400);
  console.log(`     提示: ${reg3.body?.error}`);

  // ---- 4. 用户名为空 ----
  console.log('\n【4】用户名为空');
  const reg4 = await req('POST', '/api/register', {
    body: { username: '', password: TEST_PASS },
  });
  check('状态码', reg4.status, 400);
  console.log(`     提示: ${reg4.body?.error}`);

  // ---- 5. 正确登录 ----
  console.log('\n【5】用正确密码登录');
  const login = await req('POST', '/api/login', {
    body: { username: TEST_USER, password: TEST_PASS },
  });
  check('状态码', login.status, 200);
  check('拿到 token', typeof login.body?.data?.token === 'string', true);
  const token = login.body?.data?.token;
  console.log(`     token 前 40 字: ${token?.slice(0, 40)}...`);
  console.log(`     用户信息: ${JSON.stringify(login.body?.data?.user)}`);

  // ---- 6. 错误密码 ----
  console.log('\n【6】用错误密码登录');
  const badLogin = await req('POST', '/api/login', {
    body: { username: TEST_USER, password: '错误的密码xxxx' },
  });
  check('状态码', badLogin.status, 401);
  const msgWrongPass = badLogin.body?.error;
  console.log(`     提示: ${msgWrongPass}`);

  // ---- 7. 不存在的用户名 ----
  console.log('\n【7】用不存在的用户名登录');
  const noUser = await req('POST', '/api/login', {
    body: { username: '根本不存在的用户xyz', password: TEST_PASS },
  });
  check('状态码', noUser.status, 401);
  const msgNoUser = noUser.body?.error;
  console.log(`     提示: ${msgNoUser}`);
  check('提示语与密码错误时完全一致（防探测）', msgNoUser === msgWrongPass, true);

  // ---- 8. 带 token 访问 /api/me ----
  console.log('\n【8】带有效 token 访问 /api/me');
  const me = await req('GET', '/api/me', { token });
  check('状态码', me.status, 200);
  check('返回的是本人', me.body?.data?.username, TEST_USER);
  console.log(`     返回: ${JSON.stringify(me.body)}`);

  // ---- 9. 不带 token ----
  console.log('\n【9】不带 token 访问 /api/me');
  const noToken = await req('GET', '/api/me');
  check('状态码', noToken.status, 401);
  console.log(`     提示: ${noToken.body?.error}`);

  // ---- 10. 伪造 token ----
  console.log('\n【10】带伪造 token 访问 /api/me');
  const fakeToken = await req('GET', '/api/me', {
    token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwidXNlcm5hbWUiOiJoYWNrZXIifQ.fake_signature',
  });
  check('状态码', fakeToken.status, 401);
  console.log(`     提示: ${fakeToken.body?.error}`);

  // ---- 11. 检查数据库里的密码 ----
  console.log('\n【11】检查数据库：密码是否为哈希');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('./chat.db');
  const row = db
    .prepare('SELECT id, username, password_hash, created_at FROM users WHERE username = ?')
    .get(TEST_USER);
  db.close();

  if (row) {
    const isHashed = row.password_hash.startsWith('$2');
    check('密码已加密（以 $2 开头，bcrypt 格式）', isHashed, true);
    check('密码不等于明文', row.password_hash !== TEST_PASS, true);
    console.log(`     存的值: ${row.password_hash.slice(0, 50)}...`);
    console.log(`     明文密码 "${TEST_PASS}" 是否出现在库里: ${row.password_hash.includes(TEST_PASS)}`);
  } else {
    failed++;
    console.log('  ❌ 数据库里没找到刚才注册的用户');
  }

  // ---- 汇总 ----
  console.log('\n' + '─'.repeat(60));
  console.log(`\n汇总：通过 ${passed} 项，失败 ${failed} 项\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n测试脚本本身出错：', err);
  process.exit(1);
});
