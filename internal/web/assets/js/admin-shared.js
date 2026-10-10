// 后台共用小件：按钮 / 单元格 / 表格 / 下拉（从 admin.js 原样搬家，行为不变）

import { el } from "./dom.js";

export function button(label, onclick, extraClass) {
  return el("button", {
    class: "btn small" + (extraClass ? " " + extraClass : ""),
    type: "button", text: label, onclick,
  });
}

export function cell(value) {
  const td = el("td");
  if (value instanceof Node) td.append(value);
  else td.textContent = value === null || value === undefined || value === "" ? "-" : String(value);
  return td;
}

export function rowOf(values) {
  const row = el("tr");
  for (const value of values) row.append(cell(value));
  return row;
}

export function emptyRow(cols, text) {
  return el("tr", null, el("td", { class: "empty", colspan: String(cols), text }));
}

export function gridOf(headers) {
  const table = el("table", { class: "grid" });
  const headRow = el("tr");
  for (const label of headers) headRow.append(el("th", { text: label }));
  const body = el("tbody");
  table.append(el("thead", null, headRow), body);
  return { table: el("div", { class: "table-scroll" }, table), body };
}

export function selectFrom(options) {
  const select = el("select", { class: "input" });
  for (const option of options) select.append(el("option", { value: option.value, text: option.label }));
  return select;
}
