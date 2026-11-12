"use strict";
/**
 * 一键跑全部测试：`node tests/run.cjs`
 *
 *   node tests/run.cjs            只报每套的结论 + 失败明细
 *   node tests/run.cjs --verbose  失败的套件把完整输出吐出来（排查用）
 *   node tests/run.cjs --only panel   只跑名字里含 "panel" 的套件
 *
 * 每套测试是独立进程（互不污染环境变量与临时目录），汇总结果后统一退出码。
 * 顺序：静态检查 → 纯函数矩阵 → 真起进程的协议/集成测试。
 */
const { spawnSync } = require("child_process");
const path = require("path");

const SUITES = [
  ["manifest 校验", "_manifest.cjs"],
  ["面板静态检查", "_panel-syntax.cjs"],
  ["JSX 语法校验", "_panel-jsx.cjs"],
  ["面板渲染（55 项）", "_panel-render.cjs"],
  ["纯函数（过期 / 目标 / 路径 / 大小）", "_panel-collapse.cjs"],
  ["错误信息契约（11 例）", "_panel-errmsg.cjs"],
  ["配置归一化（15 例）", "_config-normalize.cjs"],
  ["决策矩阵（41 例）", "decide-matrix.cjs"],
  ["MCP 握手（75 项）", "_mcp-handshake.cjs"],
  ["stdin 排空（响应不丢）", "_stdin-drain.cjs"],
  ["WebDAV 端到端（10 例）", "e2e-webdav.cjs"],
  ["远端遍历防自环（8 例）", "_walk-safety.cjs"],
];

const argv = process.argv.slice(2);
const verbose = argv.includes("--verbose") || argv.includes("-v");
const onlyIdx = argv.findIndex((a) => a === "--only");
const only = onlyIdx >= 0 ? String(argv[onlyIdx + 1] || "").toLowerCase() : "";

const picked = only ? SUITES.filter(([n, f]) => (n + " " + f).toLowerCase().includes(only)) : SUITES;

if (!picked.length) {
  console.log("没有匹配 \"" + only + "\" 的测试套件。可选：");
  for (const [n] of SUITES) console.log("  · " + n);
  process.exit(1);
}

let bad = 0;
const results = [];

for (const [name, file] of picked) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], {
    encoding: "utf8",
    cwd: path.join(__dirname, ".."),
  });
  const ms = Date.now() - started;
  const out = (r.stdout || "") + (r.stderr || "");
  const tail = out.trim().split("\n").filter(Boolean).slice(-1)[0] || "";
  const ok = r.status === 0;
  if (!ok) bad++;
  results.push({ name, ok, ms, tail });
  console.log((ok ? "  ✓ " : "  ✗ ") + name + "  " + ms + "ms");
  if (!ok) {
    if (verbose) {
      console.log(out.trim().split("\n").map((l) => "      " + l).join("\n"));
    } else {
      console.log("      " + tail);
      console.log(
        out
          .split("\n")
          .filter((l) => l.includes("✗"))
          .map((l) => "      " + l.trim())
          .join("\n"),
      );
    }
  }
}

console.log("\n" + "─".repeat(52));
console.log(
  bad === 0
    ? "全部通过：" + picked.length + " 套测试"
    : bad + " / " + picked.length + " 套失败" + (verbose ? "" : "（加 --verbose 看完整输出）"),
);
process.exit(bad ? 1 : 0);
