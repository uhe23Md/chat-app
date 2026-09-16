/**
 * run-launcher.cjs —— 实测启动脚本的完整流程
 *
 * 和 run-cmd.cjs 的区别：这个把输出写到文件，并且不等脚本结束就返回。
 * 因为启动脚本最后有个 pause，直接等会挂住。
 *
 * 用法：node deploy/run-launcher.cjs
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outFile = path.join(root, 'deploy', '_launcher-out.log');

fs.writeFileSync(outFile, '');

const child = spawn('cmd.exe', ['/c', path.join(root, '启动公网访问.cmd')], {
  cwd: root,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});

const append = (d) => {
  fs.appendFileSync(outFile, d.toString('utf8'));
};
child.stdout.on('data', append);
child.stderr.on('data', append);

// 脚本里的 pause 会等输入，直接关掉 stdin 让它过
child.stdin.end();

const timeoutMs = 180000;
const timer = setTimeout(() => {
  append('\n\n[RUNNER] timeout reached, killing child\n');
  child.kill();
}, timeoutMs);

child.on('exit', (code) => {
  clearTimeout(timer);
  append(`\n\n[RUNNER] exit code = ${code}\n`);
  console.log('done, exit=' + code);
});
