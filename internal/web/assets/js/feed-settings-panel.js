// 设置面板（底部 sheet）＋ 剧场「选集」面板：只画 DOM、只回调，状态由 feed.js 持有。
// 面板可见性一律现查 DOM（panelVisible），不许缓存成布尔值 —— 见 holdCurrent 的不变量说明。

import { el, fmtDuration } from "./dom.js";
import { icon } from "./icons.js";
import { createFeedSettingsForm } from "./play-settings.js";
import { tvMode, focusFirst } from "./tv.js";
import { pipAvailable, castAvailable, nativeCacheAvailable } from "./feed-native.js";

export function createSettingsPanel(ctx) {
  const state = ctx.state;
  const feed = ctx.feed;
  const picker = ctx.picker;
  const playlist = ctx.playlist;
  const showToast = ctx.core.showToast;
  const isAdmin = ctx.core.isAdmin;
  const toggleWatchLater = ctx.core.toggleWatchLater;
  const askDelete = ctx.core.askDelete;
  const goTo = ctx.core.goTo;
  const saveSettings = ctx.core.saveSettings;
  const paintPanel = ctx.core.paintPanel;
  const loopEnabled = ctx.core.loopEnabled;
  const toggleClean = ctx.fs.toggleClean;
  const toggleCast = ctx.native.toggleCast;
  const togglePip = ctx.native.togglePip;

  // 面板外的遮罩：**吞掉点击**（点外面只关面板，不触发播放/暂停等外部操作 —— 用户明确要求）。
  let sheetScrim = null;
  function ensureScrim() {
    if (sheetScrim) return sheetScrim;
    sheetScrim = el("div", { class: "sheet-scrim hidden", dataset: { role: "sheet-scrim" } });
    sheetScrim.addEventListener("pointerdown", (event) => event.stopPropagation(), true);
    sheetScrim.addEventListener("click", (event) => {
      event.stopPropagation();
      closePanels();
    });
    return sheetScrim;
  }

  function toolButton(label, onClick, extra) {
    const btn = el("button", {
      class: "sheet-tool" + (extra ? " " + extra : ""), type: "button", text: label,
    });
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    return btn;
  }

  // 底部设置面板（用户 2026-09-24：参考抖音 —— 分组卡片 + 每行"图标+文字+右侧值/开关"）
  function buildPanel(entry) {
    entry.settingsForm = createFeedSettingsForm({
      settings: state.settings,
      onChange: saveSettings,
      // 剧场：自动连播写死开启且**不可设置**（用户要求），只留"跳转秒数"。
      lockAutoplay: !!playlist,
      variant: "sheet",
      // 左右键跳转只在 web 有意义，App 里不显示这一行（用户 2026-09-24）
      hideSeek: inAppWebView(),
    });

    // 第 1 组：投屏 / 小窗播放 / 缓存视频（能做才显示）
    const tools = el("div", { class: "sheet-group" });
    if (castAvailable()) tools.append(actionRow("cast", "投屏", () => { closePanels(); toggleCast(entry); }));
    if (pipAvailable()) tools.append(actionRow("pip", "小窗播放", () => { closePanels(); togglePip(entry); }));
    if (nativeCacheAvailable()) {
      tools.append(actionRow("download", "缓存视频", () => {
        // 元数据跟着文件一起落盘（标题/封面/时长/原始 id）⇒「我的 → 已缓存」离线也能显示
        // 标题和封面，不再是一串 med_xxxx（用户 2026-09-25 报障）。
        const meta = JSON.stringify({
          id: String(entry.item.id),
          title: entry.item.title || "",
          cover: entry.item.cover_url || "",
          duration_ms: Number(entry.item.duration_ms) || 0,
        });
        try {
          if (typeof window.ZvAndroid.cacheVideo2 === "function") window.ZvAndroid.cacheVideo2(String(entry.item.id), meta);
          else window.ZvAndroid.cacheVideo(String(entry.item.id), entry.item.title || "");
          showToast("开始缓存，看通知栏进度");
          closePanels();
        } catch (err) { showToast("这台设备缓存不了"); }
      }));
    }

    // 电视端（遥控器）够不着右侧栏（没有触摸）⇒ 把侧栏那 4 个动作原样搬一份到这里
    // （用户 2026-09-25 选了"复用网页界面 + 方向键"，手机上/网页上这一组不显示）。
    // 只是"换个地方放"，不新增任何功能。
    const tvQuick = tvMode() ? el("div", { class: "sheet-group" }) : null;
    if (tvQuick) {
      tvQuick.append(
        actionRow("thumb", "点赞", () => { entry.like.click(); }),
        actionRow("heart", "收藏", () => { entry.fav.click(); }),
        // 声音/全屏两行**电视端不放**（用户 2026-09-28："不要在 tv 端显示全屏按钮！不要显示静音！"）；
        // 这两个按钮在 TV 上压根没建（entry.sound / entry.fullscreen 为空），点了也会是空指针。
        // ⚠️ 电视端**不放搜索**（用户 2026-09-28："不要全屏、和搜索按钮…直接隐藏掉"）—— 这里也不再补。
      );
    }

    // 第 2 组：常用（清屏/稍后再看 + 播放设置那一堆行，同一张卡片里）
    const common = el("div", { class: "sheet-group" });
    if (playlist) {
      // 剧场：选集（原来在边栏，边栏只留 4 个后搬到这里）
      common.append(actionRow("theater", "选集", () => {
        closePanels();
        if (!entry.epsPanel) entry.layer.append(buildEpisodePanel(entry));
        entry.epsPanel.classList.remove("hidden");
      }, state.items.length + " 集"));
    }
    // 清屏播放图标 = 用户给的图1（一把刷子，2026-09-25）
    const cleanRow = actionRow("clean", "清屏播放", () => { toggleClean(); paintCommon(); });
    cleanRow.dataset.role = "sheet-clean";
    common.append(cleanRow);
    const laterRow = actionRow("clock", "稍后再看", () => { toggleWatchLater(entry); paintCommon(); });
    laterRow.dataset.role = "sheet-later";
    common.append(laterRow);
    if (isAdmin()) {
      // 管理员：删除入口（原来在边栏）。删除要弹确认框，所以这里**不自动收面板**
      const delRow = actionRow("trash", "删除这个视频", () => askDelete(entry), "", false);
      delRow.dataset.role = "sheet-delete";
      common.append(delRow);
    }
    common.append(entry.settingsForm.node);

    const groups = [];
    if (tools.childNodes.length) groups.push(tools);
    if (tvQuick) groups.push(tvQuick);
    groups.push(common);

    // 第 3 组：剧场入口（图3 的「合集 · 这是一个小短剧 更新至 N 集 >」）
    if (playlist && playlist.seriesId) {
      // tabindex=0：跟 actionRow 一样，电视端遥控器得能落焦（div 默认不可聚焦 ⇒ 点了没反应）
      const row = el("div", { class: "sheet-row sheet-series", tabindex: "0", dataset: { role: "sheet-series" } },
        icon("theater"),
        el("span", { class: "sheet-label", text: "剧场 · " + (playlist.title || "") }),
        el("span", { class: "sheet-right muted", text: "共 " + (playlist.episodeCount || state.items.length) + " 集" }),
        el("span", { class: "sheet-arrow", text: "›" }));
      row.addEventListener("click", (event) => {
        event.stopPropagation();
        location.hash = "#/series/" + encodeURIComponent(playlist.seriesId);
      });
      groups.push(el("div", { class: "sheet-group" }, row));
    }

    // 门禁要求：展开只能用数组（groups 是数组没错，但为了可读性显式用循环拼）
    const panel = el("div", { class: "set-panel sheet hidden", dataset: { role: "settings-sheet" } },
      el("div", { class: "sheet-handle" }));
    for (const g of groups) panel.append(g);
    entry.panel = panel;
    entry.panel.addEventListener("click", (event) => event.stopPropagation());
    // 面板自己能滚：滚轮/触摸就地消化，别冒泡到 feed（否则一滚就换下一条视频）
    entry.panel.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
    entry.panel.addEventListener("touchmove", (event) => event.stopPropagation(), { passive: true });

    // 行上的状态文字（清屏开/关、稍后再看已添加/未添加）跟着真实状态刷
    function paintCommon() {
      const cleanRow = common.querySelector('[data-role="sheet-clean"] .sheet-right');
      if (cleanRow) cleanRow.textContent = feed.classList.contains("clean") ? "已开启" : "关闭";
      const laterRight = common.querySelector('[data-role="sheet-later"] .sheet-right');
      if (laterRight) laterRight.textContent = (entry.item && entry.item.watch_later) ? "已添加" : "未添加";
    }
    entry.paintSheet = paintCommon;
    entry.panel.__zvPaintCommon = paintCommon;
    return entry.panel;
  }

  // 抖音式行：[图标] 标签 ………… 右侧值
  // collapse=true（默认）：点完**立刻收起面板**回到播放（用户 2026-09-24：
  // "任何操作完成都应该收起面板，如点了稍后再看后立刻收起，显示视频播放"）。
  function actionRow(iconName, label, onClick, rightText, collapse) {
    const right = el("span", { class: "sheet-right muted", text: rightText || "" });
    // tabindex=0：电视端遥控器要能落焦到这一行（div 默认不可聚焦），确定键由 tv.js 代点
    const row = el("div", { class: "sheet-row", tabindex: "0", dataset: { role: "sheet-action" } },
      icon(iconName), el("span", { class: "sheet-label", text: label }), right);
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
      if (collapse !== false) closePanels();
    });
    return row;
  }

  function openPanel(entry) {
    if (entry.destroyed || !entry.layer) return;
    if (!entry.panel) entry.layer.append(ensureScrim(), buildPanel(entry));
    closePanels();
    holdCurrent(true);   // 面板开着期间：当前这条一直循环，不许自动下一个
    // 长按/右键可能顺带选中了底下的文字，进而弹出系统选择菜单（用户报障）——开面板时清掉选区
    try { const sel = window.getSelection(); if (sel) sel.removeAllRanges(); } catch (err) { /* 忽略 */ }
    paintPanel(entry);
    ensureScrim().classList.remove("hidden");
    // 电视端：面板一开就把焦点落到第一行（用户 2026-09-27："面板打开没反应/只能上下左右"——
    // 原来是"开了但没落焦"，第一下↓才落焦，看着就像没打开）。
    if (tvMode()) setTimeout(() => focusFirst(), 0);
    entry.panel.classList.remove("hidden");
    if (entry.paintSheet) entry.paintSheet();
  }

  // 剧场「选集」面板：样式与剧场列表里的选集一致（.ep-list/.ep-item），点一集就跳过去。
  function buildEpisodePanel(entry) {
    const panel = el("div", { class: "set-panel eps hidden" });
    const list = el("div", { class: "ep-list" });
    state.items.forEach((item, i) => {
      list.append(el("button", {
        class: "ep-item" + (i === entry.index ? " on" : ""), type: "button",
        dataset: { role: "ep-item", index: String(i) },
        onclick: () => { panel.classList.add("hidden"); goTo(i); },
      },
        el("span", { class: "ep-no", text: item.episode_label || ("第 " + (i + 1) + " 集") }),
        el("span", { class: "ep-title", text: item.title || ("#" + item.id) }),
        el("span", { class: "ep-pct muted", text: fmtDuration(item.duration_ms) })));
    });
    panel.append(el("div", { class: "panel-title", text: (playlist.title || "剧场") + " · 选集" }), list);
    panel.addEventListener("click", (event) => event.stopPropagation());
    entry.epsPanel = panel;
    return panel;
  }

  function closePanels() {
    const hadOpen = anyPanelOpen();
    for (const entry of state.built.values()) {
      if (entry.panel) entry.panel.classList.add("hidden");
      if (entry.epsPanel) entry.epsPanel.classList.add("hidden");
    }
    if (sheetScrim) sheetScrim.classList.add("hidden");
    if (picker) picker.classList.add("hidden");
    holdCurrent(false); // 面板收起 ⇒ 恢复用户设置的连播/循环行为
    // 电视端：面板是 `.hidden` 藏起来的（节点还在文档里），tv.js 的"焦点节点被删才补焦点"兜不住 ——
    // 收面板后焦点会掉到 body（遥控器立刻没反应）。这里显式把焦点还回画面（见 focusFirst 的说明）。
    if (hadOpen && tvMode()) setTimeout(() => focusFirst(), 0);
  }

  // 面板开着时：当前这条一直循环，绝不自动下一个（用户 2026-09-24 的改进 3）。
  // 收起后怎么播由用户的设置决定：开了连播/循环就照旧，都没开就播完暂停。
  //
  // ⚠️ 不变量：**"面板开着"绝不缓存成布尔值**，一律用 panelVisible() 现查 DOM。
  //    面板节点是 entry 的 DOM 子节点：dropItem（从设置面板删掉当前视频）和 zvResumeNative
  //    （原生收回播放、网页跳到别的条目）都会销毁 entry 却不走 closePanels()，缓存下来的 true
  //    就永远复位不了 —— onEnded 里那句"面板开着就早退"从此对**所有**条目生效，
  //    本条及之后每条视频播完都停在最后一帧（不连播、不循环、也没有播放按钮）。
  function holdCurrent(on) {
    const loop = on ? true : loopEnabled();
    for (const entry of state.built.values()) {
      if (entry.video) entry.video.loop = loop;
    }
  }

  // 当前这条（active）的面板**真的可见**吗？判据就是 DOM（见上面 holdCurrent 的不变量）。
  // 只看 active：别的条目的 layer 在翻页轨道里（手机端）或收在列表行里（电视端），它们的面板
  // 就算没 .hidden 也压根不在屏幕上 —— 那种残留不许再把播放按死在"只循环当前这条"上。
  function panelVisible() {
    const entry = state.built.get(state.active);
    if (!entry) return false;
    if (entry.panel && !entry.panel.classList.contains("hidden")) return true;
    return !!(entry.epsPanel && !entry.epsPanel.classList.contains("hidden"));
  }

  // 有面板开着吗？（返回手势/App 返回键先关它，再管全屏）
  function anyPanelOpen() {
    for (const entry of state.built.values()) {
      if (entry.panel && !entry.panel.classList.contains("hidden")) return true;
      if (entry.epsPanel && !entry.epsPanel.classList.contains("hidden")) return true;
    }
    return !!(picker && !picker.classList.contains("hidden"));
  }

  // App 里的判定：原生桥在（window.ZvAndroid）或 URL 带 zv=app（WebActivity 会加）。
  // App 不显示设置按钮 —— 抖音就是长按弹面板，用户 2026-09-24 明确要一致。
  function inAppWebView() {
    return !!window.ZvAndroid || /[?&]zv=app(&|#|$)/.test(location.search + location.hash);
  }

  return { openPanel, closePanels, panelVisible, anyPanelOpen, buildEpisodePanel, holdCurrent };
}
