"use strict";
/**
 * 端到端测试：起一个**最小 WebDAV 服务器**（内存实现），跑完整的
 * 扫描 → 决策 → 执行 链路，验证四件事：
 *
 *   1. 本地新文件 → push → 云端出现，且记录回填了真实远程 mtime
 *   2. 第二轮规划 → 判为「未变化」，不会来回传
 *   3. 云端新文件 → pull → 本地出现
 *   4. 两端都改 → 冲突 → 保留双方：本地生成 .conflict-remote-* 副本，原名被本地版覆盖
 *   5. 本地删除（有记录）→ remove-remote，且删除默认要确认
 *
 * 跑法：node tests/e2e-webdav.cjs
 */

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

/* ------------------------- 临时数据目录（必须先设置） ------------------------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nutstore-e2e-"));
process.env.NUTSTORE_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.NUTSTORE_DATA_DIR, { recursive: true });

const { WebDAVClient } = require("../server/lib/webdav");
const planLib = require("../server/lib/plan");
const execLib = require("../server/lib/exec");
const stateLib = require("../server/lib/state");

/* ------------------------------ mock WebDAV ------------------------------ */

const REMOTE = new Map(); // relPath("" = root) -> {isDir, body, mtime}
REMOTE.set("", { isDir: true, body: Buffer.alloc(0), mtime: Date.now() });

const AUTH = "Basic " + Buffer.from("u@example.com:app-pass").toString("base64");

function rfc1123(ms) {
  return new Date(ms).toUTCString();
}

function htmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlFor(p) {
  const e = REMOTE.get(p);
  if (!e) return "";
  const href = "/dav/" + p.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const name = p === "" ? "dav" : p.split("/").pop();
  return (
    `<D:response><D:href>${href}</D:href><D:propstat><D:prop>` +
    `<D:displayname>${htmlEscape(name)}</D:displayname>` +
    `<D:resourcetype>${e.isDir ? "<D:collection/>" : ""}</D:resourcetype>` +
    `<D:getlastmodified>${rfc1123(e.mtime)}</D:getlastmodified>` +
    `<D:getcontentlength>${e.isDir ? 0 : e.body.length}</D:getcontentlength>` +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  );
}

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== AUTH) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="mock"' });
    return res.end("unauthorized");
  }
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = urlPath.replace(/^\/dav\/?/, "").replace(/\/+$/, "");
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);

    if (req.method === "PROPFIND") {
      const entry = REMOTE.get(rel);
      if (!entry) {
        res.writeHead(404);
        return res.end("not found");
      }
      const depth = req.headers.depth === "0" ? 0 : 1;
      let xml = xmlFor(rel);
      if (depth === 1) {
        for (const key of REMOTE.keys()) {
          if (key === rel || key === "") continue;
          const parent = key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "";
          if (parent === rel) xml += xmlFor(key);
        }
      }
      res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
      return res.end(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${xml}</D:multistatus>`);
    }

    if (req.method === "GET") {
      const entry = REMOTE.get(rel);
      if (!entry || entry.isDir) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      return res.end(entry.body);
    }

    if (req.method === "PUT") {
      const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      const pe = REMOTE.get(parent);
      if (!pe || !pe.isDir) {
        res.writeHead(409);
        return res.end("conflict");
      }
      REMOTE.set(rel, { isDir: false, body, mtime: Date.now() });
      res.writeHead(201);
      return res.end();
    }

    if (req.method === "MKCOL") {
      const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      const pe = REMOTE.get(parent);
      if (!pe) {
        res.writeHead(409);
        return res.end("conflict");
      }
      if (REMOTE.has(rel)) {
        res.writeHead(405);
        return res.end("exists");
      }
      REMOTE.set(rel, { isDir: true, body: Buffer.alloc(0), mtime: Date.now() });
      res.writeHead(201);
      return res.end();
    }

    if (req.method === "DELETE") {
      if (!REMOTE.has(rel)) {
        res.writeHead(404);
        return res.end();
      }
      for (const key of [...REMOTE.keys()]) {
        if (key === rel || key.startsWith(rel + "/")) REMOTE.delete(key);
      }
      res.writeHead(204);
      return res.end();
    }

    res.writeHead(405);
    res.end("method not allowed");
  });
});

/* --------------------------------- 工具 --------------------------------- */

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    failures.push({ name, error: String((e && e.stack) || e) });
    console.log("  ✗ " + name + "\n      " + String((e && e.message) || e));
  }
}

function writeLocal(root, rel, text) {
  const abs = path.join(root, rel.split("/").join(path.sep));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

function readLocal(root, rel) {
  const abs = path.join(root, rel.split("/").join(path.sep));
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
}

function localFileList(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = prefix ? prefix + "/" + name : name;
      if (fs.statSync(abs).isDirectory()) walk(abs, rel);
      else out.push(rel);
    }
  };
  walk(root, "");
  return out.sort();
}

/* --------------------------------- 用例 --------------------------------- */

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/dav`;

  const client = new WebDAVClient({
    baseUrl,
    username: "u@example.com",
    password: "app-pass",
    concurrency: 2,
    retries: 1,
    retryBaseMs: 20,
  });

  const localRoot = path.join(TMP, "vault");
  fs.mkdirSync(localRoot, { recursive: true });
  const config = {
    baseUrl,
    username: "u@example.com",
    password: "app-pass",
    strategy: "two-way",
    conflictStrategy: "no-conflict-merge",
    scanMode: "loose",
    maxFileSizeMB: 10,
    concurrency: 2,
    excludes: [],
    includes: [],
  };
  const state = { records: {} };

  console.log("\nmock WebDAV @ " + baseUrl + "\n");

  await test("连接测试能列出根目录", async () => {
    const r = await client.test();
    assert.strictEqual(r.ok, true);
    assert.ok(r.topLevel >= 0);
  });

  await test("本地新文件 → push 到云端，并回填远程 mtime", async () => {
    writeLocal(localRoot, "notes/a.md", "# hello");
    const plan = await planLib.buildPlan({ client, localRoot, remoteRoot: "", config, state, deviceLabel: "test" });
    const push = plan.tasks.filter((t) => t.type === "push");
    assert.strictEqual(push.length, 1, "应只有 1 个 push，实际：" + JSON.stringify(plan.tasks));
    const res = await execLib.execute({ client, localRoot, remoteRoot: "", tasks: plan.tasks, state, config, confirmDelete: true });
    assert.strictEqual(res.ok, true, JSON.stringify(res.failed));
    assert.strictEqual(res.pushed, 1);
    assert.ok(REMOTE.has("notes/a.md"), "云端应出现 notes/a.md");
    const rec = state.records["notes/a.md"];
    assert.ok(rec, "应写入同步记录");
    assert.ok(rec.remoteMtime > 0, "回填的远程 mtime 应大于 0，实际 " + rec.remoteMtime);
    assert.strictEqual(rec.remoteSize, 7);
  });

  await test("第二轮规划：判为未变化，不来回传", async () => {
    const plan = await planLib.buildPlan({ client, localRoot, remoteRoot: "", config, state, deviceLabel: "test" });
    const actions = plan.tasks.filter((t) => ["push", "pull", "remove-local", "remove-remote"].includes(t.type));
    assert.strictEqual(actions.length, 0, "不该有动作，实际：" + JSON.stringify(actions));
  });

  await test("云端新文件 → pull 到本地", async () => {
    REMOTE.set("notes/b.md", { isDir: false, body: Buffer.from("# from cloud"), mtime: Date.now() });
    const plan = await planLib.buildPlan({ client, localRoot, remoteRoot: "", config, state, deviceLabel: "test" });
    const pull = plan.tasks.filter((t) => t.type === "pull");
    assert.strictEqual(pull.length, 1, JSON.stringify(plan.tasks));
    const res = await execLib.execute({ client, localRoot, remoteRoot: "", tasks: plan.tasks, state, config, confirmDelete: true });
    assert.strictEqual(res.pulled, 1);
    assert.strictEqual(readLocal(localRoot, "notes/b.md"), "# from cloud");
  });

  await test("两端都改 → 冲突 → 保留双方（本地原名 + .conflict-remote 副本）", async () => {
    // 本地改 a.md（不同长度，loose 也能识别）
    writeLocal(localRoot, "notes/a.md", "# local edit version");
    // 云端改 a.md
    REMOTE.set("notes/a.md", { isDir: false, body: Buffer.from("# cloud edit version"), mtime: Date.now() + 5000 });
    const plan = await planLib.buildPlan({ client, localRoot, remoteRoot: "", config, state, deviceLabel: "test" });
    assert.strictEqual(plan.conflicts.length, 1, "应识别到 1 个冲突，实际：" + JSON.stringify(plan.summary));
    assert.ok(plan.tasks.some((t) => t.type === "pull" && t.dest), "应有一条 pull 写到冲突副本");
    assert.ok(plan.tasks.some((t) => t.type === "push"), "应有一条 push 把本地版推上去");
    const res = await execLib.execute({ client, localRoot, remoteRoot: "", tasks: plan.tasks, state, config, confirmDelete: true });
    assert.strictEqual(res.ok, true, JSON.stringify(res.failed));
    const files = localFileList(localRoot);
    const conflictCopy = files.find((f) => /\.conflict-/.test(f));
    assert.ok(conflictCopy, "本地应出现冲突副本，实际：" + files.join(", "));
    assert.strictEqual(readLocal(localRoot, conflictCopy), "# cloud edit version", "副本应是云端版本");
    assert.strictEqual(readLocal(localRoot, "notes/a.md"), "# local edit version", "原名应保留本地版本");
    assert.strictEqual(REMOTE.get("notes/a.md").body.toString(), "# local edit version", "云端应被本地版覆盖");
  });

  await test("本地删除（有记录）→ remove-remote；删除默认需要确认", async () => {
    fs.unlinkSync(path.join(localRoot, "notes", "b.md"));
    const plan = await planLib.buildPlan({ client, localRoot, remoteRoot: "", config, state, deviceLabel: "test" });
    const del = plan.tasks.filter((t) => t.type === "remove-remote");
    assert.strictEqual(del.length, 1, JSON.stringify(plan.tasks));
    // 不带 confirmDelete 应拒绝
    const refused = await execLib.execute({ client, localRoot, remoteRoot: "", tasks: plan.tasks, state, config });
    assert.strictEqual(refused.requiresConfirmation, true);
    assert.strictEqual(REMOTE.has("notes/b.md"), true, "未确认时不该删云端");
    // 确认后执行
    const res = await execLib.execute({ client, localRoot, remoteRoot: "", tasks: plan.tasks, state, config, confirmDelete: true });
    assert.strictEqual(res.removedRemote, 1);
    assert.strictEqual(REMOTE.has("notes/b.md"), false, "云端 b.md 应被删");
    assert.ok(!state.records["notes/b.md"], "记录应被清掉");
  });

  await test("云端目录不存在 → 自动建目录，不再报错", async () => {
    // 面板会把目标拼成「根/工作空间/工作区」，第一次同步时那层目录肯定还不存在，
    // 所以这里不能再要求用户先去网页上手动建一个。
    const plan = await planLib.buildPlan({
      client,
      localRoot,
      remoteRoot: "no-such-dir-xyz",
      config,
      state,
      deviceLabel: "test",
    });
    const mk = plan.tasks.filter((t) => t.type === "mkdir-remote");
    assert.ok(mk.length >= 1, "应补一条建目录任务，实际：" + JSON.stringify(plan.tasks.slice(0, 3)));
    assert.strictEqual(mk[0].path, "", "建的应该是云端根目录本身");
    assert.strictEqual(plan.summary.deleteCount, 0, "云端是空的时候不许删任何东西");
    assert.ok(
      (plan.notes || []).some((n) => /自动建好/.test(n)),
      "应说明会自动建目录，实际：" + JSON.stringify(plan.notes),
    );

    // 真跑一次：目录要能被建出来（执行器用的是 mkdirp，父级一起建）
    const res = await execLib.execute({
      client,
      localRoot,
      remoteRoot: "no-such-dir-xyz",
      tasks: plan.tasks.filter((t) => t.type === "mkdir-remote" && t.path === ""),
      state,
      config,
    });
    assert.strictEqual(res.ok, true, JSON.stringify(res.failed).slice(0, 300));
    const items = await client.list("no-such-dir-xyz");
    assert.ok(Array.isArray(items), "目录应已建好");
  });

  await test("计划里带请求量估算，且点名限额", async () => {
    const plan = await planLib.buildPlan({ client, localRoot, remoteRoot: "", config, state, deviceLabel: "test" });
    assert.ok(plan.summary.requestEstimate > 0, "requestEstimate 应大于 0");
    assert.strictEqual(plan.summary.requestQuota, 600, "应引用免费版 600 次限额");
    const d = planLib.describe(plan);
    assert.ok(/预计请求/.test(d), "describe 应含请求估算，实际：" + d);
  });

  await test("默认配置是保守限速（不再裸奔）", async () => {
    const d = stateLib.DEFAULT_CONFIG;
    assert.strictEqual(d.minGapMs, 120, "默认应有软限速");
    assert.strictEqual(d.concurrency, 2, "默认并发应为 2");
  });

  await test("同步记录能原子落盘并读回", async () => {
    stateLib.saveState(state);
    const back = stateLib.loadState();
    assert.ok(back.records["notes/a.md"], "读回后应仍有记录");
    assert.ok(back.updatedAt);
  });

  server.close();
  console.log("\n结果：" + passed + " 通过 / " + failed + " 失败\n");
  if (failed) {
    for (const f of failures) console.log("--- " + f.name + " ---\n" + f.error + "\n");
    process.exit(1);
  }
  process.exit(0);
})();
