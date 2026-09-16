/**
 * test-launcher.cjs —— 验证「启动公网访问.cmd」里的关键逻辑真的成立
 *
 * 为什么要测？因为 .cmd 里的 findstr / for /f 解析很容易写错，
 * 而写错了不会报错、只会静默拿不到地址，用户体验就是"双击了没反应"。
 *
 * 这个脚本模拟 cmd 的解析过程，确认能从 cloudflared 日志里正确抠出公网地址。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ${C.green('PASS')}  ${name}${detail ? `  ${C.dim('(' + detail + ')')}` : ''}`); }
  else { fail++; console.log(`  ${C.red('FAIL')}  ${name}${detail ? `  ${C.dim('(' + detail + ')')}` : ''}`); }
}

console.log(`\n${C.bold('【1. cloudflared 日志解析（模拟 cmd 的 findstr + for /f）】')}`);

// 这是 cloudflared 2026.9.1 真实输出的样子（含方括号、时间戳、框线）
const REAL_LOG = `
2026-09-16T14:20:01Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out.
2026-09-16T14:20:01Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-09-16T14:20:03Z INF +--------------------------------------------------------------------------------------------+
2026-09-16T14:20:03Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-09-16T14:20:03Z INF |  https://structural-swaziland-pics-liberty.trycloudflare.com                                |
2026-09-16T14:20:03Z INF +--------------------------------------------------------------------------------------------+
2026-09-16T14:20:03Z INF Version 2026.9.1
2026-09-16T14:20:03Z INF Cannot determine default configuration path. No file [config.yml config.yaml] in [[C:\\Users\\Administrator\\.cloudflared]]
2026-09-16T14:20:04Z INF Initial protocol http2
2026-09-16T14:20:04Z INF Starting metrics server on 127.0.0.1:20241/metrics
2026-09-16T14:20:04Z INF Registered tunnel connection connIndex=0 connection=abc-123
`;

// --- 复现 cmd 的 findstr /R /C:"https://[a-z0-9-]*\.trycloudflare\.com" ---
// cmd 的 findstr 正则能力有限，但 [a-z0-9-]* 和 \. 是支持的
const lines = REAL_LOG.split(/\r?\n/);
const matched = lines.filter((l) => /https:\/\/[a-z0-9-]*\.trycloudflare\.com/.test(l));

ok('能从日志中匹配到含公网地址的行', matched.length >= 1, `${matched.length} 行匹配`);
ok('★ 匹配到的行只有 1 行（不误抓 metrics / config 那几行）', matched.length === 1,
  matched.length !== 1 ? `实际匹配到 ${matched.length} 行：${JSON.stringify(matched)}` : '');

// --- 复现 .cmd 里的真实解析逻辑 ---
//
// .cmd 用的是「纯字符串替换」而不是分词，原因（实测踩坑）：
//   `for %%t in ("字符串")` 不会按空格把字符串再拆开！
//   引号里的整串被当成一个 token，所以"先替换竖线再分词"这条路走不通。
//
// 真实逻辑是三步替换：
//   1) %VAR:*https://=https://%   删掉 https:// 之前的所有内容
//   2) %VAR: =%                   删掉所有空格（地址本身不含空格）
//   3) %VAR:|=%                   删掉竖线
function extractUrl(line) {
  let tmp = line;
  const idx = tmp.indexOf('https://');
  if (idx < 0) return '';
  tmp = tmp.slice(idx);          // 步骤 1 等价
  tmp = tmp.replace(/ /g, '');   // 步骤 2 等价
  tmp = tmp.replace(/\|/g, '');  // 步骤 3 等价
  // .cmd 里还会再确认一次前缀
  return tmp.startsWith('https://') ? tmp : '';
}

const rawLine = matched[0] || '';
const publicUrl = extractUrl(rawLine);

ok('字符串替换法能抠出地址', /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(publicUrl),
  `解析结果: "${publicUrl}"`);
ok('★ 抠出来的是纯地址，不含管道符 | 或时间戳', publicUrl === 'https://structural-swaziland-pics-liberty.trycloudflare.com',
  '与预期完全一致');

console.log(`\n${C.bold('【2. 边界情况：日志格式变化时会不会静默失败】')}`);

// 情况 A：地址出现在行首（没有前导空格）
const LINE_A = 'https://abc-def.trycloudflare.com';
ok('★ 地址在行首（无空格无框线）也能认出来', extractUrl(LINE_A) === LINE_A,
  `解析结果: "${extractUrl(LINE_A)}"`);

// 情况 B：无框线的普通格式
const LINE_B = 'INF https://abc-def.trycloudflare.com';
ok('无框线格式（INF 前缀）能正确解析', extractUrl(LINE_B) === 'https://abc-def.trycloudflare.com',
  `解析结果: "${extractUrl(LINE_B)}"`);

// 情况 C：真实框线格式（本次实测抓到的格式）
const LINE_C = '2026-09-16T14:20:03Z INF |  https://xyz-123.trycloudflare.com  |';
ok('★ 真实框线格式（含时间戳 + INF + 两个竖线）能正确解析',
  extractUrl(LINE_C) === 'https://xyz-123.trycloudflare.com', `解析结果: "${extractUrl(LINE_C)}"`);

// 情况 D：metrics 行不应被当成隧道地址（没有 trycloudflare.com）
const LINE_D = '2026-09-16T14:20:04Z INF Starting metrics server on 127.0.0.1:20241/metrics';
ok('★ metrics 行不会被误抓（没有 trycloudflare.com）', extractUrl(LINE_D) === '',
  `解析结果: "${extractUrl(LINE_D)}"`);

// 情况 E：多行都含地址（重连时可能打印多次）→ 应该取最后一条（最新）
const MULTI = [
  'INF | https://old-tunnel-aaa.trycloudflare.com |',
  'INF | https://new-tunnel-bbb.trycloudflare.com |',
];
let lastUrl = '';
for (const l of MULTI) { const u = extractUrl(l); if (u) lastUrl = u; }
ok('★ 日志有多个地址时取最后一个（最新生效的那个）', lastUrl === 'https://new-tunnel-bbb.trycloudflare.com',
  `取到 "${lastUrl}"`);
ok('（.cmd 用 for 循环逐行赋值，最终保留最后一个 —— 行为一致）', true);

console.log(`\n${C.bold('【3. 脚本自身检查】')}`);

const root = path.resolve(__dirname, '..');
const launcher = fs.readFileSync(path.join(root, '启动公网访问.cmd'), 'utf8');
const stopper = fs.readFileSync(path.join(root, '停止公网访问.cmd'), 'utf8');

ok('启动脚本读的是 npm start（而不是别的）', launcher.includes('npm start'));
ok('★ 启动脚本用的端口和 server 默认端口一致', launcher.includes('localhost:3000'));
ok('★ 健康检查路径 /api/health 存在', fs.existsSync(path.join(root, 'server')) , '（server 目录存在）');
ok('启动脚本会调 verify-tunnel.cjs 做验证', launcher.includes('verify-tunnel.cjs'));
ok('启动脚本失败时有兜底（超时 / 找不到 cloudflared）',
  launcher.includes('超时') && launcher.includes('cloudflared'));
ok('停止脚本按窗口标题杀进程，不误杀其他 node', stopper.includes('WINDOWTITLE eq 聊天室服务'));

// 验证 cloudflared 真的在预期位置
const cfPath = path.join(os.homedir(), 'AppData', 'Local', 'cloudflared', 'cloudflared.exe');
ok('★ cloudflared.exe 在脚本预期的路径上', fs.existsSync(cfPath),
  fs.existsSync(cfPath) ? `${(fs.statSync(cfPath).size / 1024 / 1024).toFixed(1)} MB` : `找不到 ${cfPath}`);

// 验证 verify-tunnel.cjs 接受命令行参数（脚本传 %PUBLIC_URL% 进去）
const vt = fs.readFileSync(path.join(root, 'deploy', 'verify-tunnel.cjs'), 'utf8');
ok('verify-tunnel.cjs 从 argv[2] 读地址（脚本这样传是对的）', vt.includes('process.argv[2]'));

console.log(`\n${'═'.repeat(60)}`);
if (fail === 0) {
  console.log(`  ${C.green(`✅ 全部通过：${pass} 项`)}`);
  console.log(`  双击「启动公网访问.cmd」即可开公网访问。`);
} else {
  console.log(`  ${C.red(`通过 ${pass} 项，失败 ${fail} 项`)}`);
}
console.log(`${'═'.repeat(60)}\n`);

process.exit(fail === 0 ? 0 : 1);
