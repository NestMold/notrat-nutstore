"use strict";
/**
 * 回归测试：宿主关 stdin 时，in-flight 请求的响应不能丢。
 *
 * 事故（2026-10-25）：面板点「测试连接」后一直转圈。根因是
 *   process.stdin.on("end", () => process.exit(0));
 * 宿主重载插件会关 stdin，此时 ns_test 还在等网络，进程被直接杀掉，
 * 响应永远发不出去 → 面板的 Promise 永不 resolve。
 *
 * 这个测试用「不可达地址」制造一个必然慢的请求，然后在请求途中关 stdin，
 * 断言：进程不能立刻退出、响应必须回来。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nutstore-drain-"));

// 指向一个不可路由地址：连接会挂住，制造 in-flight 窗口
fs.writeFileSync(
  path.join(TMP, "config.json"),
  JSON.stringify({
    baseUrl: "https://10.255.255.1/dav",
    username: "a@b.com",
    password: "x",
    strategy: "two-way",
    conflictStrategy: "no-conflict-merge",
    scanMode: "loose",
    maxFileSizeMB: 100,
    concurrency: 2,
    minGapMs: 0,
    autoDelete: false,
    excludes: [],
    includes: [],
    autoSync: { enabled: false, intervalMinutes: 30, onStart: false },
  }),
);

const child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { NUTSTORE_DATA_DIR: TMP }),
  stdio: ["pipe", "pipe", "pipe"],
});

let out = "";
let err = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (err += d));

const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");

const checks = [];
const add = (n, ok, extra) => checks.push({ n, ok, extra });

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

setTimeout(() => {
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ns_test", arguments: {} } });
  // 请求发出 150ms 后关 stdin（模拟宿主重载插件）
  setTimeout(() => child.stdin.end(), 150);
}, 200);

// 给足时间：连不上 + 重试退避，理论上会走完超时或重试耗尽
const HARD_TIMEOUT = 20000;
const t0 = Date.now();

const finish = (reason) => {
  const ids = out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l).id;
      } catch (_) {
        return null;
      }
    });
  add("进程没有在关 stdin 时秒退", Date.now() - t0 > 500 || reason === "exited-late", "耗时 " + (Date.now() - t0) + "ms");
  add("initialize 有响应", ids.includes(1), JSON.stringify(ids));
  add("ns_test 响应没有丢失", ids.includes(2), "收到的 id：" + JSON.stringify(ids));
  add("stderr 记录了宽限退出", /stdin 关闭/.test(err), err.trim().split("\n").slice(-2).join(" | "));

  let bad = 0;
  for (const c of checks) {
    if (!c.ok) bad++;
    console.log((c.ok ? "  ✓ " : "  ✗ ") + c.n + (c.ok || !c.extra ? "" : "  (" + c.extra + ")"));
  }
  console.log("\nstdin 排空：" + (checks.length - bad) + " 通过 / " + bad + " 失败");
  try {
    child.kill();
  } catch (_) {}
  process.exit(bad ? 1 : 0);
};

child.on("exit", (code, sig) => {
  // 进程自己退出了：检查响应是否已发完
  setTimeout(() => finish("exited"), 100);
});

setTimeout(() => finish("timeout"), HARD_TIMEOUT);
