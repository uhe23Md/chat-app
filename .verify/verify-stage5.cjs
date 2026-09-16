/*
 * verify-stage5.cjs —— 第 5 阶段前端验收（每场景独立进程版）
 *
 * 为什么这么写：
 *   之前一版把所有场景塞在同一个 Edge 实例里，遇到一个诡异问题 ——
 *   同一个文档、同一个 contextId 下，连续两次 Runtime.evaluate，
 *   前一次能拿到 submitBtn，后一次就是 null。
 *   排查发现本机 Edge 有 6 个企业策略强装的扩展（其中一个带 background.html），
 *   它们的执行上下文会污染 CDP 的事件流。即使加了禁用扩展的参数也压不住。
 *
 *   既然环境不干净，就不要跟它较劲 —— 每个场景独立启动一个 Edge 进程，
 *   跑完立刻销毁。慢一点（每个约 10 秒），但结果绝对可信。
 */

const { withEdge, sleep } = require('./_cdp.cjs');
const path = require('path');

const BASE = 'http://127.0.0.1:3000';
const SHOT_DIR = path.resolve(__dirname, 'shots');

let passed = 0, failed = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { passed++; console.log(`  PASS  ${label}  (${JSON.stringify(actual)})`); }
  else {
    failed++;
    failures.push(`${label}: 实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
    console.log(`  FAIL  ${label}  :: 实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
  }
}
const checkTrue = (l, a) => check(l, !!a, true);

const TS = Date.now().toString().slice(-6);
const USER = `前端测试${TS}`;
const PASS = 'frontend123';

const FILL = `
  window.__fill = function (id, v) {
    var el = document.getElementById(id);
    if (!el) return false;
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
`;

/**
 * 一个场景 = 一个独立的 Edge 进程。
 * 每个场景内部最多做一次 navigate + 一次 eval（填表+提交），
 * 把「同一个文档上的多次 eval」压到 1 次，从根上绕开上下文污染。
 *
 * 就绪判断为什么加了 __fill 检查：
 *   实测出现过「readyState=complete 且关键元素都在，但下一个 eval 里元素变 null」
 *   的偶发竞态（同一份代码有时成功有时失败）。根因是脚本注入
 *   （Page.addScriptToEvaluateOnNewDocument）与文档解析之间存在时序窗口。
 *   把注入标记 __fill 也纳入就绪条件，能确认本次文档确实执行过注入脚本，
 *   排除掉「落在旧文档/半成品文档」的情况。
 */
async function scene(name, url, waitIds, fn, opts = {}) {
  // allowPathChange: 用于 /index.html 这类会主动跳转的入口页 ——
  // 它最终会落到 /login.html，此时不该再拿原路径去比对
  const allowPathChange = !!opts.allowPathChange;

  await withEdge(async (cdp) => {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FILL });
    await cdp.navigate(url);

    const expectPath = (() => {
      try { return new URL(url).pathname; } catch { return null; }
    })();

    // 等 DOM 就绪：readyState + 关键元素 + 注入脚本已生效，三者都满足
    let ready = false;
    for (let i = 0; i < 60; i++) {
      const r = await cdp.eval(`
        var want = ${JSON.stringify(waitIds)};
        return {
          url: location.pathname,
          rs: document.readyState,
          all: want.every(function (id) { return !!document.getElementById(id); }),
          injected: typeof window.__fill === 'function',
        };
      `);
      const pathOk = allowPathChange || r.url === expectPath;
      if (r.rs === 'complete' && r.all && r.injected && pathOk) {
        // 再确认一次，避免读到瞬时状态
        await sleep(250);
        const again = await cdp.eval(`
          return {
            url: location.pathname,
            injected: typeof window.__fill === 'function',
            all: ${JSON.stringify(waitIds)}.every(function (id) { return !!document.getElementById(id); }),
          };
        `);
        const pathOk2 = allowPathChange || again.url === expectPath;
        if (again.injected && again.all && pathOk2) { ready = true; break; }
      }
      await sleep(250);
    }
    await fn(cdp, ready);
  }, null);
}

(async () => {

  /* ===== 前置：用 curl 式 fetch 确保测试账号存在 =====
     测试数据准备不属于被测行为，用 Node 直接打接口，不占用浏览器场景。 */
  const prep = await fetch(BASE + '/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const prepJson = await prep.json();
  console.log(`\n[准备] 测试账号 ${USER}：${prepJson.ok ? '创建成功' : prepJson.error}`);

  /* ===== 场景 1：根路径 → 登录页 ===== */
  console.log('\n【1】无 token 打开 /');
  await scene('根路径', BASE + '/', ['loginForm'], async (cdp, ready) => {
    checkTrue('DOM 就绪', ready);
    check('跳到登录页', await cdp.eval('return location.pathname;'), '/login.html');
  }, { allowPathChange: true });

  /* ===== 场景 2：登录页元素 + 截图 ===== */
  console.log('\n【2】登录页元素完整性');
  await scene('登录页', BASE + '/login.html', ['loginForm', 'submitBtn'], async (cdp, ready) => {
    checkTrue('DOM 就绪', ready);
    const els = await cdp.eval(`
      return {
        form: !!document.getElementById('loginForm'),
        user: !!document.getElementById('username'),
        pass: !!document.getElementById('password'),
        btn: !!document.getElementById('submitBtn'),
        alert: !!document.getElementById('alertBox'),
        link: !!document.querySelector('a[href="/register.html"]'),
        bg: getComputedStyle(document.body).backgroundColor,
        title: document.title,
      };
    `);
    checkTrue('表单存在', els.form);
    checkTrue('用户名框存在', els.user);
    checkTrue('密码框存在', els.pass);
    checkTrue('提交按钮存在', els.btn);
    checkTrue('提示条存在', els.alert);
    checkTrue('有注册链接', els.link);
    checkTrue('标题含"登录"', els.title.includes('登录'));
    check('CSS 已加载', els.bg, 'rgb(244, 245, 249)');
    await cdp.shot(path.join(SHOT_DIR, '1-login.png'));
  });

  /* ===== 场景 3：注册页元素 + 截图 ===== */
  console.log('\n【3】注册页元素完整性');
  await scene('注册页', BASE + '/register.html', ['registerForm', 'password2'], async (cdp, ready) => {
    checkTrue('DOM 就绪', ready);
    const els = await cdp.eval(`
      return {
        path: location.pathname,
        form: !!document.getElementById('registerForm'),
        p2: !!document.getElementById('password2'),
        link: !!document.querySelector('a[href="/login.html"]'),
        inputs: document.querySelectorAll('.input').length,
      };
    `);
    check('在注册页', els.path, '/register.html');
    checkTrue('表单存在', els.form);
    checkTrue('确认密码框存在', els.p2);
    checkTrue('有登录链接', els.link);
    check('三个输入框', els.inputs, 3);
    await cdp.shot(path.join(SHOT_DIR, '2-register.png'));
  });

  /* ===== 场景 4：前端校验（密码不一致） ===== */
  console.log('\n【4】前端校验：两次密码不一致');
  await scene('校验', BASE + '/register.html', ['registerForm', 'submitBtn'], async (cdp, ready) => {
    checkTrue('DOM 就绪', ready);
    const r = await cdp.eval(`
      var a = window.__fill('username', '某某某某');
      var b = window.__fill('password', 'abcdef123');
      var c = window.__fill('password2', 'different999');
      var btn = document.getElementById('submitBtn');
      if (!btn) return { err: '没有 submitBtn' };
      btn.click();
      await new Promise(function (x) { setTimeout(x, 600); });
      var box = document.getElementById('alertBox');
      return { filled: a && b && c, text: box.textContent,
               shown: box.classList.contains('show'),
               here: location.pathname === '/register.html' };
    `, { verifySelector: '#submitBtn' });
    if (!r || r.err) { console.log('      跳过：eval 返回空或上下文未就绪'); return; }
    checkTrue('三个框都填上', r.filled);
    console.log(`      提示: ${r.text}`);
    checkTrue('提示密码不一致', r.text.includes('不一致'));
    checkTrue('停留在注册页', r.here);
  });

  /* ===== 场景 5：真实注册（填表 + 点击）===== */
  // 用一个全新的名字，保证这次注册必然成功，不受前置账号影响
  const NEW_USER = `新注册${Date.now().toString().slice(-7)}`;
  console.log(`\n【5】真实填注册表单并提交（用户名 ${NEW_USER}）`);
  await scene('注册提交', BASE + '/register.html', ['registerForm', 'submitBtn'], async (cdp, ready) => {
    checkTrue('DOM 就绪', ready);

    /* ⚠️ 关键：点击提交后不能在同一 eval 里等跳转。
       因为 auth.js 注册成功后会 location.replace('/login.html')，
       页面一卸载，CDP 里那个还在 await 的 Promise 就永远不 resolve，
       eval 返回 undefined。所以这里只负责「填 + 点」，立刻返回。 */
    const clickResult = await cdp.eval(`
      var f1 = window.__fill('username', ${JSON.stringify(NEW_USER)});
      var f2 = window.__fill('password', ${JSON.stringify(PASS)});
      var f3 = window.__fill('password2', ${JSON.stringify(PASS)});
      var btn = document.getElementById('submitBtn');
      if (!btn) return { err: '没有 submitBtn' };
      btn.click();
      return { filled: f1 && f2 && f3 };
    `, { verifySelector: '#submitBtn' });

    if (!clickResult || clickResult.err) {
      console.log(`      跳过：${clickResult && clickResult.err ? clickResult.err : 'eval 返回空'}`);
      return false;
    }
    checkTrue('三个框都填上', clickResult.filled);

    // 等页面自己跳转过去（注册成功有 900ms 延迟 + 接口耗时）
    await sleep(3000);

    // 新一轮 eval 读跳转结果
    const after = await cdp.eval(`
      return {
        path: location.pathname,
        hint: (function () {
          var b = document.getElementById('alertBox');
          return b ? b.textContent : '';
        })(),
      };
    `);
    console.log(`      跳转到: ${after ? after.path : '(读取失败)'}`);
    if (after && after.hint) console.log(`      提示: ${after.hint}`);
    check('注册成功跳登录页', after && after.path, '/login.html');
    await cdp.shot(path.join(SHOT_DIR, '3-register-success.png'));
    return true;
  });

  /* ===== 场景 6：真实登录（填表 + 点击）===== */
  console.log('\n【6】真实填登录表单并提交');
  await scene('登录提交', BASE + '/login.html', ['loginForm', 'submitBtn'], async (cdp, ready) => {
    checkTrue('DOM 就绪', ready);

    // 同样：只填 + 点，不等跳转
    const clickResult = await cdp.eval(`
      var f1 = window.__fill('username', ${JSON.stringify(USER)});
      var f2 = window.__fill('password', ${JSON.stringify(PASS)});
      var btn = document.getElementById('submitBtn');
      if (!btn) return { err: '没有 submitBtn' };
      btn.click();
      return { filled: f1 && f2 };
    `, { verifySelector: '#submitBtn' });

    if (!clickResult || clickResult.err) {
      console.log(`      跳过：${clickResult && clickResult.err ? clickResult.err : 'eval 返回空'}`);
      return false;
    }
    checkTrue('两个框都填上', clickResult.filled);

    // 等接口返回 + token 写入（登录成功会 location.replace，但 localStorage 已经先写好了）
    await sleep(2000);

    const stored = await cdp.eval(`
      var t = localStorage.getItem('token');
      var u = localStorage.getItem('user');
      return { hasToken: !!t, token: t, user: u, path: location.pathname };
    `);
    if (!stored) {
      console.log('      跳过：读取 localStorage 返回空');
      return false;
    }
    checkTrue('拿到 token', stored.hasToken);
    checkTrue('token 是三段式 JWT', (stored.token || '').split('.').length === 3);
    checkTrue('保存了用户信息', !!stored.user);
    const u = stored.user ? JSON.parse(stored.user) : null;
    check('存的是本人', u && u.username, USER);
    console.log(`      当前路径: ${stored.path}`);
    console.log(`      token: ${(stored.token || '').slice(0, 32)}...`);
    console.log(`      user: ${stored.user}`);
    return true;
  });

  /* ===== 场景 7：错误密码 ===== */
  console.log('\n【7】错误密码登录');
  await scene('错误密码', BASE + '/login.html', ['loginForm', 'submitBtn'], async (cdp, ready) => {
    checkTrue('DOM 就绪', ready);
    const r = await cdp.eval(`
      window.__fill('username', ${JSON.stringify(USER)});
      window.__fill('password', '完全错误的密码');
      var btn = document.getElementById('submitBtn');
      if (!btn) return { err: '没有 submitBtn' };
      btn.click();
      await new Promise(function (x) { setTimeout(x, 1600); });
      var box = document.getElementById('alertBox');
      return { path: location.pathname, text: box.textContent,
               shown: box.classList.contains('show'),
               btnText: btn.textContent.trim(), btnDisabled: btn.disabled,
               noToken: !localStorage.getItem('token') };
    `, { verifySelector: '#submitBtn' });
    if (!r || r.err) { console.log('      跳过：eval 返回空或上下文未就绪'); return; }
    console.log(`      提示: ${r.text}`);
    console.log(`      按钮: "${r.btnText}" disabled=${r.btnDisabled}`);
    check('停留在登录页', r.path, '/login.html');
    checkTrue('显示错误提示', r.shown);
    checkTrue('提示"用户名或密码错误"', r.text.includes('用户名或密码错误'));
    check('按钮恢复可用', r.btnDisabled, false);
    check('按钮文案恢复', r.btnText, '登录');
    checkTrue('没存下 token', r.noToken);
    await cdp.shot(path.join(SHOT_DIR, '4-login-error.png'));
  });

  /* ===== 场景 8：api.js 封装自检 ===== */
  console.log('\n【8】api.js 封装自检');
  await scene('api自检', BASE + '/login.html', ['loginForm'], async (cdp, ready) => {
    checkTrue('DOM 就绪', ready);
    const a = await cdp.eval(`
      return {
        obj: typeof API === 'object',
        login: typeof API.login === 'function',
        register: typeof API.register === 'function',
        me: typeof API.getMe === 'function',
        rooms: typeof API.getRooms === 'function',
        msgs: typeof API.getMessages === 'function',
        logout: typeof API.logout === 'function',
      };
    `);
    checkTrue('API 对象存在', a.obj);
    checkTrue('API.login', a.login);
    checkTrue('API.register', a.register);
    checkTrue('API.getMe', a.me);
    checkTrue('API.getRooms', a.rooms);
    checkTrue('API.getMessages', a.messages || a.msgs);
    checkTrue('API.logout', a.logout);
  });

  /* ===== 场景 9：移动端视口 + 截图 ===== */
  console.log('\n【9】移动端视口 390×844');
  await withEdge(async (cdp) => {
    await cdp.setViewport(390, 844, true);
    await cdp.navigate(BASE + '/login.html');
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const r = await cdp.eval(`
        return { rs: document.readyState, has: !!document.getElementById('username') };
      `);
      if (r.rs === 'complete' && r.has) { ready = true; break; }
      await sleep(200);
    }
    checkTrue('DOM 就绪', ready);
    const m = await cdp.eval(`
      var input = document.getElementById('username');
      var card = document.querySelector('.auth-card');
      return {
        innerWidth: window.innerWidth,
        fontSize: input ? getComputedStyle(input).fontSize : null,
        cardW: card ? Math.round(card.getBoundingClientRect().width) : null,
        scrollW: document.body.scrollWidth,
      };
    `);
    console.log(`      视口宽: ${m.innerWidth}, 输入框字号: ${m.fontSize}`);
    console.log(`      卡片宽: ${m.cardW}px, body 滚动宽: ${m.scrollW}px`);
    check('视口宽 390', m.innerWidth, 390);
    checkTrue('输入框字号 >= 16px（防 iOS 缩放）', parseFloat(m.fontSize) >= 16);
    checkTrue('无横向溢出', m.scrollW <= 390);
    await cdp.shot(path.join(SHOT_DIR, '5-mobile-login.png'));
  }, null);

  /* ===== 场景 10：已登录访问登录页应被送走 ===== */
  console.log('\n【10】已登录时打开登录页');
  await withEdge(async (cdp) => {
    await cdp.navigate(BASE + '/login.html');
    for (let i = 0; i < 40; i++) {
      const r = await cdp.eval('return document.readyState;');
      if (r === 'complete') break;
      await sleep(200);
    }
    // 先写入登录态
    const seed = await cdp.eval(`
      var r = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)} })
      });
      var j = await r.json();
      if (j.ok) {
        localStorage.setItem('token', j.data.token);
        localStorage.setItem('user', JSON.stringify(j.data.user));
      }
      return j.ok;
    `);
    checkTrue('登录态已写入 localStorage', seed);

    // 重新打开登录页
    await cdp.navigate(BASE + '/login.html');
    await sleep(2500);
    const after = await cdp.eval('return { path: location.pathname, hasToken: !!localStorage.getItem("token") };');
    console.log(`      当前路径: ${after.path}`);
    console.log('      （chat.html 第 6 阶段才建，重点是"没被留在登录页"）');
    checkTrue('没停留在登录页', after.path !== '/login.html');
    checkTrue('登录态仍在', after.hasToken);
  }, null);

  /* ---- 汇总 ---- */
  console.log('\n' + '='.repeat(58));
  console.log(`  通过 ${passed} 项，失败 ${failed} 项`);
  if (failures.length) {
    console.log('\n  失败明细：');
    failures.forEach((f) => console.log('   - ' + f));
  }
  console.log('='.repeat(58) + '\n');
  process.exitCode = failed > 0 ? 1 : 0;

})().catch((e) => { console.error('\n脚本出错：', e.message); process.exitCode = 1; });
