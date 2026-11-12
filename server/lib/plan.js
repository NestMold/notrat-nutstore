"use strict";
/**
 * 规划编排：扫描本地 + 遍历远端 → 交给 decide()。
 *
 * 远程遍历是**最贵**的一步（每个目录一次 PROPFIND，坚果云还有频率限制），所以：
 *   - 用 BFS 而不是递归（深目录不会爆栈）；
 *   - 目录在本地规则里被忽略时**直接不入队**（省掉整棵子树）；
 *   - 支持取消（长时间遍历要能停）。
 *
 * 计划本身会被缓存到 data/last-plan.json，`ns_run` 可以带 planId 复用同一份计划
 * （避免「预览看到的」和「真正执行的」不是同一份）。缓存超过 10 分钟自动失效。
 *
 * 本文件是 notrat-nutstore 的一部分，按 AGPL-3.0 发布（全文见包内 LICENSE）。
 * 衍生自 nutstore/obsidian-nutstore-sync (AGPL-3.0)，原项目版权归其作者所有。
 */

const fs = require("fs");
const path = require("path");
const { scanLocal } = require("./scan");
const { buildIgnoreRules, DEFAULT_EXCLUDES, mergeExcludes } = require("./rules");
const { decide } = require("./decide");
const { safeJoin } = require("./scan");
const stateLib = require("./state");

const PLAN_FILE = path.join(stateLib.DATA_DIR, "last-plan.json");
const PLAN_TTL_MS = 10 * 60 * 1000;

function remoteToRel(remoteRoot, itemPath) {
  const root = String(remoteRoot || "").replace(/^\/+|\/+$/g, "");
  const p = String(itemPath || "").replace(/^\/+|\/+$/g, "");
  if (!root) return p;
  if (p === root) return "";
  if (!p.startsWith(root + "/")) return null;
  return p.slice(root.length + 1);
}

/** 远端目录树遍历（BFS）。 */
async function walkRemote(client, remoteRoot, opts) {
  const o = opts || {};
  const rules = o.rules || buildIgnoreRules(DEFAULT_EXCLUDES, []);
  const map = new Map();
  // propfinds = 实际发出的列目录请求数（每入队一个目录一次；分页会更多，此处按 1 计）
  const stats = { dirs: 0, files: 0, bytes: 0, ignored: 0, errors: [], propfinds: 0 };
  const queue = [{ rel: "", remote: String(remoteRoot || "").replace(/^\/+|\/+$/g, "") }];
  /**
   * 已入队的相对路径。
   *
   * webdav.list() 已经剔除了「目录自身」那条 href，所以正常情况不会自环。
   * 但这道判断不能只靠上游：任何一台行为不规范的 WebDAV 服务器（把父目录当
   * 子目录返回、软链接成环、分页把同一条吐两次）都会让 BFS 无限跑下去，
   * 而我们每小时只有 600 次请求额度 —— 自环会在几十秒内把账号打到限流。
   * 这里用 seen 兜住，是纯防御。
   */
  const seen = new Set([""]);
  /**
   * 硬上限：即便 seen 也被绕过，也绝不让遍历无限跑。
   * 可用 opts.maxDirs 收紧（测试、或用户目录确实很大时想早点止损）。
   */
  const MAX_DIRS = Math.max(10, Number(o.maxDirs) || 20000);
  let visited = 0;

  while (queue.length) {
    if (seen.size > MAX_DIRS) {
      stats.errors.push({ path: ".", error: "目录数超过 " + MAX_DIRS + " 上限，已中止遍历" });
      break;
    }
    if (typeof o.shouldCancel === "function" && o.shouldCancel()) {
      const err = new Error("已取消远程扫描");
      err.code = "CANCELLED";
      throw err;
    }
    const cur = queue.shift();
    let items;
    try {
      items = await client.list(cur.remote);
    } catch (e) {
      // 单个目录失败不中断整棵树（记录后继续）
      stats.errors.push({ path: cur.rel || ".", error: String((e && e.message) || e) });
      continue;
    }
    visited++;
    stats.propfinds = visited;
    if (typeof o.onProgress === "function" && visited % 20 === 0) {
      o.onProgress({ dirs: visited, files: stats.files, current: cur.rel || "." });
    }
    for (const it of items) {
      const rel = remoteToRel(remoteRoot, it.path);
      if (rel == null || rel === "") continue;
      if (it.isDir) {
        if (rules.ignored(rel, true)) {
          stats.ignored++;
          continue;
        }
        stats.dirs++;
        map.set(rel, { path: rel, isDir: true, size: 0, mtime: it.mtime });
        if (!seen.has(rel)) {
          seen.add(rel);
          queue.push({ rel, remote: it.path });
        }
      } else {
        if (rules.ignored(rel, false)) {
          stats.ignored++;
          continue;
        }
        stats.files++;
        stats.bytes += it.size;
        map.set(rel, { path: rel, isDir: false, size: it.size, mtime: it.mtime });
      }
    }
  }
  return { map, stats };
}

/**
 * 生成计划。
 * @param {{client:any, localRoot:string, remoteRoot:string, config:object,
 *          state:{records:object}, deviceLabel?:string,
 *          onProgress?:(p:object)=>void, shouldCancel?:()=>boolean}} input
 */
async function buildPlan(input) {
  const { client, config } = input;
  const localRoot = path.resolve(String(input.localRoot || ""));
  const remoteRoot = String(input.remoteRoot || "").replace(/^\/+|\/+$/g, "");
  const st = await fs.promises.stat(localRoot).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error("本地目录不存在：" + localRoot);

  const config2 = Object.assign({}, config || {});
  const excludes = mergeExcludes(config2.excludes);
  const rules = buildIgnoreRules(excludes, config2.includes || []);
  const maxFileSize = Number(config2.maxFileSizeMB) > 0 ? Number(config2.maxFileSizeMB) * 1024 * 1024 : Infinity;

  const report = (phase, extra) => {
    if (typeof input.onProgress === "function") {
      try {
        input.onProgress(Object.assign({ phase }, extra || {}));
      } catch (_) {
        /* ignore */
      }
    }
  };

  report("local-scan");
  const local = await scanLocal(localRoot, {
    excludes,
    includes: config2.includes || [],
    maxFileSize,
    shouldCancel: input.shouldCancel,
    onProgress: (p) => report("local-scan", p),
  });

  report("remote-scan");
  const remote = await walkRemote(client, remoteRoot, {
    rules,
    shouldCancel: input.shouldCancel,
    onProgress: (p) => report("remote-scan", p),
  });

  // 远端根目录不存在：**自动建**，不再让用户先去网页上手动建一个目录。
  // 判定要严格：只有一条错误、错误发生在根（rel 为空 → 记作 "."）、且是 404。
  // 子目录 404 不算 —— 那是「扫描不全」，必须留着下面的安全阀。
  const rootMissing =
    remote.stats.errors.length === 1 &&
    remote.stats.errors[0].path === "." &&
    /404/.test(String(remote.stats.errors[0].error || ""));

  const records = (input.state && input.state.records) || {};
  const decided = decide({
    local: local.map,
    remote: remote.map,
    records,
    config: config2,
    deviceLabel: input.deviceLabel || "remote",
  });

  // 安全阀：远程扫描有目录失败时，**禁止任何删除**。
  // 扫描不全 → 大量文件看起来「云端没有」→ 双向同步会把本地全删掉。这是最贵的 bug。
  if (remote.stats.errors.length) {
    let downgraded = 0;
    for (let i = 0; i < decided.tasks.length; i++) {
      const t = decided.tasks[i];
      if (t.type === "remove-local" || t.type === "remove-remote") {
        decided.tasks[i] = {
          type: "skip",
          path: t.path,
          reason: "remote-scan-incomplete",
          detail: "有 " + remote.stats.errors.length + " 个云端目录读取失败，本次不执行删除",
        };
        downgraded++;
      }
    }
    if (downgraded) {
      decided.notes.push(
        rootMissing
          ? "云端目录是新建的，里面还没有东西，这次不做任何删除。"
          : "坚果云上有 " +
            remote.stats.errors.length +
            " 个文件夹没能读出来。为了不误删你的东西，这次会跳过 " +
            downgraded +
            " 个删除操作。过一会儿再试一次就好。",
      );
      decided.summary.deleteCount = 0;
    }
  }

  // 云端根目录还不存在 → 补一条「建根目录」任务，执行时 mkdirp 会一路把父级建好。
  // 必须排在任务最前面：目录要先用。path 为空串 = 就是 remoteRoot 本身。
  if (rootMissing) {
    decided.tasks.unshift({ type: "mkdir-remote", path: "", reason: "remote-root-missing" });
    decided.summary.mkdirRemote = (decided.summary.mkdirRemote || 0) + 1;
    decided.notes.push(
      "坚果云上还没有「" + (remoteRoot || "/") + "」这个目录，这次会自动建好再往里传。",
    );
  }

  // 给 pull 任务补上远程元数据（执行器写记录要用）
  for (const t of decided.tasks) {
    if (t.type === "pull") {
      const r = remote.map.get(t.path);
      if (r) t.remoteStat = { mtime: r.mtime, size: r.size };
    }
  }

  // ---- 请求量估算（坚果云免费版 600 次 / 30 分钟）----
  const s0 = decided.summary;
  const remoteScanReqs = remote.stats.propfinds || 0;
  const changeReqs = (s0.push || 0) + (s0.pull || 0) + (s0.mkdirRemote || 0) + (s0.removeRemote || 0);
  // push 之后按目录回填 mtime：最坏情况每个 push 落到不同目录
  const backfillReqs = Math.min(s0.push || 0, remote.stats.dirs + (s0.mkdirRemote || 0));
  const requestEstimate = remoteScanReqs + changeReqs + backfillReqs;
  const quota = require("./state").QUOTA;
  const freeLimit = quota.free.requestsPer30Min;
  const pct = Math.round((requestEstimate / freeLimit) * 100);

  if (requestEstimate > freeLimit) {
    decided.notes.push(
      "这次大概要访问坚果云 " +
        requestEstimate +
        " 次，超过免费用户「半小时 " +
        freeLimit +
        " 次」的上限（约 " +
        pct +
        "%）。可以这样处理：" +
        "① 先不要整个大文件夹一起同步，只挑要紧的子文件夹；" +
        "② 分几次同步，两次之间隔半小时；" +
        "③ 第一次先用坚果云官方客户端把文件传上去，之后本插件只做日常更新。",
    );
  } else if (requestEstimate > freeLimit * 0.8) {
    decided.notes.push(
      "这次大概要访问坚果云 " + requestEstimate + " 次，比较接近免费用户「半小时 " + freeLimit + " 次」的上限。如果中途失败，过半小时再试一次。",
    );
  }

  const plan = {
    planId: "plan-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
    at: new Date().toISOString(),
    localRoot,
    remoteRoot,
    config: {
      strategy: config2.strategy,
      conflictStrategy: config2.conflictStrategy,
      scanMode: config2.scanMode,
      maxFileSizeMB: config2.maxFileSizeMB,
      excludes,
      includes: config2.includes || [],
    },
    tasks: decided.tasks,
    conflicts: decided.conflicts || [],
    summary: Object.assign({}, decided.summary, {
      localFiles: local.stats.files,
      localDirs: local.stats.dirs,
      remoteFiles: remote.stats.files,
      remoteDirs: remote.stats.dirs,
      ignoredLocal: local.stats.ignored,
      ignoredRemote: remote.stats.ignored,
      tooLarge: local.stats.tooLarge,
      remoteErrors: remote.stats.errors.length,
      requestEstimate,
      requestQuota: freeLimit,
      requestPct: pct,
      scannedAt: new Date().toISOString(),
    }),
    notes: decided.notes,
  };

  savePlan(plan);
  return plan;
}

function savePlan(plan) {
  try {
    stateLib.atomicWrite(PLAN_FILE, JSON.stringify(plan));
  } catch (_) {
    /* 缓存失败不影响主流程 */
  }
  return plan;
}

function loadPlan() {
  try {
    const j = stateLib.readJson(PLAN_FILE, null);
    if (!j || !Array.isArray(j.tasks)) return null;
    const age = Date.now() - Date.parse(j.at);
    if (!Number.isFinite(age) || age > PLAN_TTL_MS) return null;
    return j;
  } catch (_) {
    return null;
  }
}

/** 把计划概括成一段人话（给聊天和面板头部用）。 */
function describe(plan) {
  const s = plan.summary || {};
  const lines = [];
  lines.push("策略：「" + (s.strategyLabel || s.strategy) + "」 扫描模式：" + (s.scanMode === "strict" ? "严格" : "宽松"));
  lines.push(
    "本地 " +
      (s.localFiles || 0) +
      " 个文件 / " +
      (s.localDirs || 0) +
      " 个目录；云端 " +
      (s.remoteFiles || 0) +
      " 个文件 / " +
      (s.remoteDirs || 0) +
      " 个目录",
  );
  lines.push(
    "待办 " +
      (s.changes || 0) +
      " 项：上传 " +
      (s.push || 0) +
      "，下载 " +
      (s.pull || 0) +
      "，建目录 " +
      ((s.mkdirRemote || 0) + (s.mkdirLocal || 0)) +
      "，删除 " +
      (s.deleteCount || 0) +
      (s.conflict ? "，冲突 " + s.conflict : "") +
      "，跳过 " +
      (s.skip || 0),
  );
  if (s.bytesUp || s.bytesDown) {
    lines.push("预计流量：↑" + fmtBytes(s.bytesUp) + " ↓" + fmtBytes(s.bytesDown));
  }
  if (s.requestEstimate) {
    const pct = s.requestPct || 0;
    lines.push(
      "预计请求：" +
        s.requestEstimate +
        " 次（免费版限额 " +
        s.requestQuota +
        " 次 / 30 分钟，约占 " +
        pct +
        "%）" +
        (pct > 80 ? "  ⚠️ 偏高" : ""),
    );
  }
  return lines.join("\n");
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + " MB";
  return (v / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

module.exports = { buildPlan, walkRemote, loadPlan, savePlan, describe, fmtBytes, remoteToRel, PLAN_TTL_MS, PLAN_FILE };
