/**
 * status.cjs —— 部署进度检查
 *
 * 用法：node deploy/status.cjs
 *
 * 随时运行，看当前卡在哪一步、下一步该做什么。
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function sh(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return ((e.stdout || '') + (e.stderr || '')).trim();
  }
}

const steps = [];

// ---- 1. 代码就绪 ----
const commits = sh('git rev-list --count HEAD') || '0';
const files = sh('git ls-files').split('\n').filter(Boolean).length;
const dirty = sh('git status --porcelain');
steps.push({
  name: '代码已提交到本地 git',
  done: Number(commits) > 0 && !dirty,
  detail: `${commits} 次提交，${files} 个文件` + (dirty ? ` ${C.yellow('（有未提交改动）')}` : ''),
});

// ---- 2. 敏感文件安全 ----
const tracked = sh('git ls-files').split('\n').filter(Boolean);
const leaks = tracked.filter((f) =>
  /^\.env$|\.db$|\.db-(wal|shm)$|^node_modules\/|^\.deploy-secret/.test(f)
);
steps.push({
  name: '敏感文件未入库',
  done: leaks.length === 0,
  detail: leaks.length === 0 ? `检查了 ${tracked.length} 个文件` : `发现 ${leaks.length} 个：${leaks.join(', ')}`,
});

// ---- 3. SSH 公钥已授权 ----
const sshOut = sh('ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -T git@github.com 2>&1');
const sshOk = sshOut.includes('successfully authenticated') || /^Hi [^!]+!/m.test(sshOut);
const ghUser = (sshOut.match(/Hi ([^!]+)!/) || [])[1];
steps.push({
  name: 'GitHub SSH 公钥已授权',
  done: sshOk,
  detail: sshOk ? `账号：${ghUser}` : '公钥还没加到 GitHub',
});

// ---- 4. GitHub 仓库已关联 ----
const remote = sh('git remote get-url origin');
const repoWeb = remote
  ? remote.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '')
  : '';
steps.push({
  name: 'GitHub 仓库已关联',
  done: !!remote,
  detail: remote || '还没配置 remote',
});

// ---- 5. 代码已推送 ----
let pushed = false;
let pushDetail = '还没推送';
if (remote && sshOk) {
  const remoteHead = sh('git ls-remote origin -h refs/heads/main');
  const localHead = sh('git rev-parse HEAD');
  if (remoteHead && remoteHead.includes(localHead)) {
    pushed = true;
    pushDetail = '远端已是最新';
  } else if (remoteHead) {
    pushDetail = '远端有内容但和本地不一致（可能还没推完）';
  } else {
    pushDetail = '远端仓库是空的';
  }
}
steps.push({ name: '代码已推送到 GitHub', done: pushed, detail: pushDetail });

// ---- 6. 部署配置就绪 ----
const hasYaml = fs.existsSync(path.join(ROOT, 'render.yaml'));
const hasSecret = fs.existsSync(path.join(ROOT, '.deploy-secret.txt'));
steps.push({
  name: '部署配置已准备',
  done: hasYaml && hasSecret,
  detail: `render.yaml ${hasYaml ? '✓' : '✗'}  JWT_SECRET ${hasSecret ? '✓' : '✗'}`,
});

// ---- 7. 线上服务是否可访问 ----
// 如果用户已经部署了，可以通过设置 DEPLOY_URL 环境变量来检查
const deployUrl = process.env.DEPLOY_URL;
if (deployUrl) {
  const health = sh(`curl -s -m 10 -o /dev/null -w "%{http_code}" ${deployUrl}/api/health`);
  steps.push({
    name: '线上服务可访问',
    done: health === '200',
    detail: health === '200' ? `${deployUrl} 正常` : `返回 HTTP ${health}`,
  });
}

// ============================================================
// 输出
// ============================================================
const line = '─'.repeat(60);
console.log(`\n${line}`);
console.log(`  ${C.bold('部署进度')}`);
console.log(line);

for (const s of steps) {
  const mark = s.done ? C.green('✓') : C.yellow('○');
  console.log(`\n  ${mark} ${s.done ? s.name : C.bold(s.name)}`);
  console.log(`     ${C.dim(s.detail)}`);
}

// 找出第一个未完成项，给指引
const firstTodo = steps.find((s) => !s.done);

console.log(`\n${line}`);

if (!firstTodo) {
  console.log(`  ${C.green(C.bold('全部就绪！'))}`);
  console.log(`\n  线上地址（如果已部署）：`);
  console.log(`    ${C.cyan(deployUrl || 'https://<你的域名>.onrender.com')}`);
  console.log(`\n  ${C.dim('如果还没在 Render 上建服务，运行下面命令看清单：')}`);
  console.log(`    ${C.cyan('node deploy/render-checklist.cjs')}\n`);
} else {
  console.log(`  ${C.yellow(C.bold('下一步：'))} ${firstTodo.name}\n`);

  if (firstTodo.name.includes('SSH 公钥')) {
    const pubKeyPath = path.join(process.env.USERPROFILE || process.env.HOME, '.ssh', 'id_ed25519.pub');
    let pubKey = '';
    try { pubKey = fs.readFileSync(pubKeyPath, 'utf8').trim(); } catch { /* ignore */ }

    console.log(`  ${C.cyan('1.')} 复制下面这一整行公钥：\n`);
    console.log(`     ${C.bold(pubKey || '（读不到公钥文件，检查 ' + pubKeyPath + '）')}\n`);
    console.log(`  ${C.cyan('2.')} 打开 ${C.cyan('https://github.com/settings/keys')}`);
    console.log(`  ${C.cyan('3.')} 点 ${C.cyan('New SSH key')}，Title 随便填，Key 里粘贴`);
    console.log(`  ${C.cyan('4.')} 点 ${C.cyan('Add SSH key')}\n`);
    console.log(`  ${C.dim('加完重新运行：node deploy/status.cjs')}\n`);
  } else if (firstTodo.name.includes('GitHub 仓库')) {
    console.log(`  ${C.cyan('1.')} 打开 ${C.cyan('https://github.com/new')}`);
    console.log(`  ${C.cyan('2.')} Repository name 填 ${C.bold('chat-app')}`);
    console.log(`  ${C.cyan('3.')} ${C.yellow('三个勾选框全部不要勾')}（Add README / .gitignore / license）`);
    console.log(`  ${C.cyan('4.')} 点 Create repository，把仓库地址发给我\n`);
    console.log(`  ${C.dim('或者直接运行：node deploy/push-github.cjs git@github.com:你的用户名/chat-app.git')}\n`);
  } else if (firstTodo.name.includes('已推送')) {
    console.log(`  运行推送脚本：`);
    console.log(`    ${C.cyan('node deploy/push-github.cjs git@github.com:' + (ghUser || '你的用户名') + '/chat-app.git')}\n`);
  } else if (firstTodo.name.includes('部署配置')) {
    console.log(`  运行：${C.cyan('node deploy/render-checklist.cjs')}\n`);
  } else {
    console.log(`  运行 ${C.cyan('git add -A && git commit -m "更新"')} 提交改动\n`);
  }
}

console.log(line + '\n');
