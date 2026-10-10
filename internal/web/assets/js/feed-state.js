// 首页播放流的共享运行态：一份 state（条目/游标/设置/声音偏好）＋一份跨模块可变标志 rt。
// 为什么要单独一个文件：拆模块之后 tv 布局、设置面板、原生桥都要读写同一份状态；
// 显式放在这里，谁在改什么一眼可见 —— 不许退化成隐式全局变量。

import { normalizeFeedSettings } from "./play-settings.js";
import { readSoundPref } from "./feed-sound.js";
import { tvMode } from "./tv.js";

// createFeedRuntime(options)：每次挂载播放器建一份（一个页面同时只有一个）。
// options.playlist = { title, items } 时是剧场（播放列表）模式，与首页共用这一个 state。
export function createFeedRuntime(options) {
  const playlist = (options && options.playlist) || null;
  const state = {
    // ⚠️ items 必须**从空开始**：数据统一由 appendItems 追加（它按 state.items.length 决定下标与
    // 外壳 top）。播放列表模式若在这里预填，appendItems 会再加一遍 ⇒ 外壳下标/位置错位，
    // 卡片被推到 top:100% 的视口外 —— 观感就是"点开一片黑"（用户 2026-09-22 报障）。
    items: [],
    shells: [], built: new Map(),
    active: -1,
    // 首页靠游标无限翻页；播放列表模式一次给全，没有"更多页"（goTo 到末尾就 clamp）
    hasMore: !playlist, loading: false,
    soundOn: readSoundPref(), // 与首页共用同一个偏好（localStorage 同一个键）
    // 浏览器把"有声自动播放"摁掉过一次（没有用户手势时一定会被摁）⇒ 这一页实际是静音的。
    // 图标必须跟着它走，否则就是用户报障的"图标显示有声、其实没声，要点两下"（2026-09-25）。
    soundBlocked: false,
    scope: "", scopeName: "", nextCursor: "",
    libraries: [], librariesLoaded: !!playlist,
    // 剧场：自动连播写死开启、循环写死关闭（用户："自动连播且无法设置"）
    settings: normalizeFeedSettings(playlist ? { autoplay_next: true, loop_play: false } : undefined),
    infoCard: null, emptyCard: null, errorCard: null,
  };
  // rt：跨模块共享的**可变标量**（对象本身共享，字段直接读写）。
  const rt = {
    // 画面态判定不绑死“某个具体 layer”：换视频会重建 layer、旧节点被搬走，
    // 那一瞬间 activeElement 还指着旧节点 —— 必须仍旧当画面态，否则遥控器会突然没反应。
    tvSurface: tvMode(),
    /** 全屏（影院）状态；tvOpsOpen = 设置键弹出的「点赞/收藏/设置」栏开着。 */
    tvFull: false,
    tvOpsOpen: false,
    /** 服务器版本号（只用来显示，读不到就空着）—— 电视端“这版到底生效没有”的第一判据。 */
    tvVersion: "",
    // 沉浸（全屏）状态：全局一份（feed 只有一个）—— paintImmersive / releaseFullscreen 都改它。
    full: { rotated: false, native: false, uiHidden: false },
  };
  return { state, rt };
}
