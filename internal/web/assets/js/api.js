// API 客户端：统一信封解析 + CSRF 双提交（坑 3：写操作必须带 X-CSRF-Token）

const CSRF_COOKIE = "zv_csrf";

export class ApiError extends Error {
  constructor(message, code, status, path) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    // 打的是哪个接口：出问题时页面上要能写清"GET /api/v1/feed/next → 401"，
    // 否则用户只能看到一句"加载失败"（用户 2026-09-27 报障："报错没看清"）。
    this.path = path || "";
  }

  /** 给用户看的一句话：接口 + 状态码 + 服务端原文。 */
  detail() {
    const where = this.path ? this.path : "";
    const code = this.status ? "HTTP " + this.status : (this.code || "");
    const head = [where, code].filter(Boolean).join(" → ");
    return head ? head + "：" + this.message : this.message;
  }
}

function readCookie(name) {
  const raw = String(document.cookie || "");
  for (const part of raw.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return "";
}

// csrfToken 给 XHR 上传用（fetch 封装走不到那一步）。
export function csrfToken() { return readCookie(CSRF_COOKIE); }

function queryString(params) {
  if (!params) return "";
  const parts = [];
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (value === null || value === undefined || value === "") continue;
    parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
  }
  return parts.length ? "?" + parts.join("&") : "";
}

function buildInit(method, body, keepalive) {
  const headers = {};
  const init = { method, headers, credentials: "same-origin", cache: "no-store" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  if (method !== "GET" && method !== "HEAD") {
    const token = readCookie(CSRF_COOKIE);
    if (token) headers["X-CSRF-Token"] = token;
  }
  if (keepalive) init.keepalive = true;
  return init;
}

async function envelope(method, path, body, keepalive) {
  let response;
  try {
    response = await fetch(path, buildInit(method, body, keepalive));
  } catch (err) {
    throw new ApiError("网络错误，请重试", "NETWORK", 0, method + " " + path);
  }
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch (err) { payload = null; }
  }
  const error = payload && payload.error;
  if (!response.ok || error) {
    const message = error && error.message ? String(error.message) : "请求失败（HTTP " + response.status + "）";
    throw new ApiError(message, (error && error.code) || "HTTP_" + response.status, response.status, method + " " + path);
  }
  const data = payload && Object.prototype.hasOwnProperty.call(payload, "data") ? payload.data : payload;
  const meta = (payload && payload.meta) || {};
  return { data: data === undefined ? null : data, meta };
}

async function request(method, path, body) {
  const result = await envelope(method, path, body, false);
  return result.data;
}

// PATCH 无法走 sendBeacon，只能 fetch + keepalive 在页面卸载时补一次（坑 2）
export function patchProgressKeepalive(mediaId, body) {
  const path = "/api/v1/me/progress/" + encodeURIComponent(mediaId);
  try {
    const done = fetch(path, buildInit("PATCH", body, true));
    if (done && typeof done.catch === "function") done.catch(() => {});
  } catch (err) {
    // 页面正在卸载，忽略
  }
}

export const api = {
  request,
  envelope,
  setupStatus: () => request("GET", "/api/v1/setup/status"),
  setup: (body) => request("POST", "/api/v1/setup", body),
  login: (body) => request("POST", "/api/v1/auth/login", body),
  register: (body) => request("POST", "/api/v1/auth/register", body),
  logout: () => request("POST", "/api/v1/auth/logout", {}),
  me: () => request("GET", "/api/v1/auth/me"),
  // 扫码登录（电视出码 → 手机扫）：start/poll 匿名，claim 由手机端带着自己的会话调。
  qrStart: () => request("POST", "/api/v1/auth/qr/start", {}),
  qrPoll: (id, secret) =>
    request("GET", "/api/v1/auth/qr/poll?id=" + encodeURIComponent(id) + "&s=" + encodeURIComponent(secret)),
  qrClaim: (id, secret, base) => request("POST", "/api/v1/auth/qr/claim", { id, secret, base }),

  users: () => request("GET", "/api/v1/users"),
  createUser: (body) => request("POST", "/api/v1/users", body),
  updateUser: (id, body) => request("PATCH", "/api/v1/users/" + encodeURIComponent(id), body),
  userLibraries: (id) => request("GET", "/api/v1/admin/users/" + encodeURIComponent(id) + "/libraries"),
  setUserLibraries: (id, libraryIds) =>
    request("PUT", "/api/v1/admin/users/" + encodeURIComponent(id) + "/libraries", { library_ids: libraryIds }),
  defaultLibraries: () => request("GET", "/api/v1/admin/libraries/defaults"),
  backfillDefaults: () => request("POST", "/api/v1/admin/libraries/defaults/backfill", { confirm: true }),

  // 媒体库分组（用户 2026-09-22）：组只做归类/批量操作/批量授权，鉴权判据仍在后端。
  libraryGroups: () => request("GET", "/api/v1/admin/library-groups"),
  createLibraryGroup: (body) => request("POST", "/api/v1/admin/library-groups", body),
  updateLibraryGroup: (id, body) => request("PATCH", "/api/v1/admin/library-groups/" + encodeURIComponent(id), body),
  deleteLibraryGroup: (id) => request("DELETE", "/api/v1/admin/library-groups/" + encodeURIComponent(id)),
  setGroupLibraries: (id, libraryIds) =>
    request("PUT", "/api/v1/admin/library-groups/" + encodeURIComponent(id) + "/libraries", { library_ids: libraryIds }),
  libraryGroupAction: (id, action) =>
    request("POST", "/api/v1/admin/library-groups/" + encodeURIComponent(id) + "/action", { action }),
  setLibraryGroup: (libraryId, groupId) =>
    request("PUT", "/api/v1/libraries/" + encodeURIComponent(libraryId) + "/group", { group_id: groupId }),
  userLibraryGroups: (id) => request("GET", "/api/v1/admin/users/" + encodeURIComponent(id) + "/library-groups"),
  setUserLibraryGroups: (id, groupIds) =>
    request("PUT", "/api/v1/admin/users/" + encodeURIComponent(id) + "/library-groups", { group_ids: groupIds }),

  libraries: () => request("GET", "/api/v1/libraries"),
  library: (id) => request("GET", "/api/v1/libraries/" + encodeURIComponent(id)),
  createLibrary: (body) => request("POST", "/api/v1/libraries", body),
  updateLibrary: (id, body) => request("PATCH", "/api/v1/libraries/" + encodeURIComponent(id), body),
  deleteLibrary: (id) => request("DELETE", "/api/v1/libraries/" + encodeURIComponent(id)),
  scanLibrary: (id) => request("POST", "/api/v1/libraries/" + encodeURIComponent(id) + "/scan", { kind: "incremental" }),
  // 清理"文件已不在"的记录（只删记录，不动磁盘文件）；后端要 confirm=true。
  purgeMissing: (id) => request("POST", "/api/v1/libraries/" + encodeURIComponent(id) + "/purge-missing", { confirm: true }),
  scanTask: (id) => request("GET", "/api/v1/scan-tasks/" + encodeURIComponent(id)),
  detectAll: (body) => request("POST", "/api/v1/admin/series/detect-all", body),
  jobTask: (id) => request("GET", "/api/v1/admin/tasks/" + encodeURIComponent(id)),
  // ③ 备份恢复：先预览（multipart 上传）→ 说口令确认
  restorePreview: async (file) => {
    const form = new FormData();
    form.append("file", file, file.name);
    const init = { method: "POST", credentials: "same-origin", cache: "no-store", body: form };
    const token = readCookie(CSRF_COOKIE);
    if (token) init.headers = { "X-CSRF-Token": token };
    const response = await fetch("/api/v1/admin/backup/restore/preview", init);
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (err) { payload = null; }
    const error = payload && payload.error;
    if (!response.ok || error) {
      const message = error && error.message ? String(error.message) : ("请求失败（HTTP " + response.status + "）");
      throw new ApiError(message, (error && error.code) || ("HTTP_" + response.status), response.status);
    }
    return payload && Object.prototype.hasOwnProperty.call(payload, "data") ? payload.data : payload;
  },
  restoreApply: (token, confirm) => request("POST", "/api/v1/admin/backup/restore", { token, confirm }),

  // ② 任务中心：列表 / 取消 / 重试（转码与扫描合并）
  taskList: (limit) => request("GET", "/api/v1/admin/tasks" + (limit ? ("?limit=" + limit) : "")),
  cancelTask: (id) => request("POST", "/api/v1/admin/tasks/" + encodeURIComponent(id) + "/cancel"),
  retryTask: (id) => request("POST", "/api/v1/admin/tasks/" + encodeURIComponent(id) + "/retry"),
  // 按目录建剧场：A=剧场内导入一个目录，B=按一级子目录批量建。
  seriesDirPreview: (id, body) =>
    request("POST", "/api/v1/admin/series/" + encodeURIComponent(id) + "/import-dir/preview", body),
  seriesDirImport: (id, body) =>
    request("POST", "/api/v1/admin/series/" + encodeURIComponent(id) + "/import-dir", body),
  seriesDirsPreview: (body) => request("POST", "/api/v1/admin/series/import-dirs/preview", body),
  seriesDirsImport: (body) => request("POST", "/api/v1/admin/series/import-dirs", body),
  // 上传三步：start → PUT（XHR，见 uploads.js） → finish。
  uploadStart: (body) => request("POST", "/api/v1/admin/uploads/start", body),
  uploadFinish: (id) => request("POST", "/api/v1/admin/uploads/" + encodeURIComponent(id) + "/finish", {}),

  mediaList: (params) => envelope("GET", "/api/v1/media" + queryString(params), undefined, false),
  media: (id) => request("GET", "/api/v1/media/" + encodeURIComponent(id)),
  myLibraries: () => request("GET", "/api/v1/me/libraries"),
  feedNext: (params) => envelope("GET", "/api/v1/feed/next" + queryString(params), undefined, false),
  feedSettings: () => request("GET", "/api/v1/feed/settings"),
  patchFeedSettings: (body) => request("PATCH", "/api/v1/feed/settings", body),

  patchProgress: (mediaId, body) => request("PATCH", "/api/v1/me/progress/" + encodeURIComponent(mediaId), body),
  myProgress: () => request("GET", "/api/v1/me/progress"),

  addFavorite: (id) => request("POST", "/api/v1/me/favorites/" + encodeURIComponent(id), {}),
  removeFavorite: (id) => request("DELETE", "/api/v1/me/favorites/" + encodeURIComponent(id)),

  addWatchLater: (id) => request("POST", "/api/v1/me/watch-later/" + encodeURIComponent(id), {}),
  removeWatchLater: (id) => request("DELETE", "/api/v1/me/watch-later/" + encodeURIComponent(id)),
  watchLater: () => request("GET", "/api/v1/me/watch-later"),
  clearWatchLater: () => request("DELETE", "/api/v1/me/watch-later"),

  addReaction: (id, kind) => request("POST", "/api/v1/media/" + encodeURIComponent(id) + "/reactions", { kind }),
  patchReaction: (id, kind) => request("PATCH", "/api/v1/media/" + encodeURIComponent(id) + "/reactions", { kind }),
  removeReaction: (id) => request("DELETE", "/api/v1/media/" + encodeURIComponent(id) + "/reactions"),

  // 用户上传（UGC）：开会话 / 断点回读 / 定稿 / 取消 / 我的上传；PUT 用 XHR（见 upload.js）。
  // 名字带 ugc 前缀，别和上面管理端那套 uploadStart/uploadFinish 撞车（撞了会互相覆盖）。
  // target 可选：{target_library_id, target_series_title} —— 上传者指定的投递目标（A2）
  ugcStart: (name, size, target) => request("POST", "/api/v1/uploads",
    Object.assign({ name, size }, target || {})),
  ugcGet: (id) => request("GET", "/api/v1/uploads/" + encodeURIComponent(id)),
  ugcFinish: (id) => request("POST", "/api/v1/uploads/" + encodeURIComponent(id) + "/finish"),
  ugcCancel: (id) => request("DELETE", "/api/v1/uploads/" + encodeURIComponent(id)),
  myUploads: () => request("GET", "/api/v1/me/uploads"),
  pendingUploads: () => request("GET", "/api/v1/admin/uploads/pending"),
  approveUpload: (id, body) => request("POST", "/api/v1/admin/uploads/" + encodeURIComponent(id) + "/approve", body),
  rejectUpload: (id, note) => request("POST", "/api/v1/admin/uploads/" + encodeURIComponent(id) + "/reject", { note }),
  // 批量审核（A1）：一次几十集时用，逐条结果由后端如实返回
  approveUploadBatch: (body) => request("POST", "/api/v1/admin/uploads/approve-batch", body),
  rejectUploadBatch: (ids, note) => request("POST", "/api/v1/admin/uploads/reject-batch", { ids, note }),

  systemInfo: () => request("GET", "/api/v1/admin/system/info"),
  systemDisks: () => request("GET", "/api/v1/admin/system/disks"),
  uploadSpace: (libraryId) => request("GET", "/api/v1/me/upload-space" +
    (libraryId ? ("?library_id=" + encodeURIComponent(libraryId)) : "")),

  // P1 转码队列：排队转码（进度看 jobTask）。
  // maxHeight：输出高度上限（0/不传 = 保持原分辨率）
  transcode: (mediaIds, maxHeight) =>
    request("POST", "/api/v1/admin/transcodes", { media_ids: mediaIds, max_height: Number(maxHeight) || 0 }),

  // 自动扫描：读写设置 + 立即触发一轮（202 + task_ids，扫描仍走任务中心）。
  autoScan: () => request("GET", "/api/v1/admin/autoscan"),
  saveAutoScan: (body) => request("PATCH", "/api/v1/admin/autoscan", body),
  runAutoScan: () => request("POST", "/api/v1/admin/autoscan/run", {}),

  mediaRoots: () => request("GET", "/api/v1/media/roots"),
  // 前台删除（仅管理员）：body {delete_file, confirm}
  deleteMedia: (id, body) => request("DELETE", "/api/v1/admin/media/" + encodeURIComponent(id), body),
  addMediaRoot: (path) => request("POST", "/api/v1/media/roots", { path }),
  removeMediaRoot: (path) =>
    request("DELETE", "/api/v1/media/roots" + queryString({ path })),
  browse: (path, offset) =>
    request("GET", "/api/v1/fs/browse" + queryString({ path, offset, limit: 200 })),
};
