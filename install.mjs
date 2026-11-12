#!/usr/bin/env node
/**
 * notrat-nutstore 安装 / 更新 / 卸载器
 *
 *   node install.mjs              # 安装或原地更新到 ~/.notrat/plugins/notrat-nutstore/
 *   node install.mjs --uninstall  # 卸载
 *   node install.mjs --to <dir>   # 指定目标根目录
 *   node install.mjs --dry-run    # 只打印计划
 *
 * 三条来自插件规范的硬要求：
 *   1) **manifest.json 必须最后落盘** —— 它是宿主的「安装信号」。提前落盘会在
 *      server 脚本还没就位时被 chokidar 抓到 → 启动失败。
 *   2) **更新要原地覆盖，不要 rm -rf 再拷** —— 插件加载后目录会被运行中的
 *      MCP server 进程占住（Windows 上 rmdir 直接 EBUSY）。
 *   3) **写完必须回读校验** —— 事故（2026-10-25）：install 报了「完成」，
 *      但目标目录里的 server/index.js 还是旧版，排查时白烧了两轮时间。
 *      copyFileSync 在某些占用/杀软拦截场景下会静默写不完整，所以这里
 *      逐文件对比 sha1，对不上就重试一次并明确报错。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ID = "notrat-nutstore";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const HOME = os.homedir();
const TARGET_ROOT = path.resolve(val("--to", path.join(HOME, ".notrat", "plugins")));
const TARGET = path.join(TARGET_ROOT, ID);
const SINGLE_FILE = path.join(TARGET_ROOT, `${ID}.json`);

/**
 * 装机时一并复制的文件。
 *
 * LICENSE 必须在列 —— 上游是 AGPL-3.0，分发时**必须随包提供许可全文**，
 * 只在仓库里有、装到插件目录后没有，等于没给。
 */
const INCLUDE = ["manifest.json", "README.md", "LICENSE", "install.mjs", "server", "panels", "docs", "tests"];
const SKIP_NAMES = new Set(["node_modules", ".git", ".DS_Store", "last-plan.json"]);

const log = (...a) => console.log("[install]", ...a);

function walkRel(root, rel = "") {
  const out = [];
  const abs = rel ? path.join(root, rel) : root;
  if (!fs.existsSync(abs)) return out;
  for (const name of fs.readdirSync(abs)) {
    if (SKIP_NAMES.has(name) || name.startsWith(".")) continue;
    const r = rel ? path.join(rel, name) : name;
    const a = path.join(root, r);
    if (fs.statSync(a).isDirectory()) {
      out.push({ rel: r, dir: true });
      out.push(...walkRel(root, r));
    } else {
      out.push({ rel: r, dir: false });
    }
  }
  return out;
}

function topLevelInclude(rel) {
  return INCLUDE.some((x) => x === rel || rel.startsWith(x + path.sep));
}

/** 文件 sha1，用于写入后校验。 */
function sha1(p) {
  return crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex");
}

/** 复制 + 回读校验。返回 null 表示成功，否则返回错误描述。 */
function copyVerified(srcRel, destAbs, tries = 2) {
  const srcAbs = path.join(HERE, srcRel);
  const want = sha1(srcAbs);
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      fs.copyFileSync(srcAbs, destAbs);
      const got = sha1(destAbs);
      if (got === want) return null;
      last = "内容不一致（期望 " + want.slice(0, 8) + "，实际 " + got.slice(0, 8) + "）";
    } catch (e) {
      last = String((e && e.message) || e);
    }
  }
  return last;
}

function uninstall() {
  if (fs.existsSync(TARGET)) {
    for (const item of walkRel(TARGET).filter((x) => !x.dir).reverse()) {
      try {
        fs.unlinkSync(path.join(TARGET, item.rel));
      } catch (e) {
        log("跳过（可能被占用）：" + item.rel);
      }
    }
    for (const item of walkRel(TARGET).filter((x) => x.dir).reverse()) {
      try {
        fs.rmdirSync(path.join(TARGET, item.rel));
      } catch (_) {
        /* 非空则留 */
      }
    }
    try {
      fs.rmdirSync(TARGET);
    } catch (_) {
      log("⚠️ 目标目录未清空（有文件被运行中的进程占用），重载插件后再删。");
    }
  }
  if (fs.existsSync(SINGLE_FILE)) {
    try {
      fs.unlinkSync(SINGLE_FILE);
    } catch (_) {
      /* ignore */
    }
  }
  log("已卸载。重载插件（或重启 Notrat）后生效。");
}

if (flag("--uninstall")) {
  uninstall();
  process.exit(0);
}

log("源目录：" + HERE);
log("目标目录：" + TARGET);

const all = walkRel(HERE);
const dirs = all.filter((x) => x.dir && topLevelInclude(x.rel));
const files = all.filter((x) => !x.dir && topLevelInclude(x.rel) && x.rel !== "manifest.json");

log("将写入 " + files.length + " 个文件" + (flag("--dry-run") ? "（dry-run）" : ""));

if (fs.existsSync(SINGLE_FILE)) {
  log("⚠️ 检测到同 id 的单文件包：" + SINGLE_FILE + " —— 两者会 id 冲突，建议删除它。");
}

if (flag("--dry-run")) {
  for (const f of files) log("  " + f.rel);
  log("  manifest.json（最后落盘）");
  process.exit(0);
}

fs.mkdirSync(TARGET, { recursive: true });
for (const d of dirs) fs.mkdirSync(path.join(TARGET, d.rel), { recursive: true });

/* ---------- 1) 普通文件（带校验） ---------- */
const failed = [];
for (const f of files) {
  const dest = path.join(TARGET, f.rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const err = copyVerified(f.rel, dest);
  if (err) failed.push({ rel: f.rel, err });
}

/* ---------- 2) manifest 最后落盘（宿主的安装信号） ---------- */
if (failed.length === 0) {
  const err = copyVerified("manifest.json", path.join(TARGET, "manifest.json"));
  if (err) failed.push({ rel: "manifest.json", err });
}

/* ---------- 3) 校验结果 ---------- */
if (failed.length) {
  log("");
  log("❌ " + failed.length + " 个文件没写成功：");
  for (const f of failed) log("   " + f.rel + " —— " + f.err);
  log("");
  log("常见原因：目标文件被运行中的 MCP 进程占用（Windows），或被杀软拦截。");
  log("处理：先在「插件箱」右键 → 重载插件（或停用插件），再重跑本命令。");
  process.exit(1);
}

log("✓ " + files.length + " 个文件 + manifest.json 全部写入并校验通过");
log("");
log("生效方式（二选一，不用重启 Notrat）：");
log("  · 状态栏「插件箱」→ 右键 " + ID + " → 重载插件");
log("  · 命令面板 → /mcp:reload");
log("");
log("数据目录（配置/记录/日志）：" + path.join(HOME, ".notrat", "plugins", "data", ID));
