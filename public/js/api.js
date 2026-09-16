/* ============================================================
 * api.js —— 前端请求封装层
 *
 * 为什么要单独封装一层，而不是每个页面直接 fetch？
 *
 *   1. 每次请求都要手动加 Authorization 头 —— 加十次就会漏一次
 *   2. 每次响应都要判断 HTTP 状态码 + 业务 ok 字段 —— 写十遍容易写歪
 *   3. token 过期要统一清掉并跳登录页 —— 散落各处会不一致
 *
 * 封装之后，页面上只需要写：
 *     const rooms = await API.getRooms()
 * 出错会抛出带中文提示的 Error，页面 catch 一下显示就完事。
 * ============================================================ */

const API = (() => {
  // 同源部署，用相对路径即可。这样本地和线上都不用改配置。
  const BASE = '/api';

  const TOKEN_KEY = 'token';
  const USER_KEY = 'user';

  /* ---------- token 读写 ---------- */

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function setToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
  }

  function getUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function setUser(user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  /** 清空登录态 */
  function clearAuth() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  /** 跳登录页，并记住当前地址，登录后可以跳回来 */
  function redirectToLogin() {
    const current = location.pathname + location.search;
    // 已经在登录页就别重复跳，否则会死循环
    if (location.pathname.endsWith('/login.html')) return;

    const back = current && current !== '/index.html' ? `?redirect=${encodeURIComponent(current)}` : '';
    location.replace('/login.html' + back);
  }

  /**
   * 核心请求方法
   * @param {string} path 例如 '/login'
   * @param {object} options { method, body, auth }
   * @returns {Promise<any>} 直接返回 data 部分，失败时抛 Error
   */
  async function request(path, { method = 'GET', body, auth = true } = {}) {
    const headers = {};

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    // 需要鉴权的接口自动带上 token
    if (auth) {
      const token = getToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }

    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      // fetch 抛异常 = 网络层就失败了（服务没启动、断网）
      throw new Error('网络连接失败，请检查网络或稍后重试');
    }

    // 解析响应体。服务端出错时可能返回 HTML，这里要兜住
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }

    // 401：token 过期或无效 —— 清掉登录态，踢回登录页
    // 注意排除登录接口本身：登录时密码错了也返回 401，
    // 那种情况应该把错误提示显示在登录页，而不是跳转。
    if (res.status === 401 && auth) {
      clearAuth();
      redirectToLogin();
      throw new Error(payload?.error || '登录已过期，请重新登录');
    }

    // 其他错误统一抛出中文提示
    if (!res.ok || (payload && payload.ok === false)) {
      throw new Error(payload?.error || `请求失败（${res.status}）`);
    }

    // 成功：返回 data 部分，页面拿到的就是纯业务数据
    return payload ? payload.data : null;
  }

  /* ---------- 具体接口 ---------- */

  return {
    // token / 用户信息管理
    getToken,
    setToken,
    getUser,
    setUser,
    clearAuth,
    redirectToLogin,

    /** 注册。成功返回 { id, username, avatar, createdAt } */
    register(username, password) {
      return request('/register', {
        method: 'POST',
        body: { username, password },
        auth: false, // 注册时还没有 token
      });
    },

    /** 登录。成功返回 { token, user }，这里顺手存进 localStorage */
    async login(username, password) {
      const data = await request('/login', {
        method: 'POST',
        body: { username, password },
        auth: false,
      });

      setToken(data.token);
      setUser(data.user);
      return data;
    },

    /** 获取当前用户。用来验证 token 是否还有效 */
    getMe() {
      return request('/me');
    },

    /** 获取房间列表 */
    getRooms() {
      return request('/rooms');
    },

    /**
     * 获取历史消息
     * @param {number} roomId
     * @param {object} opts { before, limit }
     */
    getMessages(roomId, { before, limit = 50 } = {}) {
      const params = new URLSearchParams({ roomId, limit });
      if (before) params.set('before', before);
      return request(`/messages?${params.toString()}`);
    },

    /**
     * 获取与某人的私聊记录
     * @param {number} withUserId 对方用户 ID（对话的另一方固定是当前登录用户）
     * @param {object} opts { limit }
     * @returns {Promise<{withUser: object, messages: Array}>}
     *   注意返回的是对象不是数组：
     *     withUser —— 对方的基本信息 { id, username, avatar }
     *     messages —— 从旧到新的消息数组
     */
    getPrivateMessages(withUserId, { limit = 50 } = {}) {
      const params = new URLSearchParams({ withUserId, limit });
      return request(`/private-messages?${params.toString()}`);
    },

    /** 退出登录：清本地状态即可，服务端是无状态的 JWT */
    logout() {
      clearAuth();
      location.replace('/login.html');
    },
  };
})();
