"use strict";
/**
 * 面板里那几个纯逻辑函数的单测：过期判定、云端目标怎么算、路径处理、大小格式化。
 *
 * 做法是从 panels/sync.tsx 里把这些函数原样抠出来求值（它们是纯函数，不依赖
 * React），所以测的是**真代码**，不是复刻的副本 —— 面板改了，这里立刻能反映。
 *
 * 这几处错了后果都很实在：
 *   · 过期判定漏了 → 改完同步方式再点同步，会按旧设置动文件；
 *   · 云端目标算错 → 同步写进别人的目录；
 *   · 路径处理错了 → 目录名带尾斜杠就拼出双斜杠。
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "panels", "sync.tsx"), "utf8");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    console.log("  ✗ " + name + "\n      " + String((e && e.message) || e));
  }
}
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error((msg || "不相等") + "：实际 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b));
  }
}

/** 按名字抠出一个顶层 function（从 `function x(` 到行首的 `}`）。 */
function extractFn(name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("没找到 function " + name);
  const end = src.indexOf("\n}\n", start);
  if (end < 0) throw new Error(name + " 没有找到结尾");
  return src.slice(start, end + 3);
}

const FNS = ["normDir", "looksAbsPath", "baseName", "joinRemote", "safeSeg", "derivedRemote", "planStale", "fmtBytes", "readWorkspace"];
const body = FNS.map(extractFn).join("\n");

const api = new Function(
  body +
    "\nreturn { normDir, looksAbsPath, baseName, joinRemote, safeSeg, derivedRemote, planStale, fmtBytes, readWorkspace };",
)();
const { baseName, joinRemote, safeSeg, derivedRemote, planStale, fmtBytes, readWorkspace, looksAbsPath } = api;

/* ───────── 云端目标 ───────── */

test("云端目标 = 根目录 / 工作区名（不再拼工作空间名）", () => {
  const ws = { space: "a + b + c", roots: ["G:/x/notrat-plugins"], active: "G:/x/notrat-plugins" };
  eq(derivedRemote(ws, "G:/x/notrat-plugins", "我的坚果云"), "我的坚果云/notrat-plugins");
});

test("工作空间名里的加号 / 空格被洗成短横线", () => {
  eq(safeSeg("notrat-payment + notrat-plugins"), "notrat-payment-notrat-plugins");
  eq(safeSeg("a、b，c"), "a-b-c");
  eq(safeSeg("bad:name*with?chars"), "bad-name-with-chars");
  eq(safeSeg("   "), "");
  eq(safeSeg("x".repeat(80)).length, 40);
});

test("长工作空间名不会污染目录（根本不参与拼接）", () => {
  const ws = { space: "notrat-payment + notrat-plugins + notrat-plugins-site + notrat-promotion" };
  eq(derivedRemote(ws, "G:/front_project/notrat-payment", "我的坚果云"), "我的坚果云/notrat-payment");
});

test("根目录留空就只剩工作区名", () => {
  eq(derivedRemote({ space: "空间" }, "C:/notes", ""), "notes");
});

test("两端斜杠不会拼出双斜杠", () => {
  eq(joinRemote("/a/", "/b/", "c"), "a/b/c");
  eq(derivedRemote({ space: "s" }, "C:/notes/", "/base/"), "base/notes");
});

test("baseName 两种分隔符都对", () => {
  eq(baseName("G:/front_project/notrat-plugins"), "notrat-plugins");
  eq(baseName("C:\\Users\\30398\\notes"), "notes");
  eq(baseName("C:\\Users\\30398\\notes\\"), "notes");
  eq(baseName(""), "");
});

/* ───────── 计划过期 ───────── */

const freshCfg = { strategy: "two-way", conflictStrategy: "no-conflict-merge", remoteDir: "我的坚果云/x" };
const freshPlan = {
  at: new Date().toISOString(),
  remoteRoot: "我的坚果云/x",
  config: { strategy: "two-way", conflictStrategy: "no-conflict-merge" },
};

test("刚算的计划不算过期", () => {
  eq(planStale(freshPlan, freshCfg), "");
});

test("改了同步方式就过期", () => {
  eq(planStale(freshPlan, Object.assign({}, freshCfg, { strategy: "send-only" })), "strategy");
});

test("改了冲突处理就过期", () => {
  eq(planStale(freshPlan, Object.assign({}, freshCfg, { conflictStrategy: "local-priority" })), "conflict");
});

test("改了云端文件夹就过期", () => {
  eq(planStale(freshPlan, Object.assign({}, freshCfg, { remoteDir: "我的坚果云/y" })), "remote");
});

test("目录尾斜杠不算改过", () => {
  eq(planStale(Object.assign({}, freshPlan, { remoteRoot: "/我的坚果云/x/" }), freshCfg), "");
});

test("超过 10 分钟算过期", () => {
  const old = Object.assign({}, freshPlan, { at: new Date(Date.now() - 11 * 60 * 1000).toISOString() });
  eq(planStale(old, freshCfg), "expired");
});

test("没有计划就没有过期一说", () => {
  eq(planStale(null, freshCfg), "");
});

/* ───────── 工作区读取 ───────── */

test("ctx.workspace 为 null 时返回 unavailable", () => {
  const r = readWorkspace({});
  eq(r.unavailable, true);
  eq(r.roots, []);
});

test("只有 path 时 roots 就是它自己", () => {
  const r = readWorkspace({ workspace: { path: "C:/notes" } });
  eq(r.roots, ["C:/notes"]);
  eq(r.active, "C:/notes");
  eq(r.unavailable, false);
});

test("多根时全部带出来", () => {
  const r = readWorkspace({
    workspace: { path: "C:/a", roots: [{ path: "C:/a" }, { path: "C:/b" }] },
    space: { name: "空间" },
  });
  eq(r.roots, ["C:/a", "C:/b"]);
  eq(r.space, "空间");
});

test("相对路径不认（宁可不填，也不猜）", () => {
  eq(readWorkspace({ workspace: { path: "notes" } }).unavailable, true);
});

test("绝对路径识别：盘符与正斜杠开头", () => {
  eq(looksAbsPath("C:/x"), true);
  eq(looksAbsPath("C:\\x"), true);
  eq(looksAbsPath("/usr/local"), true);
  eq(looksAbsPath("notes/x"), false);
  eq(looksAbsPath(""), false);
});

/* ───────── 大小格式化 ───────── */

test("大小是人类可读的", () => {
  eq(fmtBytes(0), "0");
  eq(fmtBytes(512), "512 B");
  eq(fmtBytes(2048), "2.0 KB");
  eq(fmtBytes(1024 * 1024 * 3), "3.0 MB");
});

test("负数 / 空值不炸", () => {
  eq(fmtBytes(-5), "0");
  eq(fmtBytes(null), "0");
  eq(fmtBytes(undefined), "0");
});

console.log("\n纯函数：" + passed + " 通过 / " + failed + " 失败");
if (failed) process.exit(1);
