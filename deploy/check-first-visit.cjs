/**
 * check-first-visit.cjs —— 模拟"别人第一次打开这个链接"会发生什么
 *
 * 为什么单独测这个？
 * 你自己在本机看是"正常的"，但别人是从外网第一次访问，
 * 有一批问题只有这种视角才暴露：
 *   - 静态资源 404（路径写错、大小写问题）
 *   - 混合内容（HTTPS 页面里加载 HTTP 资源，浏览器直接拦掉）
 *   - 首屏加载的体积（手机流量下太慢）
 *   - 缺 favicon 导致满屏 404
 *   - meta viewport 缺失导致手机上显示成缩小版桌面页
 *
 * 用法：node deploy/check-first-visit.cjs <公网地址>
 */

const BASE = process.argv[2];
if (!BASE) {
  console.error('用法: node deploy/check-first-visit.cjs https://xxx.trycloudflare.com');
  process.exit(1);
}

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

let pass = 0, fail = 0, warn = 0;
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ${C.green('PASS')}  ${n}${d ? `  ${C.dim('(' + d + ')')}` : ''}`); }
  else { fail++; console.log(`  ${C.red('FAIL')}  ${n}${d ? `  ${C.dim('(' + d + ')')}` : ''}`); }
};
const note = (n, d = '') => { warn++; console.log(`  ${C.yellow('注意')}  ${n}${d ? `  ${C.dim('(' + d + ')')}` : ''}`); };
const section = (t) => console.log(`\n${C.bold('【' + t + '】')}`);

async function get(path, timeoutMs = 20000) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, buf, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, error: e.cause?.code || e.message, ms: Date.now() - t0 };
  }
}

(async () => {
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  ${C.bold('首次访问体验检查')}`);
  console.log(`  ${BASE}`);
  console.log(`${'═'.repeat(62)}`);

  // ---- 1. 入口页 ----
  section('1. 入口页');

  const root = await get('/');
  ok('根路径返回 200', root.status === 200, `HTTP ${root.status}, ${root.ms}ms`);

  const rootHtml = root.buf ? root.buf.toString('utf8') : '';
  ok('根路径返回的是 HTML', /<html|<!DOCTYPE/i.test(rootHtml));
  ok('入口页会跳转到登录/聊天页',
    /location\.(href|replace)|window\.location/i.test(rootHtml),
    'index.html 是跳转页');

  // ---- 2. 静态资源（页面上引用的每一个都要能拿到） ----
  section('2. 静态资源');

  const pages = ['/login.html', '/register.html', '/chat.html'];
  for (const p of pages) {
    const r = await get(p);
    ok(`${p} 可访问`, r.status === 200, `HTTP ${r.status}, ${(r.buf.length / 1024).toFixed(1)} KB`);
  }

  const assets = [
    '/css/style.css',
    '/js/api.js',
    '/js/auth.js',
    '/js/chat.js',
    '/img/logo.png',
    '/socket.io/socket.io.js',
  ];
  const assetResults = [];
  for (const a of assets) {
    const r = await get(a);
    const icon = r.status === 200 ? C.green('OK') : C.red('缺');
    console.log(`     ${icon}  ${a}  ${C.dim(`HTTP ${r.status}  ${(r.buf?.length / 1024 || 0).toFixed(1)} KB  ${r.ms}ms`)}`);
    assetResults.push({ path: a, status: r.status, size: r.buf?.length || 0 });
    if (r.status !== 200) fail++; else pass++;
  }

  // ---- 3. 混合内容（HTTPS 页面里的 HTTP 请求会被浏览器直接拦） ----
  section('3. 混合内容检查');

  const allHtml = [];
  for (const p of ['/login.html', '/register.html', '/chat.html']) {
    const r = await get(p);
    if (r.status === 200) allHtml.push({ path: p, html: r.buf.toString('utf8') });
  }

  let mixed = 0;
  for (const { path, html } of allHtml) {
    const hits = html.match(/(?:src|href)\s*=\s*["']http:\/\/[^"']+/gi) || [];
    if (hits.length) {
      mixed += hits.length;
      ok(`${path} 无 HTTP 明文资源`, false, `${hits.length} 处: ${hits.slice(0, 2).join(', ')}`);
    }
  }
  if (mixed === 0) ok('所有页面都没有 HTTP 明文资源（不会被浏览器拦）', true);

  // ---- 4. 手机适配 ----
  section('4. 手机适配');

  for (const { path, html } of allHtml) {
    const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(html);
    ok(`${path} 有 viewport meta`, hasViewport,
      hasViewport ? (html.match(/<meta[^>]+name=["']viewport["'][^>]*>/i) || [''])[0].slice(0, 70) : '缺了手机上会显示成缩小版桌面页');
  }

  // ---- 5. WebSocket 客户端脚本 ----
  section('5. Socket.IO 客户端');

  const sock = await get('/socket.io/socket.io.js');
  ok('socket.io 客户端脚本可访问', sock.status === 200, `HTTP ${sock.status}`);
  ok('脚本内容不是空壳', sock.buf && sock.buf.length > 10000, `${((sock.buf?.length || 0) / 1024).toFixed(1)} KB`);

  // ---- 6. 首屏体积 ----
  section('6. 首屏加载体积（手机流量视角）');

  const loginSize = assetResults.filter((a) =>
    ['/css/style.css', '/js/api.js', '/js/auth.js', '/img/logo.png', '/socket.io/socket.io.js'].includes(a.path)
  ).reduce((s, a) => s + a.size, 0)
    + (await get('/login.html')).buf.length;

  const kb = loginSize / 1024;
  if (kb < 500) ok('登录页首屏体积合理', true, `${kb.toFixed(0)} KB`);
  else if (kb < 1500) note('登录页首屏偏大', `${kb.toFixed(0)} KB`);
  else ok('登录页首屏体积过大', false, `${kb.toFixed(0)} KB`);

  // ---- 7. 响应头 ----
  section('7. 响应头');

  const h = root.headers;
  ok('经由 Cloudflare 转发', /cloudflare/i.test(h.get('server') || ''),
    'server=' + (h.get('server') || '未识别'));

  // 真正去读响应头，而不是想当然地写个警告 ——
  // 假警告会让人对真告警麻木。
  const secHeaders = [
    ['x-content-type-options', 'nosniff', '防 MIME 类型嗅探'],
    ['x-frame-options', /SAMEORIGIN|DENY/i, '防点击劫持'],
    ['referrer-policy', /./, '控制 Referer 泄露'],
  ];
  let secMissing = 0;
  for (const [name, expect, why] of secHeaders) {
    const val = h.get(name);
    const okVal = val && (expect instanceof RegExp ? expect.test(val) : val === expect);
    if (okVal) {
      pass++;
      console.log(`  ${C.green('PASS')}  ${name}: ${val}  ${C.dim('(' + why + ')')}`);
    } else {
      secMissing++;
      warn++;
      console.log(`  ${C.yellow('注意')}  ${name} ${val ? `值异常: ${val}` : '未设置'}  ${C.dim('(' + why + ')')}`);
    }
  }
  if (secMissing === 0) console.log(`  ${C.dim('   安全响应头齐全。')}`);

  // ---- 汇总 ----
  console.log(`\n${'═'.repeat(62)}`);
  if (fail === 0) {
    console.log(`  ${C.green(`✅ 检查通过：${pass} 项`)}  ${C.dim(`（${warn} 条可选优化提示）`)}`);
    console.log(`  ${C.dim('别人第一次打开这个链接的体验是正常的。')}`);
  } else {
    console.log(`  ${C.red(`❌ ${fail} 项有问题，${pass} 项通过`)}`);
  }
  console.log(`${'═'.repeat(62)}\n`);

  process.exit(fail === 0 ? 0 : 1);
})();
