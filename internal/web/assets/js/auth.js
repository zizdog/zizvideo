// 会话状态 + 登录/初始化视图（顶栏已删：用户 2026-09-23「顶部什么都不显示」）

import { api } from "./api.js";
import { el, clear, banner, setBanner, field, input } from "./dom.js";

export const session = { user: null };

export async function loadMe() {
  try {
    session.user = await api.me();
  } catch (err) {
    if (err && (err.status === 401 || err.code === "AUTH_UNAUTHORIZED")) session.user = null;
    else throw err;
  }
  return session.user;
}

export async function doLogout() {
  try { await api.logout(); } catch (err) { /* 退出失败也要回到登录页 */ }
  session.user = null;
  // 主动退出后**不要**再被"自动登录"顶回去（否则一点退出就又进去了）；
  // 同时把"自动登录"这个意愿关掉 —— 用户点了退出，就不该下次还被自动带进来。
  try { sessionStorage.setItem("zv_no_auto", "1"); } catch (err) { /* 隐私模式忽略 */ }
  try { localStorage.removeItem("zv_auto"); } catch (err) { /* 隐私模式忽略 */ }
}

export function mountLogin(view, onSuccess) {
  const username = input({ type: "text", autocomplete: "username", placeholder: "用户名", required: true });
  const password = input({ type: "password", autocomplete: "current-password", placeholder: "口令", required: true });
  const note = banner();
  // 用户 2026-09-24：拆成两个勾选 —— 「记住信息」（用户名/口令存本机）与「自动登录」（下次直接进）。
  const remember = el("input", { type: "checkbox", dataset: { role: "login-remember" } });
  const auto = el("input", { type: "checkbox", dataset: { role: "login-auto" } });
  const submit = el("button", { class: "btn primary", type: "submit", text: "登录" });
  const form = el("form", { class: "panel narrow" },
    el("h1", { class: "title", text: "Zizvideo" }),
    field("用户名", username),
    field("口令", password),
    // 口令明文存本机浏览器 —— 界面上如实写明，不藏着
    el("label", { class: "check" }, remember,
      el("span", { class: "muted small-note", text: "记住信息（用户名与口令存本机）" })),
    el("label", { class: "check" }, auto,
      el("span", { class: "muted small-note", text: "自动登录（打开就进，需先记住信息）" })),
    note,
    submit
  );
  const KEY = "zv_login";       // {u,p} —— 记住信息
  const AUTO_KEY = "zv_auto";   // "1" —— 自动登录
  const readLocal = (key) => { try { return localStorage.getItem(key); } catch (err) { return null; } };
  const writeLocal = (key, value) => {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (err) { /* 隐私模式忽略 */ }
  };
  const saved = (() => {
    try { return JSON.parse(readLocal(KEY) || "null"); } catch (err) { return null; }
  })();
  const noAuto = (() => { try { return sessionStorage.getItem("zv_no_auto") === "1"; } catch (err) { return false; } })();
  const wantAuto = readLocal(AUTO_KEY) === "1";
  if (saved && saved.u) {
    username.value = saved.u;
    password.value = saved.p || "";
    remember.checked = true;
    auto.checked = wantAuto;
    // 只有"自动登录"勾着才自己提交（用户主动退出过一次就不再顶回去）
    if (wantAuto && !noAuto) {
      setTimeout(() => { form.dispatchEvent(new Event("submit", { cancelable: true })); }, 0);
    }
  }
  // 勾了自动登录就要先记住信息：直接替用户勾上（否则"自动"没有口令可自动）
  auto.addEventListener("change", () => { if (auto.checked) remember.checked = true; });
  remember.addEventListener("change", () => { if (!remember.checked) auto.checked = false; });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBanner(note, "");
    submit.disabled = true;
    try {
      session.user = await api.login({ username: username.value.trim(), password: password.value });
      try { sessionStorage.removeItem("zv_no_auto"); } catch (err) { /* 忽略 */ }
      if (remember.checked) {
        writeLocal(KEY, JSON.stringify({ u: username.value.trim(), p: password.value }));
        writeLocal(AUTO_KEY, auto.checked ? "1" : null);
      } else {
        writeLocal(KEY, null);
        writeLocal(AUTO_KEY, null);
      }
      onSuccess();
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "登录失败");
    } finally {
      submit.disabled = false;
    }
  });
  view.append(form);
  username.focus();
  // 扫码登录入口（用户 2026-09-27）：不用在电视上敲账号 —— 手机 App 扫一下就进。
  form.append(el("div", { class: "muted small-note center" },
    el("a", { class: "link", href: "#/qrlogin", text: "扫码登录（手机扫一下，不用输账号）" })));
  // 首屏那次"连不上服务器"要说出来：不然用户只看到"又回到登录页"，以为登录白输了
  // （用户 2026-09-27 报障；app.js boot 里两次尝试都失败才会置这个标记）。
  try {
    if (sessionStorage.getItem("zv_boot_failed") === "1") {
      sessionStorage.removeItem("zv_boot_failed");
      setBanner(note, "连不上服务器（网络或服务端抖动），请重试");
    }
  } catch (err) { /* 隐私模式忽略 */ }
  // 「注册」入口只在管理员开着注册时出现（判据 = 公开的 setup/status.allow_register）。
  const registerEntry = el("div", { class: "muted small-note", hidden: true, dataset: { role: "register-entry" } });
  form.append(registerEntry);
  // 当前版本（用户 2026-09-22 要求）：同一次 setup/status 顺带给出，读不到就不显示，不编。
  const versionLine = el("div", { class: "muted small-note", hidden: true, dataset: { role: "app-version" } });
  form.append(versionLine);
  api.setupStatus().then((status) => {
    if (status && status.version) {
      versionLine.textContent = "zizvideo " + status.version;
      versionLine.hidden = false;
    }
    if (!(status && status.allow_register && !status.needs_setup)) return;
    registerEntry.append(el("span", { text: "还没有账号？" }),
      el("a", { class: "link", href: "#/register", text: "注册" }));
    registerEntry.hidden = false;
  }).catch(() => {});
}

export function mountRegister(view, onSuccess) {
  const username = input({ type: "text", autocomplete: "username", placeholder: "用户名（2-32 位字母数字或 _-.）", required: true });
  const displayName = input({ type: "text", autocomplete: "nickname", placeholder: "显示名（可选）" });
  const password = input({ type: "password", autocomplete: "new-password", placeholder: "口令（至少 6 位）", required: true });
  const confirm = input({ type: "password", autocomplete: "new-password", placeholder: "再输一次口令", required: true });
  const note = banner();
  const submit = el("button", { class: "btn primary", type: "submit", text: "注册并登录" });
  const form = el("form", { class: "panel narrow" },
    el("h1", { class: "title", text: "注册 Zizvideo" }),
    field("用户名", username),
    field("显示名", displayName),
    field("口令", password),
    field("确认口令", confirm),
    note,
    submit,
    el("div", { class: "actions" }, el("a", { class: "link", href: "#/login", text: "← 返回登录" }))
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBanner(note, "");
    if (password.value.length < 6) { setBanner(note, "口令至少 6 位"); return; }
    if (password.value !== confirm.value) { setBanner(note, "两次输入的口令不一致"); return; }
    submit.disabled = true;
    try {
      const name = username.value.trim();
      await api.register({
        username: name, password: password.value, display_name: displayName.value.trim() || name,
      });
      session.user = await api.login({ username: name, password: password.value });
      onSuccess();
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "注册失败");
    } finally {
      submit.disabled = false;
    }
  });
  view.append(form);
  username.focus();
  // 未初始化 → 去初始化；管理员已关注册 → 不让提交（接口仍会再拦一次）。
  api.setupStatus().then((status) => {
    if (status && status.needs_setup) { location.hash = "#/setup"; return; }
    if (!(status && status.allow_register)) {
      submit.disabled = true;
      setBanner(note, "管理员已关闭注册");
    }
  }).catch(() => {});
}

export function mountSetup(view, onSuccess) {
  const username = input({ type: "text", autocomplete: "username", placeholder: "用户名", required: true });
  const password = input({ type: "password", autocomplete: "new-password", placeholder: "口令（至少 6 位）", required: true });
  const confirm = input({ type: "password", autocomplete: "new-password", placeholder: "再输一次口令", required: true });
  const note = banner();
  const submit = el("button", { class: "btn primary", type: "submit", text: "创建管理员" });
  const form = el("form", { class: "panel narrow" },
    el("h1", { class: "title", text: "初始化 Zizvideo" }),
    field("用户名", username),
    field("口令", password),
    field("确认口令", confirm),
    note,
    submit
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBanner(note, "");
    if (password.value.length < 6) { setBanner(note, "口令至少 6 位"); return; }
    if (password.value !== confirm.value) { setBanner(note, "两次输入的口令不一致"); return; }
    submit.disabled = true;
    try {
      const name = username.value.trim();
      // 契约要求 display_name，初始化界面未单列，用用户名兜底（坑 7）
      session.user = await api.setup({ username: name, password: password.value, display_name: name });
      onSuccess();
    } catch (err) {
      setBanner(note, err && err.message ? err.message : "初始化失败");
    } finally {
      submit.disabled = false;
    }
  });
  view.append(form);
  username.focus();
}
