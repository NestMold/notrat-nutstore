"use strict";
/**
 * gitignore 风格路径规则（零依赖）。
 *
 * 语义与坚果云插件一致：**最后一条匹配的规则生效**，`!` 开头表示重新包含。
 * 支持：`#` 注释、`!` 取反、尾部 `/` 只匹配目录、`**` 跨层、`*` 不跨 `/`、`?` 单字符、
 * `/` 开头锚定根目录、中间含 `/` 视为锚定（与 gitignore 相同）。
 *
 * 为什么自己写：插件不能带依赖（宿主只跑 `node server/index.js`，没有 node_modules），
 * 而 minimatch/picomatch 都太大且行为细节过多。
 *
 * 本文件是 notrat-nutstore 的一部分，按 AGPL-3.0 发布（全文见包内 LICENSE）。
 * 衍生自 nutstore/obsidian-nutstore-sync (AGPL-3.0)，原项目版权归其作者所有。
 */

function globToRegex(pattern) {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      const isDouble = pattern[i + 1] === "*";
      if (isDouble) {
        const after = pattern[i + 2];
        if (after === "/") {
          out += "(?:.*/)?"; // **/foo → 任意层
          i += 3;
          continue;
        }
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i++;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    if ("\\^$.|+()[]{}".includes(ch)) {
      out += "\\" + ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 编译单条规则。 */
function compileRule(raw) {
  let p = String(raw || "").trim();
  if (!p || p.startsWith("#")) return null;
  let negate = false;
  let dirOnly = false;
  let anchored = false;

  if (p.startsWith("!")) {
    negate = true;
    p = p.slice(1).trim();
    if (!p) return null;
  }
  if (p.endsWith("/")) {
    dirOnly = true;
    p = p.replace(/\/+$/, "");
  }
  if (p.startsWith("/")) {
    anchored = true;
    p = p.replace(/^\/+/, "");
  } else if (p.includes("/")) {
    anchored = true;
  }
  if (!p) return null;

  const body = globToRegex(p);
  // 锚定：从根开始；非锚定：任意层级
  const source = anchored ? "^" + body + "$" : "^(?:.*/)?" + body + "$";
  let re;
  try {
    re = new RegExp(source);
  } catch (_) {
    return null;
  }
  return { raw: String(raw).trim(), negate, dirOnly, anchored, re, pattern: p };
}

/**
 * 编译规则集。
 * @param {string[]} lines 规则文本行
 * @returns {{rules:Array, ignored:(relPath:string,isDir:boolean)=>boolean, explain:(relPath:string,isDir:boolean)=>object|null}}
 */
function compileRules(lines) {
  const rules = (Array.isArray(lines) ? lines : [])
    .map(compileRule)
    .filter(Boolean);

  function matches(rule, relPath, isDir) {
    const p = String(relPath || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (!p) return false;
    if (rule.dirOnly) {
      // 只对目录生效：路径本身是目录，或路径的某个祖先目录命中
      const segs = p.split("/");
      for (let i = 1; i <= segs.length; i++) {
        const prefix = segs.slice(0, i).join("/");
        const isLast = i === segs.length;
        if (isLast && !isDir) continue; // 文件本身不算目录
        if (rule.re.test(prefix)) return true;
      }
      return false;
    }
    // 非目录规则：路径本身命中，或某个祖先目录命中（整个目录被忽略）
    if (rule.re.test(p)) return true;
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i++) {
      if (rule.re.test(segs.slice(0, i).join("/"))) return true;
    }
    return false;
  }

  function explain(relPath, isDir) {
    let hit = null;
    for (const rule of rules) {
      if (matches(rule, relPath, isDir)) hit = rule;
    }
    return hit;
  }

  function ignored(relPath, isDir) {
    const hit = explain(relPath, isDir);
    return !!(hit && !hit.negate);
  }

  return { rules, ignored, explain };
}

/** 把这些规则按「忽略」语义拼起来（excludes + 用 ! 取反的 includes）。 */
function buildIgnoreRules(excludes, includes) {
  const lines = [];
  for (const e of excludes || []) if (String(e).trim()) lines.push(String(e).trim());
  for (const i of includes || []) {
    const s = String(i).trim();
    if (!s) continue;
    lines.push(s.startsWith("!") ? s : "!" + s);
  }
  return compileRules(lines);
}

/**
 * 默认排除 + 用户自己的排除**合并**（不是替换）。
 *
 * 曾经的写法是「用户 excludes 非空就整组丢掉默认值」，于是只要加了一条自定义
 * 规则，`.git/`、`node_modules/` 的保护就一起消失 —— 2 万个文件、几千次请求，
 * 直接顶爆坚果云的频率限制。默认值是底线，用户只能往上加，不能删。
 */
function mergeExcludes(userExcludes) {
  const merged = [];
  const seen = new Set();
  for (const e of DEFAULT_EXCLUDES.concat(Array.isArray(userExcludes) ? userExcludes : [])) {
    const s = String(e == null ? "" : e).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    merged.push(s);
  }
  return merged;
}

const DEFAULT_EXCLUDES = [
  ".git/",
  ".hg/",
  ".svn/",
  "node_modules/",
  ".notrat/",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  "**/*.tmp",
  "**/*.swp",
  "**/~$*",
];

module.exports = {
  compileRules,
  compileRule,
  buildIgnoreRules,
  globToRegex,
  mergeExcludes,
  DEFAULT_EXCLUDES,
};
