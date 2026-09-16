/* ============================================================
 * auth.js —— 登录页 / 注册页的逻辑
 *
 * 暴露一个 AuthPage 对象，页面上按需调用：
 *   AuthPage.initLoginForm()     登录页
 *   AuthPage.initRegisterForm()  注册页
 *
 * 【一个容易踩的坑：为什么两个页面都用 <form> 而不是 div？】
 *   因为用 form 的话，按回车就能提交 —— 这是用户在登录框里最自然的操作。
 *   如果写成 div + 按钮的 onclick，回车就没反应了，体验很差。
 *   配合 form 的 submit 事件和 preventDefault()，既能回车提交又不会刷新页面。
 * ============================================================ */

const AuthPage = (() => {
  /* ---------- 小工具 ---------- */

  /** 显示错误提示 */
  function showError(message) {
    const box = document.getElementById('alertBox');
    if (!box) return;
    box.textContent = message;
    box.classList.add('show');
  }

  /** 隐藏提示 */
  function hideError() {
    const box = document.getElementById('alertBox');
    if (box) box.classList.remove('show');
  }

  /**
   * 按钮进入/退出加载态
   * 加载中时禁用按钮，防止用户狂点导致重复提交（比如重复注册）
   */
  function setLoading(btn, loading, textWhenIdle) {
    if (!btn) return;
    if (loading) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> 处理中…';
    } else {
      btn.disabled = false;
      btn.textContent = textWhenIdle;
    }
  }

  /**
   * 已登录的话就别待在登录页了，直接进聊天页
   * 场景：用户登录后手动敲地址回到 /login.html
   */
  async function redirectIfLoggedIn() {
    if (!API.getToken()) return;

    try {
      // 不能光看本地有没有 token —— token 可能已过期。
      // 调一次 /api/me 才是可靠的验证。
      await API.getMe();
      location.replace('/chat.html');
    } catch {
      // token 无效，api.js 已经清掉了，留在这里正常登录即可
      hideError();
    }
  }

  /* ---------- 登录页 ---------- */

  function initLoginForm() {
    const form = document.getElementById('loginForm');
    if (!form) return;

    // 打开页面就检查一次：已登录的直接进聊天页
    redirectIfLoggedIn();

    form.addEventListener('submit', async (e) => {
      // 阻止表单默认提交（默认行为会导致页面刷新）
      e.preventDefault();
      hideError();

      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value;
      const btn = document.getElementById('submitBtn');

      // 前端先做一轮基础校验，能省一次没必要的网络请求
      if (!username || !password) {
        showError('请填写用户名和密码');
        return;
      }

      setLoading(btn, true);

      try {
        await API.login(username, password);

        // 登录成功 → 跳转。
        // 如果是从别的页面被踢过来的，地址上会带 redirect 参数，登录后跳回去。
        const params = new URLSearchParams(location.search);
        const redirect = params.get('redirect');
        location.replace(redirect || '/chat.html');
      } catch (err) {
        showError(err.message);
        setLoading(btn, false, '登录');
      }
      // 注意：成功分支里没有 setLoading(false) ——
      // 因为马上就要跳转了，按钮保持禁用状态反而更合适，避免重复提交
    });
  }

  /* ---------- 注册页 ---------- */

  function initRegisterForm() {
    const form = document.getElementById('registerForm');
    if (!form) return;

    redirectIfLoggedIn();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError();

      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value;
      const password2 = document.getElementById('password2').value;
      const btn = document.getElementById('submitBtn');

      // 前端校验：和服务端规则保持一致，但服务端仍然会再校验一次
      // （前端校验只是提升体验，绝不能当作安全边界 —— 用户可以绕过它）
      if (!username || !password) {
        showError('请填写用户名和密码');
        return;
      }
      if (username.length < 3 || username.length > 20) {
        showError('用户名长度需为 3-20 个字符');
        return;
      }
      if (password.length < 6) {
        showError('密码至少 6 位');
        return;
      }
      if (password !== password2) {
        showError('两次输入的密码不一致');
        return;
      }

      setLoading(btn, true);

      try {
        await API.register(username, password);

        // 注册成功不直接登录，而是回登录页 —— 让用户确认一次密码，
        // 也顺便验证一下刚设的密码能不能用
        const box = document.getElementById('alertBox');
        box.className = 'alert alert-success show';
        box.textContent = '注册成功，正在跳转到登录页…';

        setTimeout(() => {
          location.replace('/login.html');
        }, 900);
      } catch (err) {
        showError(err.message);
        setLoading(btn, false, '注册');
      }
    });
  }

  return { initLoginForm, initRegisterForm };
})();
