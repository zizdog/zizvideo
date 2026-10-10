// 播放声音：本机偏好（localStorage）＋“这一刻实际听不听得到”的唯一判据。
// 拆出来的原因：首页、剧场、原生桥（回到前台自动恢复有声）都要读同一份结论，
// 而它与播放器主体（条目/手势/进度）无关。

import { el } from "./dom.js";
import { setIcon } from "./icons.js";
import { api } from "./api.js";
import { tvMode } from "./tv.js";

const SOUND_KEY = "zv_sound";

export function readSoundPref() {
  // 没存过 = **默认开声**（用户 2026-09-27："默认视频应该是打开声音的，我测试时默认静音"）。
  // 只有用户自己按过喇叭（存了 "off"）才静音。浏览器不许"有声自动播放"时，
  // 下面的 tryPlay() 会退回静音自动播 + 提示去哪里开声，这条路不变。
  // ⚠️ 电视端不适用：用户 2026-09-28 明确"任何情况下都不要静音" ⇒ TV 上偏好恒为"开"。
  if (tvMode()) return true;
  try {
    const saved = localStorage.getItem(SOUND_KEY);
    return saved === null ? true : saved === "on";
  } catch (err) {
    return true;
  }
}

function writeSoundPref(on) {
  try { localStorage.setItem(SOUND_KEY, on ? "on" : "off"); } catch (err) { /* 隐私模式忽略 */ }
}

// createSoundModule(ctx)：ctx 由 feed.js 装配（见 feed-state.js 的说明）。
export function createSoundModule(ctx) {
  const state = ctx.state;
  const showToast = ctx.core.showToast;

  /* ---------- 声音（角落按钮，不再是单击画面） ---------- */

  // 唯一的判据：**这一刻实际听不听得到**。偏好（localStorage）说"开"、但浏览器把有声自动播放
  // 摁掉了（soundBlocked）时，实际是静音 —— 图标/提示/元素三者都必须按这个来。
  // 原来只有"用户点喇叭"那一处会同步元素，被策略摁静音那次不同步 ⇒ 图标显示有声、实际没声，
  // 用户得点两下（先静音、再开声）才有声音（用户 2026-09-25 报障）。
  function effectiveSoundOn() {
    // 电视端恒定有声（用户 2026-09-28："任何情况下都不要静音"）——
    // 偏好、"被策略摁掉"这两条路都不许把 TV 弄静音。
    if (tvMode()) return true;
    return state.soundOn && !state.soundBlocked;
  }

  /**
   * 音量均一化补一次：列表是**打开页面时**取的，那时这条可能还没量过响度（gain_db=0），
   * 而服务端是"第一次播它"时才开始在后台量（量完才写库）⇒ 本次会话里这条拿不到增益。
   * 所以开播后过几秒回查一次这一条：量到了就把音量落下去（用户 2026-09-26："不同视频音量不同"）。
   * 只查一次、只查没量过的那些，避免每条都多打一个请求。
   */
  function refreshGain(index) {
    const item = state.items[index];
    if (!item || Number(item.gain_db) < 0 || item.__gainChecked) return;
    item.__gainChecked = true;
    setTimeout(() => {
      api.media(String(item.id)).then((m) => {
        const gain = m && Number(m.gain_db);
        if (!(gain < 0)) return;
        item.gain_db = gain;
        const entry = state.built.get(index);
        // 同一下标可能已经换成别的视频了（切库/换挂载，同类竞态）：只认"还在这个位置上的那一条"
        if (entry && entry.item === item && entry.video) {
          entry.video.volume = Math.max(0, Math.min(1, Math.pow(10, gain / 20)));
        }
      }).catch(() => { /* 查不到就算了，下次打开页面还有机会 */ });
    }, 6000);
  }

  /** 把"实际该不该有声"落到**所有**已建条目上，并同步图标/提示（只此一处改 audio 状态）。 */
  function applySound() {
    const on = effectiveSoundOn();
    for (const entry of state.built.values()) {
      if (entry.video) entry.video.muted = !on;
      paintSound(entry);
      if (on) hideSoundHint(entry);
    }
  }

  function paintSound(entry) {
    if (!entry || !entry.sound) return;
    const on = effectiveSoundOn();
    setIcon(entry.sound, on ? "volume" : "mute");
    entry.sound.dataset.sound = on ? "on" : "off"; // 给验收脚本一个稳的判据（不是文案）
  }

  /** 浏览器不许"有声自动播放"：标记 + 图标与元素一起变静音（偏好不动，等用户点一下）。 */
  function markSoundBlocked() {
    if (state.soundBlocked) return;
    state.soundBlocked = true;
    applySound();
  }

  /** 有手势之后浏览器放行了：解除标记，按用户偏好恢复（图标与元素同时回到"有声"）。 */
  function clearSoundBlocked() {
    if (!state.soundBlocked) return;
    state.soundBlocked = false;
    applySound();
  }

  let soundToastReady = false
  function setSound(on) {
    const before = effectiveSoundOn();
    // 这个调用只来自"用户点了喇叭/按了确定"⇒ 已经是手势，策略不再拦
    state.soundBlocked = false;
    state.soundOn = !!on;
    writeSoundPref(state.soundOn);
    applySound();
    const after = effectiveSoundOn();
    if (soundToastReady && before !== after) showToast(after ? "声音已开" : "已静音");
    soundToastReady = true;
  }

  function soundButton(entry) {
    entry.sound = el("button", { class: "icon-btn", type: "button", title: "声音" });
    paintSound(entry);
    entry.sound.addEventListener("click", (event) => {
      event.stopPropagation();
      // 按"实际听不听得到"决定下一次 —— 被策略摁成静音时，点一下就该有声（不是先静音再开声）
      setSound(!effectiveSoundOn());
    });
    return entry.sound;
  }

  function showSoundHint(entry) {
    if (tvMode()) return; // 电视端没有喇叭键、也永远不静音 —— 这条提示在 TV 上没有意义（用户 2026-09-28）
    if (entry.destroyed || !entry.layer) return;
    if (!entry.soundHint) {
      entry.soundHint = el("div", { class: "hint low", text: "点右下角的喇叭开启声音" });
      entry.layer.append(entry.soundHint);
    }
    entry.soundHint.classList.remove("hidden");
  }

  function hideSoundHint(entry) {
    if (entry.soundHint) entry.soundHint.classList.add("hidden");
  }

  return { effectiveSoundOn, refreshGain, markSoundBlocked, clearSoundBlocked, soundButton, showSoundHint };
}
