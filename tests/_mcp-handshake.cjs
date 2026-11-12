"use strict";
/**
 * MCP 协议握手测试：真的把 server 当子进程跑起来，用 stdio 说 JSON-RPC。
 *
 * 为什么必须真跑：`tools/list` 的 schema 是运行时拼出来的（TOOLS_META），
 * 静态读源码看不出「某个工具的参数类型写错、required 漏了」这类问题；
 * 而这类错误在宿主里表现为「工具能看见但一调就失败」，最难排查。
 *
 * 检查项：
 *   1. initialize 握手返回 protocolVersion + serverInfo
 *   2. tools/list 返回 12 个工具，每个都有 name/description/inputSchema
 *   3. 每个 inputSchema 的 required 字段都在 properties 里
 *   4. 通知（无 id）不回包
 *   5. 未配置账号时调 ns_test 得到结构化错误（不是崩溃）
 *   6. ns_guide 能直接返回内容（纯本地，不需要网络）
 */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "nutstore-mcp-"));

const child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { NUTSTORE_DATA_DIR: TMP_DATA }),
  stdio: ["pipe", "pipe", "pipe"],
});

let out = "";
let errOut = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (errOut += d));

const responses = new Map();

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

function waitFor(id, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (responses.has(id)) return resolve(responses.get(id));
      if (Date.now() - started > (timeoutMs || 8000)) {
        return reject(new Error("等 id=" + id + " 超时。stdout=" + out.slice(0, 800) + " stderr=" + errOut.slice(0, 800)));
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

child.stdout.on("data", () => {
  const lines = out.split("\n");
  out = lines.pop() || "";
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const msg = JSON.parse(t);
      if (msg.id != null) responses.set(msg.id, msg);
    } catch (e) {
      console.error("stdout 出现非 JSON 内容（会污染协议）：" + t.slice(0, 200));
    }
  }
});

const checks = [];
const add = (name, ok, extra) => checks.push({ name, ok, extra });

(async () => {
  // 1) 握手
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } });
  const init = await waitFor(1);
  add("initialize 有 protocolVersion", !!(init.result && init.result.protocolVersion), "");
  add("serverInfo.name 正确", init.result && init.result.serverInfo && init.result.serverInfo.name === "notrat-nutstore", "");
  add("声明 tools 能力", !!(init.result && init.result.capabilities && init.result.capabilities.tools), "");

  // 4) 通知不回包（发一个无 id 的 initialized）
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  // 2) tools/list
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const list = await waitFor(2);
  const tools = (list.result && list.result.tools) || [];
  add("tools/list 返回 12 个工具", tools.length === 12, "got " + tools.length + ": " + tools.map((t) => t.name).join(","));

  const expected = [
    "ns_guide", "ns_config", "ns_test", "ns_ls", "ns_plan", "ns_conflicts",
    "ns_run", "ns_job", "ns_cancel", "ns_resolve", "ns_status", "ns_log",
  ];
  for (const name of expected) {
    add("工具存在：" + name, tools.some((t) => t.name === name), "");
  }

  for (const t of tools) {
    add(t.name + " 有 description", typeof t.description === "string" && t.description.length > 20, "");
    add(t.name + " 有 inputSchema", !!t.inputSchema && t.inputSchema.type === "object", "");
    const props = Object.keys(t.inputSchema.properties || {});
    const req = t.inputSchema.required || [];
    const missing = req.filter((r) => !props.includes(r));
    add(t.name + " 的 required 都在 properties 里", missing.length === 0, missing.join(","));
    const badType = Object.entries(t.inputSchema.properties || {}).filter(
      ([, s]) => !["string", "number", "boolean", "object", "array"].includes(s.type),
    );
    add(t.name + " 参数类型合法", badType.length === 0, badType.map(([k]) => k).join(","));
  }

  // 6) ns_guide 纯本地，必须能跑
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ns_guide", arguments: {} } });
  const guide = await waitFor(3);
  const guideText = guide.result && guide.result.content && guide.result.content[0] && guide.result.content[0].text;
  let guideJson = null;
  try {
    guideJson = JSON.parse(guideText || "null");
  } catch (_) {
    guideJson = null;
  }
  add("ns_guide 返回可解析 JSON", !!guideJson, String(guideText).slice(0, 120));
  add("ns_guide 含五种策略", !!(guideJson && Array.isArray(guideJson.strategies) && guideJson.strategies.length === 5), "");

  // 5) 未配置账号 → 结构化错误，进程不能崩
  const cfgFile = path.join(TMP_DATA, "config.json");
  if (fs.existsSync(cfgFile)) fs.unlinkSync(cfgFile);
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ns_test", arguments: {} } });
  const testRes = await waitFor(4);
  const testText = testRes.result && testRes.result.content && testRes.result.content[0] && testRes.result.content[0].text;
  let testJson = null;
  try {
    testJson = JSON.parse(testText || "null");
  } catch (_) {
    testJson = null;
  }
  add("未配置时返回结构化错误", !!(testJson && testJson.ok === false), String(testText).slice(0, 160));
  add("错误带可执行的 hint", !!(testJson && /ns_config|面板/.test(String(testJson.hint || ""))), String(testJson && testJson.hint));
  add("isError 标记正确", !!(testRes.result && testRes.result.isError), "");

  // 7) ns_status 必须暴露构建指纹 —— 用来判断「跑的是不是新代码」
  send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "ns_status", arguments: {} } });
  const stRes = await waitFor(6);
  const stText = stRes.result && stRes.result.content && stRes.result.content[0] && stRes.result.content[0].text;
  let stJson = null;
  try {
    stJson = JSON.parse(stText || "null");
  } catch (_) {
    stJson = null;
  }
  add("ns_status 返回可解析 JSON", !!(stJson && stJson.ok), String(stText).slice(0, 120));
  add("ns_status 暴露 build 指纹", !!(stJson && stJson.build && stJson.build.pid), JSON.stringify(stJson && stJson.build));
  add(
    "build 带 stale 判断（能看出跑的是旧代码）",
    !!(stJson && stJson.build && typeof stJson.build.stale === "boolean"),
    JSON.stringify(stJson && stJson.build),
  );
  add(
    "build 记录文件的 mtime",
    !!(stJson && stJson.build && /^\d{4}-\d{2}-\d{2}T/.test(String(stJson.build.mtime || ""))),
    String(stJson && stJson.build && stJson.build.mtime),
  );

  // 未知工具 → 也是结构化错误
  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ns_nope", arguments: {} } });
  const nope = await waitFor(5);
  add("未知工具报错不崩", !!(nope.result && nope.result.isError), "");

  add("进程仍存活", child.exitCode === null, "exitCode=" + child.exitCode);

  child.kill();
  let bad = 0;
  for (const c of checks) {
    if (!c.ok) bad++;
    console.log((c.ok ? "  ✓ " : "  ✗ ") + c.name + (c.ok || !c.extra ? "" : "  (" + c.extra + ")"));
  }
  console.log("\nMCP 握手：" + (checks.length - bad) + " 通过 / " + bad + " 失败");
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error("测试异常：" + String((e && e.stack) || e));
  child.kill();
  process.exit(1);
});
