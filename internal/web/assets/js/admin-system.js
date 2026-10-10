// 系统信息页签：磁盘 / 备份导出 / 从备份恢复（从 admin.js 原样搬家，行为不变）

import { api } from "./api.js";
import { el, clear, banner, setBanner, fmtBytes } from "./dom.js";

function kv(label, value) {
  return el("div", { class: "kv" },
    el("span", { class: "k", text: label }),
    el("span", { class: "v", text: value === null || value === undefined || value === "" ? "-" : String(value) }));
}

/* ---------- 系统 ---------- */

export function mountSystem(root) {
  const note = banner();
  const box = el("div", { class: "panel" });
  // D11 磁盘告警 + D10 备份导出
  const disksBox = el("div", { class: "panel", dataset: { role: "system-disks" } });
  root.append(note, box, disksBox);

  // D11：每块盘剩余量一眼看见；吃紧的直接红字说出来（不静默等人踩坑）
  api.systemDisks().then((data) => {
    const disks = (data && data.disks) || [];
    const warnings = (data && data.warnings) || [];
    clear(disksBox);
    disksBox.append(el("div", { class: "panel-title", text: "磁盘" }));
    for (const d of disks) {
      const line = d.error
        ? (d.label + "：" + d.path + "（读不到：" + d.error + "）")
        : (d.label + "：" + fmtBytes(d.free_bytes) + " 可用 / " + fmtBytes(d.total_bytes) +
           "（剩 " + (d.free_percent || 0) + "%）");
      disksBox.append(el("div", {
        class: d.low ? "danger small-note" : "muted small-note",
        dataset: { role: "system-disk", low: d.low ? "1" : "0" },
        text: (d.role === "library" ? "媒体库 · " : "") + line + (d.low ? "  ← 吃紧" : ""),
      }));
    }
    for (const w of warnings) {
      disksBox.append(el("div", { class: "danger small-note", dataset: { role: "system-disk-warning" }, text: w }));
    }
    disksBox.append(el("div", { class: "muted small-note",
      text: "判据：剩余不足 5GB 或不足 5% 算吃紧（上传、转码、入库都可能因此失败）。" }));

    // D10 备份导出：数据库快照（一致性由 VACUUM INTO 保证），点一下直接下载
    disksBox.append(
      el("div", { class: "panel-title", text: "备份" }),
      el("div", { class: "muted small-note",
        text: "导出数据库快照：用户 / 媒体库 / 剧场 / 观看进度 / 上传记录。不含视频文件与封面缓存（视频请另外备份媒体库目录）。" }),
      el("div", { class: "row" },
        el("a", { class: "btn small primary", href: "/api/v1/admin/backup",
          dataset: { role: "system-backup" }, text: "导出备份（.tar.gz）" })));

    // ③ 从备份恢复：两段式（先看里面是什么 → 说口令确认），确认后自动备份当前库再替换
    const restoreFile = el("input", { type: "file", accept: ".gz,.tar.gz,.db,application/gzip",
      dataset: { role: "restore-file" } });
    const restorePreviewBtn = el("button", { class: "btn small", type: "button",
      dataset: { role: "restore-preview" }, text: "先看里面是什么" });
    const restoreOut = el("div", { class: "muted small-note", dataset: { role: "restore-preview-out" } });
    const restoreWord = el("input", { class: "input", placeholder: "在这里输入两个字确认",
      dataset: { role: "restore-confirm" } });
    const restoreApplyBtn = el("button", { class: "btn small danger", type: "button",
      dataset: { role: "restore-apply" }, text: "确认恢复", disabled: true, hidden: true });
    let restoreToken = "";
    restorePreviewBtn.addEventListener("click", async () => {
      const file = (restoreFile.files || [])[0];
      if (!file) { setBanner(note, "先选一个备份文件（.tar.gz）"); return; }
      restorePreviewBtn.disabled = true;
      setBanner(note, "");
      restoreOut.textContent = "正在读取备份…（大的备份要一会儿）";
      try {
        const data = await api.restorePreview(file);
        restoreToken = (data && data.token) || "";
        const c = (data && data.counts) || {};
        clear(restoreOut);
        restoreOut.append(
          el("div", { text: "备份内容：账号 " + (c.users || 0) + " · 媒体库 " + (c.libraries || 0) +
            " · 媒体 " + (c.media || 0) + " · 剧场 " + (c.series || 0) +
            " · 库结构 v" + (c.schema_version || 0) }),
          ...((data && data.warnings) || []).map((w) =>
            el("div", { class: "danger small-note", text: "注意：" + w })),
          el("div", { text: "确认后我会先把当前数据库备份一份，再整体替换。这一步会覆盖现有数据。" }));
        restoreWord.placeholder = "输入「" + ((data && data.confirm_word) || "恢复") + "」两个字确认";
        restoreApplyBtn.hidden = false;
        restoreApplyBtn.disabled = false;
      } catch (err) {
        restoreOut.textContent = "";
        setBanner(note, err && err.message ? err.message : "读取备份失败");
      } finally {
        restorePreviewBtn.disabled = false;
      }
    });
    restoreApplyBtn.addEventListener("click", async () => {
      if (!restoreToken) { setBanner(note, "先点「先看里面是什么」"); return; }
      restoreApplyBtn.disabled = true;
      try {
        const data = await api.restoreApply(restoreToken, restoreWord.value.trim());
        setBanner(note, "已恢复。恢复前的库备份在：" + ((data && data.safety_backup) || "") +
          " —— 建议重启一次服务并重新登录。");
        restoreApplyBtn.hidden = true;
        restoreToken = "";
      } catch (err) {
        setBanner(note, err && err.message ? err.message : "恢复失败");
      } finally {
        restoreApplyBtn.disabled = false;
      }
    });
    disksBox.append(
      el("div", { class: "panel-title", text: "从备份恢复" }),
      el("div", { class: "muted small-note",
        text: "会整体替换数据库（用户/库/剧场/进度/上传记录）。恢复前自动备份当前库；有扫描或转码在跑时会拒绝。" }),
      el("div", { class: "row" }, restoreFile, restorePreviewBtn),
      restoreOut,
      el("div", { class: "row" }, restoreWord, restoreApplyBtn));
  }).catch((err) => {
    clear(disksBox);
    disksBox.append(el("div", { class: "muted small-note",
      text: "磁盘信息读取失败：" + (err && err.message ? err.message : "") }));
  });

  api.systemInfo().then((info) => {
    const ffmpeg = info.ffmpeg || {};
    const ffprobe = info.ffprobe || {};
    const disk = info.disk || {};
    const counts = info.counts || {};
    clear(box);
    box.append(
      kv("版本", info.version),
      kv("Go 版本", info.go_version),
      kv("监听", info.listen),
      kv("数据目录", info.data_dir || disk.data_dir),
      kv("ffmpeg", ffmpeg.version),
      kv("ffmpeg 路径", ffmpeg.path),
      kv("VideoToolbox H.264", ffmpeg.videotoolbox_h264 ? "支持" : "不支持"),
      kv("ffprobe", ffprobe.version),
      kv("ffprobe 路径", ffprobe.path),
      kv("磁盘可用", fmtBytes(disk.free_bytes)),
      kv("磁盘总量", fmtBytes(disk.total_bytes)),
      kv("媒体库 / 媒体 / 失败", (counts.libraries || 0) + " / " + (counts.media || 0) + " / " + (counts.failed || 0)));
  }).catch((err) => {
    setBanner(note, err && err.message ? err.message : "加载失败");
  });
}
