"use strict";
/**
 * 配置归一化测试 —— 复现并锁死「设置失败」这个 bug。
 *
 * 事故现场（2026-10-25）：面板输入框失焦时无条件提交，把空值写进 config.json：
 *   baseUrl: ""      → 面板显示空白，用户以为「设置失败」
 *   minGapMs: ""     → 归一化成 0 → 刚修好的限速被静默关掉
 *   concurrency: ""  → 垃圾值落盘
 * 根因：只有 loadConfig 归一化，saveConfig 直接落盘。
 * 修法：抽出 normalizeConfig，读写共用；空值一律视为「回默认」而不是「写入空」。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nutstore-cfg-"));
process.env.NUTSTORE_DATA_DIR = TMP;

const s = require("../server/lib/state.js");

let passed = 0;
let failed = 0;
const fails = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    fails.push(name + " :: " + String((e && e.message) || e));
    console.log("  ✗ " + name + "\n      " + String((e && e.message) || e));
  }
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((msg || "不相等") + "：实际 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b));
  }
}

const DEFAULT_URL = "https://dav.jianguoyun.com/dav";

test("全新安装：baseUrl 回落到默认端点（不能是空串）", () => {
  eq(s.loadConfig().baseUrl, DEFAULT_URL);
});

test("面板失焦提交空 baseUrl → 回默认（不再写空串）", () => {
  eq(s.saveConfig({ baseUrl: "" }).baseUrl, DEFAULT_URL);
});

test("纯空格 baseUrl → 回默认", () => {
  eq(s.saveConfig({ baseUrl: "   " }).baseUrl, DEFAULT_URL);
});

test("minGapMs 空串 → 回默认 120（绝不能被归一化成 0）", () => {
  const n = s.saveConfig({ minGapMs: "" });
  eq(n.minGapMs, 120);
  if (n.minGapMs === 0) throw new Error("限速被静默关掉了");
});

test("concurrency 空串 → 回默认 2", () => {
  eq(s.saveConfig({ concurrency: "" }).concurrency, 2);
});

test("maxFileSizeMB 空串 / 0 / 负数 → 回默认 100", () => {
  eq(s.saveConfig({ maxFileSizeMB: "" }).maxFileSizeMB, 100);
  eq(s.saveConfig({ maxFileSizeMB: 0 }).maxFileSizeMB, 100);
  eq(s.saveConfig({ maxFileSizeMB: -5 }).maxFileSizeMB, 100);
});

test("maxFileSizeMB 正常值保留", () => {
  eq(s.saveConfig({ maxFileSizeMB: 250 }).maxFileSizeMB, 250);
});

test("concurrency 越界被夹到 1..8", () => {
  eq(s.saveConfig({ concurrency: 99 }).concurrency, 8);
  eq(s.saveConfig({ concurrency: 0 }).concurrency, 1);
});

test("strategy 空串 → 回默认 two-way（不抛错）", () => {
  eq(s.saveConfig({ strategy: "" }).strategy, "two-way");
});

test("非法枚举仍然报错，且错误里带可选值", () => {
  let msg = "";
  try {
    s.saveConfig({ strategy: "bogus" });
  } catch (e) {
    msg = String(e.message);
  }
  if (!msg) throw new Error("应该抛错");
  if (!/two-way/.test(msg)) throw new Error("错误信息应列出可选值，实际：" + msg);
});

test("username / password 自动 trim（粘贴带换行也能用）", () => {
  const n = s.saveConfig({ username: "  a@b.com  ", password: " abc123\n" });
  eq(n.username, "a@b.com");
  eq(n.password, "abc123");
});

test("remoteDir 去掉首尾斜杠", () => {
  eq(s.saveConfig({ remoteDir: "/notes/x/" }).remoteDir, "notes/x");
  eq(s.saveConfig({ remoteDir: "/" }).remoteDir, "");
});

test("落盘后重新 load 结果一致（读写同一套归一化）", () => {
  s.saveConfig({ baseUrl: "", minGapMs: "", concurrency: "" });
  const back = s.loadConfig();
  eq(back.baseUrl, DEFAULT_URL);
  eq(back.minGapMs, 120);
  eq(back.concurrency, 2);
});

test("publicConfig 不泄漏密码", () => {
  s.saveConfig({ password: "secret123" });
  const p = s.publicConfig(s.loadConfig());
  eq(p.password, "");
  eq(p.passwordSet, true);
  if (String(JSON.stringify(p)).includes("secret123")) throw new Error("publicConfig 泄漏了密码");
});

test("配置里 baseUrl 永远不以 / 结尾（避免拼出双斜杠）", () => {
  const n = s.saveConfig({ baseUrl: "https://dav.jianguoyun.com/dav/" });
  if (/\/$/.test(n.baseUrl)) throw new Error("baseUrl 不该以 / 结尾：" + n.baseUrl);
});

console.log("\n配置归一化：" + passed + " 通过 / " + failed + " 失败");
if (failed) {
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
