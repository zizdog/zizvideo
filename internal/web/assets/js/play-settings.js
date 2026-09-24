// 播放设置：首页 ⚙ 与「我的」共用同一份控件语义 + 同一个 PATCH /api/v1/feed/settings。
// 三项：自动播放下一个 / 循环播放 / 左右键跳转秒数。

import { el } from "./dom.js";

export const FEED_SETTINGS_DEFAULTS = {
  loop_play: false, autoplay_next: true, seek_seconds: 10, autoplay_enter: true,
  feed_hide_series: false, playback_rate: 1,
};

// 倍速档位（B5）：与后端白名单一致
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
export function rateLabel(r) { return (Number(r) === 1 ? "1×（正常）" : String(r) + "×"); }

// normalizeFeedSettings 把任意响应收敛成三项合法值：非法/缺省一律用默认（10 秒、上限 120）。
export function normalizeFeedSettings(data) {
  const src = data && typeof data === "object" ? data : {};
  const raw = Number(src.seek_seconds);
  const seek = Number.isFinite(raw) && raw >= 1 ? Math.min(120, Math.round(raw)) : FEED_SETTINGS_DEFAULTS.seek_seconds;
  return {
    loop_play: !!src.loop_play,
    autoplay_next: src.autoplay_next === undefined ? FEED_SETTINGS_DEFAULTS.autoplay_next : !!src.autoplay_next,
    seek_seconds: seek,
    // 用户 2026-09-24：进入首页是否自动播放（默认开；关掉时首页显示预览帧，点了才播）
    autoplay_enter: src.autoplay_enter === undefined ? FEED_SETTINGS_DEFAULTS.autoplay_enter : !!src.autoplay_enter,
    // 用户 2026-09-24：首页不显示剧场内容（默认关）—— 免得刷到剧集打乱「观看中」的进度
    feed_hide_series: src.feed_hide_series === undefined
      ? FEED_SETTINGS_DEFAULTS.feed_hide_series : !!src.feed_hide_series,
    // B5 播放倍速：只认白名单档位，其它值按 1×
    playback_rate: PLAYBACK_RATES.some((r) => Math.abs(r - Number(src.playback_rate)) < 0.01)
      ? Number(src.playback_rate) : FEED_SETTINGS_DEFAULTS.playback_rate,
  };
}

export function seekSecondsOf(settings) {
  return normalizeFeedSettings(settings).seek_seconds;
}

// 自动播下一个开着时循环不生效（与后端 loop_effective 同义）。
export function loopEffective(settings) {
  const s = normalizeFeedSettings(settings);
  return !!s.loop_play && !s.autoplay_next;
}

// createFeedSettingsForm 只画控件并回调 onChange(partial)；状态与请求由调用方持有。
// lockAutoplay=true（剧场）：自动连播写死开启且**不可设置**，只留"左右键跳转秒数"。
export function createFeedSettingsForm(options) {
  const opts = options || {};
  const lockAutoplay = !!opts.lockAutoplay;
  const hideSeries = el("input", { type: "checkbox" });
  const enter = el("input", { type: "checkbox" });
  const auto = el("input", { type: "checkbox" });
  const loop = el("input", { type: "checkbox" });
  const seek = el("input", { type: "number", min: "1", max: "120", step: "1" });
  const rate = el("select", { class: "input", dataset: { role: "set-rate" } },
    ...PLAYBACK_RATES.map((r) => el("option", { value: String(r), text: rateLabel(r) })));
  const note = el("div", { class: "set-note", text: "连播开启时循环不生效" });
  const hideSeriesRow = el("label", { class: "set-row" }, hideSeries,
    el("span", { text: "首页不显示剧场内容" }));
  const enterRow = el("label", { class: "set-row" }, enter, el("span", { text: "进入自动播放" }));
  const autoRow = el("label", { class: "set-row" }, auto, el("span", { text: "自动播放下一个" }));
  const loopRow = el("label", { class: "set-row" }, loop, el("span", { text: "循环播放" }));
  const seekRow = el("label", { class: "set-row" }, el("span", { text: "左右键跳转" }), seek, el("span", { text: "秒" }));
  const rateRow = el("label", { class: "set-row" }, el("span", { text: "播放倍速" }), rate);
  const form = el("div", { class: "set-form" },
    lockAutoplay ? null : hideSeriesRow,
    lockAutoplay ? null : enterRow,
    lockAutoplay ? null : autoRow,
    lockAutoplay ? null : loopRow,
    rateRow,
    seekRow,
    lockAutoplay ? el("div", { class: "set-note", text: "剧场自动连播（不可设置）" }) : note);

  function emit(partial) {
    if (opts.onChange) opts.onChange(partial);
  }

  let last = normalizeFeedSettings(opts.settings);

  hideSeries.addEventListener("change", () => emit({ feed_hide_series: hideSeries.checked }));
  rate.addEventListener("change", () => emit({ playback_rate: Number(rate.value) }));
  enter.addEventListener("change", () => emit({ autoplay_enter: enter.checked }));
  auto.addEventListener("change", () => emit({ autoplay_next: auto.checked }));
  loop.addEventListener("change", () => emit({ loop_play: loop.checked }));
  seek.addEventListener("change", () => {
    const raw = Number(seek.value);
    const next = Number.isFinite(raw) ? Math.max(1, Math.min(120, Math.round(raw))) : last.seek_seconds;
    seek.value = String(next);
    emit({ seek_seconds: next });
  });

  function paint(settings) {
    last = normalizeFeedSettings(settings || last);
    rate.value = String(last.playback_rate);
    hideSeries.checked = !!last.feed_hide_series;
    enter.checked = !!last.autoplay_enter;
    auto.checked = !!last.autoplay_next;
    loop.checked = !!last.loop_play;
    loop.disabled = !!last.autoplay_next;
    seek.value = String(last.seek_seconds);
    note.classList.toggle("hidden", !last.autoplay_next);
  }

  paint();
  return { node: form, paint };
}
