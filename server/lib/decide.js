"use strict";
/**
 * 同步决策引擎 —— 纯函数，不做任何 IO。
 *
 * 迁移自 obsidian-nutstore-sync 的 5 个 decider（two-way / send-only /
 * send-only-override-changes / receive-only / receive-only-revert-local-changes），
 * 但把「读 Vault / 读 WebDAV」全部提前到调用方（plan.js），这里只吃三张表：
 *
 *   local  : Map<relPath, {isDir,size,mtime}>
 *   remote : Map<relPath, {isDir,size,mtime}>
 *   records: { relPath: {localMtime,localSize,remoteMtime,remoteSize,syncedAt} }
 *
 * 判定依据（与参考实现一致）：
 *   - 远程只能靠元数据（mtime/size）判断，因为规划阶段不下载内容；
 *   - 本地在 strict 模式下看 mtime+size，在 loose 模式下 size 相同即视为未变
 *     （大型目录扫描优先速度；loose 也是坚果云插件的默认）；
 *   - 时间比较必须容忍秒级误差（WebDAV 的 getlastmodified 只到秒）。
 *
 * 安全原则：
 *   - 首次接入（两端都有但无同步记录）在 two-way 下判为 conflict，**不静默覆盖**；
 *   - 删除只在明确的方向里发生；两端都改过且要删 → 一律当 conflict；
 *   - 任何「覆盖另一端」的动作都必须能被 plan 预览到。
 *
 * 本文件是 notrat-nutstore 的一部分，按 AGPL-3.0 发布（全文见包内 LICENSE）。
 * 衍生自 nutstore/obsidian-nutstore-sync (AGPL-3.0)，原项目版权归其作者所有。
 */

const MTIME_TOLERANCE_MS = 2000;
/**
 * strict 模式的容差。
 * 坚果云 WebDAV 的 getlastmodified 只到秒，所以不能要求 0 容差 ——
 * 否则每个文件都会被判成「改过」。留 1 秒刚好卡在秒级精度上：
 * 同一秒内的改动仍视为未变，跨秒即视为改动。
 */
const MTIME_TOLERANCE_STRICT_MS = 1000;

const TASK = {
  PUSH: "push",
  PULL: "pull",
  MKDIR_LOCAL: "mkdir-local",
  MKDIR_REMOTE: "mkdir-remote",
  REMOVE_LOCAL: "remove-local",
  REMOVE_REMOTE: "remove-remote",
  CONFLICT: "conflict",
  SKIP: "skip",
};

const STRATEGY_LABEL = {
  "two-way": "双向同步",
  "send-only": "仅发送",
  "send-only-override-changes": "仅发送（覆盖云端）",
  "receive-only": "仅接收",
  "receive-only-revert-local-changes": "仅接收（还原本地）",
};

const CONFLICT_LABEL = {
  "no-conflict-merge": "保留双方（远端另存冲突副本）",
  diff3: "三方合并（无基线时退化为保留双方）",
  "local-priority": "本地优先（覆盖远端）",
  "server-priority": "云端优先（覆盖本地）",
};

/**
 * 时间是否可视为同一时刻。
 * @param {number} a 毫秒时间戳
 * @param {number} b 毫秒时间戳
 * @param {number} [tol] 容差（毫秒），默认 MTIME_TOLERANCE_MS；strict 传 MTIME_TOLERANCE_STRICT_MS
 */
function sameTime(a, b, tol) {
  const x = Number(a) || 0;
  const y = Number(b) || 0;
  if (x === 0 || y === 0) return false;
  const limit = Number.isFinite(Number(tol)) ? Number(tol) : MTIME_TOLERANCE_MS;
  return Math.abs(x - y) <= limit;
}

/** 文件名是否在 Windows 上非法（远程文件要落到本地时必须拦）。 */
function hasInvalidName(relPath) {
  const name = String(relPath).split("/").pop() || "";
  if (!name) return true;
  if (/[<>:"|?*]/.test(name)) return true;
  if (/[\x00-\x1f]/.test(name)) return true;
  if (/[ .]$/.test(name)) return true;
  // Windows 保留名
  const base = name.split(".")[0].toUpperCase();
  const reserved = new Set([
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
  ]);
  return reserved.has(base);
}

/**
 * 判断两端是否「都没变」。
 * @param {'loose'|'strict'} scanMode
 */
function changesOf(local, remote, record, scanMode) {
  const loose = scanMode !== "strict";
  let localChanged;
  if (!record) {
    localChanged = true; // 无记录 = 首次见到
  } else if (loose) {
    // loose 原先只看 size：size 不变就判「没变」。多机场景下这是静默丢数据 ——
    // 把 "1" 改成 "2" 字节数不变，另一台机器永远收不到；更糟的是「双方都改」
    // 会被误判成「只有云端改」，于是直接 pull 覆盖本地。
    // 所以 loose 也必须看 mtime，只是容差更宽（吃掉 touch / 工具重写的时间戳抖动）。
    localChanged =
      Number(local.size) !== Number(record.localSize) || !sameTime(local.mtime, record.localMtime);
  } else {
    localChanged =
      Number(local.size) !== Number(record.localSize) || !sameTime(local.mtime, record.localMtime, MTIME_TOLERANCE_STRICT_MS);
  }
  let remoteChanged;
  if (!record) {
    remoteChanged = true; // 无记录 = 首次见到
  } else if (record.pendingRemoteStat) {
    // 本机刚上传、还没来得及回填真实远程 mtime：record.remoteMtime 此刻是哨兵 0。
    // 拿 0 跟真实 mtime 比必然「变了」，会把刚上传的文件反向拉回来覆盖
    // —— 断点续传就变成原地打转（推 500 再拉回 500，净进展为零）。
    // 这些文件的内容就是本机刚才推上去的那份，所以只按 size 判断；
    // 真实 mtime 由 exec 的回填步骤补齐后这个分支自动失效。
    remoteChanged = Number(remote.size) !== Number(record.remoteSize);
  } else {
    remoteChanged =
      Number(remote.size) !== Number(record.remoteSize) ||
      !sameTime(remote.mtime, record.remoteMtime);
  }
  return { localChanged, remoteChanged };
}

/** 冲突副本名：`name.conflict-<label>-<ts>.ext`。 */
function conflictCopyPath(relPath, label, ts) {
  const parts = String(relPath).split("/");
  const name = parts.pop() || "";
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const safeLabel = String(label || "remote").replace(/[^\w.-]+/g, "-").slice(0, 24);
  const stamp = (ts || new Date()).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const copy = stem + ".conflict-" + safeLabel + "-" + stamp + ext;
  parts.push(copy);
  return parts.join("/");
}

/**
 * 主决策。
 * @param {{
 *   local: Map<string,object>, remote: Map<string,object>,
 *   records: object, config: object, deviceLabel?: string, now?: Date
 * }} input
 * @returns {{tasks:Array, summary:object, notes:string[]}}
 */
function decide(input) {
  const { local, remote, records } = input;
  const config = input.config || {};
  const strategy = config.strategy || "two-way";
  const conflictStrategy = config.conflictStrategy || "no-conflict-merge";
  const scanMode = config.scanMode || "loose";
  const maxFileSize =
    Number(config.maxFileSizeMB) > 0 ? Number(config.maxFileSizeMB) * 1024 * 1024 : Infinity;
  const label = input.deviceLabel || "remote";
  const now = input.now || new Date();

  const tasks = [];
  const notes = [];
  const localMap = local instanceof Map ? local : new Map(Object.entries(local || {}));
  const remoteMap = remote instanceof Map ? remote : new Map(Object.entries(remote || {}));
  const recs = records || {};

  const push = (t) => tasks.push(t);
  const allPaths = new Set([...localMap.keys(), ...remoteMap.keys(), ...Object.keys(recs)]);

  const tooLarge = (l, r) =>
    (l && l.size > maxFileSize) || (r && r.size > maxFileSize);

  const skipLarge = (path, l, r) =>
    push({
      type: TASK.SKIP,
      path,
      reason: "file-too-large",
      detail: "超过 " + Math.round(maxFileSize / 1024 / 1024) + " MB 上限",
      localSize: l ? l.size : undefined,
      remoteSize: r ? r.size : undefined,
    });

  /** 西向（本地→远端）允许的动作。 */
  const westAllowed = (s) =>
    s === "two-way" || s === "send-only" || s === "send-only-override-changes";
  /** 东向（远端→本地）允许的动作。 */
  const eastAllowed = (s) =>
    s === "two-way" || s === "receive-only" || s === "receive-only-revert-local-changes";
  /** 「另一端没有就删」的镜像语义。 */
  const mirrorToRemote = (s) => s === "send-only-override-changes";
  const mirrorToLocal = (s) => s === "receive-only-revert-local-changes";

  // 先处理目录：只建不删（空目录残留比误删安全）
  for (const path of allPaths) {
    const l = localMap.get(path);
    const r = remoteMap.get(path);
    const lDir = !!(l && l.isDir);
    const rDir = !!(r && r.isDir);
    if (lDir && !rDir && !r) {
      if (westAllowed(strategy)) push({ type: TASK.MKDIR_REMOTE, path, reason: "local-only-dir" });
      continue;
    }
    if (rDir && !lDir && !l) {
      if (eastAllowed(strategy)) push({ type: TASK.MKDIR_LOCAL, path, reason: "remote-only-dir" });
      else if (mirrorToRemote(strategy)) {
        push({ type: TASK.SKIP, path, reason: "remote-only-dir-kept", detail: "镜像模式下空目录不删" });
      }
      continue;
    }
  }

  for (const path of allPaths) {
    const l = localMap.get(path);
    const r = remoteMap.get(path);
    if ((l && l.isDir) || (r && r.isDir)) continue; // 目录已在上面处理
    const record = recs[path];
    const localExists = !!l;
    const remoteExists = !!r;

    // 两端都不在：清记录
    if (!localExists && !remoteExists) {
      if (record) push({ type: TASK.SKIP, path, reason: "both-missing-drop-record" });
      continue;
    }

    // ① 两端都在
    if (localExists && remoteExists) {
      // 首次接入但两端完全一致：不该报冲突，静默记一条记录即可
      if (!record && Number(l.size) === Number(r.size) && sameTime(l.mtime, r.mtime)) {
        push({ type: TASK.SKIP, path, reason: "identical-new" });
        continue;
      }
      const { localChanged, remoteChanged } = changesOf(l, r, record, scanMode);

      if (!localChanged && !remoteChanged) {
        push({ type: TASK.SKIP, path, reason: "unchanged" });
        continue;
      }
      if (tooLarge(l, r)) {
        skipLarge(path, l, r);
        continue;
      }
      if (localChanged && remoteChanged) {
        push(conflictTask(path, l, r, conflictStrategy, label, now));
        continue;
      }
      if (localChanged) {
        if (westAllowed(strategy)) push({ type: TASK.PUSH, path, reason: "local-changed" });
        else push({ type: TASK.SKIP, path, reason: "local-changed-kept", detail: "当前策略不推送本地改动" });
        continue;
      }
      // 只有远程变了
      if (eastAllowed(strategy)) push({ type: TASK.PULL, path, reason: "remote-changed" });
      else push({ type: TASK.SKIP, path, reason: "remote-changed-kept", detail: "当前策略不拉取云端改动" });
      continue;
    }

    // ② 只有本地有
    if (localExists && !remoteExists) {
      if (tooLarge(l, null)) {
        skipLarge(path, l, null);
        continue;
      }
      if (!record) {
        // 远端从未有过
        if (westAllowed(strategy)) {
          push({ type: TASK.PUSH, path, reason: "local-only" });
        } else if (mirrorToLocal(strategy)) {
          push({ type: TASK.REMOVE_LOCAL, path, reason: "local-only-mirror-to-remote", localSize: l.size });
        } else {
          push({ type: TASK.SKIP, path, reason: "local-only-kept" });
        }
        continue;
      }
      // 记录存在 → 远端被删
      if (mirrorToRemote(strategy) || strategy === "send-only" || strategy === "two-way") {
        if (strategy === "two-way") {
          const localChanged = changesOf(l, { size: record.remoteSize, mtime: record.remoteMtime }, record, scanMode).localChanged;
          if (localChanged) {
            // 本地改过而云端删了 → 保守：当冲突（保留本地并推回去）
            push(conflictTask(path, l, null, conflictStrategy, label, now, "remote-deleted-local-changed"));
          } else {
            push({ type: TASK.REMOVE_LOCAL, path, reason: "remote-deleted", localSize: l.size });
          }
        } else if (strategy === "send-only") {
          push({ type: TASK.PUSH, path, reason: "restore-to-remote", detail: "本地这份推回云端" });
        } else {
          push({ type: TASK.PUSH, path, reason: "mirror-to-remote" });
        }
        continue;
      }
      if (mirrorToLocal(strategy)) {
        push({ type: TASK.REMOVE_LOCAL, path, reason: "local-only-mirror", localSize: l.size });
        continue;
      }
      push({ type: TASK.SKIP, path, reason: "local-kept" });
      continue;
    }

    // ③ 只有远端有
    if (!localExists && remoteExists) {
      if (tooLarge(null, r)) {
        skipLarge(path, null, r);
        continue;
      }
      if (hasInvalidName(path)) {
        push({
          type: TASK.SKIP,
          path,
          reason: "invalid-filename",
          detail: "文件名在 Windows 上非法，无法落到本地",
        });
        continue;
      }
      if (!record) {
        if (eastAllowed(strategy)) {
          push({ type: TASK.PULL, path, reason: "remote-only" });
        } else if (mirrorToRemote(strategy)) {
          push({ type: TASK.REMOVE_REMOTE, path, reason: "remote-only-mirror", remoteSize: r.size });
        } else {
          push({ type: TASK.SKIP, path, reason: "remote-only-kept" });
        }
        continue;
      }
      // 记录存在 → 本地被删。方向由策略决定，但「云端这条改过没有」优先：
      // 云端改过就绝不能在双向里直接删本地/删云端，否则必丢数据。
      const remoteChanged =
        Number(r.size) !== Number(record.remoteSize) || !sameTime(r.mtime, record.remoteMtime);
      const restore = () =>
        push({
          type: TASK.PULL,
          path,
          reason: remoteChanged ? "local-deleted-remote-changed-restore" : "local-deleted-restore",
        });

      if (strategy === "two-way") {
        if (remoteChanged) {
          notes.push(
            "「" + path + "」本地已删除但云端有改动，已保留云端版本（拉回本地），避免丢失云端修改。",
          );
          restore();
        } else {
          push({ type: TASK.REMOVE_REMOTE, path, reason: "local-deleted", remoteSize: r.size });
        }
        continue;
      }
      if (mirrorToRemote(strategy)) {
        push({ type: TASK.REMOVE_REMOTE, path, reason: "mirror-to-remote", remoteSize: r.size });
        continue;
      }
      if (strategy === "send-only") {
        if (remoteChanged) {
          push({
            type: TASK.SKIP,
            path,
            reason: "remote-changed-kept",
            detail: "本地已删但云端改过，保留云端",
          });
        } else {
          push({ type: TASK.REMOVE_REMOTE, path, reason: "local-deleted", remoteSize: r.size });
        }
        continue;
      }
      // receive-only / receive-only-revert-local-changes：云端为主 → 拉回
      restore();
      continue;
    }
  }

  // 冲突策略 → 具体任务
  const finalTasks = [];
  for (const t of tasks) {
    if (t.type !== TASK.CONFLICT) {
      finalTasks.push(t);
      continue;
    }
    const cs = t.conflictStrategy;
    const remoteMissing = t.remoteSize == null;
    if (remoteMissing) {
      // 云端这份已经不存在（本地改过、云端删过）——只能把本地推回去
      notes.push("「" + t.path + "」云端已删除但本地有改动，保留本地并推回云端。");
      finalTasks.push({ type: TASK.PUSH, path: t.path, reason: "conflict-remote-missing-push-local" });
      continue;
    }
    if (cs === "local-priority") {
      finalTasks.push({
        type: TASK.PUSH,
        path: t.path,
        reason: "conflict-local-priority",
        conflictFrom: t.reason,
      });
    } else if (cs === "server-priority") {
      finalTasks.push({
        type: TASK.PULL,
        path: t.path,
        reason: "conflict-server-priority",
        conflictFrom: t.reason,
      });
    } else if (cs === "diff3") {
      // 没有基线内容时无法真正三方合并 → 明确降级为「保留双方」
      notes.push(
        "「" + t.path + "」使用三方合并，但本插件未保存基线内容，已降级为保留双方（云端副本另存）。",
      );
      finalTasks.push(
        {
          type: TASK.PULL,
          path: t.path,
          dest: t.copyPath,
          reason: "conflict-keep-both-remote-copy",
          conflictFrom: t.reason,
        },
        { type: TASK.PUSH, path: t.path, reason: "conflict-keep-both-push-local" },
      );
    } else {
      finalTasks.push(
        {
          type: TASK.PULL,
          path: t.path,
          dest: t.copyPath,
          reason: "conflict-keep-both-remote-copy",
          conflictFrom: t.reason,
        },
        { type: TASK.PUSH, path: t.path, reason: "conflict-keep-both-push-local" },
      );
    }
  }

  const conflicts = tasks.filter((t) => t.type === TASK.CONFLICT);
  const summary = summarize(finalTasks);
  // 冲突在展开阶段被拆成 pull+push，统计要按「展开前」的数量算，否则永远是 0
  summary.conflict = conflicts.length;
  summary.strategy = strategy;
  summary.strategyLabel = STRATEGY_LABEL[strategy] || strategy;
  summary.conflictStrategy = conflictStrategy;
  summary.scanMode = scanMode;
  summary.localOnly = [...localMap.keys()].filter((p) => !remoteMap.has(p)).length;
  summary.remoteOnly = [...remoteMap.keys()].filter((p) => !localMap.has(p)).length;

  return { tasks: finalTasks, summary, notes, conflicts };
}

function conflictTask(path, local, remote, conflictStrategy, label, now, reason) {
  return {
    type: TASK.CONFLICT,
    path,
    reason: reason || "both-changed",
    conflictStrategy,
    copyPath: conflictCopyPath(path, label, now),
    localSize: local ? local.size : undefined,
    remoteSize: remote ? remote.size : undefined,
  };
}

function summarize(tasks) {
  const s = {
    total: tasks.length,
    push: 0,
    pull: 0,
    mkdirRemote: 0,
    mkdirLocal: 0,
    removeRemote: 0,
    removeLocal: 0,
    conflict: 0,
    skip: 0,
    bytesUp: 0,
    bytesDown: 0,
    deleteCount: 0,
  };
  for (const t of tasks) {
    switch (t.type) {
      case TASK.PUSH:
        s.push++;
        s.bytesUp += Number(t.localSize) || 0;
        break;
      case TASK.PULL:
        s.pull++;
        s.bytesDown += Number(t.remoteSize) || 0;
        break;
      case TASK.MKDIR_REMOTE:
        s.mkdirRemote++;
        break;
      case TASK.MKDIR_LOCAL:
        s.mkdirLocal++;
        break;
      case TASK.REMOVE_REMOTE:
        s.removeRemote++;
        s.deleteCount++;
        break;
      case TASK.REMOVE_LOCAL:
        s.removeLocal++;
        s.deleteCount++;
        break;
      case TASK.CONFLICT:
        s.conflict++;
        break;
      case TASK.SKIP:
        s.skip++;
        break;
      default:
        break;
    }
  }
  s.changes = s.push + s.pull + s.mkdirRemote + s.mkdirLocal + s.removeRemote + s.removeLocal;
  return s;
}

module.exports = {
  decide,
  summarize,
  changesOf,
  sameTime,
  hasInvalidName,
  conflictCopyPath,
  TASK,
  STRATEGY_LABEL,
  CONFLICT_LABEL,
  MTIME_TOLERANCE_MS,
  MTIME_TOLERANCE_STRICT_MS,
};
