/**
 * security-scan.cjs —— 公开仓库前的安全体检
 *
 * 为什么必须做这件事？因为这个仓库是**公开**的，任何人都能 clone。
 * 一旦密钥进了公开仓库，就算你马上删掉，GitHub 的抓取机器人也早就
 * 存下来了——这类泄露是**不可逆**的。所以发布前必须逐项确认。
 *
 * 扫描三类东西：
 *   1) 密钥类：JWT 密钥、密码、token
 *   2) 数据库文件：里面存着真实的用户密码哈希和聊天记录
 *   3) 会被 git 跟踪的可疑文件
 *
 * 用法：node deploy/security-scan.cjs
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

let problems = 0;
let warnings = 0;

function bad(msg, detail = '') {
  problems++;
  console.log(`  ${C.red('危险')}  ${msg}${detail ? `\n        ${C.dim(detail)}` : ''}`);
}
function warn(msg, detail = '') {
  warnings++;
  console.log(`  ${C.yellow('注意')}  ${msg}${detail ? `\n        ${C.dim(detail)}` : ''}`);
}
function good(msg) {
  console.log(`  ${C.green('通过')}  ${msg}`);
}
function section(t) {
  console.log(`\n${C.bold('── ' + t + ' ──')}`);
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

// ============================================================
console.log(`\n${'═'.repeat(64)}`);
console.log(`  ${C.bold('公开仓库安全体检')}`);
console.log(`  ${ROOT}`);
console.log(`${'═'.repeat(64)}`);

// ── 1. 密钥文件是否被 git 忽略 ──
section('1. 密钥文件');

const secretFiles = ['.env', '.env.local', '.deploy-secret.txt'];
for (const f of secretFiles) {
  const full = path.join(ROOT, f);
  if (!fs.existsSync(full)) {
    good(`${f} 不存在（没东西可泄露）`);
    continue;
  }
  // --no-index 才能检查「假设它没被跟踪」时的忽略状态
  let ignored = false;
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', f], { cwd: ROOT });
    ignored = true;
  } catch { ignored = false; }

  if (ignored) {
    good(`${f} 存在，但被 .gitignore 挡住`);
  } else {
    bad(`${f} 存在且【没有被忽略】，会被推到公开仓库！`, `立即在 .gitignore 里加上 ${f}`);
  }
}

// ── 2. 数据库文件 ──
section('2. 数据库文件（含真实用户密码哈希 + 聊天记录）');

const dbFiles = fs.readdirSync(ROOT).filter((f) => /\.(db|db-shm|db-wal|sqlite|sqlite3)$/.test(f));
if (dbFiles.length === 0) {
  good('项目根目录没有数据库文件');
} else {
  for (const f of dbFiles) {
    const size = (fs.statSync(path.join(ROOT, f)).size / 1024).toFixed(0);
    let ignored = false;
    try {
      execFileSync('git', ['check-ignore', '-q', '--no-index', f], { cwd: ROOT });
      ignored = true;
    } catch { ignored = false; }
    if (ignored) {
      good(`${f}（${size} KB）被忽略`);
    } else {
      bad(`${f}（${size} KB）没被忽略！`, '里面有真实用户数据，绝不能公开');
    }
  }
}

// ── 3. git 实际跟踪的文件里有没有可疑的 ──
section('3. git 已跟踪的文件（这些才会真的推上去）');

let tracked = [];
try {
  tracked = git(['ls-files']).split('\n').filter(Boolean);
} catch (e) {
  bad('读不到 git 文件列表', e.message);
}
console.log(`  ${C.dim(`共 ${tracked.length} 个文件已被跟踪`)}`);

/**
 * 判断一个路径是不是「模板/示例」性质的 .env 文件。
 *
 * 为什么需要这个区分？.env.example 里全是占位值（change_me_xxx），
 * 它**本来就应该**进公开仓库——别人 clone 下来照着填自己的值。
 * 一刀切地把 .env* 全判为危险，会造成误报，反而让人忽略真正的告警。
 */
function isEnvTemplate(rel) {
  return /\.env\.(example|sample|template|dist)$/i.test(rel);
}

const suspiciousTracked = tracked.filter((f) => {
  if (isEnvTemplate(f)) return false;                 // 模板文件，放行
  return (
    /(^|\/)\.env($|\.)/.test(f) ||                    // 真实的 .env / .env.local
    /\.(db|db-shm|db-wal|sqlite|sqlite3)$/.test(f) ||
    /\.deploy-secret/.test(f) ||
    /(^|\/)id_(rsa|ed25519|ecdsa)/.test(f) ||
    /\.pem$/.test(f) ||
    /(^|\/)node_modules\//.test(f)
  );
});
if (suspiciousTracked.length === 0) {
  good('已跟踪文件里没有密钥 / 数据库 / node_modules');
  if (tracked.some(isEnvTemplate)) {
    good('.env.example 模板在仓库里（正确做法：只放占位值）');
  }
} else {
  for (const f of suspiciousTracked) bad(`已跟踪的可疑文件：${f}`);
}

// ── 4. 已跟踪文件的内容里有没有硬编码密钥 ──
section('4. 文件内容里的硬编码密钥');

// 只扫会被发布的源码，跳过二进制
const codeExts = ['.js', '.cjs', '.mjs', '.json', '.html', '.css', '.yaml', '.yml', '.md'];
const patterns = [
  { name: 'JWT 密钥赋值', re: /JWT_SECRET\s*[:=]\s*['"](?!process\.env|your-|xxx|changeme|generate|\$\{)[^'"]{12,}['"]/i },
  { name: '疑似真实密钥串', re: /['"][A-Za-z0-9+/]{43,}={0,2}['"]/ },
  { name: '硬编码密码', re: /password\s*[:=]\s*['"][^'"]{6,}['"]/i },
  { name: '私钥块', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'AWS / 云厂商 key', re: /(AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{32,})/ },
];

let contentHits = 0;
for (const rel of tracked) {
  if (!codeExts.includes(path.extname(rel))) continue;
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 跳过明显的示例 / 占位 / 注释说明
    if (/\bexample\b|\bplaceholder\b|占位|示例|TODO|FIXME|\*\*\*|\.\.\./.test(line)) continue;
    for (const p of patterns) {
      if (p.re.test(line)) {
        // 测试脚本里的假密钥是正常的，单独提示
        const isTestish = /(^|\/)(test-|verify|test_|\.verify\/)|deploy\/(test-|verify-)/.test(rel);
        if (isTestish) {
          warn(`${rel}:${i + 1} 命中「${p.name}」（测试脚本，通常是假的）`, line.trim().slice(0, 90));
        } else {
          bad(`${rel}:${i + 1} 命中「${p.name}」`, line.trim().slice(0, 90));
        }
        contentHits++;
        break;
      }
    }
  }
}
if (contentHits === 0) good('源码里没有发现硬编码的密钥');

// ── 5. 历史提交里有没有泄露过 ──
section('5. git 历史（最关键：历史里有过就永远算泄露）');

try {
  const allFiles = git(['log', '--all', '--pretty=format:', '--name-only'])
    .split('\n').filter(Boolean);
  const uniq = [...new Set(allFiles)];
  const leakedEver = uniq.filter((f) => {
    if (isEnvTemplate(f)) return false;               // 模板不算泄露
    return (
      /(^|\/)\.env($|\.)/.test(f) ||
      /\.(db|db-shm|db-wal|sqlite|sqlite3)$/.test(f) ||
      /\.deploy-secret/.test(f) ||
      /(^|\/)id_(rsa|ed25519)/.test(f)
    );
  });
  if (leakedEver.length === 0) {
    good('git 历史里从未出现过密钥 / 数据库文件');
  } else {
    for (const f of leakedEver) {
      bad(`历史提交里出现过：${f}`, '即使现在删了，历史里还查得到。公钥类需作废重签，密码类需改密码');
    }
  }
} catch (e) {
  warn('读不到 git 历史', e.message);
}

// ── 6. 远端仓库地址 ──
section('6. 远端仓库');
try {
  const remotes = git(['remote', '-v']);
  console.log(`  ${remotes.split('\n').join('\n  ')}`);
  if (/github\.com/.test(remotes)) {
    const m = remotes.match(/github\.com[:/]([^/\s]+)\/([^/\s.]+)/);
    if (m) {
      warn(`目标是 ${m[1]}/${m[2]}，请确认它是公开还是私有`, '公开仓库 = 全世界可见，含历史提交');
    }
  }
} catch {
  warn('还没配置远端仓库');
}

// ============================================================
console.log(`\n${'═'.repeat(64)}`);
if (problems === 0) {
  console.log(`  ${C.green('✅ 安全体检通过')}  ${C.dim(`（${warnings} 条提示，无需处理也能推）`)}`);
  console.log(`  ${C.dim('可以安全推送到公开仓库。')}`);
} else {
  console.log(`  ${C.red(`❌ 发现 ${problems} 个危险项，先修掉再推！`)}`);
}
console.log(`${'═'.repeat(64)}\n`);

process.exit(problems === 0 ? 0 : 1);
