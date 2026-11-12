"use strict";
/**
 * manifest 静态校验：宿主加载插件时会做的检查，提前在本地跑一遍。
 *
 * 检查项来自 Notrat 插件规范（v2）：
 *   - manifest 必填字段与类型
 *   - mcpServers 指向的文件真实存在
 *   - contributions.ui 的 sourceFile 真实存在
 *   - contributions.commands 里的 tool 名必须在 server 的 tools 表里存在
 *     （写错工具名 → 命令点了没反应，且不报错，最难查）
 *   - settings 的 key / default 类型自洽
 *   - promptSections 非空
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

const checks = [];
const add = (name, ok, extra) => checks.push({ name, ok, extra });

/* ---------- 必填字段 ---------- */
add("id 与目录名一致", manifest.id === path.basename(ROOT), "id=" + manifest.id);
add("有 name / version", !!manifest.name && !!manifest.version, "");
add("manifestVersion = 2", manifest.manifestVersion === 2, "got " + manifest.manifestVersion);
add("enabled 是布尔", typeof manifest.enabled === "boolean", "");
add("scope 合法", ["global", "workspace"].includes(manifest.scope), "got " + manifest.scope);
add("description 非空且不过长", !!manifest.description && manifest.description.length < 900, "len=" + String(manifest.description || "").length);

/* ---------- 许可与出处（上游 AGPL-3.0，二开必须同协议） ---------- */
add("license 是 AGPL-3.0（不能标 MIT）", /^AGPL-3\.0/.test(String(manifest.license)), "got " + manifest.license);
add("包内有 LICENSE 全文", fs.existsSync(path.join(ROOT, "LICENSE")), "");
const licText = fs.existsSync(path.join(ROOT, "LICENSE")) ? fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8") : "";
add("LICENSE 确实是 AGPL 全文", /GNU AFFERO GENERAL PUBLIC LICENSE/.test(licText) && /Version 3/.test(licText), "len=" + licText.length);
add("声明了上游出处", !!(manifest.upstream && manifest.upstream.url && manifest.upstream.license), JSON.stringify(manifest.upstream || null).slice(0, 80));
add("上游指向 obsidian-nutstore-sync", /obsidian-nutstore-sync/.test(String((manifest.upstream || {}).url || "")), "");
add("装机清单包含 LICENSE（否则装到应用里没有许可全文）", /"LICENSE"/.test(fs.readFileSync(path.join(ROOT, "install.mjs"), "utf8")), "");
add("衍生源码保留了出处声明", ["server/index.js", "server/lib/decide.js", "server/lib/webdav.js"]
  .every((f) => fs.readFileSync(path.join(ROOT, f), "utf8").slice(0, 1200).includes("AGPL-3.0")), "");

/* ---------- 图标 ---------- */
const icon = String(manifest.icon || "");
add("manifest.icon 是内联栅格图（发布不依赖外链）", /^data:image\/(webp|png|jpeg);base64,/.test(icon), icon.slice(0, 30));
add("图标体积在 512KB 内", Buffer.from(icon.split(",")[1] || "", "base64").length < 512 * 1024, (Buffer.from(icon.split(",")[1] || "", "base64").length / 1024).toFixed(1) + "KB");
add("图标不用 emoji（活动栏缩到 16px 会糊）", !/[\u{1F300}-\u{1FAFF}]/u.test(icon), icon.slice(0, 12));

/* ---------- mcpServers ---------- */
const srv = (manifest.mcpServers || [])[0];
add("声明了 1 个 mcpServer", !!srv, "");
if (srv) {
  add("transport = stdio", srv.transport === "stdio", "");
  const arg = (srv.args || [])[0] || "";
  const rel = arg.replace("${pluginDir}/", "");
  add("server 入口文件存在", fs.existsSync(path.join(ROOT, rel)), rel);
  add("env 注入了数据目录", !!(srv.env && srv.env.NUTSTORE_DATA_DIR), "");
}

/* ---------- ui ---------- */
const ui = manifest.contributions && manifest.contributions.ui;
/** 合法面板位置：抄自宿主 src/types/plugin-v2.ts 的 PluginUiLocation。 */
const VALID_LOCATIONS = [
  "sidebar-input", "welcome-input", "messages-top", "right-panel", "popup",
  "floating", "sidebar-toolbar", "activity-bar", "status-bar", "widget",
  "outline", "editor-tabs", "editor-header", "page", "window",
];

add("声明了面板", Array.isArray(ui) && ui.length > 0, "");
for (const u of ui || []) {
  const sf = u.content && u.content.sourceFile;
  add("面板 " + u.id + " 的 sourceFile 存在", !!sf && fs.existsSync(path.join(ROOT, sf)), String(sf));
  add("面板 " + u.id + " 有 location", VALID_LOCATIONS.includes(u.location), String(u.location));
}

/* ---------- commands ↔ 工具名 ---------- */
const serverSrc = fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8");
const toolNames = Array.from(serverSrc.matchAll(/^\s{2}(ns_\w+):\s*\{/gm)).map((m) => m[1]);
add("解析到工具定义", toolNames.length >= 10, toolNames.length + " 个：" + toolNames.join(","));

for (const c of (manifest.contributions && manifest.contributions.commands) || []) {
  add("命令 " + c.name + " 指向真实工具 " + c.tool, toolNames.includes(c.tool), "");
}

/* ---------- 每个工具都有描述与 schema ---------- */
for (const t of toolNames) {
  const block = serverSrc.slice(serverSrc.indexOf("  " + t + ": {"));
  const desc = (block.match(/desc:\s*\n?\s*"([^"]*)"/) || block.match(/desc:\s*"([^"]*)"/) || [])[1];
  add("工具 " + t + " 有 desc", !!desc && desc.length > 10, "");
}

/* ---------- settings ---------- */
const st = (manifest.contributions && manifest.contributions.settings) || [];
add("声明了设置项", st.length > 0, "");
for (const s of st) {
  add("设置 " + s.key + " 有 fields", Array.isArray(s.fields) && s.fields.length > 0, "");
  for (const f of s.fields || []) {
    const okTypes = ["text", "number", "boolean", "select", "password"];
    add("设置字段 " + f.key + " 类型合法", okTypes.includes(f.type), "got " + f.type);
    if (f.type === "select") {
      add("设置字段 " + f.key + " 有 options", Array.isArray(f.options) && f.options.length > 0, "");
    }
  }
}

/* ---------- promptSections ---------- */
const ps = (manifest.contributions && manifest.contributions.promptSections) || [];
add("有提示词段", ps.length > 0, "");
for (const p of ps) {
  add("提示词段有 slot/title/content", !!p.slot && !!p.title && !!p.content, "");
  add("提示词段长度合理", p.content.length > 200 && p.content.length < 8000, "len=" + p.content.length);
}

/* ---------- 结论 ---------- */
let bad = 0;
for (const c of checks) {
  if (!c.ok) bad++;
  console.log((c.ok ? "  ✓ " : "  ✗ ") + c.name + (c.ok || !c.extra ? "" : "  (" + c.extra + ")"));
}
console.log("\nmanifest 检查：" + (checks.length - bad) + " 通过 / " + bad + " 失败");
process.exit(bad ? 1 : 0);
