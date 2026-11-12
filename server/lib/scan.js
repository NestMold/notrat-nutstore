"use strict";
/**
 * 本地目录扫描。
 *
 * 产出与远程列表**同构**的 stat：{ isDir, size, mtime(ms), path }，这样 decide.js
 * 只需要处理一种数据结构。
 *
 * 约定：
 *   - relPath 一律用 `/` 分隔、不带前导斜杠（跨平台一致，远程也用同一套）；
 *   - mtime 取毫秒，但比较时用秒级容差（坚果云只到秒）；
 *   - 符号链接目录**不展开**（防环）；文件链接按普通文件 stat；
 *   - 超过 maxFileSize 的文件仍然返回，但标 tooLarge:true，由决策层决定 skip。
 *
 * 本文件是 notrat-nutstore 的一部分，按 AGPL-3.0 发布（全文见包内 LICENSE）。
 * 衍生自 nutstore/obsidian-nutstore-sync (AGPL-3.0)，原项目版权归其作者所有。
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { buildIgnoreRules, DEFAULT_EXCLUDES, mergeExcludes } = require("./rules");

function toPosix(p) {
  return String(p).replace(/\\/g, "/");
}

/**
 * @param {string} root 本地根目录（绝对路径）
 * @param {{excludes?:string[], includes?:string[], maxFileSize?:number,
 *          onProgress?:(p:{scanned:number,dirs:number})=>void, shouldCancel?:()=>boolean}} opts
 * @returns {Promise<{root:string, items:Array, map:Map<string,object>, stats:object}>}
 */
async function scanLocal(root, opts) {
  const o = opts || {};
  const absRoot = path.resolve(root);
  const st = await fsp.stat(absRoot).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw new Error("本地目录不存在或不是目录：" + absRoot);
  }
  const ruleSet = buildIgnoreRules(
    mergeExcludes(o.excludes),
    o.includes || [],
  );
  const maxSize = Number.isFinite(o.maxFileSize) && o.maxFileSize > 0 ? o.maxFileSize : Infinity;

  const items = [];
  const map = new Map();
  const stats = { files: 0, dirs: 0, bytes: 0, ignored: 0, tooLarge: 0, errors: [] };
  let scanned = 0;

  /** 深度优先（显式栈，避免递归爆栈）。 */
  const stack = [{ rel: "", abs: absRoot }];
  while (stack.length) {
    if (typeof o.shouldCancel === "function" && o.shouldCancel()) {
      throw Object.assign(new Error("已取消扫描"), { code: "CANCELLED" });
    }
    const cur = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(cur.abs, { withFileTypes: true });
    } catch (e) {
      stats.errors.push({ path: cur.rel || ".", error: String((e && e.message) || e) });
      continue;
    }
    for (const ent of entries) {
      const rel = cur.rel ? cur.rel + "/" + ent.name : ent.name;
      const abs = path.join(cur.abs, ent.name);

      if (ent.isSymbolicLink()) {
        // 文件链接按文件处理，目录链接跳过（防环）
        let lst;
        try {
          lst = await fsp.lstat(abs);
        } catch (_) {
          continue;
        }
        if (lst.isDirectory()) {
          stats.ignored++;
          continue;
        }
      }
      if (ent.isDirectory()) {
        if (ruleSet.ignored(rel, true)) {
          stats.ignored++;
          continue;
        }
        stats.dirs++;
        const item = { path: rel, isDir: true, size: 0, mtime: 0, tooLarge: false };
        items.push(item);
        map.set(rel, item);
        stack.push({ rel, abs });
        continue;
      }
      if (!ent.isFile()) continue;
      if (ruleSet.ignored(rel, false)) {
        stats.ignored++;
        continue;
      }
      let fst;
      try {
        fst = await fsp.lstat(abs);
      } catch (e) {
        stats.errors.push({ path: rel, error: String((e && e.message) || e) });
        continue;
      }
      stats.files++;
      stats.bytes += fst.size;
      const tooLarge = fst.size > maxSize;
      if (tooLarge) stats.tooLarge++;
      const item = {
        path: rel,
        isDir: false,
        size: fst.size,
        mtime: Math.floor(fst.mtimeMs),
        tooLarge,
      };
      items.push(item);
      map.set(rel, item);

      if (++scanned % 200 === 0 && typeof o.onProgress === "function") {
        o.onProgress({ scanned, dirs: stats.dirs, files: stats.files });
      }
    }
  }

  items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { root: absRoot, items, map, stats };
}

/** 读单个本地文件的完整信息（执行阶段用）。 */
async function statLocalFile(root, relPath) {
  const abs = path.join(root, String(relPath).split("/").join(path.sep));
  try {
    const st = await fsp.lstat(abs);
    if (st.isDirectory()) return { path: relPath, isDir: true, size: 0, mtime: Math.floor(st.mtimeMs) };
    return { path: relPath, isDir: false, size: st.size, mtime: Math.floor(st.mtimeMs) };
  } catch (_) {
    return null;
  }
}

/** 安全的相对路径拼接（拒绝 .. 穿越）。 */
function safeJoin(root, relPath) {
  const rel = toPosix(relPath).replace(/^\/+/, "");
  if (rel.split("/").some((s) => s === "..")) {
    throw new Error("非法路径（不允许 .. 穿越）：" + relPath);
  }
  const abs = path.join(root, rel.split("/").join(path.sep));
  const rootAbs = path.resolve(root);
  const resolved = path.resolve(abs);
  if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) {
    throw new Error("非法路径（越出同步根）：" + relPath);
  }
  return resolved;
}

module.exports = { scanLocal, statLocalFile, safeJoin, toPosix };
