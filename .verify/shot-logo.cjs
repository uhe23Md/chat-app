// 只干一件事：把改了 logo 的两个页面各截一张图，确认图标渲染正确。
// 用法：node shot-logo.cjs
const { withEdge } = require('./_cdp.cjs');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const scenes = [
  { name: 'logo-login', url: 'http://localhost:3000/login.html' },
  { name: 'logo-register', url: 'http://localhost:3000/register.html' },
];

(async () => {
  for (const s of scenes) {
    await withEdge(async (cdp) => {
      await cdp.navigate(s.url);

      // 探针：等 .auth-logo 出现，再读图片真实加载结果。
      // naturalWidth > 0 才说明图片真的解码成功了（404/损坏时是 0）。
      // 注意：_cdp.cjs 的 eval 会把表达式包进 `(async () => { ... })()`，
      // 所以这里必须显式 `return`，否则拿回来永远是 undefined。
      const info = await cdp.eval(
        `const img = document.querySelector('.auth-logo');
         if (!img) return { found: false };
         const r = img.getBoundingClientRect();
         return {
           found: true,
           tag: img.tagName,
           src: img.getAttribute('src'),
           natural: img.naturalWidth + 'x' + img.naturalHeight,
           rendered: Math.round(r.width) + 'x' + Math.round(r.height),
           complete: img.complete,
           favicon: (document.querySelector('link[rel="icon"]') || {}).href || null,
         };`,
        { verifySelector: '.auth-logo', attempts: 20 }
      );
      console.log('[' + s.name + ']', JSON.stringify(info));

      const file = path.join(OUT, s.name + '.png');
      await cdp.shot(file);
      console.log('  -> saved ' + s.name + '.png');
    }, s.url);
  }
  console.log('DONE');
})().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
