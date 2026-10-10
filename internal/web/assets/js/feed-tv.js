// 电视端（Android TV / 盒子）：三栏骨架（媒体库 · 视频列表 · 播放窗口）＋ 遥控器方向键。
// 布局判定 tvLayout 在挂载那一刻由 feed.js 传入（就是 tvMode() 的结果）；
// 只在这里画电视端 DOM 与算焦点，手机/网页端一行都不变。

import { el, clear, fmtDuration } from "./dom.js";
import { tvMode, focusSelector, moveFocusIn } from "./tv.js";

export function createTvModule(ctx) {
  const state = ctx.state;
  const rt = ctx.rt;
  const feed = ctx.feed;
  const playlist = ctx.playlist;
  const tvLayout = ctx.tvLayout;
  const tvStage = ctx.tvStage;
  const tvLibs = ctx.tvLibs;
  const tvLibsBody = ctx.tvLibsBody;
  const tvNav = ctx.tvNav;
  const tvHintMain = ctx.tvHintMain;
  const tvHintSub = ctx.tvHintSub;
  const goTo = ctx.core.goTo;
  const togglePlay = ctx.core.togglePlay;
  const tryPlay = ctx.core.tryPlay;
  const maybeLoadMore = ctx.core.maybeLoadMore;
  const switchScope = ctx.core.switchScope;
  const isPlayable = ctx.core.isPlayable;
  const titleOf = ctx.core.titleOf;
  const closePanels = ctx.panels.closePanels;
  const tvNeedsNative = ctx.native.tvNeedsNative;
  const tvNativePlay = ctx.native.tvNativePlay;

  /**
   * 电视端：左侧列表点亮当前这条 + 滚到看得见的地方（不做整屏位移 —— 那是手机端的翻页）。
   * 列表行是"索引"，不是焦点：焦点始终在右侧画面上（用户 2026-09-28 的范式：上下键翻页）。
   */
  function paintTvList() {
    if (!tvLayout) return;
    state.shells.forEach((row, i) => {
      if (row && row.classList) row.classList.toggle("on", i === state.active);
    });
    const cur = state.shells[state.active];
    if (cur && cur.scrollIntoView) {
      try { cur.scrollIntoView({ block: "nearest" }); } catch (err) { /* 老 WebView 忽略 */ }
    }
  }

  /** 电视端：右侧播放区里只放"当前这条"的 layer；其余收回列表行（行内的 layer 是隐藏的）。 */
  function tvStageSet() {
    if (!tvLayout) return;
    for (const [index, entry] of state.built) {
      if (!entry.layer) continue;
      if (index === state.active) {
        if (entry.layer.parentNode !== tvStage) tvStage.append(entry.layer);
      } else if (entry.layer.parentNode === tvStage) {
        const row = state.shells[index];
        if (row) row.append(entry.layer);
        else entry.layer.remove();
      }
    }
  }

  /**
   * 电视端左栏列表的一行：封面 + 时长 + 标题 + 一行元信息。
   * 行**可以聚焦**：焦点走到哪条就切到哪条（右边跟着播）；按确定 = 进全屏播放。
   * 元信息做减法：没有播放量就写"看到 x% / 已看完"，播放列表就写"第 N 集"。
   */
  function tvRow(item, index) {
    const dur = fmtDuration(item.duration_ms);
    const prog = item.progress || {};
    let meta = "";
    if (prog.completed) meta = "已看完";
    else if (prog.position_ms > 0 && item.duration_ms > 0) {
      meta = "看到 " + Math.min(99, Math.round((prog.position_ms / item.duration_ms) * 100)) + "%";
    } else if (playlist) meta = "第 " + (index + 1) + " 集";
    else if (item.library_name) meta = item.library_name;
    // 非 H.264 的编码在电视端要走原生播放器 —— 标出来，用户一眼知道为什么
    const vcodec = String((item.codecs && item.codecs.video) || "").toLowerCase();
    if (vcodec && vcodec !== "h264" && vcodec !== "avc1") {
      meta = (meta ? meta + " · " : "") + vcodec.toUpperCase();
    }
    const row = el("div", { class: "tv-row", tabindex: "0", dataset: { index: String(index), id: String(item.id) } },
      el("span", { class: "tv-thumb" },
        item.cover_url ? el("img", { src: item.cover_url, alt: "", loading: "lazy" }) : null,
        dur ? el("span", { class: "tv-dur", text: dur }) : null),
      el("span", { class: "tv-row-body" },
        el("span", { class: "tv-row-title", text: titleOf(item, index) }),
        el("span", { class: "tv-row-meta", text: meta || "未看" })));
    // ⚠️ 只移动焦点、**不切播放**（用户 2026-09-29："视频列表上下切换时不播放！切换到对应焦点，
    // 点击确定再播放，期间正在播放的视频不停止"）。焦点框由 tv.js 的 .tv-focus 画，
    // "正在播的那条"由 .on 画 —— 两者可以不是同一条。
    row.addEventListener("click", () => tvPlayFromList(index));
    return row;
  }

  /** 从左栏列表播放某一条：如果是全屏就用它，否则切过去并进全屏（用户 2026-09-28："确定进入全屏播放"）。 */
  function tvPlayFromList(index) {
    closePanels();
    const item = state.items[index];
    // WebView 解不了的编码（HEVC/AV1）先交原生 —— 别让它去 <video> 里黑屏
    if (tvNeedsNative(item)) return tvNativePlay(item);
    // 这一条服务端说放不了（别的编码/状态）：也交给原生播放器，别停在"放不了"那张卡上
    if (item && !isPlayable(item) && !item.missing) return tvNativePlay(item);
    // 用户 2026-09-30："视频列表点击时只播放，不全屏，再次点击才全屏"
    // 第一次确定 = 切过去播（焦点留在列表里，方便接着挑下一条）；**同一条**再按确定才进全屏。
    if (index !== state.active) {
      goTo(index);
      return true;
    }
    if (rt.tvFull) { tvFocusSurface(); return true; }
    return tvSetFull(true);
  }

  /** 右栏库列表的数据：第一个永远是"全部库"，后面是这台账号能访问的媒体库（顺序按后端）。 */
  function tvTabs() {
    return [{ id: "", name: "全部库" }].concat(
      state.libraries.map((lib) => ({ id: lib.id, name: lib.name || lib.id })));
  }

  /**
   * 电视端**右栏**：该用户可访问的媒体库（竖排；用户 2026-09-28 最新版把原来顶部那排挪到右边）。
   * 剧场（播放列表）没有"库"的概念，右栏整块藏起来。
   */
  function renderTvLibs() {
    if (!tvLayout || !tvLibs) return;
    clear(tvLibsBody);
    if (playlist) {
      tvLibs.classList.add("hidden");
      return;
    }
    tvLibs.classList.remove("hidden");
    for (const it of tvTabs()) {
      const on = String(state.scope || "") === String(it.id || "");
      const tab = el("button", {
        class: "tv-tab" + (on ? " on" : ""), type: "button",
        dataset: { role: "tv-tab", lib: it.id || "" }, text: it.name,
      });
      tab.addEventListener("click", () => switchScope(it.id, it.name));
      tvLibsBody.append(tab);
    }
    const cur = tvLibsBody.querySelector(".tv-tab.on");
    if (cur && cur.scrollIntoView) {
      try { cur.scrollIntoView({ block: "nearest" }); } catch (err) { /* 忽略 */ }
    }
  }

  /** 媒体库那一栏：展开 / 折叠（折叠时只留左边那条可聚焦的窄条）。 */
  function tvLibsExpand(on) {
    if (!tvLayout || !tvLibs) return;
    tvLibs.classList.toggle("collapsed", !on);
    tvLibs.classList.toggle("expanded", !!on);
  }
  /** 焦点进媒体库：先展开，再落到当前那个库上。 */
  function tvFocusLibs() {
    tvLibsExpand(true);
    void tvLibs.offsetHeight;
    if (focusSelector(".tv-libs-body .tv-tab.on")) return true;
    return focusSelector(".tv-libs-body .tv-tab");
  }

  /**
   * 右栏再往右露出来的那一列：**剧场 / 收藏 / 我的**（用户 2026-09-28："光标在库列表中时继续按右键，
   * 显示剧场、收藏、我的列表（竖向），按左键焦点回库列表并隐藏它"）。
   * 复用 mountNav 的那份导航（同一份实现），只把「首页」和上传「+」摘掉 —— 人已经在首页了。
   */
  function renderTvNav() {
    if (!tvLayout || !tvNav) return;
    tvNav.classList.add("hidden");
    for (const item of Array.from(tvNav.querySelectorAll(".nav-item"))) {
      const key = item.dataset ? item.dataset.key : "";
      if (key === "feed" || key === "upload" || item.classList.contains("upload")) item.remove();
    }
    for (const item of Array.from(tvNav.querySelectorAll(".nav-item"))) {
      item.addEventListener("click", () => tvHideNav());
    }
  }

  /** 电视端：只有**当前这条**画面能当焦点落点 / 默认落点（data-tv-default 给 tv.js 的 focusFirst 用）。 */
  function tvPaintLayers() {    if (!tvMode()) return;
    for (const [index, entry] of state.built) {
      if (!entry.layer) continue;
      const on = index === state.active;
      entry.layer.tabIndex = on ? 0 : -1;
      if (on) entry.layer.setAttribute("data-tv-default", "1");
      else entry.layer.removeAttribute("data-tv-default");
    }
  }

  // 电视端（遥控器）：**三栏 + 左右键切换**（用户 2026-09-28 最新一版，最高优先级）。
  //
  //   三栏：左 = 视频列表 · 中 = 播放窗口 · 右 = 媒体库列表（库里再按 → 露出「剧场/收藏/我的」）
  //   非全屏：←→ 在这几栏之间走；↑↓ 在当前栏里走（在画面上 = 换视频）
  //          左栏或中栏上按**确定 = 进全屏播放**；右栏库列表上按确定 = 换库
  //   全屏：**什么都不显示**（进度条只在暂停时出现）；确定 = 播放/暂停；返回 = 回三栏
  //   设置键（播放时，无论全屏与否、只要焦点在中间的画面栏）：画面右侧弹出「点赞/收藏/设置」栏，
  //          焦点直接进栏里；返回 = 收起并把焦点还给画面
  //   返回：① 有面板 ⇒ 关面板 ② 操作栏开着 ⇒ 收起 ③ 全屏 ⇒ 回三栏 ④ 否则交给路由
  //   ⚠️ 长按没有任何特殊含义；屏幕上不放全屏键、不放搜索键（用户 2026-09-28："TV 端不需要"）。
  const TV_CHROME = ".header, .bottom-nav, .ov-rail, .tv-ops, .ov-corner, .center-btn, .imm-back," +
    " .set-panel, .sheet-scrim, .modal-overlay, .picker-overlay, .lib-chip," +
    " .tv-row, .tv-list, .tv-libs, .tv-nav, .tv-tab";
  function tvInChrome() {
    const a = document.activeElement;
    if (!a || a === document.body) return false;
    return !!(a.closest && a.closest(TV_CHROME));
  }
  function tvSurfaceEntry() {
    const entry = state.built.get(state.active);
    return entry && !entry.destroyed ? entry : null;
  }
  function tvPanelOpen() {
    const entry = tvSurfaceEntry();
    return !!(entry && entry.panel && !entry.panel.classList.contains("hidden"));
  }
  /** 三栏/全屏/操作栏/暂停态，全落到 feed 的 class 上（CSS 见 app.css 的电视端那两段）。 */
  function tvPaint() {
    if (!tvLayout) return;
    feed.classList.toggle("tv-cinema", rt.tvFull);
    feed.classList.toggle("tv-ops-open", rt.tvOpsOpen);
    document.body.classList.toggle("tv-cinema", rt.tvFull);
    // 全屏里"进度条只在暂停时显示"（用户 2026-09-28）：暂停态由播放事件同步
    const entry = tvSurfaceEntry();
    const paused = !!(entry && entry.video && entry.video.paused);
    feed.classList.toggle("tv-paused", paused);
    tvPaintHint();
  }
  function tvPaintHint() {
    if (!tvMode()) return;
    // 用户 2026-09-29："画面上不要出现操作提示" —— 操作提示（按键说明）整条撤掉。
    // 这里只留一个**很淡的版本号**（右下角那种）：它帮我们判断"服务端更新到底生效没有"
    // （2026-09-29 那次"没有任何变化"就是服务端没升级成功，当时只能猜）。全屏里连它也藏掉。
    tvHintMain.textContent = "";
    tvHintSub.textContent = rt.tvVersion ? "v" + rt.tvVersion : "";
  }

  // 进全屏前焦点在哪一栏（退出全屏要还回去）—— 用户 2026-09-30 报障："从视频列表点进全屏，按返回后
  // 蓝色焦点框还在列表里，但实际焦点在播放画面（按上下键直接切播放）"：进全屏时列表被 display:none 藏了，
  // 焦点掉给 body，而 tv.js 的兜底只在"焦点节点被删"时才补焦点（节点还在、只是被藏起来，兜不住），
  // 于是**焦点在 body、焦点框留在列表行**，两边不一致 → 用户按上下键时看到的是"列表在选、实际在切播放"。
  let tvReturnFocus = "surface";
  function tvSetFull(on) {
    if (!tvLayout || rt.tvFull === !!on) return false;
    if (on) {
      // 进全屏前先看这一条 WebView 能不能放：解不了的编码 / 放不了的条目都交原生播放器
      const cur = state.items[state.active];
      if (tvNeedsNative(cur)) return tvNativePlay(cur);
      if (cur && !isPlayable(cur) && !cur.missing) return tvNativePlay(cur);
      const a = document.activeElement;
      tvReturnFocus = (a && a.closest && a.closest(".tv-row")) ? "list" : "surface";
    }
    rt.tvFull = !!on;
    if (rt.tvFull) tvSetOps(false);
    tvPaint();
    if (rt.tvFull) {
      // 进全屏就开播（电视端永远不静音；有手势的这一下一定是有声的）
      const entry = tvSurfaceEntry();
      if (entry && entry.video && !entry.broken && entry.video.paused) tryPlay(entry);
      tvFocusSurface();   // 全屏里焦点必须在画面上（否则焦点框和实际焦点会分家）
    } else if (tvReturnFocus === "list") {
      if (!focusSelector(".tv-row.on")) tvFocusList();
    } else {
      tvFocusSurface();
    }
    return true;
  }
  /** 设置键弹出的「点赞/收藏/设置」栏：开、关（关的时候把焦点还给画面）。 */
  function tvSetOps(on) {
    if (!tvLayout) return false;
    const next = !!on;
    if (rt.tvOpsOpen === next) return false;
    rt.tvOpsOpen = next;
    tvPaint();
    if (next) {
      if (focusSelector(".tv-ops .icon-btn")) {
        rt.tvSurface = false;
        document.body.classList.remove("tv-surface");
      }
    } else {
      tvFocusSurface();
    }
    return true;
  }
  function tvFocusSurface() {
    rt.tvSurface = true;
    document.body.classList.add("tv-surface");
    const entry = tvSurfaceEntry();
    if (entry && entry.layer) {
      try { entry.layer.focus({ preventScroll: true }); } catch (err) { /* 老 WebView 不认参数 */ }
    }
    tvPaintHint();
    return true;
  }
  function tvGoChrome(selector) {
    if (!focusSelector(selector)) return false;
    rt.tvSurface = false;
    document.body.classList.remove("tv-surface");
    tvPaintHint();
    return true;
  }
  /** 焦点进左栏视频列表（列表里 ↑↓ 选、右边跟着播）。 */
  function tvFocusList() {
    if (focusSelector(".tv-row.on")) return true;
    return focusSelector(".tv-row");
  }
  /** 右栏再往右：露出「剧场/收藏/我的」并把焦点送进去。 */
  function tvShowNav() {
    if (!tvLayout || !tvNav) return false;
    if (tvNav.classList.contains("hidden")) {
      tvNav.classList.remove("hidden");
      // 键的布局会变（右栏让位），强制一次回流再算焦点
      void tvNav.offsetHeight;
    }
    if (focusSelector(".tv-nav .nav-item")) {
      rt.tvSurface = false;
      document.body.classList.remove("tv-surface");
      return true;
    }
    tvNav.classList.add("hidden");
    return false;
  }
  function tvHideNav() {
    if (!tvNav) return;
    tvNav.classList.add("hidden");
  }
  /** 电视端 ←→：切上一个/下一个媒体库（到头就停住，不绕回）。 */
  function tvSwitchLibrary(dir) {
    if (playlist || !state.libraries.length) return false;
    const tabs = tvTabs();
    let idx = tabs.findIndex((t) => String(t.id || "") === String(state.scope || ""));
    if (idx < 0) idx = 0;
    const next = idx + dir;
    if (next < 0 || next >= tabs.length) return false;
    switchScope(tabs[next].id, tabs[next].name);
    return true;
  }
  /**
   * 在某栏（scope 选择器）里按方向键走一步；scope 传 null = 用通用空间导航（面板/弹窗靠 overlayRoots 收窄）。
   * ⚠️ 走不动就停在原地，但调用方**照样吃掉这个按键** —— 漏出去会被 feed 的桌面键盘处理器接走
   * （ArrowDown = 切下一个视频），那就是用户报的"没按确定、播放自己换了"。
   */
  function tvMoveIn(arrowKey, scope) {
    const dir = arrowKey === "ArrowUp" ? "up" : arrowKey === "ArrowDown" ? "down"
      : arrowKey === "ArrowLeft" ? "left" : "right";
    if (scope) moveFocusIn(dir, scope);
    else moveFocusIn(dir);
  }
  function onTvKeyDown(event) {
    const entry = tvSurfaceEntry();
    if (!entry) return false;
    // 面板开着：↑↓ 交给空间导航走动，← 收面板
    if (tvPanelOpen()) {
      if (event.key === "ArrowLeft") { closePanels(); return true; }
      // ⚠️ ↑↓ 必须**自己吃掉**：漏给 tv.js 的空间导航，一旦它移动失败（到边界），事件会继续冒泡到
      // feed 的"桌面键盘处理器"，那边 ArrowDown = goTo(next) —— 于是"没按确定，播放自己换了"。
      if (event.key === "ArrowUp" || event.key === "ArrowDown") { tvMoveIn(event.key, null); return true; }
      return false;
    }
    const active = document.activeElement;
    const inOps = !!(active && active.closest && active.closest(".tv-ops"));
    const inList = !!(active && active.closest && active.closest(".tv-list"));
    const inLibs = !!(active && active.closest && active.closest(".tv-libs"));
    const inNav = !!(active && active.closest && active.closest(".tv-nav"));
    const onStrip = !!(active && active.closest && active.closest(".tv-libs-strip"));

    // ① 「点赞/收藏/设置」栏：↑↓ 走栏内按钮，← 收起并往左走（视频列表），→ 回播放界面
    if (inOps) {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") { tvMoveIn(event.key, ".tv-ops"); return true; }
      // 这栏在**画面右侧**：← 回画面（用户 2026-09-29 纠正方向后的自然走法），→ 到头停住
      if (event.key === "ArrowLeft") { tvSetOps(false); return true; }
      if (event.key === "ArrowRight") return true;
      return false;
    }
    // ② 「剧场/收藏/我的」抽屉（最左，← 露出来的）：→ 收起并回媒体库；其它交给空间导航
    if (inNav) {
      if (event.key === "ArrowRight") { tvHideNav(); tvFocusLibs(); return true; }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") { tvMoveIn(event.key, ".tv-nav"); return true; }
      return false;
    }
    // ③ 媒体库那一栏（展开态）：← 再往左露「剧场/收藏/我的」；→ 回视频列表并折叠
    if (inLibs) {
      if (event.key === "ArrowLeft") return tvShowNav();
      if (event.key === "ArrowRight") { tvLibsExpand(false); tvFocusList(); return true; }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") { tvMoveIn(event.key, ".tv-libs"); return true; }
      return false;   // 确定 = 换库
    }
    // ④ 折叠时的那条窄条：焦点一进来就展开（用户 2026-09-29："默认折叠，有焦点再展开"）
    if (onStrip) {
      if (event.key === "ArrowRight") { tvLibsExpand(false); tvFocusList(); return true; }
      if (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") {
        tvFocusLibs();
        return true;
      }
      return false;
    }
    // ⑤ 视频列表：↑↓ 只走焦点（**不切播放**），确定才播；→ 回播放界面；← 去媒体库栏
    if (inList) {
      if (event.key === "Enter") { tvPlayFromList(Number(active.dataset.index)); return true; }
      if (event.key === "ArrowRight") { tvFocusSurface(); return true; }
      if (event.key === "ArrowLeft") { tvFocusLibs(); return true; }
      // ⚠️ 用户 2026-10-01 报障："焦点每走几次播放就自己换了（没按确定）"：
      // 走到列表**最后一行**时空间导航找不到下一个 → 事件冒泡到桌面键盘处理器 → ArrowDown = goTo(next)。
      // 现在 ↑↓ 一律在**列表内部**走并吃掉按键（到边界就停住，不会漏出去、也不会溜到别的栏）。
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        tvMoveIn(event.key, ".tv-list");
        // 焦点走到（接近）当前批次末尾就继续加载 —— 以前是靠"漏出去被 goTo 接走"顺带触发的，
        // 现在按键被我们自己吃掉了，得显式补上，否则用户选到第 10 条就到头了。
        const cur = document.activeElement;
        if (cur && cur.dataset && cur.dataset.index !== undefined) maybeLoadMore(Number(cur.dataset.index));
        return true;
      }
      if (event.key === "Home") { focusSelector(".tv-row"); return true; }
      if (event.key === "End") { focusSelector(".tv-list .tv-row:last-child"); return true; }
      return false;
    }
    // ⑥ 焦点在播放界面上
    if (rt.tvFull) {
      switch (event.key) {
        case "Enter": togglePlay(entry); tvPaint(); return true;   // 全屏：确定 = 播放/暂停
        case "ArrowUp": if (state.active > 0) { goTo(state.active - 1); return true; } return true;
        case "ArrowDown":
          if (state.active < state.items.length - 1 || state.hasMore) { goTo(state.active + 1); return true; }
          return true;
        default: return false;   // 全屏里 ←→ 不切栏（用户："非全屏播放时"才切）
      }
    }
    switch (event.key) {
      case "ArrowUp":
        if (state.active > 0) { goTo(state.active - 1); return true; }
        return true;
      case "ArrowDown":
        if (state.active < state.items.length - 1 || state.hasMore) { goTo(state.active + 1); return true; }
        return true;
      // 用户 2026-09-30："视频播放界面再按右键改为全屏播放；设置键调出点赞功能（和右键重复了）"
      case "ArrowLeft": tvFocusList(); return true;
      case "ArrowRight": tvSetFull(true); return true;
      case "Enter": tvSetFull(true); return true;   // 确定 = 进全屏播放
      default: return false;
    }
  }

  // 电视端：把遥控器按键接过来（tv.js 的通用空间导航在它之后跑）
  function onTvFocusIn() {
    // 媒体库那一栏：焦点不在它里面就折回去（用户 2026-09-29："默认折叠，有焦点再展开"）
    if (tvLayout) {
      const a = document.activeElement;
      const inside = !!(a && a.closest && a.closest(".tv-libs"));
      if (!inside) tvLibsExpand(false);
    }
    const next = !tvInChrome();
    if (next !== rt.tvSurface) {
      rt.tvSurface = next;
      document.body.classList.toggle("tv-surface", rt.tvSurface);
      tvPaintHint();
    }
    if (tvLayout) tvPaint();   // 全屏里暂停才显示进度条：焦点/状态变了都重算一次
  }

  return { tvRow, paintTvList, tvStageSet, tvPaintLayers, tvPaint, tvPaintHint, tvFocusSurface,
    tvFocusLibs, renderTvLibs, renderTvNav, tvSetOps, tvSetFull, onTvFocusIn, onTvKeyDown, tvPlayFromList };
}
