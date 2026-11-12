"use strict";
/**
 * 用真正的 JSX/TSX 编译器校验面板语法。
 *
 * 为什么需要：panels/sync.tsx 由宿主在运行时编译，Node 的 --check 根本读不懂 JSX。
 * 上一版只有「括号配平」这种近似检查 —— 它能抓出括号错，但抓不出
 * `<div>` 少一个闭合、`{cond ? a : b}` 写歪这类必然白屏的错误。
 * 面板一白屏，用户看到的就是「点了没反应」，最难查。
 *
 * 找不到 esbuild 时**跳过而不是失败**：esbuild 不该成为本插件的运行依赖。
 * 但会把「跳过了」明确打出来，不让它伪装成通过。
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TARGET = path.join(ROOT, "panels", "sync.tsx");
const OUT = path.join(os.tmpdir(), "nutstore-panel-jsxcheck.js");

const exe = process.platform === "win32" ? "esbuild.exe" : "esbuild";

const candidates = [
  process.env.ESBUILD_BIN,
  path.join(ROOT, "node_modules", "@esbuild", "win32-x64", exe),
  path.join(ROOT, "node_modules", "@esbuild", "linux-x64", "bin", "esbuild"),
  path.join(ROOT, "node_modules", "@esbuild", "darwin-arm64", "bin", "esbuild"),
  path.join(ROOT, "node_modules", ".bin", "esbuild"),
  path.join(os.homedir(), "node_modules", "@esbuild", "win32-x64", exe),
  path.join(os.homedir(), "node_modules", "@esbuild", "linux-x64", "bin", "esbuild"),
  path.join(os.homedir(), "node_modules", ".bin", "esbuild"),
].filter(Boolean);

function findEsbuild() {
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch (_) {
      /* 继续 */
    }
  }
  // 最后试 PATH
  const probe = spawnSync(exe, ["--version"], { encoding: "utf8" });
  if (probe.status === 0) return exe;
  return "";
}

const bin = findEsbuild();

if (!bin) {
  console.log("  ⚠ JSX 语法校验：跳过（没找到 esbuild）");
  console.log("    想真正校验 TSX，装一个即可：npm i -g esbuild");
  console.log("    或设 ESBUILD_BIN=<esbuild 可执行文件路径>");
  console.log("\nJSX 语法：跳过 0 通过 / 0 失败");
  process.exit(0);
}

try {
  fs.unlinkSync(OUT);
} catch (_) {}

const r = spawnSync(
  bin,
  [
    "--loader:.tsx=tsx",
    "--jsx=transform",
    "--target=es2020",
    "--log-level=warning",
    "--outfile=" + OUT,
    TARGET,
  ],
  { encoding: "utf8", cwd: ROOT },
);

const checks = [];
const add = (n, ok, extra) => checks.push({ n, ok, extra });

add("esbuild 能跑起来", r.status !== null && r.status >= 0, "status=" + r.status);
add("TSX 编译无错误", r.status === 0, (r.stderr || "").trim().split("\n").slice(0, 4).join(" | "));

let size = 0;
try {
  size = fs.statSync(OUT).size;
} catch (_) {}
add("产物非空（说明真的编译了）", size > 5000, "size=" + size);

// 编译产物里必须能看见新增的关键函数，防止「编译了但编的是旧文件」
let out = "";
try {
  out = fs.readFileSync(OUT, "utf8");
} catch (_) {}
add("产物包含 errMsg", out.indexOf("errMsg") >= 0, "");
add("产物包含 readWorkspace", out.indexOf("readWorkspace") >= 0, "");

let bad = 0;
for (const c of checks) {
  console.log((c.ok ? "  ✓ " : "  ✗ ") + c.n + (c.ok || !c.extra ? "" : "  (" + c.extra + ")"));
  if (!c.ok) bad++;
}
console.log("\nJSX 语法：" + (checks.length - bad) + " 通过 / " + bad + " 失败（esbuild " + bin + "）");
process.exit(bad ? 1 : 0);
