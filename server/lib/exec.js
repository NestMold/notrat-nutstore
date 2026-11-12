"use strict";
/**
 * 任务执行器。
 *
 * 输入是 decide() 产出的 tasks（纯数据），输出是逐条执行结果 + 更新后的同步记录。
 * 这一层只做三件事：**做 IO、写记录、报进度**，任何决策都不要在这里做。
 *
 * 执行顺序（重要）：
 *   1) 所有 mkdir（父目录必须先存在，WebDAV/本地都不会自动建父目录）
 *   2) push / pull（两者互不影响，用并发池跑）
 *   3) remove（放最后：避免「先删了目录再往里写」）
 *
 * 记录（record）写入规则：
 *   - push 成功后**不能**立刻猜远程 mtime（WebDAV 返回的是服务器接收时间），
 *     先标记 pending，最后按目录批量 PROPFIND 回填 —— 否则下一轮会把刚上传的
 *     文件判成「云端变了」，反向把旧内容拉回来覆盖。
 *   - pull 成功后本地 mtime 是「写入时间」，按实际 stat 写；远程用规划阶段的 mtime。
 *   - remove 成功后删记录（否则下轮会以为文件被删了又拉回来）。
 *
 * 本文件是 notrat-nutstore 的一部分，按 AGPL-3.0 发布（全文见包内 LICENSE）。
 * 衍生自 nutstore/obsidian-nutstore-sync (AGPL-3.0)，原项目版权归其作者所有。
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { TASK } = require("./decide");
const { safeJoin } = require("./scan");
const { createLimiter, sleep } = require("./webdav");

function contentTypeOf(relPath) {
  const ext = path.extname(String(relPath)).toLowerCase();
  const map = {
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".ts": "text/plain; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
  };
  return map[ext] || "application/octet-stream";
}

/** 远程相对路径（相对 remoteRoot）。 */
function remotePathOf(remoteRoot, relPath) {
  const root = String(remoteRoot || "").replace(/^\/+|\/+$/g, "");
  const rel = String(relPath || "").replace(/^\/+/, "");
  return root ? (rel ? root + "/" + rel : root) : rel;
}

/**
 * @param {{
 *   client:any, localRoot:string, remoteRoot:string, tasks:Array,
 *   state:{records:object}, config:object,
 *   onProgress?:(p:object)=>void, shouldCancel?:()=>boolean,
 *   confirmDelete?:boolean, concurrency?:number
 * }} opts
 */
async function execute(opts) {
  const o = opts || {};
  const { client, localRoot, remoteRoot, state, config } = o;
  const tasks = Array.isArray(o.tasks) ? o.tasks : [];
  const records = state && state.records ? state.records : (state.records = {});
  const concurrency = Math.max(1, Math.min(8, o.concurrency || (config && config.concurrency) || 3));

  const deletes = tasks.filter((t) => t.type === TASK.REMOVE_LOCAL || t.type === TASK.REMOVE_REMOTE);
  if (deletes.length && !o.confirmDelete && !(config && config.autoDelete)) {
    return {
      ok: false,
      requiresConfirmation: true,
      message:
        "计划里有 " +
        deletes.length +
        " 个删除动作，默认不自动执行。确认后重跑并带 confirmDelete:true（或在设置里打开「允许自动删除」）。",
      deleteSample: deletes.slice(0, 10).map((d) => ({ type: d.type, path: d.path })),
    };
  }

  const result = {
    ok: true,
    startedAt: new Date().toISOString(),
    executed: 0,
    pushed: 0,
    pulled: 0,
    removedLocal: 0,
    removedRemote: 0,
    mkdirLocal: 0,
    mkdirRemote: 0,
    skipped: 0,
    bytesUp: 0,
    bytesDown: 0,
    failed: [],
    cancelled: false,
  };

  /** 取消：只设标志，不抛异常 —— 抛出去会把已完成进度一起丢掉。 */
  const cancelCheck = () => {
    if (typeof o.shouldCancel === "function" && o.shouldCancel()) {
      result.cancelled = true;
      return false;
    }
    return true;
  };

  const total = tasks.length;
  let index = 0;
  const tick = (task, status, extra) => {
    index++;
    if (typeof o.onProgress === "function") {
      try {
        o.onProgress(
          Object.assign({ index, total, path: task.path, type: task.type, status }, extra || {}),
        );
      } catch (_) {
        /* 面板报错不影响同步 */
      }
    }
    // 每个已完成的任务都可能是「本轮唯一进展」，落一次盘
    checkpoint();
  };

  const dirsToStat = new Set();

  /**
   * 检查点：把内存里的同步记录周期性刷到磁盘。
   *
   * 为什么必须有它：records 是「上次同步时两端长什么样」的祖先快照，下一轮全靠它
   * 判断该推还是该拉。原先只在 ns_run 整轮结束、成功返回之后才 saveState 一次，
   * 于是任何中途中断（配额 429、断网、进程被杀、用户取消）都会**整轮记录一起丢**：
   * 那一轮已经成功上传的文件，下一轮全被当成「从没同步过」重新上传。
   * 结果是每一轮都在重做上一轮的活，大目录永远推不到 100%。
   *
   * 节流 1.2s：state.json 在万级文件时可达数 MB，逐文件写盘会拖慢同步本身。
   */
  let lastCheckpointMs = 0;
  const checkpoint = (force) => {
    if (typeof o.onCheckpoint !== "function") return;
    const nowMs = Date.now();
    if (!force && nowMs - lastCheckpointMs < 1200) return;
    lastCheckpointMs = nowMs;
    try {
      o.onCheckpoint();
    } catch (_) {
      /* 落盘失败不能打断同步，但也不能静默吞掉整轮：调用方 finally 里还会再写一次 */
    }
  };

  /* ---------- 1) mkdir ---------- */
  for (const t of tasks) {
    if (t.type !== TASK.MKDIR_LOCAL && t.type !== TASK.MKDIR_REMOTE) continue;
    if (!cancelCheck()) break;
    try {
      if (t.type === TASK.MKDIR_LOCAL) {
        await fsp.mkdir(safeJoin(localRoot, t.path), { recursive: true });
        result.mkdirLocal++;
      } else {
        await client.mkdirp(remotePathOf(remoteRoot, t.path));
        result.mkdirRemote++;
      }
      result.executed++;
      tick(t, "ok");
    } catch (e) {
      result.failed.push({ type: t.type, path: t.path, error: String((e && e.message) || e) });
      result.ok = false;
      tick(t, "error", { error: String((e && e.message) || e) });
    }
    if (config && config.minGapMs) await sleep(config.minGapMs);
  }

  /* ---------- 2) push / pull ---------- */
  const limit = createLimiter(concurrency);
  const fileTasks = tasks.filter((t) => t.type === TASK.PUSH || t.type === TASK.PULL);

  await Promise.all(
    fileTasks.map((t) =>
      limit(async () => {
        if (result.cancelled) return;
        if (typeof o.shouldCancel === "function" && o.shouldCancel()) {
          result.cancelled = true;
          return;
        }
        const fullRemote = remotePathOf(remoteRoot, t.path);
        try {
          if (t.type === TASK.PUSH) {
            const abs = safeJoin(localRoot, t.path);
            const st = await fsp.lstat(abs);
            if (st.isDirectory()) throw new Error("这是目录，不能当文件上传");
            const buf = await fsp.readFile(abs);
            await client.put(fullRemote, buf, contentTypeOf(t.path));
            result.pushed++;
            result.bytesUp += buf.length;
            // 远程 mtime 先不猜，标记目录待回填
            dirsToStat.add(String(t.path).split("/").slice(0, -1).join("/"));
            records[t.path] = Object.assign({}, records[t.path], {
              localMtime: Math.floor(st.mtimeMs),
              localSize: st.size,
              remoteMtime: 0,
              remoteSize: buf.length,
              syncedAt: new Date().toISOString(),
              pendingRemoteStat: true,
            });
          } else {
            // pull：dest 存在时写到冲突副本，不覆盖原名
            const destRel = t.dest || t.path;
            const buf = await client.get(fullRemote);
            const absDest = safeJoin(localRoot, destRel);
            await fsp.mkdir(path.dirname(absDest), { recursive: true });
            await writeFileAtomic(absDest, buf);
            const st = await fsp.lstat(absDest);
            result.pulled++;
            result.bytesDown += buf.length;
            const planRemote = t.remoteStat || {};
            if (!t.dest) {
              records[t.path] = Object.assign({}, records[t.path], {
                localMtime: Math.floor(st.mtimeMs),
                localSize: st.size,
                remoteMtime: Number(planRemote.mtime) || 0,
                remoteSize: Number(planRemote.size) || buf.length,
                syncedAt: new Date().toISOString(),
              });
            } else {
              // 冲突副本**故意不写同步记录**：它此刻只是「本地新文件」，下一轮会作为
              // local-only 正常上传。写记录会让它被当成「曾同步过、云端已删」而删掉。
              delete records[destRel];
            }
          }
          result.executed++;
          tick(t, "ok", { bytes: result.bytesUp + result.bytesDown });
        } catch (e) {
          const msg = String((e && e.message) || e);
          result.failed.push({ type: t.type, path: t.path, error: msg });
          result.ok = false;
          tick(t, "error", { error: msg });
        }
      }),
    ),
  );

  /* ---------- 3) remove ---------- */
  for (const t of tasks) {
    if (t.type !== TASK.REMOVE_LOCAL && t.type !== TASK.REMOVE_REMOTE) continue;
    if (!cancelCheck()) break;
    try {
      if (t.type === TASK.REMOVE_LOCAL) {
        await fsp.rm(safeJoin(localRoot, t.path), { force: true, recursive: false });
        result.removedLocal++;
      } else {
        await client.remove(remotePathOf(remoteRoot, t.path));
        result.removedRemote++;
      }
      delete records[t.path];
      result.executed++;
      tick(t, "ok");
    } catch (e) {
      result.failed.push({ type: t.type, path: t.path, error: String((e && e.message) || e) });
      result.ok = false;
      tick(t, "error", { error: String((e && e.message) || e) });
    }
  }

  /* ---------- 4) 批量回填远程 mtime ---------- */
  // 上一轮被中断时留下的 pendingRemoteStat 记录：remoteMtime 是哨兵 0。
  // 不补真实 mtime，下一轮 changesOf 会拿 0 跟真实值比，必然判成「云端变了」，
  // 于是把本机刚上传的文件反向拉回来覆盖本地 —— 续传就在原地打转。
  // 这里把它们所在的目录一并纳入回填范围，让下一轮恢复正常判断。
  const pendingDirs = new Set();
  for (const [rel, rec] of Object.entries(records)) {
    if (rec && rec.pendingRemoteStat) pendingDirs.add(String(rel).split("/").slice(0, -1).join("/"));
  }
  // 目录数上限：每个目录一次 PROPFIND，放任涨会自己把配额吃光。
  // 超出就先补 200 个目录，剩下的下一轮继续（记录仍在，别的地方不会误判成丢失）。
  let pendingSkipped = 0;
  if (pendingDirs.size > 200) {
    const keep = [...pendingDirs].slice(0, 200);
    pendingSkipped = pendingDirs.size - keep.length;
    pendingDirs.clear();
    for (const d of keep) pendingDirs.add(d);
  }
  for (const d of pendingDirs) dirsToStat.add(d);

  result.statBackfilled = await backfillRemoteStats(client, remoteRoot, records, dirsToStat);
  if (pendingSkipped) result.statBackfilled.pendingSkipped = pendingSkipped;
  checkpoint(true);

  // 跳过任务只报数
  result.skipped = tasks.filter((t) => t.type === TASK.SKIP).length;
  result.finishedAt = new Date().toISOString();
  if (result.failed.length) result.ok = false;
  return result;
}

/** push 之后按目录做一次 Depth 1，把真实远程 mtime/size 写回记录。 */
async function backfillRemoteStats(client, remoteRoot, records, dirs) {
  if (!dirs || dirs.size === 0) return { dirs: 0, files: 0 };
  let files = 0;
  let dirsDone = 0;
  for (const dir of dirs) {
    try {
      const items = await client.list(remotePathOf(remoteRoot, dir));
      const prefix = String(dir || "").replace(/^\/+|\/+$/g, "");
      for (const it of items) {
        if (it.isDir) continue;
        // it.path 是相对 endpoint 根的路径，要转回相对 remoteRoot
        const rel = remoteToRel(remoteRoot, it.path);
        if (!rel) continue;
        const rec = records[rel];
        if (!rec || !rec.pendingRemoteStat) continue;
        rec.remoteMtime = it.mtime;
        rec.remoteSize = it.size;
        rec.pendingRemoteStat = false;
        files++;
      }
      dirsDone++;
    } catch (e) {
      // 回填失败不致命：下轮这些文件会被判成「云端变了」而多拉一次，
      // 但因为有 size/mtime 兜底，不会丢数据。日志由调用方记。
      void e;
    }
  }
  return { dirs: dirsDone, files, unchecked: dirs.size - dirsDone };
}

function remoteToRel(remoteRoot, itemPath) {
  const root = String(remoteRoot || "").replace(/^\/+|\/+$/g, "");
  const p = String(itemPath || "").replace(/^\/+|\/+$/g, "");
  if (!root) return p;
  if (p === root) return "";
  if (!p.startsWith(root + "/")) return null;
  return p.slice(root.length + 1);
}

/** 原子写本地文件（先写 .part 再 rename，避免中断留下半个文件）。 */
async function writeFileAtomic(absPath, buffer) {
  const dir = path.dirname(absPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = absPath + ".part-" + process.pid + "-" + Date.now();
  await fsp.writeFile(tmp, buffer);
  try {
    await fsp.rename(tmp, absPath);
  } catch (e) {
    try {
      await fsp.unlink(tmp);
    } catch (_) {
      /* ignore */
    }
    throw e;
  }
}

module.exports = { execute, backfillRemoteStats, remotePathOf, remoteToRel, writeFileAtomic, contentTypeOf };
