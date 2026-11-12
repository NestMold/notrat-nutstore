"use strict";
/**
 * 配置 / 同步记录 / 日志的落盘层。
 *
 * 三个文件，各司其职：
 *   config.json       用户配置（含坚果云应用密码 —— 只存本机，绝不回显）
 *   state.json        同步记录（每个文件上次同步时的两端 mtime/size，决策的唯一依据）
 *   sync.log.jsonl    运行日志（环形，保留最近 N 行）
 *
 * 硬约束：
 *   1) **原子写**：tmp + rename。同步正在跑时面板可能在读，半截 JSON 会让状态「丢失」。
 *   2) **损坏不静默清零**：解析失败先备份 .broken-<ts>，再返回空结构。
 *   3) **记录不能乱删**：记录缺失 = 首次同步，可能导致「双向同步把云端旧文件拉回来覆盖」。
 *      只在明确 prune 时才删（文件两端都不存在 + 超过 N 天）。
 *
 * 本文件是 notrat-nutstore 的一部分，按 AGPL-3.0 发布（全文见包内 LICENSE）。
 * 衍生自 nutstore/obsidian-nutstore-sync (AGPL-3.0)，原项目版权归其作者所有。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const PLUGIN_ID = "notrat-nutstore";

function envStr(name, fallback) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : fallback;
}

const DATA_DIR = envStr(
  "NUTSTORE_DATA_DIR",
  path.join(os.homedir(), ".notrat", "plugins", "data", PLUGIN_ID),
);
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const LOG_FILE = path.join(DATA_DIR, "sync.log.jsonl");
const LOG_MAX_LINES = 2000;

const log = (...a) => process.stderr.write("[notrat-nutstore] " + a.join(" ") + "\n");
const nowIso = () => new Date().toISOString();

const DEFAULT_CONFIG = {
  version: 1,
  baseUrl: "https://dav.jianguoyun.com/dav",
  username: "",
  password: "",
  remoteDir: "",
  remoteBase: "",
  autoFollow: true,
  strategy: "two-way",
  conflictStrategy: "no-conflict-merge",
  scanMode: "loose",
  maxFileSizeMB: 100,
  concurrency: 2,
  minGapMs: 120,
  autoDelete: false,
  excludes: [],
  includes: [],
  autoSync: { enabled: false, intervalMinutes: 30, onStart: false },
  updatedAt: "",
};

const STRATEGIES = [
  "two-way",
  "send-only",
  "send-only-override-changes",
  "receive-only",
  "receive-only-revert-local-changes",
];
const CONFLICT_STRATEGIES = ["no-conflict-merge", "diff3", "local-priority", "server-priority"];
const SCAN_MODES = ["loose", "strict"];

/**
 * 坚果云官方 WebDAV 限额（帮助中心 p=2064）：
 *   - 免费版 600 次请求 / 30 分钟，付费版 1500 次 / 30 分钟
 *   - 单次请求最多返回 750 个条目（需要客户端分页，webdav.js 已实现 Link 分页）
 *   - 单文件上传上限 500 MB（免费版默认）
 * 这里只用来**估算并提前警告**，不做硬性拦截 —— 限额是按 30 分钟窗口算的，
 * 短时爆发是允许的，拦死反而会让首次同步永远跑不完。
 */
const QUOTA = {
  free: { requestsPer30Min: 600, maxFileMB: 500 },
  paid: { requestsPer30Min: 1500, maxFileMB: 500 },
  windowMs: 30 * 60 * 1000,
};

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function atomicWrite(file, text) {
  ensureDir();
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, text, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* ignore */
    }
    throw e;
  }
}

function backupBroken(file, err) {
  try {
    const target = file + ".broken-" + Date.now();
    fs.copyFileSync(file, target);
    log("解析失败，已备份为 " + path.basename(target) + "：" + String((err && err.message) || err));
  } catch (_) {
    /* 备份失败也不拦 */
  }
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return fallback;
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object" || Array.isArray(j)) return fallback;
    return j;
  } catch (e) {
    if (fs.existsSync(file)) backupBroken(file, e);
    return fallback;
  }
}

/* ------------------------------- config ------------------------------- */

/** 数字归一：空串/NaN 一律回默认值（不能当 0 —— 0 在 minGapMs 上等于关掉限速）。 */
function numOr(v, def, min, max) {
  if (v === "" || v === null || v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/**
 * 配置归一化 —— **读和写都必须过这一层**。
 *
 * 曾经的 bug：只有 loadConfig 归一化，saveConfig 直接落盘。于是面板在字段为空时
 * blur 一下就把 baseUrl:"" / concurrency:"" / minGapMs:"" 写进文件；
 * baseUrl 空 → 面板显示空白（用户以为「设置失败」），minGapMs 空 → 归一化成 0
 * → 限速被静默关掉（正好是刚修好的限流问题复发）。
 */
function normalizeConfig(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const cfg = Object.assign({}, DEFAULT_CONFIG, src);
  cfg.autoSync = Object.assign({}, DEFAULT_CONFIG.autoSync, src.autoSync || {});

  // 服务地址：空白 → 回默认。留空没有意义，客户端本来就 fallback 到默认端点。
  // 去掉尾部斜杠：webdav.js 内部会再 replace，但落盘值也该是规范形式，
  // 否则面板显示 `https://dav.jianguoyun.com/dav/` 会让人以为配错了。
  const baseUrl = String(cfg.baseUrl == null ? "" : cfg.baseUrl)
    .trim()
    .replace(/\/+$/, "");
  cfg.baseUrl = baseUrl || DEFAULT_CONFIG.baseUrl;

  cfg.username = String(cfg.username == null ? "" : cfg.username).trim();
  // 应用密码是坚果云生成的字母数字串，trim 掉粘贴时带的换行/空格
  cfg.password = String(cfg.password == null ? "" : cfg.password).trim();
  cfg.remoteDir = String(cfg.remoteDir == null ? "" : cfg.remoteDir)
    .trim()
    .replace(/^\/+|\/+$/g, "");

  // 云端根目录：跟随时是「主目录」，真正的目标由面板拼成 根/空间/工作区
  // 老配置里没有这个键：把当时的 remoteDir 当成根目录迁移一次。
  // 只迁一次 —— 之后用户显式清空就是清空，不再回填。
  if (!Object.prototype.hasOwnProperty.call(src, "remoteBase")) cfg.remoteBase = cfg.remoteDir;
  cfg.remoteBase = String(cfg.remoteBase == null ? "" : cfg.remoteBase)
    .trim()
    .replace(/^\/+|\/+$/g, "");
  // 只有显式 false 才关；缺省（老配置）按开处理
  cfg.autoFollow = !(cfg.autoFollow === false || cfg.autoFollow === "false");

  if (!STRATEGIES.includes(cfg.strategy)) cfg.strategy = DEFAULT_CONFIG.strategy;
  if (!CONFLICT_STRATEGIES.includes(cfg.conflictStrategy)) {
    cfg.conflictStrategy = DEFAULT_CONFIG.conflictStrategy;
  }
  if (!SCAN_MODES.includes(cfg.scanMode)) cfg.scanMode = DEFAULT_CONFIG.scanMode;

  // 上限 <= 0 没有意义（等于什么都不同步），按「非法 → 回默认」处理，
  // 而不是夹到最小正数 —— 夹边界会让用户以为「我设的 0 生效了」。
  cfg.maxFileSizeMB = numOr(cfg.maxFileSizeMB, 100, 0, 10240);
  if (cfg.maxFileSizeMB <= 0) cfg.maxFileSizeMB = 100;
  cfg.concurrency = Math.round(numOr(cfg.concurrency, 2, 1, 8));
  cfg.minGapMs = Math.round(numOr(cfg.minGapMs, 120, 0, 10000));
  cfg.autoDelete = cfg.autoDelete === true || cfg.autoDelete === "true";

  cfg.excludes = Array.isArray(cfg.excludes) ? cfg.excludes.map((x) => String(x)) : [];
  cfg.includes = Array.isArray(cfg.includes) ? cfg.includes.map((x) => String(x)) : [];

  const interval = numOr(cfg.autoSync.intervalMinutes, 30, 1, 1440);
  cfg.autoSync = {
    enabled: cfg.autoSync.enabled === true,
    intervalMinutes: Math.round(interval),
    onStart: cfg.autoSync.onStart === true,
  };
  return cfg;
}

function loadConfig() {
  return normalizeConfig(readJson(CONFIG_FILE, {}));
}

function saveConfig(patch) {
  const cur = loadConfig();
  const merged = Object.assign({}, cur, patch || {});

  // 枚举字段先**显式**校验：归一化会把非法值悄悄改成默认，用户会以为「改了没生效」。
  // 但空值例外 —— 空串来自「面板字段被清空」，按「回默认」处理，不该报错。
  const checkEnum = (key, allowed, label) => {
    const v = merged[key];
    if (v === "" || v === null || v === undefined) {
      merged[key] = DEFAULT_CONFIG[key];
      return;
    }
    if (!allowed.includes(v)) {
      throw new Error(
        "未知" + label + "：" + JSON.stringify(v) + "。可选值：" + allowed.join(" / "),
      );
    }
  };
  checkEnum("strategy", STRATEGIES, "同步策略");
  checkEnum("conflictStrategy", CONFLICT_STRATEGIES, "冲突策略");
  checkEnum("scanMode", SCAN_MODES, "扫描模式");

  const next = normalizeConfig(merged);
  next.version = 1;
  next.updatedAt = nowIso();
  atomicWrite(CONFIG_FILE, JSON.stringify(next, null, 2));
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch (_) {
    /* Windows 上无意义，忽略 */
  }
  return next;
}

/** 对外展示用：密码永远脱敏。 */
function publicConfig(cfg) {
  const c = Object.assign({}, cfg || loadConfig());
  const pw = c.password ? String(c.password) : "";
  c.password = "";
  c.passwordSet = !!pw;
  c.passwordHint = pw ? "已设置（" + pw.slice(0, 2) + "****" + pw.slice(-2) + "）" : "";
  c.dataDir = DATA_DIR;
  c.strategies = STRATEGIES;
  c.conflictStrategies = CONFLICT_STRATEGIES;
  c.scanModes = SCAN_MODES;
  return c;
}

/* -------------------------------- state -------------------------------- */

function emptyState() {
  return { version: 1, records: {}, updatedAt: "" };
}

function loadState() {
  const j = readJson(STATE_FILE, null);
  if (!j) return emptyState();
  const st = { version: 1, records: {}, updatedAt: j.updatedAt || "" };
  const recs = j.records;
  if (recs && typeof recs === "object" && !Array.isArray(recs)) {
    for (const [k, v] of Object.entries(recs)) {
      if (!v || typeof v !== "object") continue;
      const rel = String(k).replace(/\\/g, "/").replace(/^\/+/, "");
      if (!rel) continue;
      st.records[rel] = {
        localMtime: Number(v.localMtime) || 0,
        localSize: Number(v.localSize) || 0,
        remoteMtime: Number(v.remoteMtime) || 0,
        remoteSize: Number(v.remoteSize) || 0,
        syncedAt: v.syncedAt || "",
      };
    }
  }
  return st;
}

function saveState(state) {
  const out = {
    version: 1,
    records: state && state.records ? state.records : {},
    updatedAt: nowIso(),
  };
  atomicWrite(STATE_FILE, JSON.stringify(out));
  return out;
}

/** 删除记录（文件两端都已不存在且记录很旧时才有意义）。 */
function pruneRecords(state, alivePaths, olderThanDays) {
  const alive = alivePaths instanceof Set ? alivePaths : new Set(alivePaths || []);
  const days = Number.isFinite(olderThanDays) ? olderThanDays : 90;
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  let removed = 0;
  for (const [rel, rec] of Object.entries(state.records || {})) {
    if (alive.has(rel)) continue;
    const t = Date.parse(rec.syncedAt || "");
    if (!Number.isFinite(t) || t < cutoff) {
      delete state.records[rel];
      removed++;
    }
  }
  return removed;
}

function recordCount(state) {
  return Object.keys((state && state.records) || {}).length;
}

/* --------------------------------- log --------------------------------- */

function appendLog(entry) {
  ensureDir();
  const line = JSON.stringify(Object.assign({ at: nowIso() }, entry)) + "\n";
  try {
    fs.appendFileSync(LOG_FILE, line, "utf8");
    // 环形裁剪：超过上限时只保留后一半（避免每次写都统计全文件）
    const size = fs.statSync(LOG_FILE).size;
    if (size > 2 * 1024 * 1024) {
      const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
      if (lines.length > LOG_MAX_LINES) {
        atomicWrite(LOG_FILE, lines.slice(-Math.floor(LOG_MAX_LINES / 2)).join("\n") + "\n");
      }
    }
  } catch (e) {
    log("写日志失败：" + String((e && e.message) || e));
  }
}

function readLog(limit) {
  const n = Math.max(1, Math.min(LOG_MAX_LINES, Number(limit) || 80));
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
    return lines.slice(-n).map((l) => {
      try {
        return JSON.parse(l);
      } catch (_) {
        return { raw: l };
      }
    });
  } catch (_) {
    return [];
  }
}

function clearLog() {
  try {
    if (fs.existsSync(LOG_FILE)) atomicWrite(LOG_FILE, "");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = {
  PLUGIN_ID,
  DATA_DIR,
  CONFIG_FILE,
  STATE_FILE,
  LOG_FILE,
  DEFAULT_CONFIG,
  STRATEGIES,
  CONFLICT_STRATEGIES,
  SCAN_MODES,
  QUOTA,
  normalizeConfig,
  loadConfig,
  saveConfig,
  publicConfig,
  loadState,
  saveState,
  pruneRecords,
  recordCount,
  appendLog,
  readLog,
  clearLog,
  atomicWrite,
  readJson,
  nowIso,
};
