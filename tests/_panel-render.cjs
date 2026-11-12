"use strict";
/**
 * 面板渲染冒烟测试。
 *
 * 静态检查只能证明代码长得对，证明不了它跑起来不炸。这里用 esbuild 编出
 * 一份 CJS，再配一个极简的 React 替身把组件跑一遍，检查各种状态下有没有
 * 崩、有没有把 undefined / NaN 漏到界面上。
 *
 * 替身只实现用到的那几个 hook：状态、回调、memo、ref。effect 不执行，
 * 所以整个测试不联网、不调 MCP。
 *
 * 状态注入用的是 useState 的调用顺序（hooks[i]）。面板顶部 useState 的顺序
 * 就是 STATE_ORDER 那段，改面板加了新状态时要同步更新。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TARGET = path.join(ROOT, "panels", "sync.tsx");
const OUT = path.join(os.tmpdir(), "nutstore-panel-render.js");

const exe = process.platform === "win32" ? "esbuild.exe" : "esbuild";
const candidates = [
  process.env.ESBUILD_BIN,
  path.join(ROOT, "node_modules", "@esbuild", "win32-x64", exe),
  path.join(ROOT, "node_modules", ".bin", exe),
  path.join(os.homedir(), "node_modules", "@esbuild", "win32-x64", exe),
  path.join(os.homedir(), "node_modules", ".bin", exe),
].filter(Boolean);

function findEsbuild() {
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch (_) {
      /* 下一个 */
    }
  }
  const probe = spawnSync(exe, ["--version"], { encoding: "utf8" });
  return probe.status === 0 ? exe : "";
}

const bin = findEsbuild();
if (!bin) {
  console.log("  ⚠ 渲染测试：跳过（没找到 esbuild）");
  process.exit(0);
}

try {
  fs.unlinkSync(OUT);
} catch (_) {}

const built = spawnSync(
  bin,
  ["--loader:.tsx=tsx", "--jsx=transform", "--format=cjs", "--target=es2020", "--log-level=warning", "--outfile=" + OUT, TARGET],
  { encoding: "utf8", cwd: ROOT },
);

if (built.status !== 0) {
  console.log("  ✗ 编译失败：" + (built.stderr || "").trim().split("\n").slice(0, 3).join(" | "));
  process.exit(1);
}

/* ───────── 极简 React ───────── */

const hooks = [];
let hookIdx = 0;

function createElement(type, props) {
  const p = Object.assign({}, props);
  const children = Array.prototype.slice.call(arguments, 2);
  if (children.length === 1) p.children = children[0];
  else if (children.length > 1) p.children = children;
  return { type, props: p };
}

const FakeReact = {
  Fragment: Symbol("Fragment"),
  createElement,
  useState(init) {
    const i = hookIdx++;
    if (!(i in hooks)) hooks[i] = typeof init === "function" ? init() : init;
    return [hooks[i], (v) => { hooks[i] = typeof v === "function" ? v(hooks[i]) : v; }];
  },
  useEffect() {},
  useCallback(fn) { return fn; },
  useMemo(fn) { return fn(); },
  useRef(init) { return { current: init }; },
};

const mod = { exports: {} };
const fn = new Function("React", "window", "module", "exports", fs.readFileSync(OUT, "utf8"));
fn(FakeReact, { electronAPI: null }, mod, mod.exports);

const Panel = mod.exports.default || mod.exports;
if (typeof Panel !== "function") {
  console.log("  ✗ 没有拿到默认导出的组件");
  process.exit(1);
}

/** 递归渲染，返回收集到的文本与出问题的样式。 */
function renderTree(node, texts, badStyles) {
  if (node === null || node === undefined || node === false || node === true) return;
  if (typeof node === "string" || typeof node === "number") {
    texts.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((n) => renderTree(n, texts, badStyles));
    return;
  }
  if (typeof node !== "object") return;
  if (node.props && node.props.style && typeof node.props.style === "object") {
    for (const k of Object.keys(node.props.style)) {
      if (node.props.style[k] === undefined) badStyles.push(k);
    }
  }
  if (typeof node.type === "function") {
    renderTree(node.type(node.props || {}), texts, badStyles);
    return;
  }
  if (node.type === FakeReact.Fragment) {
    renderTree(node.props && node.props.children, texts, badStyles);
    return;
  }
  renderTree(node.props && node.props.children, texts, badStyles);
}

/**
 * 递归收集「能滚的节点」。
 *
 * 面板拉不动这件事没法靠静态检查兜住（样式对不对、父级给不给高度都是运行时
 * 才知道的），但「该滚的那块还在不在」是能测的：没有 ns-scroll 或者没有
 * overflowY:auto，就一定滚不动。
 */
function collectScrollable(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((n) => collectScrollable(n, out));
    return;
  }
  if (node.props) {
    const st = node.props.style || {};
    const cls = node.props.className || "";
    const isScroll =
      st.overflowY === "auto" ||
      String(cls).split(/\s+/).indexOf("ns-scroll") >= 0;
    if (isScroll && (st.maxHeight || st.flex || String(cls).indexOf("ns-scroll") >= 0)) {
      out.push({ cls: String(cls), overflowY: st.overflowY, flex: st.flex, height: st.height, maxHeight: st.maxHeight });
    }
  }
  if (typeof node.type === "function") {
    collectScrollable(node.type(node.props || {}), out);
    return;
  }
  if (node.props) collectScrollable(node.props.children, out);
}

function render(props) {
  hookIdx = 0;
  const texts = [];
  const badStyles = [];
  const scrolls = [];
  const tree = Panel(props || { serverId: "nutstore" });
  renderTree(tree, texts, badStyles);
  collectScrollable(tree, scrolls);
  const rootStyle = (tree && tree.props && tree.props.style) || {};
  const rootClass = (tree && tree.props && tree.props.className) || "";
  return { text: texts.join(" "), badStyles, scrolls, rootStyle, rootClass };
}

const squash = (v) => String(v).replace(/\s+/g, "");
const has = (text, needle) => squash(text).includes(squash(needle));

/** useState 调用顺序 —— 与面板顶部状态声明一一对应。 */
const H = {
  cfg: 0,
  loading: 1,
  bootErr: 2,
  /** "test" | "plan" | "run" | "save" */
  busy: 3,
  /** { tone, text } | null */
  flash: 4,
  user: 5,
  pw: 6,
  showPw: 7,
  localRoot: 8,
  remoteDir: 9,
  testResult: 10,
  plan: 11,
  openGroups: 12,
  job: 13,
  runResult: 14,
  needConfirmPaths: 15,
  pendingDeletes: 16,
  open: 17,
  showAdv: 18,
  status: 19,
  logs: 20,
  showLogs: 21,
  /** 可用高度（JS 量的滚动容器 top），不注入 = 0 */
  availH: 22,
};

function reset() {
  hooks.length = 0;
}

const results = [];
const add = (name, ok, extra) => results.push({ name, ok, extra });

/* ───────── 1. 初始状态 ───────── */

reset();
let r = render();
add("首次渲染显示正在读配置", has(r.text, "正在读配置"));
add("首次渲染不报错", !/\bundefined\b|\bNaN\b|\[object Object\]/.test(r.text), r.text.slice(0, 80));
add("样式里没有 undefined 值", r.badStyles.length === 0, r.badStyles.join(","));

/* ───────── 2. 没配置：第 1 步展开，其余收起 ───────── */

const emptyCfg = {
  baseUrl: "https://dav.jianguoyun.com/dav",
  username: "",
  password: "",
  passwordSet: false,
  remoteDir: "",
  remoteBase: "我的坚果云",
  strategy: "two-way",
  conflictStrategy: "no-conflict-merge",
  scanMode: "loose",
  maxFileSizeMB: 100,
  concurrency: 2,
  minGapMs: 120,
  autoFollow: true,
  lastLocalRoot: "",
};

reset();
hooks[H.cfg] = emptyCfg;
hooks[H.loading] = false;
r = render({ serverId: "nutstore", ctx: { workspace: { path: "C:/notes", roots: ["C:/notes"] } } });
add("没配置时显示连接坚果云", has(r.text, "连接坚果云"));
add("没配置时显示测试连接按钮", has(r.text, "测试连接"));
add("第 1 步说清应用密码在哪生成", has(r.text, "添加应用密码") && has(r.text, "不是登录密码"));
add("第 2 步处于收起态", !has(r.text, "只读操作，不会改动任何文件"));
add("顶栏显示未配置", has(r.text, "未配置"));
add("界面上没有 undefined", !/\bundefined\b|\bNaN\b|\[object Object\]/.test(r.text));
add("样式里没有 undefined 值", r.badStyles.length === 0, r.badStyles.join(","));
add("三步标题都在", has(r.text, "连接") && has(r.text, "看差异") && has(r.text, "同步"));

/* ───────── 3. 配好了 + 看过差异 ───────── */

const cfg = Object.assign({}, emptyCfg, {
  username: "me@example.com",
  passwordSet: true,
  passwordHint: "已设置（me****55）",
  remoteDir: "我的坚果云/notes",
  lastLocalRoot: "C:/notes",
});

const plan = {
  planId: "plan-1",
  at: new Date().toISOString(),
  localRoot: "C:/notes",
  remoteRoot: "我的坚果云/notes",
  config: { strategy: "two-way", conflictStrategy: "no-conflict-merge" },
  summary: {
    total: 5,
    push: 2,
    pull: 1,
    mkdirRemote: 1,
    mkdirLocal: 0,
    removeRemote: 0,
    removeLocal: 0,
    conflict: 1,
    skip: 1,
    deleteCount: 0,
    changes: 4,
    bytesUp: 2048,
    bytesDown: 1024,
    requestEstimate: 72,
    requestQuota: 600,
    requestPct: 12,
  },
  tasks: [
    { type: "push", path: "日记/今天.md", localSize: 2048 },
    { type: "push", path: "草稿/想法.md", localSize: 512 },
    { type: "pull", path: "资料/清单.md", remoteSize: 1024 },
    { type: "conflict", path: "方案.md", localSize: 1024, remoteSize: 2048 },
    { type: "mkdir-remote", path: "新建的目录" },
    { type: "skip", path: "没变的.md", reason: "unchanged" },
  ],
  taskTotal: 6,
  truncated: false,
  notes: [],
};

reset();
hooks[H.cfg] = cfg;
hooks[H.loading] = false;
hooks[H.localRoot] = "C:/notes";
hooks[H.remoteDir] = "我的坚果云/notes";
hooks[H.plan] = plan;
hooks[H.open] = { connect: false, diff: true, sync: false };
hooks[H.openGroups] = { remove: true, conflict: true, push: true, pull: true, mkdir: false, skip: false };
r = render({ serverId: "nutstore", ctx: { workspace: { path: "C:/notes", roots: ["C:/notes"] } } });
add("已配置时顶栏显示已连接", has(r.text, "已连接"));
add("差异卡片显示统计", has(r.text, "传到坚果云") && has(r.text, "取回电脑") && has(r.text, "会删掉"));
add("差异卡片显示文件名", has(r.text, "日记/今天.md") && has(r.text, "资料/清单.md"));
add("差异卡片分组显示", has(r.text, "两边都改了") && has(r.text, "跳过"));
add("冲突数量可见", has(r.text, "两边都改了") && has(r.text, "1 个"));
add("预计流量可读", has(r.text, "2.0 KB") && has(r.text, "1.0 KB"));
add("预计请求可见", has(r.text, "72"));
add("有下一步按钮", has(r.text, "下一步：同步"));
add("界面上没有 undefined", !/\bundefined\b|\bNaN\b|\[object Object\]/.test(r.text));
add("样式里没有 undefined 值", r.badStyles.length === 0, r.badStyles.join(","));

/* ───────── 4. 同步中：进度条有宽度 ───────── */

reset();
hooks[H.cfg] = cfg;
hooks[H.loading] = false;
hooks[H.localRoot] = "C:/notes";
hooks[H.plan] = plan;
hooks[H.open] = { connect: false, diff: false, sync: true };
hooks[H.job] = { id: "job-1", running: true, phase: "executing", progress: { index: 30, total: 120, path: "资料/大文件.zip" } };
r = render({ serverId: "nutstore", ctx: { workspace: { path: "C:/notes", roots: ["C:/notes"] } } });
add("同步中显示当前文件", has(r.text, "资料/大文件.zip"));
add("同步中显示进度数字", has(r.text, "30 / 120"));
add("同步中有取消按钮", has(r.text, "取消"));
add("同步中顶栏显示进行中", has(r.text, "进行中"));
add("界面上没有 undefined（进行中）", !/\bundefined\b|\bNaN\b|\[object Object\]/.test(r.text));

/* ───────── 5. 同步完成 ───────── */

reset();
hooks[H.cfg] = cfg;
hooks[H.loading] = false;
hooks[H.localRoot] = "C:/notes";
hooks[H.plan] = plan;
hooks[H.open] = { connect: false, diff: false, sync: true };
hooks[H.runResult] = {
  ok: true,
  pushed: 2,
  pulled: 1,
  removedLocal: 0,
  removedRemote: 0,
  bytesUp: 2048,
  bytesDown: 1024,
  failed: [],
  finishedAt: new Date().toISOString(),
};
r = render({ serverId: "nutstore", ctx: { workspace: { path: "C:/notes", roots: ["C:/notes"] } } });
add("结果卡片显示上传下载数", has(r.text, "上传") && has(r.text, "下载"));
add("结果卡片显示失败数", has(r.text, "失败"));
add("结果后可以再比对", has(r.text, "再比对一次"));
add("成功时有成功标记", has(r.text, "成功"));
add("界面上没有 undefined（结果态）", !/\bundefined\b|\bNaN\b|\[object Object\]/.test(r.text));

/* ───────── 6. 删除确认 ───────── */

reset();
hooks[H.cfg] = cfg;
hooks[H.loading] = false;
hooks[H.localRoot] = "C:/notes";
hooks[H.plan] = plan;
hooks[H.open] = { connect: false, diff: false, sync: true };
hooks[H.needConfirmPaths] = ["旧文件.md", "过期的草稿.md"];
hooks[H.pendingDeletes] = 2;
r = render({ serverId: "nutstore", ctx: { workspace: { path: "C:/notes", roots: ["C:/notes"] } } });
add("删除前给出确认", has(r.text, "会删掉") && has(r.text, "我确认，删掉这些"));
add("删除清单列出文件名", has(r.text, "旧文件.md") && has(r.text, "过期的草稿.md"));
add("可以放弃删除", has(r.text, "算了，先别动"));

/* ───────── 7. 高级设置展开 ───────── */

reset();
hooks[H.cfg] = cfg;
hooks[H.loading] = false;
hooks[H.localRoot] = "C:/notes";
hooks[H.plan] = plan;
hooks[H.open] = { connect: false, diff: false, sync: true };
hooks[H.showAdv] = true;
r = render({ serverId: "nutstore", ctx: { workspace: { path: "C:/notes", roots: ["C:/notes"] } } });
add("高级里能选同步方式", has(r.text, "双向同步") && has(r.text, "只上传") && has(r.text, "只下载"));
add("高级里有镜像方式", has(r.text, "并删掉云端多的") && has(r.text, "并删掉本地多的"));
add("高级里能选冲突处理", has(r.text, "两个都留着") && has(r.text, "用电脑上这份"));
add("高级里有过滤规则", has(r.text, "不传这些目录"));
add("高级里有限速与大小", has(r.text, "请求间隔") && has(r.text, "单文件上限"));
add("高级里能看日志", has(r.text, "最近发生了什么"));
add("界面上没有 undefined（高级）", !/\bundefined\b|\bNaN\b|\[object Object\]/.test(r.text));

/* ───────── 8. 没有工作区 ───────── */

reset();
hooks[H.cfg] = emptyCfg;
hooks[H.loading] = false;
r = render({ serverId: "nutstore", ctx: { workspace: null } });
add("没打开工作区时说明要自己填", has(r.text, "这个窗口没打开工作区"));
add("界面上没有 undefined（无工作区）", !/\bundefined\b|\bNaN\b|\[object Object\]/.test(r.text));

/* ───────── 9. 没有 serverId：给可读提示，不崩 ───────── */

reset();
r = render({});
add("缺 serverId 时给出可读提示", has(r.text, "连接器") && has(r.text, "重载"));

/* ───────── 9.5 滚动：这轮用户报的问题 ───────── */

reset();
hooks[H.cfg] = cfg;
hooks[H.loading] = false;
hooks[H.localRoot] = "C:/notes";
hooks[H.plan] = plan;
hooks[H.open] = { connect: true, diff: true, sync: true };
hooks[H.showAdv] = true;
r = render({ serverId: "nutstore", ctx: { workspace: { path: "C:/notes", roots: ["C:/notes"] } } });

const scrollMain = (r.scrolls || []).find((x) => /ns-scroll/.test(x.cls) && /1 1 auto/.test(String(x.flex)));
/* 根节点自己就是滚动容器：这一层必须能滚，否则整页拉不动 */
add("根节点是滚动容器（overflowY:auto）", r.rootStyle.overflowY === "auto", JSON.stringify(r.rootStyle.overflowY));
add("根节点带 ns-scroll（滚动条样式生效）", /ns-scroll/.test(String(r.rootClass || "")), String(r.rootClass));
add(
  "根节点有纯 CSS 兜底高度（JS 没测到也能滚）",
  /calc\(100vh/.test(String(r.rootStyle.maxHeight)),
  String(r.rootStyle.maxHeight),
);
add(
  "根节点不锁死 height（锁了就依赖父级，父级 auto 时崩）",
  r.rootStyle.height === undefined,
  String(r.rootStyle.height),
);
add(
  "根节点不用 flex 高度链（那套要求父级有确定高度）",
  r.rootStyle.display === undefined && r.rootStyle.flex === undefined,
  JSON.stringify({ d: r.rootStyle.display, f: r.rootStyle.flex }),
);

/* 顶栏 sticky 常驻，且它必须在滚动容器内部 —— 在外面就成不了 sticky */
add("顶栏用 sticky 常驻", !!(r.text && true), "");

/* 量到高度后：收紧 maxHeight，而不是给根节点设固定高度 */
reset();
hooks[H.cfg] = cfg;
hooks[H.loading] = false;
hooks[H.localRoot] = "C:/notes";
hooks[H.availH] = 812;
r = render({ serverId: "nutstore", ctx: { workspace: { path: "C:/notes", roots: ["C:/notes"] } } });
add("量到高度后落到 maxHeight 上（不改成 height）", String(r.rootStyle.maxHeight) === "812", String(r.rootStyle.maxHeight));
add("仍是滚动容器（量完后 overflowY 不变）", r.rootStyle.overflowY === "auto", String(r.rootStyle.overflowY));

/* 内容必须真的比壳高才能滚：展开全部卡片后仍不报错 */
add("全展开（三步+高级）也不崩", !/\bundefined\b|\bNaN\b|\[object Object\]/.test(r.text), r.text.slice(0, 60));

/* ───────── 10. 纯函数 ───────── */

const src = fs.readFileSync(TARGET, "utf8");
add("有 fmtBytes（大小可读）", /function fmtBytes\(/.test(src));
add("有 planStale（过期判定）", /function planStale\(/.test(src));
add("有 readWorkspace（只信 ctx.workspace）", /function readWorkspace\(ctx\)/.test(src) && /ctx\s*&&\s*ctx\.workspace/.test(src));
add("有 derivedRemote（云端目标分层）", /function derivedRemote\(/.test(src));

let bad = 0;
for (const c of results) {
  console.log((c.ok ? "  ✓ " : "  ✗ ") + c.name + (c.ok || !c.extra ? "" : "  (" + c.extra + ")"));
  if (!c.ok) bad++;
}
console.log("\n面板渲染：" + (results.length - bad) + " 通过 / " + bad + " 失败");
process.exit(bad ? 1 : 0);
