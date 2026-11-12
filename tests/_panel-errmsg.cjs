"use strict";
/**
 * errMsg 的行为契约测试。
 *
 * 为什么单独测这个函数：用户这轮的两条反馈（「预演失败」看不出原因、
 * 「测试连接」看不出结果）本质是同一件事 —— **失败信息被吞掉**。
 * 旧代码 `(r.error || r.hint) || "预演失败"` 在 r 形状不对时只剩一句「失败」，
 * 用户和我都无从下手。errMsg 就是专门堵这个洞的，所以它必须有测试盯着。
 *
 * 做法：从 panels/sync.tsx 里把 errMsg 抠出来直接 eval（它是纯函数，
 * 不依赖 React），然后逐条验行为。
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "panels", "sync.tsx"), "utf8");

function extractFn(name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("没找到 function " + name);
  const end = src.indexOf("\n}", start);
  if (end < 0) throw new Error(name + " 没有找到结尾");
  return src.slice(start, end + 2);
}

let errMsg;
try {
  // 函数体里没有 JSX、没有 import，可以安全地在 Node 里求值
  errMsg = new Function(extractFn("errMsg") + "\nreturn errMsg;")();
} catch (e) {
  console.log("  ✗ errMsg 无法求值：" + e.message);
  process.exit(1);
}

const checks = [];
const add = (n, ok, extra) => checks.push({ n, ok, extra });

// 1) 完整信息必须全保留
const full = errMsg({ ok: false, code: "HTTP_401", error: "列目录失败", hint: "核对账号" });
add("保留 code", full.indexOf("HTTP_401") >= 0, full);
add("保留 error", full.indexOf("列目录失败") >= 0, full);
add("保留 hint", full.indexOf("核对账号") >= 0, full);

// 2) 空对象不能变成「什么都不说」
const empty = errMsg({}, "预演失败");
add("空对象也不静默", empty.indexOf("没有错误信息") >= 0, empty);

// 3) 陌生形状必须把原始返回摊出来（这是最关键的一条）
const weird = errMsg({ foo: "bar", n: 7 }, "预演失败");
add("陌生形状摊开原文", weird.indexOf("foo") >= 0 && weird.indexOf("bar") >= 0, weird);

// 4) null / undefined
// null 也要同时说两件事：你点的是什么失败了 + 根本没拿到返回
const nv = errMsg(null, "预演失败");
add("null 保留兜底文案", nv.indexOf("预演失败") >= 0, nv);
add("null 说明没有返回", nv.indexOf("没有收到返回") >= 0, nv);
add(
  "undefined 说明进程可能已退出",
  errMsg(undefined, "x").indexOf("没有收到返回") >= 0,
  errMsg(undefined, "x"),
);

// 5) 字符串原样回传
add("字符串原样", errMsg("连接超时", "兜底") === "连接超时", errMsg("连接超时", "兜底"));

// 6) 只有 message 字段也认
add(
  "认 message 字段",
  errMsg({ message: "boom" }, "x").indexOf("boom") >= 0,
  errMsg({ message: "boom" }, "x"),
);

// 7) 绝不返回空串（面板渲染空串 = 什么都看不到）
const cases = [{}, null, undefined, "", { ok: false }, { code: "X" }, 0, false];
let blank = 0;
for (const c of cases) {
  const m = errMsg(c, "预演失败");
  if (!m || !String(m).trim()) blank++;
}
add("任何输入都不返回空串", blank === 0, "空串 " + blank + " 次");

let bad = 0;
for (const c of checks) {
  console.log((c.ok ? "  ✓ " : "  ✗ ") + c.n + (c.ok || !c.extra ? "" : "  (" + c.extra + ")"));
  if (!c.ok) bad++;
}
console.log("\nerrMsg 契约：" + (checks.length - bad) + " 通过 / " + bad + " 失败");
process.exit(bad ? 1 : 0);
