"use strict";
/**
 * 决策矩阵测试 —— 直接对着 docs/SPEC.md 第 3 节那张表逐格验。
 *
 * 为什么单独测：`decide()` 是纯函数，但它是整个插件唯一可能**丢数据**的地方
 * （判错方向 = 覆盖/删除别人的文件）。e2e 只覆盖了几条主路径，策略×状态
 * 的笛卡尔积必须穷举，尤其五个策略对「只有一端有」的处理完全不同。
 */
const { decide, TASK } = require("../server/lib/decide");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push({ name, error: String((e && e.message) || e) });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "断言失败");
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg || "不相等") + "\n  实际：" + a + "\n  期望：" + b);
}

const T0 = 1700000000000;
const mkLocal = (entries) => new Map(Object.entries(entries));
const mkRemote = (entries) => new Map(Object.entries(entries));
const file = (p, size, mtime) => ({ path: p, isDir: false, size, mtime: mtime || T0 });
const dir = (p) => ({ path: p, isDir: true, size: 0, mtime: T0 });

function run(input) {
  const config = Object.assign(
    { strategy: "two-way", conflictStrategy: "no-conflict-merge", scanMode: "loose", maxFileSizeMB: 100 },
    input.config || {},
  );
  const out = decide({
    local: mkLocal(input.local || {}),
    remote: mkRemote(input.remote || {}),
    records: input.records || {},
    config,
    deviceLabel: "test",
    now: new Date("2024-01-01T00:00:00Z"),
  });
  return out;
}

/** 取出「真实动作」类型（不含 skip）。 */
function actions(out) {
  return out.tasks.filter((t) => t.type !== TASK.SKIP).map((t) => t.type).sort();
}
function skips(out) {
  return out.tasks.filter((t) => t.type === TASK.SKIP).map((t) => t.reason);
}
const rec = (lm, ls, rm, rs) => ({
  localMtime: lm,
  localSize: ls,
  remoteMtime: rm,
  remoteSize: rs,
  syncedAt: "2024-01-01T00:00:00.000Z",
});

/* ============ 表第 1 行：仅本地有，无记录 ============ */
const caseOnlyLocal = { local: { "a.md": file("a.md", 10) }, remote: {}, records: {} };

test("[仅本地] two-way → push", () => {
  eq(actions(run(Object.assign({ config: { strategy: "two-way" } }, caseOnlyLocal))), ["push"]);
});
test("[仅本地] send-only → push", () => {
  eq(actions(run(Object.assign({ config: { strategy: "send-only" } }, caseOnlyLocal))), ["push"]);
});
test("[仅本地] send-only-override → push", () => {
  eq(actions(run(Object.assign({ config: { strategy: "send-only-override-changes" } }, caseOnlyLocal))), ["push"]);
});
test("[仅本地] receive-only → skip（保留本地）", () => {
  const out = run(Object.assign({ config: { strategy: "receive-only" } }, caseOnlyLocal));
  eq(actions(out), []);
  eq(skips(out), ["local-only-kept"]);
});
test("[仅本地] receive-only-revert → remove-local（镜像删本地）", () => {
  eq(actions(run(Object.assign({ config: { strategy: "receive-only-revert-local-changes" } }, caseOnlyLocal))), [
    "remove-local",
  ]);
});

/* ============ 表第 2 行：仅云端有，无记录 ============ */
const caseOnlyRemote = { local: {}, remote: { "b.md": file("b.md", 20) }, records: {} };

test("[仅云端] two-way → pull", () => {
  eq(actions(run(Object.assign({ config: { strategy: "two-way" } }, caseOnlyRemote))), ["pull"]);
});
test("[仅云端] send-only → skip（保留云端）", () => {
  const out = run(Object.assign({ config: { strategy: "send-only" } }, caseOnlyRemote));
  eq(actions(out), []);
  eq(skips(out), ["remote-only-kept"]);
});
test("[仅云端] send-only-override → remove-remote（镜像删云端）", () => {
  eq(actions(run(Object.assign({ config: { strategy: "send-only-override-changes" } }, caseOnlyRemote))), [
    "remove-remote",
  ]);
});
test("[仅云端] receive-only → pull", () => {
  eq(actions(run(Object.assign({ config: { strategy: "receive-only" } }, caseOnlyRemote))), ["pull"]);
});
test("[仅云端] receive-only-revert → pull", () => {
  eq(actions(run(Object.assign({ config: { strategy: "receive-only-revert-local-changes" } }, caseOnlyRemote))), ["pull"]);
});

/* ============ 表第 3 行：仅本地有，有记录（云端删了） ============ */
const caseRemoteDeleted = {
  local: { "a.md": file("a.md", 10) },
  remote: {},
  records: { "a.md": rec(T0, 10, T0, 10) },
};

test("[云端删了] two-way 本地未改 → remove-local（跟着删）", () => {
  eq(actions(run(Object.assign({ config: { strategy: "two-way" } }, caseRemoteDeleted))), ["remove-local"]);
});
test("[云端删了] two-way 本地改过 → 冲突展开为 push（不跟着删）", () => {
  const out = run(
    Object.assign({}, caseRemoteDeleted, {
      local: { "a.md": file("a.md", 99) },
      config: { strategy: "two-way", conflictStrategy: "no-conflict-merge" },
    }),
  );
  eq(actions(out), ["push"], "本地改过时绝不能删本地");
  assert(out.notes.some((n) => /云端已删除但本地有改动/.test(n)), "应有说明：" + JSON.stringify(out.notes));
});
test("[云端删了] send-only → push（推回云端）", () => {
  eq(actions(run(Object.assign({ config: { strategy: "send-only" } }, caseRemoteDeleted))), ["push"]);
});
test("[云端删了] receive-only-revert → remove-local", () => {
  eq(actions(run(Object.assign({ config: { strategy: "receive-only-revert-local-changes" } }, caseRemoteDeleted))), [
    "remove-local",
  ]);
});

/* ============ 表第 4 行：仅云端有，有记录（本地删了） ============ */
const caseLocalDeleted = {
  local: {},
  remote: { "b.md": file("b.md", 20) },
  records: { "b.md": rec(T0, 20, T0, 20) },
};

test("[本地删了] two-way 云端未变 → remove-remote", () => {
  eq(actions(run(Object.assign({ config: { strategy: "two-way" } }, caseLocalDeleted))), ["remove-remote"]);
});
test("[本地删了] two-way 云端改过 → pull（保留云端改动）", () => {
  const out = run(
    Object.assign({}, caseLocalDeleted, {
      remote: { "b.md": file("b.md", 33) },
      config: { strategy: "two-way" },
    }),
  );
  eq(actions(out), ["pull"], "云端改过时不能删云端");
  assert(out.notes.some((n) => /云端有改动/.test(n)), "应有说明");
});
test("[本地删了] send-only 云端未变 → remove-remote", () => {
  eq(actions(run(Object.assign({ config: { strategy: "send-only" } }, caseLocalDeleted))), ["remove-remote"]);
});
test("[本地删了] send-only 云端改过 → skip（保留云端）", () => {
  const out = run(Object.assign({}, caseLocalDeleted, { remote: { "b.md": file("b.md", 33) }, config: { strategy: "send-only" } }));
  eq(actions(out), []);
  assert(skips(out).includes("remote-changed-kept"), JSON.stringify(skips(out)));
});
test("[本地删了] receive-only → pull（云端为主）", () => {
  eq(actions(run(Object.assign({ config: { strategy: "receive-only" } }, caseLocalDeleted))), ["pull"]);
});

/* ============ 表第 5/6/7 行：两端都有 ============ */
const base = {
  local: { "a.md": file("a.md", 10) },
  remote: { "a.md": file("a.md", 10) },
  records: { "a.md": rec(T0, 10, T0, 10) },
};

test("[两端都在] 都未变 → 无动作", () => {
  const out = run(Object.assign({}, base));
  eq(actions(out), []);
  assert(skips(out).includes("unchanged"), JSON.stringify(skips(out)));
});
test("[两端都在] 仅本地变 → push", () => {
  const out = run(Object.assign({}, base, { local: { "a.md": file("a.md", 30) } }));
  eq(actions(out), ["push"]);
});
test("[两端都在] 仅云端变 → pull", () => {
  const out = run(Object.assign({}, base, { remote: { "a.md": file("a.md", 30) } }));
  eq(actions(out), ["pull"]);
});
test("[两端都在] 仅消费端变，send-only → skip（不拉）", () => {
  const out = run(Object.assign({}, base, { remote: { "a.md": file("a.md", 30) }, config: { strategy: "send-only" } }));
  eq(actions(out), []);
  assert(skips(out).includes("remote-changed-kept"), JSON.stringify(skips(out)));
});
test("[两端都在] 仅本地变，receive-only → skip（不推）", () => {
  const out = run(Object.assign({}, base, { local: { "a.md": file("a.md", 30) }, config: { strategy: "receive-only" } }));
  eq(actions(out), []);
  assert(skips(out).includes("local-changed-kept"), JSON.stringify(skips(out)));
});

/* ============ 表第 8 行：冲突 × 四种策略 ============ */
const bothChanged = {
  local: { "a.md": file("a.md", 31) },
  remote: { "a.md": file("a.md", 32) },
  records: { "a.md": rec(T0, 10, T0, 10) },
};

test("[冲突] 记录冲突数", () => {
  const out = run(Object.assign({}, bothChanged));
  eq(out.conflicts.length, 1);
  eq(out.summary.conflict, 1);
});
test("[冲突] local-priority → 只有 push", () => {
  const out = run(Object.assign({}, bothChanged, { config: { conflictStrategy: "local-priority" } }));
  eq(actions(out), ["push"]);
});
test("[冲突] server-priority → 只有 pull", () => {
  const out = run(Object.assign({}, bothChanged, { config: { conflictStrategy: "server-priority" } }));
  eq(actions(out), ["pull"]);
});
test("[冲突] no-conflict-merge → pull(dest) + push，且副本名带 conflict", () => {
  const out = run(Object.assign({}, bothChanged));
  eq(actions(out), ["pull", "push"]);
  const pull = out.tasks.find((t) => t.type === TASK.PULL);
  assert(pull && pull.dest && /\.conflict-/.test(pull.dest), "dest=" + (pull && pull.dest));
});
test("[冲突] diff3 → 与保留双方一致，且 notes 说明降级", () => {
  const out = run(Object.assign({}, bothChanged, { config: { conflictStrategy: "diff3" } }));
  eq(actions(out), ["pull", "push"]);
  assert(out.notes.some((n) => /三方合并/.test(n)), JSON.stringify(out.notes));
});

/* ============ 表第 9 行：首次接入但两端一致 ============ */
test("[首次一致] 无记录但 size+mtime 相同 → 不传（identical-new）", () => {
  const out = run({
    local: { "a.md": file("a.md", 10, T0) },
    remote: { "a.md": file("a.md", 10, T0) },
    records: {},
  });
  eq(actions(out), []);
  assert(skips(out).includes("identical-new"), JSON.stringify(skips(out)));
});
test("[首次不一致] 无记录且内容不同 → 冲突（不静默覆盖）", () => {
  const out = run({
    local: { "a.md": file("a.md", 11, T0) },
    remote: { "a.md": file("a.md", 22, T0) },
    records: {},
  });
  eq(out.conflicts.length, 1, "必须先判冲突");
});

/* ============ 表第 10 行：两端都没有 ============ */
test("[两端都没] → skip 并清记录", () => {
  const out = run({ local: {}, remote: {}, records: { "a.md": rec(T0, 1, T0, 1) } });
  eq(actions(out), []);
  assert(skips(out).includes("both-missing-drop-record"), JSON.stringify(skips(out)));
});

/* ============ 目录 ============ */
test("[目录] 本地独有目录 → mkdir-remote", () => {
  const out = run({ local: { docs: dir("docs") }, remote: {}, records: {} });
  eq(actions(out), ["mkdir-remote"]);
});
test("[目录] 云端独有目录 → mkdir-local", () => {
  const out = run({ local: {}, remote: { docs: dir("docs") }, records: {} });
  eq(actions(out), ["mkdir-local"]);
});
test("[目录] 目录不参与冲突判定（同路径文件+目录不算冲突）", () => {
  const out = run({
    local: { "x": dir("x") },
    remote: { "x": file("x", 5) },
    records: {},
  });
  eq(out.conflicts.length, 0);
});

/* ============ 大文件 ============ */
test("[大文件] 超上限 → skip(file-too-large)", () => {
  const out = run({
    local: { "big.bin": file("big.bin", 5 * 1024 * 1024) },
    remote: {},
    records: {},
    config: { maxFileSizeMB: 1 },
  });
  eq(actions(out), []);
  assert(skips(out).includes("file-too-large"), JSON.stringify(skips(out)));
});

/* ============ 时间容差 & 扫描模式 ============ */
test("[容差] mtime 差 1500ms 且 size 相同 → strict 下算变更", () => {
  // strict 容差是 1 秒（卡在坚果云秒级精度上），1500ms 已经超出 → 必须判改动。
  // 之前这里断言「2 秒容差内视为未变」，是把 loose 的宽容差套用到了 strict 上，
  // 等于让 strict 也漏掉等长编辑。
  const out = run({
    local: { "a.md": file("a.md", 10, T0 + 1500) },
    remote: { "a.md": file("a.md", 10, T0) },
    records: { "a.md": rec(T0, 10, T0, 10) },
    config: { scanMode: "strict" },
  });
  eq(actions(out), ["push"]);
});

test("[容差] mtime 差 500ms 且 size 相同 → strict 下仍视为未变", () => {
  // 同一秒内的抖动（touch、工具重写）不能算改动，否则每个文件都会重传。
  const out = run({
    local: { "a.md": file("a.md", 10, T0 + 500) },
    remote: { "a.md": file("a.md", 10, T0) },
    records: { "a.md": rec(T0, 10, T0, 10) },
    config: { scanMode: "strict" },
  });
  eq(actions(out), []);
});
test("[宽松] size 相同但 mtime 变了 → 算变更（push）", () => {
  // 这是多机双向丢数据的根因用例：把 "1" 改成 "2"，size 不变。
  // loose 原先只看 size → 判「没变」→ 另一台机器永远收不到。
  // 现在 loose 也看 mtime（只是容差更宽），必须能识别出来。
  const out = run({
    local: { "a.md": file("a.md", 10, T0 + 60000) },
    remote: { "a.md": file("a.md", 10, T0) },
    records: { "a.md": rec(T0, 10, T0, 10) },
    config: { scanMode: "loose" },
  });
  eq(actions(out), ["push"]);
});

test("[宽松] 双方都改且 size 相同 → 判冲突保留双方（不再静默 pull 覆盖本地）", () => {
  const out = run({
    local: { "a.md": file("a.md", 10, T0 + 60000) },
    remote: { "a.md": file("a.md", 10, T0 + 30000) },
    records: { "a.md": rec(T0, 10, T0, 10) },
    config: { scanMode: "loose" },
  });
  const acts = actions(out);
  assert(acts.includes("push") && acts.includes("pull"), JSON.stringify(acts));
});
test("[严格] size 相同但 mtime 变了 → 算变更（push）", () => {
  const out = run({
    local: { "a.md": file("a.md", 10, T0 + 60000) },
    remote: { "a.md": file("a.md", 10, T0) },
    records: { "a.md": rec(T0, 10, T0, 10) },
    config: { scanMode: "strict" },
  });
  eq(actions(out), ["push"]);
});

/* ============ 非法文件名 ============ */
test("[非法名] 云端 a:b.md 落到 Windows 本地 → skip(invalid-filename)", () => {
  const out = run({ local: {}, remote: { "a:b.md": file("a:b.md", 5) }, records: {} });
  eq(actions(out), []);
  assert(skips(out).includes("invalid-filename"), JSON.stringify(skips(out)));
});

/* ============ 汇总字段 ============ */
test("[汇总] summary 计数与任务一致", () => {
  const out = run({
    local: { "a.md": file("a.md", 11), "b.md": file("b.md", 5), d: dir("d") },
    remote: { "a.md": file("a.md", 22), "c.md": file("c.md", 7) },
    records: { "a.md": rec(T0, 10, T0, 10) },
  });
  const push = out.tasks.filter((t) => t.type === "push").length;
  const pull = out.tasks.filter((t) => t.type === "pull").length;
  eq(out.summary.push, push);
  eq(out.summary.pull, pull);
  eq(out.summary.conflict, out.conflicts.length);
  assert(out.summary.changes > 0, "changes 应大于 0");
});

/* ============ 输出 ============ */
for (const f of failures) {
  console.log("  ✗ " + f.name + "\n      " + f.error);
}
console.log("\n决策矩阵：" + passed + " 通过 / " + failed + " 失败");
process.exit(failed ? 1 : 0);
