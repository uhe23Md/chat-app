/**
 * push-github.cjs —— 一键推送项目到 GitHub
 *
 * 用法：
 *   node deploy/push-github.cjs <你的仓库地址>
 *
 * 例：
 *   node deploy/push-github.cjs git@github.com:yourname/chat-app.git
 *
 * 【这个脚本解决什么问题】
 *   手动推送的坑：
 *     1. 忘记检查 .env 有没有被提交（泄露 JWT 密钥）
 *     2. remote 配了 HTTPS 又要输密码 / 配了 SSH 但 key 没加
 *     3. 推完才发现推错了分支
 *   脚本把这些检查全部自动化，出错就停下来说清楚原因。
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

/** 颜色输出（Windows 10+ 的终端都支持 ANSI） */
const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function run(cmd, opts = {}) {
  return execSync(cmd, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: opts.silent ? 'pipe' : 'inherit',
    ...opts,
  });
}

function capture(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function fail(msg, hint) {
  console.error(`\n${C.red('✗ ' + msg)}`);
  if (hint) console.error(`\n${C.yellow('怎么办：')}\n${hint}\n`);
  process.exit(1);
}

// ============================================================
// 0. 参数检查
// ============================================================
const repoUrl = process.argv[2];

if (!repoUrl) {
  console.error(`
${C.cyan('用法：')} node deploy/push-github.cjs <仓库地址>

${C.dim('例：')}
  node deploy/push-github.cjs git@github.com:yourname/chat-app.git

${C.yellow('去哪拿这个地址？')}
  1. 打开 https://github.com/new
  2. Repository name 填 chat-app
  3. 选 Private（推荐）或 Public
  4. ⚠️ 不要勾 "Add a README file"（本地已有代码，勾了会冲突）
  5. 点 Create repository
  6. 在跳转后的页面找到 SSH 那一栏，复制形如 git@github.com:xxx/chat-app.git 的地址
`);
  process.exit(1);
}

console.log(`
${C.cyan('════════════════════════════════════════')}
${C.cyan('  推送到 GitHub')}
${C.cyan('════════════════════════════════════════')}
仓库: ${repoUrl}
`);

// ============================================================
// 1. 安全检查：绝不能把密钥推上去
// ============================================================
console.log(`${C.dim('[1/5]')} 安全检查...`);

const FORBIDDEN = [
  { pattern: /^\.env$/, name: '.env（含 JWT 密钥）' },
  { pattern: /\.db$/, name: 'SQLite 数据库' },
  { pattern: /\.db-(wal|shm)$/, name: 'SQLite WAL 附属文件' },
  { pattern: /^node_modules\//, name: '依赖目录' },
];

const tracked = capture('git ls-files').split('\n').filter(Boolean);
const leaks = [];

for (const file of tracked) {
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(file)) {
      leaks.push(`${file}  ${C.dim('(' + rule.name + ')')}`);
    }
  }
}

if (leaks.length > 0) {
  fail(
    `发现 ${leaks.length} 个不该提交的文件：\n\n  ` + leaks.join('\n  '),
    `先把它们从 git 索引里移除（不会删掉本地文件）：\n` +
      `  git rm --cached <上面的文件路径>\n` +
      `再检查 .gitignore 是否包含对应规则，然后重新执行本脚本。`
  );
}

console.log(`      ${C.green('✓')} 没有敏感文件（检查了 ${tracked.length} 个文件）`);

// 二次确认：扫一遍内容里有没有硬编码的密钥
const secretScan = capture('git grep -l "JWT_SECRET=" -- ":!*.md" ":!*.example"')
  .split('\n')
  .filter((f) => f && !f.endsWith('.example'));

if (secretScan.length > 0) {
  console.log(`      ${C.yellow('⚠')} 以下文件里出现了 JWT_SECRET= 字样，确认不是真实密钥：`);
  for (const f of secretScan) console.log(`        ${f}`);
}

// ============================================================
// 2. 工作区状态检查
// ============================================================
console.log(`${C.dim('[2/5]')} 检查工作区...`);

const dirty = capture('git status --porcelain');
if (dirty) {
  console.log(`      ${C.yellow('⚠')} 有未提交的改动，将自动提交：`);
  for (const line of dirty.split('\n').slice(0, 10)) {
    console.log(`        ${line}`);
  }
  run('git add -A');
  run('git commit -m "部署前更新"');
  console.log(`      ${C.green('✓')} 已提交`);
} else {
  console.log(`      ${C.green('✓')} 工作区干净`);
}

// ============================================================
// 3. 配置 remote
// ============================================================
console.log(`${C.dim('[3/5]')} 配置 remote...`);

const existing = capture('git remote get-url origin');
if (existing) {
  if (existing === repoUrl) {
    console.log(`      ${C.green('✓')} origin 已指向目标仓库`);
  } else {
    console.log(`      ${C.dim(`更新 origin: ${existing} → ${repoUrl}`)}`);
    run('git remote set-url origin ' + JSON.stringify(repoUrl));
    console.log(`      ${C.green('✓')} origin 已更新`);
  }
} else {
  run('git remote add origin ' + JSON.stringify(repoUrl));
  console.log(`      ${C.green('✓')} origin 已添加`);
}

// ============================================================
// 4. 测试 SSH 连通性
// ============================================================
console.log(`${C.dim('[4/5]')} 测试连接...`);

if (repoUrl.startsWith('git@')) {
  const sshTest = capture('ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -T git@github.com 2>&1');

  if (sshTest.includes('successfully authenticated') || sshTest.includes('Hi ')) {
    const who = (sshTest.match(/Hi ([^!]+)!/) || [])[1] || '未知用户';
    console.log(`      ${C.green('✓')} SSH 认证成功，账号：${C.cyan(who)}`);
  } else if (sshTest.includes('Permission denied')) {
    fail(
      'SSH 公钥还没加到 GitHub 上',
      `1. 复制公钥内容：\n` +
        `     ${C.dim('type %USERPROFILE%\\.ssh\\id_ed25519.pub')}\n` +
        `   （或在文件管理器打开 C:\\Users\\${process.env.USERNAME}\\.ssh\\ ，用记事本打开 id_ed25519.pub）\n\n` +
        `2. 打开 https://github.com/settings/keys\n` +
        `3. 点 New SSH key，Title 随便填，Key 里粘贴公钥全文\n` +
        `4. 点 Add SSH key，然后重新运行本脚本`
    );
  } else {
    console.log(`      ${C.yellow('⚠')} SSH 测试返回了意外结果，继续尝试推送：`);
    console.log(`        ${C.dim(sshTest.slice(0, 200))}`);
  }
} else {
  console.log(`      ${C.dim('HTTPS 地址，跳过 SSH 测试（推送时可能需要输入 token）')}`);
}

// ============================================================
// 5. 推送
// ============================================================
console.log(`${C.dim('[5/5]')} 推送到 main 分支...`);

const branch = capture('git rev-parse --abbrev-ref HEAD');
if (branch !== 'main') {
  console.log(`      ${C.dim(`当前分支是 ${branch}，重命名为 main`)}`);
  run('git branch -M main');
}

try {
  run('git push -u origin main');
} catch (err) {
  fail(
    '推送失败',
    `常见原因：\n` +
      `  · 仓库地址写错了 —— 检查有没有拼写错误\n` +
      `  · 仓库不存在 —— 先去 https://github.com/new 创建\n` +
      `  · 网络问题 —— 国内直连 GitHub 偶尔会断，重试一次往往就好\n` +
      `  · HTTPS 方式需要 token —— 改用 SSH 地址（git@github.com:...）更省事`
  );
}

// ============================================================
// 完成
// ============================================================
const remoteUrl = capture('git remote get-url origin');
const webUrl = remoteUrl
  .replace(/^git@github\.com:/, 'https://github.com/')
  .replace(/\.git$/, '');

console.log(`
${C.cyan('════════════════════════════════════════')}
${C.green('  ✓ 推送成功')}
${C.cyan('════════════════════════════════════════')}

仓库地址：${C.cyan(webUrl)}
提交数：  ${capture('git rev-list --count HEAD')}
文件数：  ${tracked.length}

${C.yellow('下一步：部署到 Render')}

  1. 打开 ${C.cyan('https://render.com')}，用 GitHub 账号登录（免信用卡）
  2. 点 ${C.cyan('New +')} → ${C.cyan('Web Service')}
  3. 选 ${C.cyan('Build and deploy from a Git repository')} → Connect
  4. 选中刚推上去的 chat-app 仓库
  5. 填配置：
       Name          chat-app
       Region        Singapore
       Runtime       Node
       Build Command npm install
       Start Command npm start
       Instance Type Free
  6. Advanced → Add Environment Variable，加三条：
       NODE_ENV      production
       NODE_VERSION  24.14.1
       JWT_SECRET    ${C.dim('<运行下面命令生成的一长串字符>')}

     ${C.dim('node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"')}

  7. 点 Create Web Service，等 2~4 分钟

${C.dim('详细步骤和故障排查见 部署指南.md')}
`);
