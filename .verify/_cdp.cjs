/*
 * cdp-shared.cjs —— 可复用的无头 Edge CDP 客户端（模板）
 * ---------------------------------------------------------------------------
 * 把这个文件复制到项目里当 `_cdp.cjs`，多个验证/截图脚本共用它。
 * 好处：Edge 的启动与清理只有一处实现，新写的临时脚本不可能忘记 kill 进程。
 *
 * 用法：
 *   const { withEdge, sleep } = require('./_cdp.cjs');
 *
 *   await withEdge(async (cdp) => {
 *     await cdp.setViewport(390, 844, true);          // 手机视口 + 触摸模拟
 *     const n = await cdp.eval(`return document.querySelectorAll('.card').length;`);
 *     await cdp.shot('/abs/path/out.png');
 *   }, 'http://127.0.0.1:5173');
 *
 * 前置条件：Node >= 22（用全局 WebSocket），系统装了 Edge。
 *
 * 本模板已内置 SKILL.md 里强调的三件事，别删：
 *   1. Runtime.evaluate 绑定主框架 contextId —— 否则首屏取值可能落在上一个
 *      about:blank 上下文里，表现为 window.api 读成 null / indexedDB 报 SecurityError。
 *   2. navigate() 会等主框架上下文就绪再返回。
 *   3. eval() 遇到「Inspected target navigated or closed」自动重试。
 */

const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

/* 两个 Edge 安装位置都试一遍 */
const EDGE = fs.existsSync('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe')
  ? 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function waitForCdp(port, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      await getJson(`http://127.0.0.1:${port}/json/version`);
      return true;
    } catch (_) { await sleep(250); }
  }
  return false;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.events = [];
    /* 主框架默认执行上下文；eval 必须显式带上它，否则可能读到上一个页面 */
    this.mainContextId = null;
    /* 要测的页面 origin。一旦确定就只认这个 origin 的上下文，
       防止扩展页/内部页抢走 mainContextId */
    this.targetOrigin = null;

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
        return;
      }
      if (msg.method === 'Runtime.executionContextCreated') {
        const ctx = msg.params && msg.params.context;
        if (ctx && ctx.auxData && ctx.auxData.isDefault && ctx.auxData.frameId) {
          const origin = String(ctx.origin || '');
          const name = String(ctx.name || '');
          /* 只接受真正的网页上下文。
             排除：
               about: / chrome: / devtools:  —— 浏览器内部页
               chrome-extension:              —— 扩展页面（实测企业策略强装的扩展
                                                  会带 background.html 混进事件流，
                                                  抢走 mainContextId，导致 eval
                                                  落在扩展页面里读到 null）
               _generated_background_page    —— 扩展后台页的典型名字
             注意：this.targetOrigin 是本脚本要测的页面 origin，
             一旦确定就锁死，避免中途被别的页面抢走。 */
          const isInternal = /^(about:|chrome:|devtools:|chrome-extension:)/.test(origin);
          const isExtensionPage = /_generated_background_page|background\.html/.test(name);

          if (!isInternal && !isExtensionPage) {
            if (this.targetOrigin == null) this.targetOrigin = origin;
            /* 只认第一个匹配目标 origin 的上下文 —— 其余一律忽略 */
            if (origin === this.targetOrigin) this.mainContextId = ctx.id;
          }
        }
      }
      if (msg.method === 'Runtime.executionContextsCleared') this.mainContextId = null;
      this.events.push(msg);
      for (const fn of this.listeners) fn(msg);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 45000);
    });
  }

  on(fn) { this.listeners.push(fn); }

  /**
   * 导航并等主框架执行上下文就绪。
   * 别直接 send('Page.navigate') —— 那样紧接着的 eval 可能还在旧上下文里跑。
   */
  async navigate(url, settleMs = 1500) {
    this.mainContextId = null;
    /* 换页面时重新识别 origin，否则会被上一个页面的 origin 锁死 */
    try {
      this.targetOrigin = new URL(url).origin;
    } catch (_) {
      this.targetOrigin = null;
    }
    await this.send('Page.navigate', { url });
    const t0 = Date.now();
    while (!this.mainContextId && Date.now() - t0 < 15000) await sleep(120);
    await sleep(settleMs);
    if (!this.mainContextId) throw new Error('导航后拿不到主框架执行上下文');
  }

  /**
   * 在页面里跑一段表达式并取值。
   * 必须包成 async IIFE：裸 await 在 Runtime.evaluate 里是 SyntaxError。
   * 表达式里必须显式 return（wrapper 是函数体，不是表达式槽）。
   *
   * ── 为什么要加 verifySelector 参数 ──────────────────────────
   * 实测踩到的坑：绑定 mainContextId 后，Runtime.evaluate 偶尔仍会落到
   * 别的执行上下文里（本机 Edge 有 6 个企业策略强装的扩展，
   * 即使传了 contextId 也会出现「这次读出 6 个元素、下次全是 null」）。
   *
   * 表现是：注入脚本 window.__fill 能用（它跑在正确文档里），
   * 但同一个 eval 里 document.getElementById('submitBtn') 是 null ——
   * 两句话跑在不同上下文里，非常隐蔽。
   *
   * 解法：执行前先做一次「探针」—— 在当前上下文里查一个已知元素，
   * 查不到就认为上下文不对，清掉 mainContextId 等新事件重建后重试。
   *
   * @param {string} expr 要执行的表达式（必须含 return）
   * @param {number|object} attemptsOrOpts 重试次数，或 { attempts, verifySelector, verifyUrl }
   */
  async eval(expr, attemptsOrOpts = 3) {
    const opts =
      typeof attemptsOrOpts === 'number' ? { attempts: attemptsOrOpts } : attemptsOrOpts || {};
    const attempts = opts.attempts ?? 3;
    const verifySelector = opts.verifySelector; // 例如 '#submitBtn'
    const verifyUrl = opts.verifyUrl; // 例如 '/register.html'

    for (let i = 1; i <= attempts; i++) {
      try {
        /* 探针：确认上下文真的是我们要的页面 */
        if (verifySelector || verifyUrl) {
          const probe = await this.send('Runtime.evaluate', {
            expression: `(function () {
              return {
                url: location.pathname,
                hasEl: ${verifySelector ? `!!document.querySelector(${JSON.stringify(verifySelector)})` : 'true'},
                ready: document.readyState
              };
            })()`,
            returnByValue: true,
            ...(this.mainContextId != null ? { contextId: this.mainContextId } : {})
          });
          const v = probe.result && probe.result.value;
          const urlOk = !verifyUrl || (v && v.url === verifyUrl);
          const elOk = !verifySelector || (v && v.hasEl);
          if (!v || !urlOk || !elOk) {
            /* 上下文不对，清掉重来 */
            this.mainContextId = null;
            await sleep(400);
            continue;
          }
        }

        const r = await this.send('Runtime.evaluate', {
          expression: `(async () => { ${expr} })()`,
          awaitPromise: true,
          returnByValue: true,
          ...(this.mainContextId != null ? { contextId: this.mainContextId } : {})
        });
        if (r.exceptionDetails) {
          const ex = r.exceptionDetails;
          throw new Error('页面内异常: ' + (ex.exception?.description || ex.text));
        }
        return r.result.value;
      } catch (e) {
        /* 绑定 contextId 后任何导航（含 Vite HMR 整页刷新）都会让它失效 */
        const stale = /navigated or closed|Cannot find context/i.test(e.message);
        if (stale && i < attempts) { this.mainContextId = null; await sleep(600); continue; }
        throw e;
      }
    }
  }

  /**
   * 切换视口。mobile=true 时同时开触摸模拟，
   * 这样移动端专属的 CSS 和 tap 处理才是真实行为（而不是拿鼠标测手机布局）。
   */
  async setViewport(width, height, mobile) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: mobile ? 3 : 1,
      mobile: !!mobile
    });
    if (mobile) {
      await this.send('Emulation.setTouchEmulationEnabled', {
        enabled: true,
        maxTouchPoints: 5
      });
    }
  }

  /** 截图并落盘。自动创建输出目录（截图脚本常在目录还不存在时运行）。 */
  async shot(filePath, opts = {}) {
    const r = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: !!opts.fullPage
    });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(r.data, 'base64'));
    return filePath;
  }
}

/**
 * 起无头 Edge → 连 CDP → 打开 targetUrl → 跑 fn(cdp) → 无论成败都清理。
 *
 * @param {(cdp: Cdp) => any} fn
 * @param {string} [targetUrl] 打开这个地址后再跑 fn。
 *   传 null 表示不自动导航 —— 需要在页面脚本之前注入
 *   Page.addScriptToEvaluateOnNewDocument 时必须用 null，注入后自己调 cdp.navigate()。
 * @param {{bootWait?:number, port?:number}} [opts]
 *   bootWait 是导航后等页面启动的毫秒数；
 *   port 是 CDP 调试端口（默认 9222）。
 *   ★ 需要并行跑多个浏览器实例时必须手动传不同的 port，
 *     否则第二个实例会连到第一个的调试端口，两个"窗口"其实是同一个。
 */
async function withEdge(fn, targetUrl, opts = {}) {
  const port = opts.port || PORT;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    /* 实测：企业策略强装的扩展会无视 --disable-extensions 照样加载，
       其中一个还带 background.html。它们的执行上下文会污染
       Runtime.executionContextCreated 事件流，导致 mainContextId 被切到扩展页面上，
       表现为「同一个文档，两次 eval 之间 DOM 从有元素变成 null」。
       下面三个参数从策略层把扩展和后台页彻底掐掉。 */
    '--disable-background-networking',
    '--disable-features=ExtensionsToolbarMenu,ExtensionManifestV2Disabled',
    '--disable-policy-exceptions',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1280,900',
    'about:blank'
  ];

  const edge = spawn(EDGE, args, { stdio: 'ignore', detached: false });

  let ws = null;
  try {
    if (!(await waitForCdp(port))) throw new Error('Edge CDP 端口没起来（检查 Edge 路径）');

    const list = await getJson(`http://127.0.0.1:${port}/json/list`);
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('找不到可用页面');

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });

    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    if (targetUrl) await cdp.navigate(targetUrl, opts.bootWait ?? 2500);

    return await fn(cdp);
  } finally {
    /* 必须放 finally：错误路径漏掉 kill 会留下僵尸 msedge.exe 占着临时目录 */
    try { if (ws) ws.close(); } catch (_) {}
    try { edge.kill(); } catch (_) {}
    await sleep(400);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * 手动管理生命周期的浏览器实例。
 *
 * 为什么需要它？
 *   withEdge() 是"起浏览器 → 跑一段逻辑 → 关浏览器"的一次性封装。
 *   但有些场景需要**多个浏览器长时间同时存活**，比如：
 *     "A 窗口发消息，B 窗口实时收到" —— 这两个窗口必须一直开着，
 *     而且要在它们之间来回操作十几轮。
 *   这种场景下 withEdge 就不够用了：它返回时就把浏览器杀了。
 *
 * 用法：
 *   const a = await launchBrowser({ port: 9301 });
 *   const b = await launchBrowser({ port: 9302 });
 *   try {
 *     await a.cdp.navigate('http://...');
 *     ...
 *   } finally {
 *     await a.close();
 *     await b.close();
 *   }
 *
 * ⚠️ 必须用 try/finally 保证 close()，否则会留下僵尸 msedge.exe。
 */
async function launchBrowser(opts = {}) {
  const port = opts.port || PORT;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-background-networking',
    '--disable-features=ExtensionsToolbarMenu,ExtensionManifestV2Disabled',
    '--disable-policy-exceptions',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1280,900',
    'about:blank'
  ];

  const edge = spawn(EDGE, args, { stdio: 'ignore', detached: false });

  let ws = null;
  let closed = false;

  try {
    if (!(await waitForCdp(port))) throw new Error('Edge CDP 端口没起来（检查 Edge 路径）');

    const list = await getJson(`http://127.0.0.1:${port}/json/list`);
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('找不到可用页面');

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });

    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    /** 关闭这个实例并清理临时目录。可以重复调用，不会出错。 */
    const close = async () => {
      if (closed) return;
      closed = true;
      try { ws.close(); } catch (_) {}
      try { edge.kill(); } catch (_) {}
      await sleep(400);
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
    };

    return { cdp, close, port };
  } catch (err) {
    // 初始化失败也要清理，否则临时目录和进程都会残留
    try { if (ws) ws.close(); } catch (_) {}
    try { edge.kill(); } catch (_) {}
    await sleep(300);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
    throw err;
  }
}

module.exports = { withEdge, launchBrowser, Cdp, sleep, EDGE, PORT };
