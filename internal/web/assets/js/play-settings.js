// 播放设置：首页 ⚙ 与「我的」共用同一份控件语义 + 同一个 PATCH /api/v1/feed/settings。
// 三项：自动播放下一个 / 循环播放 / 左右键跳转秒数。

import { el } from "./dom.js";
import { icon } from "./icons.js";

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

// trimRate：抖音那排是 0.75 / 1.0 / 1.25 这种写法（整数也带一位小数）
function trimRate(r) {
  const n = Number(r);
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
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

  // ---- 抖音式行（variant: "sheet"）：[图标] 标签 ……… 右侧控件/值 ----
  //
  // 为什么要两套：面板要"抖音样式"（分组卡片 + 行 + 开关），而「我的→设置」页沿用列表式。
  // 逻辑（emit/paint）只有一份，只是 DOM 不同 —— 别写第二份设置逻辑。
  const sheet = opts.variant === "sheet";
  // activate：整行可点/可确定（电视端遥控器要能落焦到行上；开关行点行=切换，跟抖音一致）
  function sheetRow(iconName, labelText, right, activate) {
    const row = el("div", { class: "sheet-row", tabindex: "0" },
      icon(iconName),
      el("span", { class: "sheet-label", text: labelText }),
      el("span", { class: "sheet-right" }, right));
    if (activate) row.addEventListener("click", (event) => { event.stopPropagation(); activate(); });
    return row;
  }
  function switchEl(input) {
    const box = el("span", { class: "sheet-switch" }, input);
    input.classList.add("sheet-switch-input");
    // 开关本身不进焦点序列：焦点落在整行上（否则遥控器会停在看不见的复选框上）
    input.tabIndex = -1;
    return box;
  }
  function toggleOf(input) {
    return () => {
      if (input.disabled) return;
      input.checked = !input.checked;
      input.dispatchEvent(new Event("change"));
    };
  }
  function paintSwitch(input) {
    input.parentNode.classList.toggle("on", !!input.checked);
    input.parentNode.classList.toggle("off", !input.checked);
  }
  // 倍速：抖音是一排数字（点一下就切），不是下拉框
  const rateSeg = el("div", { class: "sheet-seg", dataset: { role: "sheet-rate" } });
  for (const r of PLAYBACK_RATES) {
    const b = el("button", { class: "sheet-seg-btn", type: "button", text: trimRate(r),
      dataset: { rate: String(r) } });
    b.addEventListener("click", (event) => {
      event.stopPropagation();
      emit({ playback_rate: r });
    });
    rateSeg.append(b);
  }
  const rateSheetRow = sheetRow("speed", "倍速", rateSeg);

  // 左右键跳转只对 web 有意义（App 里没有键盘）⇒ sheet 变体下可以整行不显示（用户 2026-09-24）
  const hideSeek = !!opts.hideSeek;
  const form = sheet
    ? el("div", { class: "set-form sheet-form" },
        rateSheetRow,
        hideSeek ? null : seekRow,
        lockAutoplay ? null : loopRow,
        lockAutoplay ? null : autoRow,
        lockAutoplay ? null : enterRow,
        lockAutoplay ? null : hideSeriesRow,
        lockAutoplay ? el("div", { class: "set-note", text: "剧场自动连播（不可设置）" }) : note)
    : el("div", { class: "set-form" },
        lockAutoplay ? null : hideSeriesRow,
        lockAutoplay ? null : enterRow,
        lockAutoplay ? null : autoRow,
        lockAutoplay ? null : loopRow,
        rateRow,
        seekRow,
        lockAutoplay ? el("div", { class: "set-note", text: "剧场自动连播（不可设置）" }) : note);

  // sheet 变体：把"开关行"换成抖音风格的行（同一个 input，事件/状态都不变）
  if (sheet) {
    const pairs = [
      [rateSheetRow, null],
      [seekRow, sheetRow("seek", "左右键跳转", seek)],
      [loopRow, sheetRow("repeat", "循环播放", switchEl(loop), toggleOf(loop))],
      [autoRow, sheetRow("next", "自动播放下一个", switchEl(auto), toggleOf(auto))],
      [enterRow, sheetRow("play", "进入自动播放", switchEl(enter), toggleOf(enter))],
      [hideSeriesRow, sheetRow("theater", "首页不显示剧场内容", switchEl(hideSeries), toggleOf(hideSeries))],
    ];
    // 原节点换成行式节点（顺序按上面的数组；rateSheetRow/seekRow 已在 form 里，不动）
    for (const [oldNode, newNode] of pairs) {
      if (!newNode) continue;
      if (oldNode && oldNode.parentNode) oldNode.parentNode.replaceChild(newNode, oldNode);
    }
  }

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
    // 抖音式：倍速高亮当前档；开关跟着亮灭
    for (const b of rateSeg.querySelectorAll(".sheet-seg-btn")) {
      b.classList.toggle("on", Math.abs(Number(b.dataset.rate) - last.playback_rate) < 0.01);
    }
    for (const input of [loop, auto, enter, hideSeries]) paintSwitch(input);
  }

  paint();
  return { node: form, paint };
}
