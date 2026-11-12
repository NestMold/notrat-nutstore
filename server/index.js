#!/usr/bin/env node
/**
 * notrat-nutstore MCP server —— 坚果云（WebDAV）同步。
 *
 * 迁移自 obsidian-nutstore-sync：保留它的 5 种同步策略、4 种冲突策略、同步记录
 * 三方比对、路径过滤、大文件跳过；把「Obsidian 的 Vault / 设置面板 / 渲染进程」
 * 换成「Notrat 的本地目录 / manifest settings / MCP 工具 + React 面板」。
 *
 * 协议：stdio + 换行分隔的 JSON-RPC 2.0，零依赖手写实现（与仓库其它插件一致）。
 * stdout 只许走协议，日志一律 stderr。
 *
 * 工具分层：
 *   配置层  ns_config / ns_test / ns_ls
 *   规划层  ns_plan / ns_conflicts
 *   执行层  ns_run / ns_job / ns_cancel / ns_resolve
 *   观测层  ns_status / ns_log
 *   说明层  ns_guide
 *
 * 本文件是 notrat-nutstore 的一部分，按 AGPL-3.0 发布（全文见包内 LICENSE）。
 * 衍生自 nutstore/obsidian-nutstore-sync (AGPL-3.0)，原项目版权归其作者所有。
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const stateLib = require("./lib/state");
const { WebDAVClient, WebDAVError } = require("./lib/webdav");
const planLib = require("./lib/plan");
const execLib = require("./lib/exec");
const { TASK, STRATEGY_LABEL, CONFLICT_LABEL } = require("./lib/decide");

const PLUGIN_ID = "notrat-nutstore";
/** 版本号以 manifest 为准，别在 server 里另写一份（两份对不上时排查会绕路）。 */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")).version || "0.0.0";
  } catch (_) {
    return "0.0.0";
  }
})();
const log = (...a) => process.stderr.write("[" + PLUGIN_ID + "] " + a.join(" ") + "\n");

/**
 * 进程级兜底。
 *
 * MCP server 是被宿主当子进程拉起的：**进程一死，正在等结果的调用就永久挂住**
 * （面板永远显示「测试中…」），而宿主拿不到任何错误信息。
 * 原则：宁可活着带伤，也不要静默死掉 —— 记录堆栈，继续服务后续请求。
 */
process.on("unhandledRejection", (e) => {
  log("unhandledRejection: " + ((e && e.stack) || e));
});
process.on("uncaughtException", (e) => {
  log("uncaughtException: " + ((e && e.stack) || e));
});

/* ------------------------------ 运行时状态 ------------------------------ */

/** 后台任务（同一时刻只允许一个，避免两个同步互相踩记录）。 */
const JOB = {
  id: null,
  running: false,
  cancel: false,
  startedAt: "",
  phase: "idle",
  progress: null,
  result: null,
  error: null,
  planId: null,
};

function newJobId() {
  return "job-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}

function clientFromConfig(cfg, overrides) {
  return new WebDAVClient(
    Object.assign(
      {
        baseUrl: cfg.baseUrl,
        username: cfg.username,
        password: cfg.password,
        concurrency: cfg.concurrency,
        minGapMs: cfg.minGapMs,
      },
      overrides || {},
    ),
  );
}

/**
 * 连接测试专用客户端。
 *
 * 默认超时 45s + 3 次退避重试，对「同步大批文件」是合理的，对「点一下测连接」是灾难：
 * 用户要盯着转圈两分钟。这里改成 12 秒 + 不重试 —— 连不上就立刻说清楚。
 */
function probeClient(cfg, overrides) {
  return clientFromConfig(
    cfg,
    Object.assign({ timeoutMs: 12000, retries: 0 }, overrides || {}),
  );
}

function requireConfigured(cfg) {
  if (!cfg.username || !cfg.password) {
    const err = new Error(
      "还没配置坚果云账号。请先在「坚果云同步」面板填：账号（邮箱）+ 第三方应用密码" +
        "（坚果云网页版 → 账户信息 → 安全选项 → 添加应用密码），服务地址默认 https://dav.jianguoyun.com/dav。",
    );
    err.code = "NOT_CONFIGURED";
    throw err;
  }
}

function resolveLocalRoot(args) {
  const cfg = stateLib.loadConfig();
  const candidate =
    (args && (args.localRoot || args.local_root)) ||
    (args && args.workspace) ||
    cfg.lastLocalRoot ||
    "";
  const root = String(candidate || "").trim();
  if (!root) {
    throw new Error("没指定本地目录。请传 localRoot（例如当前工作区路径）。");
  }
  return path.resolve(root);
}

function rememberLocalRoot(root) {
  try {
    stateLib.saveConfig({ lastLocalRoot: path.resolve(root) });
  } catch (_) {
    /* 记不住也不影响同步 */
  }
}

/* --------------------------------- 工具 --------------------------------- */

const tools = {
  /* ---- 说明 ---- */
  ns_guide: {
    desc:
      "坚果云同步的使用指引：第一次怎么配置、五种同步策略怎么选、冲突怎么处理、出问题怎么排查。用户问「怎么用/同步是什么意思/该选哪个策略」时先调它。",
    args: {},
    run: () => ({
      ok: true,
      title: "坚果云同步（Notrat）",
      what: "把当前工作区（或任意本地目录）与坚果云 WebDAV 目录做增量同步，支持双向 / 单向备份 / 镜像。",
      setup: [
        "1) 在坚果云网页版「账户信息 → 安全选项 → 添加应用密码」生成一个第三方应用密码（不是登录密码）。",
        "2) 在面板「账号」里填：账号（坚果云登录邮箱）、应用密码；服务地址默认 https://dav.jianguoyun.com/dav（企业版改成自己的）。",
        "3) 点「测试连接」——能列出你的云端目录就说明通了。",
        "4) 填「云端目录」（如 notrat/我的笔记，留空=云端根目录），先点「预演」看计划，再点「同步」。",
      ],
      strategies: [
        { id: "two-way", name: "双向同步", when: "多设备日常使用：两边的新增/修改/删除都会同步" },
        { id: "send-only", name: "仅发送", when: "本地为主，云端只做备份；云端独有的文件不会被删" },
        { id: "send-only-override-changes", name: "仅发送（覆盖云端）", when: "本地是唯一主副本，云端多余的文件会被删掉" },
        { id: "receive-only", name: "仅接收", when: "云端为主，本地只收不改；本地独有的文件保留" },
        { id: "receive-only-revert-local-changes", name: "仅接收（还原本地）", when: "云端是唯一主副本，本地多余的文件会被删掉" },
      ],
      conflicts: [
        { id: "no-conflict-merge", name: "保留双方", when: "默认，最安全：本地保留原名，云端那份另存为 xxx.conflict-remote-时间.md" },
        { id: "local-priority", name: "本地优先", when: "确定本地版本才是对的" },
        { id: "server-priority", name: "云端优先", when: "确定云端版本才是对的" },
        { id: "diff3", name: "三方合并", when: "本插件没有保存基线，实际会退化为「保留双方」（会在计划里注明）" },
      ],
      safe: [
        "永远先「预演」：计划会列清楚上传/下载/删除各多少，删除动作默认还要二次确认。",
        "镜像策略（覆盖云端 / 还原本地）可能删掉另一端独有的文件——第一次用先备份。",
        "密码只存在本机 ~/.notrat/plugins/data/notrat-nutstore/config.json，不随同步上传，也不会在聊天里回显。",
        "首轮扫描请求数较多（每个目录一次 PROPFIND）；坚果云有频率限制，建议并发 3、必要时调大请求间隔。",
      ],
    }),
  },

  /* ---- 配置 ---- */
  ns_config: {
    desc:
      "读或写坚果云同步的配置。action=get 返回当前配置（密码脱敏）；action=set 传 patch 局部更新（可只改一个字段）。改完不需要重启。",
    args: {
      action: { type: "string", desc: "get | set", required: true },
      patch: { type: "object", desc: "要更新的字段：baseUrl/username/password/remoteDir/remoteBase/autoFollow/strategy/conflictStrategy/scanMode/maxFileSizeMB/concurrency/minGapMs/autoDelete/excludes/includes/autoSync" },
    },
    run: (args) => {
      const action = String(args.action || "get").toLowerCase();
      if (action === "get") {
        return { ok: true, config: stateLib.publicConfig(stateLib.loadConfig()) };
      }
      if (action !== "set") throw new Error("action 只能是 get 或 set");
      const patch = args.patch && typeof args.patch === "object" ? args.patch : {};
      const allowed = [
        "baseUrl", "username", "password", "remoteDir", "remoteBase", "autoFollow",
        "strategy", "conflictStrategy",
        "scanMode", "maxFileSizeMB", "concurrency", "minGapMs", "autoDelete",
        "excludes", "includes", "autoSync", "lastLocalRoot",
      ];
      const clean = {};
      for (const k of Object.keys(patch)) {
        if (!allowed.includes(k)) continue;
        clean[k] = patch[k];
      }
      if (clean.password === "****" || clean.password === "") delete clean.password; // 面板回显占位
      const next = stateLib.saveConfig(clean);
      stateLib.appendLog({ event: "config-set", keys: Object.keys(clean) });
      return { ok: true, config: stateLib.publicConfig(next), changed: Object.keys(clean) };
    },
  },

  ns_test: {
    desc:
      "测试坚果云连接：用当前账号密码（或临时传入的）连一次 WebDAV，返回云端顶层目录条目。用户说「测试连接 / 连不上 / 密码对不对」时用。",
    args: {
      baseUrl: { type: "string", desc: "临时覆盖服务地址" },
      username: { type: "string", desc: "临时覆盖账号" },
      password: { type: "string", desc: "临时覆盖应用密码" },
      remoteDir: { type: "string", desc: "顺便检查这个云端目录是否存在" },
    },
    run: async (args) => {
      const cfg = stateLib.loadConfig();
      const merged = Object.assign({}, cfg, {
        baseUrl: args.baseUrl || cfg.baseUrl,
        username: args.username || cfg.username,
        password: args.password || cfg.password,
      });
      requireConfigured(merged);
      const client = probeClient(merged);
      const started = Date.now();
      const r = await client.test();
      let dirCheck = null;
      const dir = String(args.remoteDir != null ? args.remoteDir : cfg.remoteDir || "").replace(/^\/+|\/+$/g, "");
      if (dir) {
        const st = await client.stat(dir);
        dirCheck = st ? { path: dir, exists: true, isDir: !!st.isDir } : { path: dir, exists: false };
      }
      stateLib.appendLog({ event: "test", ok: true, ms: Date.now() - started });
      return { ok: true, ms: Date.now() - started, baseUrl: merged.baseUrl, topLevel: r.topLevel, sample: r.sample, dirCheck };
    },
  },

  ns_ls: {
    desc: "列坚果云上的目录（浏览用）。path 为空列根目录。返回 dirs（子目录）与 fileList（文件，带 size/mtime），files 是文件个数。面板的远程目录选择器用 dirs。",
    args: {
      path: { type: "string", desc: "云端路径（相对 WebDAV 根），留空=根目录" },
    },
    run: async (args) => {
      const cfg = stateLib.loadConfig();
      requireConfigured(cfg);
      const client = probeClient(cfg);
      const dir = String(args.path || "").replace(/^\/+/, "").replace(/\/+$/, "");
      const items = await client.list(dir);
      const files = items.filter((i) => !i.isDir);
      return {
        ok: true,
        path: dir || "/",
        dirs: items.filter((i) => i.isDir).map((i) => ({ path: i.path, name: i.path.split("/").pop() })),
        // files 保持「数量」语义不变（面板与旧调用方依赖它）；
        // 文件名另开 fileList，否则只看到「有 2 个文件」却不知道是哪两个。
        fileList: files.map((i) => ({
          path: i.path,
          name: i.path.split("/").pop(),
          size: i.size,
          mtime: i.mtime,
        })),
        files: files.length,
        total: items.length,
      };
    },
  },

  /* ---- 规划 ---- */
  ns_plan: {
    desc:
      "预演同步：扫描本地目录 + 云端目录，按当前策略算出「要上传哪些、下载哪些、删除哪些、哪些冲突」，但不改动任何文件。返回 planId、汇总统计和任务明细（默认前 100 条）。用户说「预演/看看会改什么/先别动」时用它。",
    args: {
      localRoot: { type: "string", desc: "本地目录（工作区路径）。省略则用上次用过的目录" },
      remoteDir: { type: "string", desc: "云端目录，省略则用配置里的" },
      strategy: { type: "string", desc: "临时覆盖同步策略（不写入配置）" },
      conflictStrategy: { type: "string", desc: "临时覆盖冲突策略" },
      limit: { type: "number", desc: "明细最多返回多少条，默认 100" },
    },
    run: async (args) => {
      const cfg = stateLib.loadConfig();
      requireConfigured(cfg);
      const localRoot = resolveLocalRoot(args);
      rememberLocalRoot(localRoot);
      const remoteRoot = String(
        args.remoteDir != null ? args.remoteDir : cfg.remoteDir || "",
      ).replace(/^\/+|\/+$/g, "");
      const effective = Object.assign({}, cfg);
      if (args.strategy) effective.strategy = String(args.strategy);
      if (args.conflictStrategy) effective.conflictStrategy = String(args.conflictStrategy);
      const client = clientFromConfig(cfg);
      const plan = await planLib.buildPlan({
        client,
        localRoot,
        remoteRoot,
        config: effective,
        state: stateLib.loadState(),
        deviceLabel: os.hostname().slice(0, 24) || "remote",
      });
      const limit = Math.max(1, Math.min(1000, Number(args.limit) || 100));
      stateLib.appendLog({
        event: "plan",
        planId: plan.planId,
        localRoot,
        remoteRoot,
        summary: plan.summary,
      });
      return {
        ok: true,
        planId: plan.planId,
        at: plan.at,
        localRoot,
        remoteRoot: remoteRoot || "/",
        summary: plan.summary,
        describe: planLib.describe(plan),
        notes: plan.notes,
        tasks: plan.tasks.slice(0, limit),
        truncated: plan.tasks.length > limit,
        taskTotal: plan.tasks.length,
      };
    },
  },

  ns_conflicts: {
    desc: "列出最近一次预演里的冲突（两端都改过的文件），并给出每种处理方式会做什么。",
    args: {},
    run: () => {
      const plan = planLib.loadPlan();
      if (!plan) return { ok: false, error: "还没有可用的预演计划，请先调用 ns_plan。" };
      const conflicts =
        Array.isArray(plan.conflicts) && plan.conflicts.length
          ? plan.conflicts
          : plan.tasks.filter((t) => t.type === TASK.CONFLICT);
      return {
        ok: true,
        planId: plan.planId,
        at: plan.at,
        conflictStrategy: plan.summary.conflictStrategy,
        conflictStrategyLabel: CONFLICT_LABEL[plan.summary.conflictStrategy] || "",
        count: conflicts.length,
        items: conflicts.slice(0, 200).map((c) => ({
          path: c.path,
          reason: c.reason,
          localSize: c.localSize,
          remoteSize: c.remoteSize,
          copyTo: c.copyPath,
        })),
      };
    },
  },

  /* ---- 执行 ---- */
  ns_run: {
    desc:
      "执行同步。默认重新生成计划再执行（保证和当前磁盘一致）；也可以传 planId 复用刚预演过的计划。删除动作默认需要 confirmDelete:true（除非配置里开了 autoDelete）。async:true 时后台执行并返回 jobId，用 ns_job 查进度。",
    args: {
      localRoot: { type: "string", desc: "本地目录，省略则用上次的" },
      remoteDir: { type: "string", desc: "云端目录，省略则用配置里的" },
      planId: { type: "string", desc: "复用哪次预演的计划（省略=重新规划）" },
      confirmDelete: { type: "boolean", desc: "确认执行计划里的删除动作" },
      dryRun: { type: "boolean", desc: "只规划不执行（等价于 ns_plan）" },
      async: { type: "boolean", desc: "后台执行，立即返回 jobId" },
      strategy: { type: "string", desc: "临时覆盖同步策略" },
      conflictStrategy: { type: "string", desc: "临时覆盖冲突策略" },
      limit: { type: "number", desc: "返回结果里失败明细上限，默认 50" },
    },
    run: async (args) => {
      if (JOB.running) {
        return { ok: false, busy: true, jobId: JOB.id, phase: JOB.phase, message: "已有同步在跑，先等它结束或调用 ns_cancel。" };
      }
      const cfg = stateLib.loadConfig();
      requireConfigured(cfg);
      const localRoot = resolveLocalRoot(args);
      rememberLocalRoot(localRoot);
      const remoteRoot = String(
        args.remoteDir != null ? args.remoteDir : cfg.remoteDir || "",
      ).replace(/^\/+|\/+$/g, "");
      const effective = Object.assign({}, cfg);
      if (args.strategy) effective.strategy = String(args.strategy);
      if (args.conflictStrategy) effective.conflictStrategy = String(args.conflictStrategy);

      if (args.dryRun) {
        return tools.ns_plan.run(Object.assign({}, args, { localRoot, remoteDir: remoteRoot }));
      }

      const plan = pickPlan(args.planId, localRoot, remoteRoot);
      if (!plan) {
        return { ok: false, error: "没有可用的计划（planId 无效或已过期）。先调用 ns_plan。" };
      }
      const deletes = plan.tasks.filter((t) => t.type === TASK.REMOVE_LOCAL || t.type === TASK.REMOVE_REMOTE);
      if (deletes.length && !args.confirmDelete && !effective.autoDelete) {
        return {
          ok: false,
          requiresConfirmation: true,
          planId: plan.planId,
          deleteCount: deletes.length,
          sample: deletes.slice(0, 10).map((d) => ({ type: d.type, path: d.path })),
          message:
            "计划里有 " + deletes.length + " 个删除动作。请把清单给用户看，得到明确同意后再带 confirmDelete:true 调用。",
        };
      }

      const runOnce = async () => {
        JOB.id = newJobId();
        JOB.running = true;
        JOB.cancel = false;
        JOB.startedAt = new Date().toISOString();
        JOB.phase = "executing";
        JOB.planId = plan.planId;
        JOB.progress = null;
        JOB.error = null;
        JOB.result = null;
        let state = null;
        try {
          const client = clientFromConfig(cfg);
          state = stateLib.loadState();
          const result = await execLib.execute({
            client,
            localRoot: plan.localRoot,
            remoteRoot: plan.remoteRoot,
            tasks: plan.tasks,
            state,
            config: effective,
            confirmDelete: !!args.confirmDelete,
            concurrency: effective.concurrency,
            shouldCancel: () => JOB.cancel,
            onProgress: (p) => {
              JOB.phase = "executing";
              JOB.progress = p;
            },
            onCheckpoint: () => stateLib.saveState(state),
          });
          stateLib.saveState(state);
          stateLib.appendLog({ event: "run", planId: plan.planId, result: { ok: result.ok, pushed: result.pushed, pulled: result.pulled, failed: result.failed.length, cancelled: result.cancelled } });
          JOB.result = result;
          JOB.phase = "done";
          return Object.assign({ ok: result.ok, planId: plan.planId, jobId: JOB.id, summary: plan.summary, describe: planLib.describe(plan) }, result, {
            failed: result.failed.slice(0, Math.max(1, Math.min(500, Number(args.limit) || 50))),
          });
        } catch (e) {
          JOB.error = String((e && e.message) || e);
          JOB.phase = "error";
          stateLib.appendLog({ event: "run-error", planId: plan.planId, error: JOB.error });
          throw e;
        } finally {
          // 断点续传的最后一道保险：本轮无论是成功、失败、被取消还是抛异常，
          // 都要把已经落地的同步记录写盘。少了这次，中断那轮上传成功的文件
          // 下一轮会被当成「从没同步过」重传，大目录就永远推不完。
          if (state) {
            try {
              stateLib.saveState(state);
            } catch (_) {
              /* 落盘失败不能掩盖真正的错误，交给上层 */
            }
          }
          JOB.running = false;
        }
      };

      if (args.async) {
        // 后台跑：立刻返回 jobId，面板用 ns_job 轮询
        JOB.id = newJobId();
        JOB.running = true;
        JOB.cancel = false;
        JOB.startedAt = new Date().toISOString();
        JOB.phase = "starting";
        setImmediate(() => {
          runOnce().catch((e) => {
            JOB.error = String((e && e.message) || e);
            JOB.phase = "error";
            JOB.running = false;
          });
        });
        return { ok: true, async: true, jobId: JOB.id, planId: plan.planId, message: "已在后台开始，用 ns_job 查询进度。" };
      }
      return runOnce();
    },
  },

  ns_job: {
    desc: "查询同步任务进度/结果：running、阶段、当前文件、已完成数、最近结果或错误。",
    args: {},
    run: () => ({
      ok: true,
      jobId: JOB.id,
      running: JOB.running,
      phase: JOB.phase,
      startedAt: JOB.startedAt,
      progress: JOB.progress,
      error: JOB.error,
      result: JOB.result
        ? {
            ok: JOB.result.ok,
            pushed: JOB.result.pushed,
            pulled: JOB.result.pulled,
            removedLocal: JOB.result.removedLocal,
            removedRemote: JOB.result.removedRemote,
            mkdirLocal: JOB.result.mkdirLocal,
            mkdirRemote: JOB.result.mkdirRemote,
            skipped: JOB.result.skipped,
            bytesUp: JOB.result.bytesUp,
            bytesDown: JOB.result.bytesDown,
            failed: (JOB.result.failed || []).slice(0, 50),
            cancelled: JOB.result.cancelled,
            finishedAt: JOB.result.finishedAt,
            statBackfilled: JOB.result.statBackfilled,
          }
        : null,
    }),
  },

  ns_cancel: {
    desc: "取消正在进行的同步（当前文件做完就停，已完成的不会回滚）。",
    args: {},
    run: () => {
      if (!JOB.running) return { ok: false, message: "当前没有正在跑的同步。" };
      JOB.cancel = true;
      JOB.phase = "cancelling";
      return { ok: true, jobId: JOB.id, message: "已请求取消，等当前文件完成。" };
    },
  },

  ns_resolve: {
    desc:
      "手动解决冲突：对指定文件（或全部冲突）按方向处理。mode=local 用本地覆盖云端；mode=remote 用云端覆盖本地（本地旧版另存 .conflict-local-时间）；mode=both 保留双方。",
    args: {
      paths: { type: "array", desc: "要处理的路径（相对同步根）；留空=处理最近一次预演里的全部冲突" },
      mode: { type: "string", desc: "local | remote | both", required: true },
      localRoot: { type: "string", desc: "本地目录，省略则用上次的" },
    },
    run: async (args) => {
      const mode = String(args.mode || "").toLowerCase();
      if (!["local", "remote", "both"].includes(mode)) throw new Error("mode 只能是 local / remote / both");
      const cfg = stateLib.loadConfig();
      requireConfigured(cfg);
      const localRoot = resolveLocalRoot(args);
      const remoteRoot = String(cfg.remoteDir || "").replace(/^\/+|\/+$/g, "");
      const plan = planLib.loadPlan();
      const wanted = Array.isArray(args.paths) && args.paths.length
        ? args.paths.map((p) => String(p).replace(/^\/+/, ""))
        : plan
          ? plan.tasks.filter((t) => t.type === TASK.CONFLICT).map((t) => t.path)
          : [];
      if (!wanted.length) return { ok: false, error: "没有要处理的冲突（先 ns_plan 生成计划，或传 paths）。" };

      const client = clientFromConfig(cfg);
      const state = stateLib.loadState();
      const out = [];
      for (const rel of wanted) {
        try {
          const full = execLib.remotePathOf(remoteRoot, rel);
          const abs = path.join(localRoot, rel.split("/").join(path.sep));
          const localExists = fs.existsSync(abs);
          const remoteStat = await client.stat(full);
          if (mode === "local") {
            if (!localExists) throw new Error("本地没有这个文件，无法用本地覆盖云端");
            const buf = await fs.promises.readFile(abs);
            await client.put(full, buf, execLib.contentTypeOf(rel));
            const st = await fs.promises.lstat(abs);
            state.records[rel] = {
              localMtime: Math.floor(st.mtimeMs),
              localSize: st.size,
              remoteMtime: 0,
              remoteSize: buf.length,
              syncedAt: new Date().toISOString(),
              pendingRemoteStat: true,
            };
            out.push({ path: rel, ok: true, action: "本地覆盖云端" });
          } else if (mode === "remote") {
            if (!remoteStat) throw new Error("云端没有这个文件，无法用云端覆盖本地");
            const buf = await client.get(full);
            if (localExists) {
              const backup = execLib.remotePathOf("", rel).replace(/(\.[^.\/]+)?$/, ".conflict-local-" + Date.now() + "$1");
              await execLib.writeFileAtomic(path.join(localRoot, backup.split("/").join(path.sep)), await fs.promises.readFile(abs));
              out.push({ path: rel, backup });
            }
            await execLib.writeFileAtomic(abs, buf);
            const st = await fs.promises.lstat(abs);
            state.records[rel] = {
              localMtime: Math.floor(st.mtimeMs),
              localSize: st.size,
              remoteMtime: remoteStat.mtime,
              remoteSize: remoteStat.size,
              syncedAt: new Date().toISOString(),
            };
            out.push({ path: rel, ok: true, action: "云端覆盖本地" });
          } else {
            const buf = remoteStat ? await client.get(full) : null;
            if (buf && localExists) {
              const copy = execLib
                .remotePathOf("", rel)
                .replace(/(\.[^.\/]+)?$/, ".conflict-remote-" + Date.now() + "$1");
              await execLib.writeFileAtomic(path.join(localRoot, copy.split("/").join(path.sep)), buf);
              const st = await fs.promises.lstat(abs);
              state.records[rel] = {
                localMtime: Math.floor(st.mtimeMs),
                localSize: st.size,
                remoteMtime: remoteStat.mtime,
                remoteSize: remoteStat.size,
                syncedAt: new Date().toISOString(),
              };
              out.push({ path: rel, ok: true, action: "保留双方", copyTo: copy });
            } else if (buf && !localExists) {
              await execLib.writeFileAtomic(abs, buf);
              out.push({ path: rel, ok: true, action: "本地缺失，已从云端补回" });
            } else {
              out.push({ path: rel, ok: false, action: "云端缺失，只保留本地" });
            }
          }
        } catch (e) {
          out.push({ path: rel, ok: false, error: String((e && e.message) || e) });
        }
      }
      stateLib.saveState(state);
      stateLib.appendLog({ event: "resolve", mode, count: out.length });
      return { ok: out.every((x) => x.ok), mode, handled: out.length, items: out };
    },
  },

  /* ---- 观测 ---- */
  ns_status: {
    desc:
      "看同步状态：是否已配置、策略、上次预演/运行、同步记录数、云端目录、数据目录、最近日志。用户问「现在什么情况/上次同步成功了吗」时用。",
    args: {
      limit: { type: "number", desc: "返回多少条最近日志，默认 10" },
    },
    run: (args) => {
      const cfg = stateLib.loadConfig();
      const st = stateLib.loadState();
      const plan = planLib.loadPlan();
      const records = st.records || {};
      const lastSynced = Object.values(records)
        .map((r) => r.syncedAt)
        .filter(Boolean)
        .sort()
        .pop();
      return {
        ok: true,
        configured: !!(cfg.username && cfg.password),
        baseUrl: cfg.baseUrl,
        remoteDir: cfg.remoteDir || "/",
        lastLocalRoot: cfg.lastLocalRoot || "",
        strategy: cfg.strategy,
        strategyLabel: STRATEGY_LABEL[cfg.strategy] || cfg.strategy,
        conflictStrategy: cfg.conflictStrategy,
        scanMode: cfg.scanMode,
        recordCount: Object.keys(records).length,
        lastSyncedAt: lastSynced || "",
        lastPlan: plan
          ? {
              planId: plan.planId,
              at: plan.at,
              summary: plan.summary,
              describe: planLib.describe(plan),
              expired: Date.now() - Date.parse(plan.at) > planLib.PLAN_TTL_MS,
            }
          : null,
        job: { id: JOB.id, running: JOB.running, phase: JOB.phase, progress: JOB.progress, error: JOB.error },
        dataDir: stateLib.DATA_DIR,
        build: BUILD,
        recentLog: stateLib.readLog(Number(args.limit) || 10),
      };
    },
  },

  ns_log: {
    desc: "读同步日志（最近的运行记录：计划、执行结果、错误）。",
    args: {
      limit: { type: "number", desc: "返回条数，默认 50" },
      clear: { type: "boolean", desc: "true 则清空日志" },
    },
    run: (args) => {
      if (args.clear) return Object.assign({ ok: true }, stateLib.clearLog(), { cleared: true });
      return { ok: true, entries: stateLib.readLog(Number(args.limit) || 50) };
    },
  },
};

/** 从缓存计划里取一份可执行的计划（planId 可选）。 */
function pickPlan(planId, localRoot, remoteRoot) {
  const plan = planLib.loadPlan();
  if (!plan) return null;
  if (planId && plan.planId !== planId) return null;
  if (path.resolve(plan.localRoot) !== path.resolve(localRoot)) return null;
  const a = String(plan.remoteRoot || "").replace(/^\/+|\/+$/g, "");
  const b = String(remoteRoot || "").replace(/^\/+|\/+$/g, "");
  if (a !== b) return null;
  return plan;
}

/* ------------------------------ MCP 协议 ------------------------------ */

const TOOLS_META = Object.keys(tools).map((name) => {
  const t = tools[name];
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(t.args || {})) {
    properties[key] = { type: spec.type || "string", description: spec.desc || "" };
    if (spec.required) required.push(key);
  }
  return {
    name,
    description: t.desc,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
  };
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // 通知不回包
  try {
    if (method === "initialize") {
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: PLUGIN_ID, version: PLUGIN_VERSION },
        },
      });
    }
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS_META } });
    if (method === "tools/call") {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      if (!tools[name]) throw new Error("unknown tool: " + name);
      const out = await tools[name].run(args);
      return send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] },
      });
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    return send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } });
  } catch (e) {
    const err = e instanceof WebDAVError ? e : e;
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: false,
                code: (err && err.code) || (err && err.status ? "HTTP_" + err.status : "ERROR"),
                error: String((err && err.message) || err),
                hint: hintFor(err),
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      },
    });
  }
}

function hintFor(err) {
  const msg = String((err && err.message) || "");
  if (err && err.code === "NOT_CONFIGURED") return "先配置账号：ns_config set {username, password}";
  if (/HTTP 401/.test(msg)) {
    // 实测：账号邮箱域名写错（.com / .cn）返回的也是 401，和密码错长得一模一样。
    // 这是最高频的踩坑点，所以排在最前面。
    return (
      "HTTP 401 —— 账号或应用密码不对。两个最常见原因：" +
      "① 账号邮箱的域名写错了（坚果云是 .cn 还是 .com 要核对清楚，写错同样返回 401）；" +
      "② 用的是登录密码而不是「第三方应用密码」（坚果云网页版 → 账户信息 → 安全选项 → 添加应用密码）。"
    );
  }
  if (/HTTP 429|HTTP 503/.test(msg)) return "请求太频繁：调小 concurrency 或设置 minGapMs（如 300ms）后重试";
  if (/HTTP 404/.test(msg)) return "云端目录不存在：先在坚果云里建目录，或改 remoteDir";
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timeout|超时/i.test(msg)) return "网络不通：检查代理 / 防火墙 / 服务地址是否正确";
  return "";
}

let buf = "";
/**
 * 未完成的请求 id → 方法名。
 *
 * 为什么记 id 而不是只记个数：宿主关 stdin 时我们要能**替这些请求回一条错误**，
 * 否则面板那侧的 Promise 永不 resolve，永远停在「测试中…」。
 */
const pending = new Map();

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;

    let reqId = null;
    try {
      const peek = JSON.parse(line);
      if (peek && peek.id !== undefined && peek.id !== null) {
        reqId = peek.id;
        pending.set(reqId, peek.method || "?");
      }
    } catch (_) {
      /* 坏包交给 handle 去回 parse error */
    }

    handle(line)
      .catch((e) => log("handle 异常: " + ((e && e.stack) || e)))
      .finally(() => {
        if (reqId !== null) pending.delete(reqId);
      });
  }
});

/**
 * stdin 结束 != 可以立刻退出。
 *
 * 事故现场（2026-10-25）：面板点「测试连接」后一直转圈。宿主在请求还没回来时
 * 重载了插件（关 stdin），而这里原本是 process.exit(0) —— in-flight 的 ns_test
 * 响应被直接丢掉，面板那侧永远等不到结果。
 *
 * 现在的契约：**每个 id 必须有且只有一个回包**。
 *   1) 宽限 8 秒，等手上的请求自然完成；
 *   2) 仍有没完成的 → 替它们发一条明确的错误（而不是让面板无限等）；
 *   3) 退出。
 */
const SHUTDOWN_GRACE_MS = 8000;

process.stdin.on("end", () => {
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  const tick = () => {
    if (pending.size === 0) {
      log("stdin 关闭，无未完成请求，正常退出");
      return process.exit(0);
    }
    if (Date.now() > deadline) {
      // 给所有还在等的请求补一条错误，避免宿主/面板永久挂起
      for (const [id, method] of pending) {
        try {
          send({
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      ok: false,
                      code: "SHUTDOWN",
                      error:
                        "插件服务正在重载，这条请求（" +
                        method +
                        "）被中断了。请稍后重试一次。",
                      hint: "重载完成后重新点一次即可；若反复出现，检查插件是否被频繁重启。",
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            },
          });
        } catch (_) {
          /* 尽力而为 */
        }
      }
      log("stdin 关闭，等待超时（" + pending.size + " 个请求），已补发中断错误后退出");
      return process.exit(0);
    }
    setTimeout(tick, 50);
  };
  tick();
});

/**
 * 构建指纹：当前**运行中**的代码是哪一版。
 *
 * 排查经验（2026-10-25，为此白烧两轮时间）：改完 server/index.js 后只重载了面板、
 * 没重载插件，跑的还是旧进程，现象就是「改了完全没变化」。
 *
 * 所以这里不只暴露 mtime / startedAt，还直接算出 `stale`：
 *   磁盘上 index.js 的 mtime > 本进程启动时间  →  跑的是旧代码
 * 看到 stale=true 就说明**该重载插件**了，不用自己算时间。
 */
const BUILD = (() => {
  const startedAt = new Date();
  try {
    const st = fs.statSync(__filename);
    // 留 1 秒容差：同一秒内「写完文件 → 立刻拉起进程」不算过期
    const stale = st.mtime.getTime() > startedAt.getTime() + 1000;
    return {
      file: __filename,
      mtime: st.mtime.toISOString(),
      size: st.size,
      startedAt: startedAt.toISOString(),
      pid: process.pid,
      stale,
      hint: stale
        ? "磁盘上的 index.js 比本进程新 —— 跑的是旧代码，请重载插件（插件箱 → 右键 → 重载插件，或 /mcp:reload）。"
        : "",
    };
  } catch (_) {
    return { startedAt: startedAt.toISOString(), pid: process.pid, stale: false, hint: "" };
  }
})();

log("ready  dataDir=" + stateLib.DATA_DIR);
log("build  index.js mtime=" + (BUILD.mtime || "?") + " pid=" + BUILD.pid + (BUILD.stale ? "  ⚠️ STALE（磁盘比进程新，需重载插件）" : ""));
