/**
 * 坚果云同步 —— 三步面板（连接 → 看差异 → 同步）
 *
 * 本文件是 notrat-nutstore 的一部分，按 AGPL-3.0 发布（全文见包内 LICENSE）。
 * 面板本身为 Notrat 插件模型新写；同步模型源自 nutstore/obsidian-nutstore-sync (AGPL-3.0)。
 *
 * 设计原则（v2）：
 *   1. 一屏只讲一件事。三步各自折叠，做完自动收起；下一步自动展开。
 *   2. 默认路径最短：填账号 → 点测试 → 点看差异 → 点同步。其余全部收进「高级」。
 *   3. 危险动作就地拦。要删文件时，删除清单直接铺在按钮上方，勾了才放行。
 *   4. 能力不缩水：五种策略、四种冲突处理、过滤规则、限速都在，只是分层摆放。
 *
 * 数据只走 MCP 工具，面板自己不读写磁盘。
 * serverId 由宿主通过 props 传进来；拿不到就直说，不猜。
 */
const { useState, useEffect, useCallback, useRef, useMemo } = React;

/* ============================ 常量 ============================ */

/** 三种常用策略：摆在外面，一眼能选完。 */
const QUICK_STRATEGIES = [
  {
    id: "two-way",
    label: "双向同步",
    hint: "两边谁改了同步谁，不删对方独有的文件",
    icon: "swap",
  },
  {
    id: "send-only",
    label: "只上传",
    hint: "把电脑上的传上去，云端多出来的不动",
    icon: "up",
  },
  {
    id: "receive-only",
    label: "只下载",
    hint: "把云端的取下来，电脑上多出来的不动",
    icon: "down",
  },
];

/** 两种「覆盖另一端」的方式：会删文件，只在「高级」里出现。 */
const MIRROR_STRATEGIES = [
  {
    id: "send-only-override-changes",
    label: "只上传，并删掉云端多的",
    hint: "以电脑为准，坚果云上多出来的文件会被删除",
  },
  {
    id: "receive-only-revert-local-changes",
    label: "只下载，并删掉本地多的",
    hint: "以坚果云为准，电脑上多出来的文件会被删除",
  },
];

const STRATEGY_LABEL = {};
for (const s of QUICK_STRATEGIES) STRATEGY_LABEL[s.id] = s.label;
for (const s of MIRROR_STRATEGIES) STRATEGY_LABEL[s.id] = s.label;

const isMirror = (id) => MIRROR_STRATEGIES.some((s) => s.id === id);

const CONFLICTS = [
  {
    id: "no-conflict-merge",
    label: "两个都留着",
    hint: "推荐。电脑上那份不动，云端那份另存成一个新文件，你自己挑",
  },
  {
    id: "local-priority",
    label: "用电脑上这份",
    hint: "用电脑上的文件盖掉云端那份",
  },
  {
    id: "server-priority",
    label: "用坚果云这份",
    hint: "用云端的文件盖掉电脑上的，本地旧版另存一份",
  },
  {
    id: "diff3",
    label: "试着合在一起",
    hint: "本插件没存基线内容，实际会退化成「两个都留着」",
  },
];

const CONFLICT_LABEL = {};
for (const c of CONFLICTS) CONFLICT_LABEL[c.id] = c.label;

/** 临时产物目录：反复变、传上去没意义。勾上就写进 excludes。 */
const TEMP_DIRS = [
  { id: "node_modules/", label: "node_modules", hint: "依赖" },
  { id: "dist/", label: "dist", hint: "构建产物" },
  { id: "preview/", label: "preview", hint: "预览截图" },
  { id: "_preview/", label: "_preview", hint: "预览产物" },
  { id: ".browser/", label: ".browser", hint: "浏览器快照" },
  { id: ".scratch/", label: ".scratch", hint: "临时草稿" },
  { id: "_bench/", label: "_bench", hint: "压测数据" },
  { id: "_diag/", label: "_diag", hint: "诊断输出" },
];

/** 计划里的任务类型 → 中文 + 分组顺序。 */
const TASK_GROUPS = [
  { key: "remove", types: ["remove-local", "remove-remote"], label: "会删掉的", tone: "err", open: true },
  { key: "conflict", types: ["conflict"], label: "两边都改了", tone: "warn", open: true },
  { key: "push", types: ["push"], label: "传到坚果云", tone: "primary", open: true },
  { key: "pull", types: ["pull"], label: "取回电脑", tone: "primary", open: true },
  { key: "mkdir", types: ["mkdir-local", "mkdir-remote"], label: "新建文件夹", tone: "muted", open: false },
  { key: "skip", types: ["skip"], label: "跳过", tone: "muted", open: false },
];

const TYPE_LABEL = {
  push: "上传",
  pull: "下载",
  "mkdir-local": "建文件夹",
  "mkdir-remote": "建文件夹",
  "remove-local": "删除",
  "remove-remote": "删除",
  conflict: "冲突",
  skip: "跳过",
};

/** 数据目录里的常见事件 → 人话。 */
const LOG_LABEL = {
  "config-set": "改了一项设置",
  test: "测了一次连接",
  run: "同步结束",
  "run-error": "同步出错",
  resolve: "处理了冲突",
  plan: "看了一遍要传什么",
};

/**
 * 面板构建标记（排障用）。
 *
 * 平时留空，界面上不显示。遇到「改了面板但看起来没生效」时，把它改成任意
 * 字符串重新装一次：界面上出现这个标记 = 代码确实重新编译过了，没出现 =
 * 宿主还在用内存里的旧组件（要重载插件或重启应用）。比反复猜省事得多。
 *
 * 发布时留空：界面上挂一个和 manifest 版本对不上的字符串只会让人困惑。
 */
const VERSION_TAG = "";

const R = { sm: 6, md: 8, lg: 10, xl: 12, pill: 999 };

const C = {
  ok: "hsl(var(--status-success-text, 142 71% 32%))",
  warn: "hsl(var(--status-warning-text, 32 90% 38%))",
  err: "hsl(var(--status-error-text, 0 72% 48%))",
  line: "hsl(var(--border))",
  soft: "hsl(var(--border) / 0.6)",
  muted: "hsl(var(--muted-foreground))",
  fg: "hsl(var(--foreground))",
  primary: "hsl(var(--primary))",
  card: "hsl(var(--card))",
};

/** 一层薄薄的主题色，省得每条都写 hsl()。 */
const tint = (color, alpha) => "hsl(var(--" + color + ") / " + alpha + ")";

const S = {
  /**
   * 外壳：顶栏固定，中间一块独立滚动。
   *
   * 之前是 height:100% + overflow:auto 直接套在最外层 —— 宿主没给父级
   * 确定高度时，100% 会塌成「内容高度」，滚动条根本不会出现，内容被裁在
   * 可视区外面，用户看到的就是「拉不动」。现在拆成两层：外壳撑满、内层滚。
   */
  /**
   * 唯一的滚动容器。
   *
   * 为什么不用「两层 flex + 百分比高度」：那套要求宿主给一个确定高度的父级，
   * 而标签页形态下宿主的容器常常是 auto —— 百分比退化、min-height 链失效，
   * 最后就是内容被裁、谁也滚不动（前两版都栽在这）。
   *
   * 现在只有一条规则：**自己限高、自己滚**。limit 用视口算，不依赖任何祖先；
   * JS 量到真实位置后再收紧成像素值。顶栏用 sticky 常驻在这一层里。
   */
  root: {
    overflowY: "auto",
    overflowX: "hidden",
    overscrollBehavior: "contain",
    boxSizing: "border-box",
    color: C.fg,
    fontSize: 13,
    lineHeight: 1.55,
    /** CSS 兜底：JS 还没测量时也能滚。数值偏小无害（只是多一截空白）。 */
    maxHeight: "calc(100vh - 96px)",
  },
  body: {
    maxWidth: 780,
    margin: "0 auto",
    padding: "14px 20px 48px",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    boxSizing: "border-box",
  },

  /* --- 顶栏 --- */
  head: {
    position: "sticky",
    top: 0,
    zIndex: 5,
    background: "hsl(var(--background))",
    borderBottom: "1px solid " + C.soft,
  },
  headIn: {
    maxWidth: 780,
    margin: "0 auto",
    padding: "14px 20px 12px",
    display: "flex",
    alignItems: "center",
    gap: 11,
    boxSizing: "border-box",
  },
  logo: {
    width: 36,
    height: 36,
    flex: "0 0 auto",
    borderRadius: R.lg,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: tint("primary", 0.12),
    color: C.primary,
  },
  h1: { fontSize: 15, fontWeight: 650, lineHeight: 1.3, letterSpacing: "-0.01em" },
  h1sub: { fontSize: 11.5, color: C.muted, lineHeight: 1.4, marginTop: 1 },

  /* --- 进度条 --- */
  steps: {
    maxWidth: 780,
    margin: "0 auto",
    padding: "0 20px 11px",
    display: "flex",
    alignItems: "center",
    gap: 8,
    boxSizing: "border-box",
  },
  stepDot: {
    width: 20,
    height: 20,
    flex: "0 0 auto",
    borderRadius: R.pill,
    border: "1px solid " + C.line,
    color: C.muted,
    fontSize: 11,
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "all 140ms",
  },
  stepDotOn: { borderColor: C.primary, color: C.primary, background: tint("primary", 0.12) },
  stepDotDone: { borderColor: C.ok, color: C.ok, background: tint("status-success-text", 0.12) },
  stepDotErr: { borderColor: C.err, color: C.err, background: tint("status-error-text", 0.12) },
  stepLine: { flex: 1, height: 1, background: C.line, minWidth: 6 },
  stepLabel: { fontSize: 11.5, color: C.muted, whiteSpace: "nowrap" },
  stepLabelOn: { color: C.fg, fontWeight: 600 },

  /* --- 卡片 --- */
  card: {
    border: "1px solid " + C.line,
    borderRadius: R.xl,
    background: C.card,
    boxShadow: "0 1px 2px hsl(var(--foreground) / 0.035)",
    boxSizing: "border-box",
    overflow: "hidden",
  },
  cardHead: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "12px 15px",
    boxSizing: "border-box",
    cursor: "pointer",
    userSelect: "none",
  },
  cardBody: {
    padding: "2px 15px 15px",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  no: {
    width: 22,
    height: 22,
    flex: "0 0 auto",
    borderRadius: R.pill,
    border: "1px solid " + C.line,
    color: C.muted,
    fontSize: 11.5,
    fontWeight: 650,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  noOn: { borderColor: C.primary, color: C.primary, background: tint("primary", 0.12) },
  noDone: { borderColor: C.ok, color: C.ok, background: tint("status-success-text", 0.12) },
  cardTitle: { fontSize: 13.5, fontWeight: 620, lineHeight: 1.4 },
  cardSum: { fontSize: 11.5, color: C.muted, lineHeight: 1.45, marginTop: 1 },
  cardTail: { marginLeft: "auto", flex: "0 0 auto", display: "flex", alignItems: "center", gap: 8 },

  /* --- 通用块 --- */
  row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  field: { display: "flex", flexDirection: "column", gap: 5 },
  label: { fontSize: 11.5, color: C.muted, fontWeight: 500 },
  hint: { fontSize: 11.5, color: C.muted, lineHeight: 1.5 },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "7px 10px",
    borderRadius: R.md,
    border: "1px solid " + C.line,
    background: "hsl(var(--background))",
    color: C.fg,
    fontSize: 12.5,
    lineHeight: 1.5,
    fontFamily: "inherit",
    outline: "none",
  },
  mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11.5 },

  btn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "7px 13px",
    borderRadius: R.md,
    border: "1px solid transparent",
    background: C.primary,
    color: "hsl(var(--primary-foreground))",
    fontSize: 12.5,
    fontWeight: 550,
    fontFamily: "inherit",
    cursor: "pointer",
    whiteSpace: "nowrap",
    boxSizing: "border-box",
    transition: "opacity 120ms",
  },
  btn2: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "7px 13px",
    borderRadius: R.md,
    border: "1px solid " + C.line,
    background: "transparent",
    color: C.fg,
    fontSize: 12.5,
    fontWeight: 500,
    fontFamily: "inherit",
    cursor: "pointer",
    whiteSpace: "nowrap",
    boxSizing: "border-box",
  },
  btnGhost: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "3px 7px",
    borderRadius: R.sm,
    border: "1px solid transparent",
    background: "transparent",
    color: C.muted,
    fontSize: 11.5,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  btnDanger: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "7px 13px",
    borderRadius: R.md,
    border: "1px solid " + tint("status-error-text", 0.45),
    background: tint("status-error-text", 0.1),
    color: C.err,
    fontSize: 12.5,
    fontWeight: 550,
    fontFamily: "inherit",
    cursor: "pointer",
  },
  big: { width: "100%", padding: "11px 16px", fontSize: 13.5, fontWeight: 600 },

  /* --- 选项卡 --- */
  opts: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 },
  opt: {
    textAlign: "left",
    padding: "10px 12px",
    borderRadius: R.lg,
    border: "1px solid " + C.line,
    background: "hsl(var(--background))",
    color: C.fg,
    fontFamily: "inherit",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    gap: 3,
    boxSizing: "border-box",
    transition: "border-color 120ms, background 120ms",
  },
  optOn: { borderColor: C.primary, background: tint("primary", 0.07), boxShadow: "0 0 0 1px " + tint("primary", 0.35) },
  optLabel: { fontSize: 12.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 },
  optHint: { fontSize: 11, color: C.muted, lineHeight: 1.45 },

  /* --- pill --- */
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    flex: "0 0 auto",
    fontSize: 11,
    lineHeight: 1.7,
    padding: "0 8px",
    borderRadius: R.pill,
    border: "1px solid " + C.line,
    color: C.muted,
    whiteSpace: "nowrap",
  },
  pillOk: { color: C.ok, borderColor: tint("status-success-text", 0.4), background: tint("status-success-text", 0.08) },
  pillWarn: { color: C.warn, borderColor: tint("status-warning-text", 0.4), background: tint("status-warning-text", 0.08) },
  pillErr: { color: C.err, borderColor: tint("status-error-text", 0.4), background: tint("status-error-text", 0.08) },
  pillOn: { color: C.primary, borderColor: tint("primary", 0.4), background: tint("primary", 0.08) },

  /* --- 统计条 --- */
  stats: { display: "flex", gap: 6, flexWrap: "wrap" },
  stat: {
    flex: "1 1 0",
    minWidth: 86,
    padding: "9px 11px",
    borderRadius: R.lg,
    border: "1px solid " + C.line,
    background: "hsl(var(--background))",
    boxSizing: "border-box",
  },
  statVal: { fontSize: 17, fontWeight: 650, lineHeight: 1.2, fontVariantNumeric: "tabular-nums" },
  statLabel: { fontSize: 11, color: C.muted, marginTop: 2 },

  /* --- 提示条 --- */
  note: {
    display: "flex",
    gap: 8,
    padding: "9px 11px",
    borderRadius: R.lg,
    fontSize: 11.5,
    lineHeight: 1.55,
    border: "1px solid " + C.soft,
    background: tint("muted", 0.06),
    color: C.muted,
    boxSizing: "border-box",
  },
  noteWarn: { borderColor: tint("status-warning-text", 0.35), background: tint("status-warning-text", 0.07), color: C.warn },
  noteErr: { borderColor: tint("status-error-text", 0.35), background: tint("status-error-text", 0.07), color: C.err },
  noteOk: { borderColor: tint("status-success-text", 0.35), background: tint("status-success-text", 0.07), color: C.ok },

  /* --- 任务清单 --- */
  group: { border: "1px solid " + C.soft, borderRadius: R.lg, overflow: "hidden", boxSizing: "border-box" },
  groupHead: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "7px 10px",
    background: tint("muted", 0.06),
    cursor: "pointer",
    userSelect: "none",
    fontSize: 11.5,
    fontWeight: 550,
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "5px 10px",
    borderTop: "1px solid " + tint("border", 0.5),
    fontSize: 11.5,
    lineHeight: 1.5,
  },
  itemPath: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  itemMeta: { flex: "0 0 auto", color: C.muted, fontSize: 11, fontVariantNumeric: "tabular-nums" },

  /* --- 进度 --- */
  bar: { height: 6, borderRadius: R.pill, background: tint("muted", 0.18), overflow: "hidden" },
  barIn: { height: "100%", background: C.primary, borderRadius: R.pill, transition: "width 220ms ease" },

  /* --- 高级区 --- */
  adv: {
    border: "1px dashed " + C.line,
    borderRadius: R.xl,
    padding: "0 15px",
    boxSizing: "border-box",
    background: "hsl(var(--card) / 0.5)",
  },
  advHead: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "11px 0",
    cursor: "pointer",
    userSelect: "none",
    fontSize: 12.5,
    fontWeight: 550,
    color: C.muted,
  },
  advBody: { display: "flex", flexDirection: "column", gap: 14, paddingBottom: 15 },
  hr: { height: 1, background: C.soft, margin: 0, border: 0 },

  empty: { textAlign: "center", padding: "22px 10px", color: C.muted, fontSize: 12 },
};

/* ============================ 图标 ============================ */

const ICONS = {
  cloud: "M4.8 12.4a3 3 0 0 1-.3-5.9 4.3 4.3 0 0 1 8.1-1.1 2.8 2.8 0 0 1-.5 5.5H4.8Z",
  check: "M3.3 8.4l3 3 6.4-6.8",
  chevron: "M4.4 6.4L8 10l3.6-3.6",
  eye: ["M1.6 8S4.2 3.8 8 3.8 14.4 8 14.4 8 11.8 12.2 8 12.2 1.6 8 1.6 8Z", "M8 6.3a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4"],
  eyeOff: ["M2 2l12 12", "M6.4 4.2A7.6 7.6 0 0 1 8 4c3.8 0 6.4 4 6.4 4a12 12 0 0 1-2.2 2.6", "M4.2 5.4A11.6 11.6 0 0 0 1.6 8S4.2 12 8 12c.7 0 1.3-.1 1.9-.3"],
  folder: "M1.8 5.2a1.4 1.4 0 0 1 1.4-1.4h2.6l1.4 1.8h4.6a1.4 1.4 0 0 1 1.4 1.4v3.8a1.4 1.4 0 0 1-1.4 1.4H3.2a1.4 1.4 0 0 1-1.4-1.4V5.2Z",
  refresh: ["M13.2 8a5.2 5.2 0 1 1-1.6-3.8", "M13.4 2.5v3.2h-3.2"],
  alert: ["M8 3.2l5.2 9.4H2.8L8 3.2Z", "M8 6.6v2.6", "M8 11.3h.01"],
  list: ["M3 4.4h10", "M3 8h10", "M3 11.6h10"],
  settings: ["M2.6 5.4h10.8", "M2.6 10.6h10.8", "M5.6 3.4v4", "M10.4 8.6v4"],
  x: "M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2",
  up: ["M8 12.6V3.6", "M4.2 7.4 8 3.6l3.8 3.8"],
  down: ["M8 3.4v9", "M4.2 8.6 8 12.4l3.8-3.8"],
  swap: ["M3 5.4h8.2", "M8.8 3.2 11.2 5.4 8.8 7.6", "M13 10.6H4.8", "M7.2 8.4 4.8 10.6 7.2 12.8"],
  external: ["M6.4 3.4H4.2a1 1 0 0 0-1 1v7.2a1 1 0 0 0 1 1h7.2a1 1 0 0 0 1-1V9.6", "M9.4 2.6h4v4", "M13.2 2.8 7.8 8.2"],
  play: "M5.6 3.6 12 8l-6.4 4.4V3.6Z",
  stop: "M4.6 4.6h6.8v6.8H4.6Z",
  key: ["M6.4 9.6a2.8 2.8 0 1 1 0-5.6 2.8 2.8 0 0 1 0 5.6Z", "M8.6 9.4 13 13.8", "M11.4 11.6l1.2-1.2"],
};

function Icon(props) {
  const d = ICONS[props.name];
  if (!d) return null;
  const list = Array.isArray(d) ? d : [d];
  const size = props.size || 16;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={props.width || 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={props.style}
      aria-hidden="true"
    >
      {list.map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
}

function Spin(props) {
  return (
    <span
      style={{
        display: "inline-block",
        width: props.size || 13,
        height: props.size || 13,
        borderRadius: "50%",
        border: "2px solid currentColor",
        borderTopColor: "transparent",
        animation: "ns-rotate 700ms linear infinite",
      }}
    />
  );
}

/** 面板级 CSS：只放伪类与动画，Tailwind 表达不了的那部分。 */
function Sheet() {
  return (
    <style>{`
      .ns-btn:hover:not(:disabled) { opacity: .9; }
      .ns-btn:disabled, .ns-btn2:disabled, .ns-btnD:disabled { opacity: .45; cursor: not-allowed; }
      .ns-btn2:hover:not(:disabled) { background: hsl(var(--accent)); }
      .ns-btnG:hover:not(:disabled) { background: hsl(var(--accent)); color: hsl(var(--foreground)); }
      .ns-opt:hover { border-color: hsl(var(--muted-foreground) / .45); }
      .ns-inp:hover { border-color: hsl(var(--muted-foreground) / .4); }
      .ns-inp:focus { border-color: hsl(var(--ring)); box-shadow: 0 0 0 3px hsl(var(--ring) / .14); }
      .ns-headClick:hover { background: hsl(var(--accent) / .55); }
      .ns-btn:focus-visible, .ns-btn2:focus-visible, .ns-btnG:focus-visible, .ns-opt:focus-visible,
      .ns-inp:focus-visible, .ns-chip:focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 1px; }
      .ns-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
      .ns-scroll::-webkit-scrollbar-thumb { background: hsl(var(--border)); border-radius: 8px; border: 2px solid transparent; background-clip: content-box; }
      .ns-scroll::-webkit-scrollbar-track { background: transparent; }
      @keyframes ns-rotate { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { * { animation-duration: .01ms !important; transition-duration: .01ms !important; } }
    `}</style>
  );
}

/* ============================ 小工具组件 ============================ */

function Pill(props) {
  const tone = props.tone || "";
  const extra =
    tone === "ok" ? S.pillOk : tone === "warn" ? S.pillWarn : tone === "err" ? S.pillErr : tone === "on" ? S.pillOn : null;
  return (
    <span style={Object.assign({}, S.pill, extra, props.style)} title={props.title}>
      {props.children}
    </span>
  );
}

function Stat(props) {
  return (
    <div style={Object.assign({}, S.stat, props.style)}>
      <div style={Object.assign({}, S.statVal, props.tone === "err" ? { color: C.err } : props.tone === "warn" ? { color: C.warn } : props.tone === "ok" ? { color: C.ok } : props.tone === "primary" ? { color: C.primary } : null)}>
        {props.value}
      </div>
      <div style={S.statLabel}>{props.label}</div>
    </div>
  );
}

function Note(props) {
  const tone = props.tone || "";
  const extra = tone === "warn" ? S.noteWarn : tone === "err" ? S.noteErr : tone === "ok" ? S.noteOk : null;
  return (
    <div style={Object.assign({}, S.note, extra, props.style)}>
      {tone === "warn" || tone === "err" ? <Icon name="alert" size={14} style={{ flex: "0 0 auto", marginTop: 1 }} /> : null}
      <div style={{ flex: 1, minWidth: 0 }}>{props.children}</div>
    </div>
  );
}

function Btn(props) {
  const base = props.variant === "2" ? S.btn2 : props.variant === "ghost" ? S.btnGhost : props.variant === "danger" ? S.btnDanger : S.btn;
  const cls = props.variant === "ghost" ? "ns-btnG" : props.variant === "2" ? "ns-btn2" : props.variant === "danger" ? "ns-btnD" : "ns-btn";
  return (
    <button
      type="button"
      className={cls}
      style={Object.assign({}, base, props.big ? S.big : null, props.style)}
      disabled={props.disabled}
      onClick={props.onClick}
      title={props.title}
    >
      {props.busy ? <Spin size={12} /> : props.icon ? <Icon name={props.icon} size={14} /> : null}
      {props.children}
    </button>
  );
}

function Field(props) {
  return (
    <label style={Object.assign({}, S.field, props.style)}>
      <span style={S.label}>
        {props.label}
        {props.optional ? <span style={{ opacity: 0.7 }}>（可选）</span> : null}
      </span>
      {props.children}
      {props.hint ? <span style={S.hint}>{props.hint}</span> : null}
    </label>
  );
}

function TextInput(props) {
  return (
    <input
      className="ns-inp"
      style={Object.assign({}, S.input, props.mono ? S.mono : null, props.style)}
      type={props.type || "text"}
      value={props.value == null ? "" : props.value}
      placeholder={props.placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => props.onChange(e.target.value)}
      onBlur={(e) => props.onBlur && props.onBlur(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && props.onEnter) props.onEnter(e.target.value);
      }}
      disabled={props.disabled}
    />
  );
}

/* ============================ 数据层工具 ============================ */

function tryParseJson(s) {
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

/** 把 MCP 返回的 content 包装拆成业务对象。 */
function unpack(res) {
  if (!res) return { ok: false, error: "没有任何返回" };
  if (typeof res === "string") return tryParseJson(res) || { ok: true, text: res };
  if (typeof res !== "object") return { ok: true, text: String(res) };
  if (res.result && (res.result.content || res.result.isError)) return unpack(res.result);
  const first = Array.isArray(res.content) ? res.content[0] : null;
  const text = first && typeof first.text === "string" ? first.text : null;
  if (text !== null) {
    const parsed = tryParseJson(text);
    if (parsed && typeof parsed === "object") return parsed;
    return res.isError ? { ok: false, error: text } : { ok: true, text: text };
  }
  return res;
}

/**
 * 把失败返回压成一句能看懂、又不丢信息的话。
 *
 * 契约（有测试盯着）：
 *   · 字符串原样返回，不加前缀；
 *   · code / error / hint / message 里有多少写多少；
 *   · 陌生形状要把原始返回摊出来，绝不能只剩一句「失败」；
 *   · null / undefined 说清「没拿到返回」；
 *   · 任何输入都不许返回空串 —— 面板渲染空串等于什么都看不到。
 */
function errMsg(r, fallback) {
  const pre = fallback ? fallback + "：" : "";
  if (r === null || r === undefined) {
    return pre + "没有收到返回，插件服务可能已经退出，重载 Notrat 再试一次";
  }
  if (typeof r === "string") return r.trim() ? r : pre + "返回是空字符串";
  if (typeof r !== "object") return pre + String(r);

  const parts = [];
  const seen = {};
  for (const k of ["error", "message", "hint", "code"]) {
    const v = r[k];
    if (v === null || v === undefined || v === "") continue;
    const t = String(v);
    if (seen[t]) continue;
    seen[t] = 1;
    parts.push(k === "code" ? "（" + t + "）" : t);
  }
  if (r.text && typeof r.text === "string" && r.text !== "{}" && r.text !== "null") {
    if (!seen[r.text]) parts.push(r.text.slice(0, 400));
  }
  if (parts.length) return pre + parts.join(" ");

  // 陌生形状：把能看到的字段摊出来，比一句「失败」有用得多
  let raw = "";
  try {
    raw = JSON.stringify(r);
  } catch (_) {
    raw = "";
  }
  if (raw && raw !== "{}" && raw !== "null") return pre + raw.slice(0, 400);
  return pre + "返回里没有错误信息";
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v <= 0) return "0";
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + " MB";
  return (v / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

function fmtTime(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!t) return String(iso);
  const d = new Date(t);
  const now = Date.now();
  const diff = now - t;
  if (diff >= 0 && diff < 60000) return "刚刚";
  if (diff >= 0 && diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
  if (diff >= 0 && diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}


function normRule(s) {
  return String(s == null ? "" : s).trim().replace(/\/+$/, "").toLowerCase();
}

function normDir(v) {
  return String(v == null ? "" : v).replace(/^\/+|\/+$/g, "");
}

function looksAbsPath(v) {
  if (typeof v !== "string" || v.length < 3) return false;
  const c0 = v.charCodeAt(0);
  const c1 = v.charCodeAt(1);
  const c2 = v.charCodeAt(2);
  const isLetter = (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122);
  const driveLike = isLetter && c1 === 58 && (c2 === 47 || c2 === 92);
  return driveLike || c0 === 47;
}

/** 取路径最后一段，当列表标题。 */
function baseName(v) {
  const t = String(v || "").replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
  return i >= 0 ? t.slice(i + 1) || t : t;
}

function joinRemote() {
  const parts = [];
  for (let i = 0; i < arguments.length; i++) {
    const s = String(arguments[i] == null ? "" : arguments[i]).trim().replace(/^\/+|\/+$/g, "");
    if (s) parts.push(s);
  }
  return parts.join("/");
}

/**
 * 读宿主的工作区。
 *
 * 唯一合法来源是 ctx.workspace（live）。ctx.workspace 为 null = 这个窗口没打开
 * 工作区，返回空让界面提示用户，**不退回任何探测**（猜 electronAPI 全是 undefined，
 * 而且 getWorkspaceDir() 返回的是 <工作区>/.notrat/plugins，不是项目根）。
 */
function readWorkspace(ctx) {
  const none = { space: "", roots: [], active: "", unavailable: true };
  const ws = ctx && ctx.workspace;
  if (!ws || !looksAbsPath(ws.path)) return none;
  const listed = Array.isArray(ws.roots)
    ? ws.roots.map((r) => (r && typeof r.path === "string" ? r.path : r)).filter(looksAbsPath)
    : [];
  return {
    space: (ctx.space && ctx.space.name) || "",
    roots: listed.length ? listed : [ws.path],
    active: ws.path,
    unavailable: false,
  };
}

/**
 * 把一段文本洗成能当文件夹名的样子。
 *
 * 工作空间名可以是用户随手起的「notrat-payment + notrat-plugins + …」，
 * 直接拼进云端路径会得到一串带加号和空格的目录名，在手机上看着像乱码。
 * 这里只做最小清洗：去掉非法字符、把分隔符收成单个短横线、限长 40。
 */
function safeSeg(v) {
  const BAD = "\\/:*?\"<>|+、， \t";
  const src = String(v == null ? "" : v);
  let out = "";
  for (let i = 0; i < src.length; i++) {
    out += BAD.indexOf(src[i]) >= 0 ? "-" : src[i];
  }
  return out.split("-").filter(Boolean).join("-").slice(0, 40);
}
/**
 * 跟随模式下算云端目标：<云端根>/<工作区名>。
 *
 * 为什么不把工作空间名也拼进去：一个工作空间常常是「4 个仓库放一起」，
 * 名字本身就长（"a + b + c + d"），洗成目录名后是 40 个字符的短横线串，
 * 在手机上看就是乱码。一个项目一个目录最可读；真需要分组，用户改这一栏即可。
 */
function derivedRemote(ws, localRoot, baseRemote) {
  return joinRemote(baseRemote, safeSeg(localRoot ? baseName(localRoot) : ""));
}

/** 计划是否已经过期（策略/目标改过，或超过 10 分钟）。 */
function planStale(plan, cfg) {
  if (!plan) return "";
  const pc = plan.config || {};
  if (cfg && pc.strategy && pc.strategy !== cfg.strategy) return "strategy";
  if (cfg && pc.conflictStrategy && pc.conflictStrategy !== cfg.conflictStrategy) return "conflict";
  if (plan.remoteRoot != null && cfg && normDir(plan.remoteRoot) !== normDir(cfg.remoteDir)) return "remote";
  if (plan.at && Date.now() - Date.parse(plan.at) > 10 * 60 * 1000) return "expired";
  return "";
}

const STALE_TEXT = {
  strategy: "同步方式改过了，重新看一遍差异再同步",
  conflict: "冲突处理改过了，重新看一遍差异再同步",
  remote: "云端文件夹改过了，重新看一遍差异再同步",
  expired: "这份差异是 10 分钟前算的，可能已经不准了",
};

/* ============================ 步骤卡片 ============================ */

/**
 * 一步一张卡。
 *
 * **必须是模块作用域组件**：定义在面板内部的话，每次父组件重渲染都会产生新的
 * 组件标识，React 会把整棵子树卸载重挂 —— 输入框每敲一个字就丢焦点。这个坑踩过。
 */
function StepCard(p) {
  const isOpen = !!p.open;
  const noStyle = p.done ? S.noDone : isOpen ? S.noOn : p.tone === "err" ? Object.assign({}, S.no, { borderColor: C.err, color: C.err, background: tint("status-error-text", 0.12) }) : null;
  return (
    <section style={Object.assign({}, S.card, p.dim ? { opacity: 0.72 } : null)}>
      <div
        className={p.clickable === false ? "" : "ns-headClick"}
        style={S.cardHead}
        onClick={() => p.clickable !== false && p.onToggle && p.onToggle()}
        role={p.clickable === false ? undefined : "button"}
        tabIndex={p.clickable === false ? undefined : 0}
        onKeyDown={(e) => {
          if (p.clickable !== false && p.onToggle && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            p.onToggle();
          }
        }}
      >
        <div style={Object.assign({}, S.no, noStyle)}>
          {p.done ? <Icon name="check" size={12} width={2.4} /> : p.n}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={S.cardTitle}>{p.title}</div>
          {p.summary ? <div style={S.cardSum}>{p.summary}</div> : null}
        </div>
        <div style={S.cardTail}>
          {p.tail}
          {p.clickable === false ? null : (
            <Icon
              name="chevron"
              size={15}
              style={{ color: C.muted, transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 140ms" }}
            />
          )}
        </div>
      </div>
      {isOpen ? <div style={S.cardBody}>{p.children}</div> : null}
    </section>
  );
}

/* ============================ 任务清单 ============================ */

/** 一组计划任务。同样必须在模块作用域，理由同 StepCard。 */
function TaskList(p) {
  const tasks = p.tasks || [];
  if (!tasks.length) return null;
  const isOpen = !!p.open;
  const color = p.tone === "err" ? C.err : p.tone === "warn" ? C.warn : p.tone === "primary" ? C.primary : C.muted;
  const shown = isOpen ? tasks.slice(0, 200) : [];
  const bytes = p.key_ === "push" ? p.bytesUp : p.key_ === "pull" ? p.bytesDown : 0;
  return (
    <div style={S.group}>
      <div style={S.groupHead} onClick={p.onToggle} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p.onToggle(); } }}>
        <Icon
          name="chevron"
          size={13}
          style={{ color: C.muted, transform: isOpen ? "none" : "rotate(-90deg)", transition: "transform 140ms" }}
        />
        <span style={{ color: color, fontWeight: 600 }}>{p.label}</span>
        <span style={{ color: C.muted }}>{tasks.length} 个</span>
        <span style={{ marginLeft: "auto", color: C.muted, fontSize: 11 }}>{fmtBytes(bytes) === "0" ? "" : fmtBytes(bytes)}</span>
      </div>
      {shown.map((t, i) => (
        <div key={i} style={S.item} className="ns-row">
          <span style={S.itemPath} title={t.path}>{t.path}</span>
          {t.localSize != null || t.remoteSize != null ? (
            <span style={S.itemMeta}>{fmtBytes(t.localSize != null ? t.localSize : t.remoteSize)}</span>
          ) : null}
          {t.detail ? (
            <span style={Object.assign({}, S.itemMeta, { maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })} title={t.detail}>
              {t.detail}
            </span>
          ) : null}
        </div>
      ))}
      {tasks.length > 200 && isOpen ? (
        <div style={Object.assign({}, S.item, { color: C.muted })}>还有 {tasks.length - 200} 个没显示</div>
      ) : null}
    </div>
  );
}

/* ============================ 主组件 ============================ */


export default function NutstoreSyncPanel(props) {
  const serverId = props.serverId || "";
  /** ctx 是 live 的：异步回调里不能读闭包里的旧 props。 */
  const ctxRef = useRef(props.ctx);
  ctxRef.current = props.ctx;

  /* --- 基础状态 --- */
  const [cfg, setCfg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [bootErr, setBootErr] = useState("");
  const [busy, setBusy] = useState(""); // "test" | "plan" | "run" | "save"
  const [flash, setFlash] = useState(null); // { tone, text }

  /* --- 第 1 步：连接 --- */
  const [user, setUser] = useState("");
  const [pw, setPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [localRoot, setLocalRoot] = useState("");
  const [remoteDir, setRemoteDir] = useState("");
  const [testResult, setTestResult] = useState(null);

  /* --- 第 2 步：差异 --- */
  const [plan, setPlan] = useState(null);
  const [openGroups, setOpenGroups] = useState({});

  /* --- 第 3 步：同步 --- */
  const [job, setJob] = useState(null);
  const [runResult, setRunResult] = useState(null);
  const [needConfirmPaths, setNeedConfirmPaths] = useState(null);
  const [pendingDeletes, setPendingDeletes] = useState(0);

  /* --- 折叠与高级 --- */
  const [open, setOpen] = useState({ connect: true, diff: false, sync: false });
  const [showAdv, setShowAdv] = useState(false);
  const [status, setStatus] = useState(null);
  const [logs, setLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(false);

  /** 每帧重算：ctx 是 live 的，宿主一变就重渲染，没必要 memo。 */
  const ws = readWorkspace(props.ctx);

  /**
   * 滚动区的可用高度。
   *
   * 宿主给面板的容器高度不可靠（标签页形态下常常是 auto），所以不去猜父级，
   * 而是**量滚动层自己在视口里的位置**：视口底部减掉它的 top，就是它能用的高度。
   * 这个值只用来收紧 maxHeight，量不出来时 CSS 的 calc(100vh - 120px) 顶上。
   *
   * 注意：不锁 root 的高度。root 一旦有固定高度 + overflow:hidden，估矮了就会
   * 变成「内容被裁、父级也不再溢出」的死锁 —— 这正是上一版拉不动的原因。
   */
  const rootRef = useRef(null);
  const [availH, setAvailH] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let raf = 0;
    let tries = 0;
    let timer = 0;
    let stopped = false;

    const measure = () => {
      if (stopped || raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const node = rootRef.current;
        if (!node) {
          // 首帧可能还没挂上：退避重试几次，不无限重试
          if (tries++ < 8) timer = setTimeout(measure, 80 * tries);
          return;
        }
        const rect = node.getBoundingClientRect();
        // 容器自己就是滚动层，top 就是它到视口顶的距离，不受自身内容多少影响
        if (!rect || rect.top < -4) {
          if (tries++ < 8) timer = setTimeout(measure, 80 * tries);
          return;
        }
        const avail = window.innerHeight - Math.max(0, rect.top) - 8;
        if (avail > 160) setAvailH(Math.round(avail));
      });
    };

    measure();
    window.addEventListener("resize", measure);
    return () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      window.removeEventListener("resize", measure);
    };
  }, []);

  const toggleStep = useCallback((k) => setOpen((st) => Object.assign({}, st, { [k]: !st[k] })), []);

  const connected = !!(cfg && cfg.username && cfg.passwordSet);
  const strategy = (cfg && cfg.strategy) || "two-way";
  const conflictStrategy = (cfg && cfg.conflictStrategy) || "no-conflict-merge";

  /* ---------------------------- 调用层 ---------------------------- */

  const call = useCallback(
    (tool, args, timeoutMs) => {
      const limit = timeoutMs || 60000;
      return new Promise((resolve) => {
        let done = false;
        const finish = (v) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(v);
        };
        const timer = setTimeout(() => {
          finish({
            ok: false,
            code: "CLIENT_TIMEOUT",
            error: "调用 " + tool + " 超过 " + Math.round(limit / 1000) + " 秒没有返回",
            hint: "插件服务进程可能被重启了。重载一次 Notrat 再试。",
          });
        }, limit);

        if (!serverId) {
          setBootErr("面板没拿到插件连接器标识（serverId），先重载一次插件");
          return finish({ ok: false, error: "no serverId" });
        }
        const api = window.electronAPI;
        if (!api || !api.mcp || !api.mcp.callTool) {
          setBootErr("当前环境没有 electronAPI.mcp.callTool，面板连不上插件");
          return finish({ ok: false, error: "no mcp api" });
        }
        Promise.resolve(api.mcp.callTool(serverId, tool, args || {}))
          .then((r) => finish(unpack(r)))
          .catch((e) => finish({ ok: false, error: String((e && e.message) || e) }));
      });
    },
    [serverId],
  );

  /* ---------------------------- 读配置 ---------------------------- */

  const applyConfig = useCallback((c) => {
    setCfg(c);
    setUser(c.username || "");
    setRemoteDir(c.remoteDir || "");
    if (c.lastLocalRoot) setLocalRoot((cur) => cur || c.lastLocalRoot);
  }, []);

  const loadConfig = useCallback(async () => {
    let r = await call("ns_config", { action: "get" });
    if (r && r.config && !r.config.remoteBase && r.config.remoteDir) {
      // 老配置只有 remoteDir：当成云端根目录，之后按跟随规则往下拼。
      const m = await call("ns_config", { action: "set", patch: { remoteBase: r.config.remoteDir } });
      if (m && m.config) r = Object.assign({}, r, { config: m.config });
    }
    if (r && r.config) applyConfig(r.config);
    else if (r && r.error) setBootErr(errMsg(r, "读不到配置"));
    return r;
  }, [call, applyConfig]);

  const loadStatus = useCallback(async () => {
    const r = await call("ns_status", { limit: 8 });
    if (r && r.ok !== false) {
      setStatus(r);
      if (r.job && r.job.running) setJob({ running: true, phase: r.job.phase, progress: r.job.progress, id: r.job.id });
    }
    return r;
  }, [call]);

  const loadLogs = useCallback(async () => {
    const r = await call("ns_log", { limit: 20 });
    if (r && r.entries) setLogs(r.entries.slice().reverse());
    return r;
  }, [call]);

  useEffect(() => {
    if (!serverId) {
      setLoading(false);
      return;
    }
    let alive = true;
    (async () => {
      const r = await loadConfig();
      if (!alive) {
        setLoading(false);
        return;
      }
      await loadStatus();
      if (alive) setLoading(false);
    })();
    loadLogs();
    return () => {
      alive = false;
    };
  }, [serverId, loadConfig, loadStatus, loadLogs]);

  /**
   * 跟随当前工作区。
   *
   * 只改界面上的值，**不悄悄写配置** —— 用户上一次精心选的云端目录，
   * 不该因为切了个项目就被换掉。真要改，界面上给一颗明确的按钮让他点。
   */
  useEffect(() => {
    if (!cfg) return;
    if (cfg.autoFollow === false) {
      if (!localRoot && cfg.lastLocalRoot) setLocalRoot(cfg.lastLocalRoot);
      return;
    }
    if (ws && !ws.unavailable && ws.active && ws.active !== localRoot) setLocalRoot(ws.active);
    else if (!localRoot && cfg.lastLocalRoot) setLocalRoot(cfg.lastLocalRoot);
  }, [cfg && cfg.autoFollow, cfg && cfg.lastLocalRoot, ws && ws.active, localRoot]);

  /** 当前工作区按理该对应的云端位置（只做建议，不自动落盘）。 */
  const suggestedRemote = useMemo(
    () => derivedRemote(ws, localRoot, (cfg && cfg.remoteBase) || ""),
    [ws, localRoot, cfg && cfg.remoteBase],
  );
  const showSuggest = !!(suggestedRemote && cfg && cfg.autoFollow !== false && normDir(suggestedRemote) !== normDir(remoteDir));

  const patch = useCallback(
    async (p, silent) => {
      if (!silent) setBusy("save");
      const r = await call("ns_config", { action: "set", patch: p });
      if (!silent) setBusy("");
      if (r && r.config) setCfg(r.config);
      else if (r && r.error) setFlash({ tone: "err", text: errMsg(r, "保存失败") });
      return (r && r.config) || null;
    },
    [call],
  );

  /* ---------------------------- 第 1 步动作 ---------------------------- */

  const doTest = useCallback(async () => {
    setBusy("test");
    setTestResult(null);
    setFlash(null);
    const args = {};
    if (!user && !(cfg && cfg.username)) {
      setBusy("");
      setTestResult({ ok: false, error: "先填坚果云邮箱，再点测试" });
      return;
    }
    if (!pw && !(cfg && cfg.passwordSet)) {
      setBusy("");
      setTestResult({ ok: false, error: "先填应用密码（不是登录密码），再点测试" });
      return;
    }
    if (user) args.username = user;
    if (pw) args.password = pw;

    const r = await call("ns_test", args, 45000);
    setBusy("");
    setTestResult(r);

    if (r && r.ok) {
      // 测通了就把临时凭证落盘（password 只在它有值时才写）
      const p = {};
      if (user && user !== (cfg && cfg.username)) p.username = user;
      if (pw) p.password = pw;
      if (Object.keys(p).length) await patch(p, true);
      setPw("");
      setFlash({ tone: "ok", text: "连接成功，云端能访问了。下一步：看差异" });
    }
  }, [call, user, pw, cfg, localRoot, patch]);

  const commitLocalRoot = useCallback(
    (v) => {
      const val = String(v || "").trim();
      if (!val || val === localRoot) return;
      setLocalRoot(val);
      setPlan(null);
      setRunResult(null);
      patch({ lastLocalRoot: val, autoFollow: false }, true);
    },
    [localRoot, patch],
  );

  const commitRemoteDir = useCallback(
    (v) => {
      const val = normDir(v);
      if (val === normDir(remoteDir)) return;
      setRemoteDir(val);
      setPlan(null);
      setRunResult(null);
      patch({ remoteDir: val, autoFollow: false }, true);
    },
    [remoteDir, patch],
  );

  const followCurrent = useCallback(() => {
    if (!ws || ws.unavailable) return;
    setLocalRoot(ws.active);
    setPlan(null);
    patch({ lastLocalRoot: ws.active, autoFollow: true }, true);
  }, [ws, patch]);

  /* ---------------------------- 第 2 步动作 ---------------------------- */

  const doPlan = useCallback(async () => {
    if (!connected) {
      setFlash({ tone: "err", text: "先把第 1 步的账号填好并点一次「测试连接」" });
      return;
    }
    if (!localRoot) {
      setFlash({ tone: "err", text: "还没确定电脑上要同步哪个文件夹" });
      return;
    }
    setBusy("plan");
    setFlash(null);
    setRunResult(null);
    const r = await call("ns_plan", { localRoot, remoteDir, limit: 400 }, 180000);
    setBusy("");
    if (r && r.ok) {
      setPlan(r);
      const g = {};
      for (const grp of TASK_GROUPS) g[grp.key] = grp.open;
      setOpenGroups(g);
      setOpen({ connect: false, diff: true, sync: !!(r.summary && r.summary.changes) });
      if (!r.summary || !r.summary.changes) {
        setFlash({ tone: "ok", text: "两边已经一致，没有要传的东西" });
      }
    } else {
      setPlan(null);
      setFlash({ tone: "err", text: errMsg(r, "比对失败") });
    }
  }, [call, connected, localRoot, remoteDir]);

  /* ---------------------------- 第 3 步动作 ---------------------------- */

  const pollJob = useCallback(async () => {
    const r = await call("ns_job", {});
    if (r && r.ok !== false) setJob(r);
    return r;
  }, [call]);

  useEffect(() => {
    if (!job || !job.running) return;
    const t = setInterval(() => {
      pollJob().then((r) => {
        if (r && !r.running) {
          clearInterval(t);
          setRunResult(r.result || null);
          loadStatus();
          loadLogs();
          if (r.error) setFlash({ tone: "err", text: r.error });
        }
      });
    }, 900);
    return () => clearInterval(t);
  }, [job && job.running, job && job.id, pollJob, loadStatus, loadLogs]);

  const doRun = useCallback(
    async (opts) => {
      const o = opts || {};
      setBusy("run");
      setFlash(null);
      setRunResult(null);
      const args = { localRoot, remoteDir, async: true };
      if (plan && !planStale(plan, cfg)) args.planId = plan.planId;
      if (o.confirmDelete) args.confirmDelete = true;

      const r = await call("ns_run", args, 120000);
      setBusy("");
      if (r && r.ok) {
        setCfg((c) => c);
        setJob({ running: true, id: r.jobId, phase: "starting", progress: null });
        setOpen({ connect: false, diff: false, sync: true });
        setNeedConfirmPaths(null);
        return;
      }
      if (r && r.requiresConfirmation) {
        const sample = Array.isArray(r.sample) ? r.sample : [];
        setNeedConfirmPaths(sample.map((x) => (typeof x === "string" ? x : x.path)));
        setPendingDeletes(Number(r.deleteCount) || sample.length);
        setOpen((s) => Object.assign({}, s, { sync: true }));
        return;
      }
      setFlash({ tone: "err", text: errMsg(r, "同步失败") });
    },
    [call, localRoot, remoteDir, plan, cfg],
  );

  const doCancel = useCallback(async () => {
    const r = await call("ns_cancel", {});
    if (r && r.ok) setFlash({ tone: "warn", text: "已请求取消，等当前文件做完就停" });
    else setFlash({ tone: "err", text: errMsg(r, "取消失败") });
  }, [call]);

  /* ---------------------------- 渲染小件 ---------------------------- */

  /* ---------------------------- 骨架 ---------------------------- */

  if (!serverId) {
    return (
      <div className="ns-scroll" style={S.root}>
        <Sheet />
        <div style={Object.assign({}, S.body, { paddingTop: 40 })}>
          <Note tone="err">这个面板没拿到插件连接器标识（serverId）。到「设置 → MCP」确认坚果云同步那个连接器是启用状态，再重载一次插件。</Note>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="ns-scroll" style={S.root}>
        <Sheet />
        <div style={Object.assign({}, S.body, { paddingTop: 40, alignItems: "center", color: C.muted })}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Spin /> 正在读配置…
          </div>
        </div>
      </div>
    );
  }

  /* ---------------------------- 派生信息 ---------------------------- */

  const summary = (plan && plan.summary) || null;
  const stale = planStale(plan, cfg);
  const deleteCount = summary ? summary.deleteCount || 0 : 0;
  const conflictCount = summary ? summary.conflict || 0 : 0;
  const changeCount = summary ? summary.changes || 0 : 0;
  const mirrored = isMirror(strategy);
  const running = !!(job && job.running);
  const progress = (job && job.progress) || null;

  const connectSummary = !cfg
    ? "读不到配置"
    : !cfg.username
      ? "还没填账号"
      : !cfg.passwordSet
        ? cfg.username + "（还没填应用密码）"
        : cfg.username + " · 已配置";

  const diffSummary = !plan
    ? "还没看过"
    : stale
      ? STALE_TEXT[stale] || "已经过期"
      : changeCount === 0
        ? "两边一致，没有要传的"
        : "上传 " + (summary.push || 0) + " · 下载 " + (summary.pull || 0) + (deleteCount ? " · 删除 " + deleteCount : "") + (conflictCount ? " · 冲突 " + conflictCount : "");

  const syncSummary = running
    ? "正在同步" + (progress && progress.total ? "（" + (progress.index || 0) + "/" + progress.total + "）" : "")
    : runResult
      ? "上次：" + (runResult.ok ? "成功" : "有失败") + " · 上传 " + (runResult.pushed || 0) + " · 下载 " + (runResult.pulled || 0)
      : "还没同步过";

  const stepNo = running ? 3 : plan ? (stale ? 2 : 3) : connected ? 2 : 1;

  /* ---------------------------- 主体 ---------------------------- */

  return (
    <div
      ref={rootRef}
      className="ns-scroll"
      style={Object.assign({}, S.root, availH ? { maxHeight: availH } : null)}
    >
      <Sheet />

      {/* 顶栏（sticky，跟着滚但常驻顶部） */}
      <div style={S.head}>
        <div style={S.headIn}>
          <div style={S.logo}>
            <Icon name="cloud" size={19} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={S.h1}>坚果云同步</div>
            <div style={S.h1sub}>
              {VERSION_TAG ? <span style={{ opacity: 0.55, marginRight: 6 }}>{VERSION_TAG}</span> : null}
              {cfg
                ? (cfg.username || "未配置") +
                  (cfg.remoteDir ? " → " + cfg.remoteDir : " → 云端根目录") +
                  (status && status.lastSyncedAt ? " · 上次同步 " + fmtTime(status.lastSyncedAt) : "")
                : "读配置中"}
            </div>
          </div>
          <div style={S.row}>
            {status && status.recordCount ? <Pill title="已建立同步记录的文件数">{status.recordCount} 个文件</Pill> : null}
            <Pill tone={connected ? "ok" : ""}>{connected ? "已连接" : "未配置"}</Pill>
          </div>
        </div>

        {/* 三步进度 */}
        <div style={S.steps}>
          {[
            { n: 1, label: "连接", done: connected },
            { n: 2, label: "看差异", done: !!plan && !stale },
            { n: 3, label: "同步", done: !!runResult && !running },
          ].map((s, i) => (
            <React.Fragment key={s.n}>
              {i > 0 ? <div style={S.stepLine} /> : null}
              <div style={{ display: "flex", alignItems: "center", gap: 5, flex: "0 0 auto" }}>
                <div style={Object.assign({}, S.stepDot, s.done ? S.stepDotDone : stepNo === s.n ? S.stepDotOn : null)}>
                  {s.done ? <Icon name="check" size={11} width={2.4} /> : s.n}
                </div>
                <span style={Object.assign({}, S.stepLabel, stepNo === s.n ? S.stepLabelOn : null)}>{s.label}</span>
              </div>
            </React.Fragment>
          ))}
        </div>

      </div>

      <div style={S.body}>
        {bootErr ? <Note tone="err">{bootErr}</Note> : null}
        {flash ? (
          <Note tone={flash.tone}>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <span style={{ flex: 1 }}>{flash.text}</span>
              <button type="button" className="ns-btnG" style={S.btnGhost} onClick={() => setFlash(null)} aria-label="关闭">
                <Icon name="x" size={12} />
              </button>
            </div>
          </Note>
        ) : null}
        {!ws.unavailable ? null : (
          <Note>
            这个窗口没打开工作区，所以「电脑上的文件夹」得自己填或者点右边挑一个。打开一个工作区后这里会自动跟随。
          </Note>
        )}

        {/* ============ 第 1 步 ============ */}
        <StepCard
          k="connect"
          open={!!open.connect}
          onToggle={() => toggleStep("connect")}
          n={1}
          title="连接坚果云"
          summary={connectSummary}
          done={connected}
          tail={connected ? <Pill tone="ok">已连接</Pill> : null}
        >
          <Note>
            应用密码在坚果云网页版生成：头像 → <b>账户信息 → 安全选项 → 添加应用密码</b>。拿到的是第三方应用密码，
            <b>不是登录密码</b>，可以随时作废。
          </Note>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
            <Field label="坚果云账号（邮箱）">
              <TextInput
                value={user}
                onChange={setUser}
                placeholder="you@example.com"
                onBlur={(v) => v && v !== (cfg && cfg.username) && patch({ username: v.trim() })}
              />
            </Field>
            <Field label="应用密码" hint={cfg && cfg.passwordSet ? "已经存好了：" + (cfg.passwordHint || "已设置") + "。留空表示不改" : ""}>
              <div style={{ position: "relative" }}>
                <TextInput
                  value={pw}
                  onChange={setPw}
                  type={showPw ? "text" : "password"}
                  placeholder={cfg && cfg.passwordSet ? "••••••••（已保存）" : "第三方应用密码"}
                  onEnter={() => doTest()}
                  style={{ paddingRight: 34 }}
                />
                <button
                  type="button"
                  className="ns-btnG"
                  style={Object.assign({}, S.btnGhost, { position: "absolute", right: 3, top: "50%", transform: "translateY(-50%)", padding: 4 })}
                  onClick={() => setShowPw((v) => !v)}
                  aria-label={showPw ? "隐藏密码" : "显示密码"}
                >
                  <Icon name={showPw ? "eyeOff" : "eye"} size={14} />
                </button>
              </div>
            </Field>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
            <Field
              label="电脑上的文件夹"
              hint={
                localRoot && ws && !ws.unavailable && ws.roots.indexOf(localRoot) < 0
                  ? "这个目录不在当前窗口的工作区里"
                  : ws && !ws.unavailable
                    ? "默认跟随当前工作区，切项目时自动换"
                    : ""
              }
            >
              <div style={{ display: "flex", gap: 6 }}>
                <TextInput value={localRoot} onChange={setLocalRoot} onBlur={commitLocalRoot} mono placeholder="C:\\path\\to\\folder" />
                {ws && !ws.unavailable ? (
                  <Btn variant="2" onClick={followCurrent} title="跟着当前工作区走" style={{ flex: "0 0 auto" }}>
                    <Icon name="folder" size={13} />
                    跟随
                  </Btn>
                ) : null}
              </div>
            </Field>
            <Field label="坚果云上的文件夹" hint="留空就放在云端根目录">
              <div style={{ display: "flex", gap: 6 }}>
                <TextInput value={remoteDir} onChange={setRemoteDir} onBlur={commitRemoteDir} mono placeholder="我的坚果云/某个目录" />
                {showSuggest ? (
                  <Btn
                    variant="2"
                    style={{ flex: "0 0 auto" }}
                    title={"改到 " + suggestedRemote}
                    onClick={() => {
                      setRemoteDir(suggestedRemote);
                      setPlan(null);
                      patch({ remoteDir: suggestedRemote }, true);
                    }}
                  >
                    用建议
                  </Btn>
                ) : null}
              </div>
            </Field>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Btn icon={busy === "test" ? null : "key"} busy={busy === "test"} onClick={doTest} disabled={busy === "test"}>
              {busy === "test" ? "正在连接…" : "测试连接"}
            </Btn>
            {connected ? (
              <Btn variant="2" onClick={() => setOpen((s) => Object.assign({}, s, { connect: false, diff: true }))}>
                下一步：看差异
              </Btn>
            ) : null}
            {testResult && testResult.ok ? (
              <Pill tone="ok" title={testResult.baseUrl}>
                通了 · {testResult.ms} ms
                {testResult.topLevel ? " · 云端 " + testResult.topLevel + " 项" : ""}
              </Pill>
            ) : null}
          </div>

          {testResult && !testResult.ok ? (
            <Note tone="err">{errMsg(testResult, "连接失败")}</Note>
          ) : null}
          {testResult && testResult.ok && testResult.dirCheck && !testResult.dirCheck.exists ? (
            <Note tone="warn">
              账号是对的，但云端目录「{testResult.dirCheck.path}」还不存在。同步时它会自动创建，或者你先去网页版建好。
            </Note>
          ) : null}
        </StepCard>

        {/* ============ 第 2 步 ============ */}
        <StepCard
          k="diff"
          open={!!open.diff}
          onToggle={() => toggleStep("diff")}
          n={2}
          title="看差异"
          summary={diffSummary}
          done={!!plan && !stale && changeCount > 0}
          dim={!connected}
          clickable
          tail={
            plan && !stale ? (
              <Pill tone={deleteCount ? "err" : conflictCount ? "warn" : "ok"}>
                {changeCount ? changeCount + " 项" : "无变化"}
              </Pill>
            ) : null
          }
        >
          <div style={{ display: "flex", gap: 8, alignSelf: "flex-start", flexWrap: "wrap" }}>
            <Btn icon={busy === "plan" ? null : "list"} busy={busy === "plan"} onClick={doPlan} disabled={busy === "plan" || running}>
              {busy === "plan" ? "正在比对…" : plan ? "重新比对" : "看看要传什么"}
            </Btn>
            <span style={S.hint}>只读操作，不会改动任何文件。首次同步大目录要等一会。</span>
          </div>

          {stale ? <Note tone="warn">{STALE_TEXT[stale]}</Note> : null}

          {summary ? (
            <>
              <div style={S.stats}>
                <Stat label="传到坚果云" value={summary.push || 0} tone="primary" />
                <Stat label="取回电脑" value={summary.pull || 0} tone="primary" />
                <Stat label="会删掉" value={deleteCount} tone={deleteCount ? "err" : undefined} />
                <Stat label="两边都改了" value={conflictCount} tone={conflictCount ? "warn" : undefined} />
                <Stat label="跳过" value={summary.skip || 0} />
              </div>

              {summary.bytesUp || summary.bytesDown ? (
                <div style={S.hint}>
                  预计流量：↑{fmtBytes(summary.bytesUp)} ↓{fmtBytes(summary.bytesDown)}
                </div>
              ) : null}

              {summary.requestEstimate ? (
                <div style={S.hint}>
                  预计请求 {summary.requestEstimate} 次
                  {summary.requestQuota ? "（免费版限额 " + summary.requestQuota + " 次 / 30 分钟" : ""}
                  {summary.requestPct ? "，约占 " + Math.round(summary.requestPct) + "%" : ""}
                  {summary.requestQuota ? "）" : ""}
                </div>
              ) : null}

              {(plan.notes || []).map((n, i) => (
                <Note key={i} tone={/删|覆盖|风险|超/.test(String(n)) ? "warn" : ""}>
                  {n}
                </Note>
              ))}

              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {TASK_GROUPS.map((g) => (
                  <TaskList
                    key={g.key}
                    label={g.label}
                    tone={g.tone}
                    key_={g.key}
                    open={!!openGroups[g.key]}
                    onToggle={() => setOpenGroups((st) => Object.assign({}, st, { [g.key]: !st[g.key] }))}
                    tasks={(plan.tasks || []).filter((t) => g.types.indexOf(t.type) >= 0)}
                    bytesUp={summary && summary.bytesUp}
                    bytesDown={summary && summary.bytesDown}
                  />
                ))}
              </div>

              {changeCount ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Btn onClick={() => setOpen((s) => Object.assign({}, s, { diff: false, sync: true }))}>下一步：同步</Btn>
                </div>
              ) : (
                <Note tone="ok">两边已经一致，没有需要处理的文件。</Note>
              )}
            </>
          ) : (
            <div style={S.empty}>还没比对过。点上面的按钮看一遍会改动什么。</div>
          )}
        </StepCard>

        {/* ============ 第 3 步 ============ */}
        <StepCard
          k="sync"
          open={!!open.sync}
          onToggle={() => toggleStep("sync")}
          n={3}
          title="开始同步"
          summary={syncSummary}
          done={!!runResult && !running}
          dim={!connected || !plan}
          tail={running ? <Pill tone="on">进行中</Pill> : runResult ? <Pill tone={runResult.ok ? "ok" : "err"}>{runResult.ok ? "成功" : "有失败"}</Pill> : null}
        >
          {/* 正在跑 */}
          {running ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              <div style={S.bar}>
                <div
                  style={Object.assign({}, S.barIn, {
                    width: progress && progress.total ? Math.min(100, Math.round(((progress.index || 0) / progress.total) * 100)) + "%" : "30%",
                  })}
                />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Spin />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {progress && progress.path ? progress.path : job.phase === "executing" ? "正在处理…" : "正在准备…"}
                </span>
                {progress && progress.total ? (
                  <span style={S.hint}>
                    {progress.index || 0} / {progress.total}
                  </span>
                ) : null}
                <Btn variant="danger" onClick={doCancel}>
                  取消
                </Btn>
              </div>
            </div>
          ) : null}

          {/* 删除确认 */}
          {needConfirmPaths && !running ? (
            <Note tone="err">
              <div style={{ fontWeight: 600, marginBottom: 4 }}>这次同步会删掉 {pendingDeletes || needConfirmPaths.length} 个文件</div>
              <div style={{ maxHeight: 160, overflow: "auto", margin: "6px 0" }} className="ns-scroll">
                {needConfirmPaths.slice(0, 50).map((p, i) => (
                  <div key={i} style={Object.assign({}, S.mono, { lineHeight: 1.7 })}>
                    {typeof p === "string" ? p : p.path}
                  </div>
                ))}
                {needConfirmPaths.length > 50 ? <div style={S.hint}>还有 {needConfirmPaths.length - 50} 个…</div> : null}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                <Btn variant="danger" onClick={() => doRun({ confirmDelete: true })}>
                  我确认，删掉这些
                </Btn>
                <Btn variant="2" onClick={() => setNeedConfirmPaths(null)}>
                  算了，先别动
                </Btn>
              </div>
            </Note>
          ) : null}

          {/* 待执行 */}
          {!running && !needConfirmPaths ? (
            <>
              {!connected ? (
                <Note>先把第 1 步的账号填好。</Note>
              ) : !plan ? (
                <Note>先在第 2 步点「看看要传什么」，看清楚会改动哪些文件再同步。</Note>
              ) : changeCount === 0 ? (
                <Note tone="ok">没有要传的文件，两边已经一致。</Note>
              ) : (
                <>
                  {deleteCount ? (
                    <Note tone="err">
                      这份计划里有 <b>{deleteCount}</b> 个删除动作（当前方式是「{STRATEGY_LABEL[strategy] || strategy}」）。
                      点下去会先列清单让你确认，不会直接删。
                    </Note>
                  ) : null}
                  {mirrored ? <Note tone="warn">当前是「覆盖另一端」的方式，那边独有的文件会被删除。第一次用建议先备份。</Note> : null}
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <Btn big={false} icon={busy === "run" ? null : "play"} busy={busy === "run"} onClick={() => doRun()} disabled={busy === "run"}>
                      {busy === "run" ? "正在启动…" : "开始同步（" + changeCount + " 项）"}
                    </Btn>
                    <span style={S.hint}>同步在后台跑，可以关掉这个页面。</span>
                  </div>
                </>
              )}
            </>
          ) : null}

          {/* 结果 */}
          {runResult && !running ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              <div style={S.stats}>
                <Stat label="上传" value={runResult.pushed || 0} tone="ok" />
                <Stat label="下载" value={runResult.pulled || 0} tone="ok" />
                <Stat label="删除" value={(runResult.removedLocal || 0) + (runResult.removedRemote || 0)} tone={(runResult.removedLocal || 0) + (runResult.removedRemote || 0) ? "warn" : undefined} />
                <Stat label="失败" value={(runResult.failed || []).length} tone={(runResult.failed || []).length ? "err" : undefined} />
              </div>
              {runResult.bytesUp || runResult.bytesDown ? (
                <div style={S.hint}>
                  ↑{fmtBytes(runResult.bytesUp)} ↓{fmtBytes(runResult.bytesDown)}
                  {runResult.finishedAt ? " · " + fmtTime(runResult.finishedAt) : ""}
                </div>
              ) : null}
              {runResult.cancelled ? <Note tone="warn">这次同步被取消了，已完成的不会回滚。</Note> : null}
              {(runResult.failed || []).length ? (
                <Note tone="err">
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{(runResult.failed || []).length} 个文件没成功</div>
                  <div style={{ maxHeight: 150, overflow: "auto" }} className="ns-scroll">
                    {(runResult.failed || []).slice(0, 20).map((f, i) => (
                      <div key={i} style={Object.assign({}, S.mono, { lineHeight: 1.7 })}>
                        {(f && (f.path || f.name)) || String(f)} — {(f && (f.error || f.message)) || ""}
                      </div>
                    ))}
                  </div>
                </Note>
              ) : null}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Btn variant="2" icon="refresh" onClick={doPlan} disabled={busy === "plan"}>
                  再比对一次
                </Btn>
              </div>
            </div>
          ) : null}
        </StepCard>

        {/* ============ 高级 ============ */}
        <div style={S.adv}>
          <div style={S.advHead} onClick={() => setShowAdv((v) => !v)}>
            <Icon name="settings" size={14} />
            <span style={{ flex: 1 }}>高级设置</span>
            <span style={{ color: C.muted, fontSize: 11.5 }}>
              {STRATEGY_LABEL[strategy] || strategy} · {CONFLICT_LABEL[conflictStrategy] || conflictStrategy}
            </span>
            <Icon name="chevron" size={14} style={{ transform: showAdv ? "rotate(180deg)" : "none", transition: "transform 140ms" }} />
          </div>

          {showAdv ? (
            <div style={S.advBody}>
              {/* 同步方式 */}
              <div style={S.field}>
                <span style={S.label}>同步方式</span>
                <div style={S.opts}>
                  {QUICK_STRATEGIES.map((s) => {
                    const on = strategy === s.id;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        className="ns-opt"
                        style={Object.assign({}, S.opt, on ? S.optOn : null)}
                        onClick={() => {
                          if (on) return;
                          patch({ strategy: s.id });
                          setPlan(null);
                        }}
                        aria-pressed={on}
                      >
                        <span style={S.optLabel}>
                          <Icon name={s.icon} size={13} />
                          {s.label}
                          {on ? <Icon name="check" size={12} width={2.4} style={{ marginLeft: "auto", color: C.primary }} /> : null}
                        </span>
                        <span style={S.optHint}>{s.hint}</span>
                      </button>
                    );
                  })}
                </div>
                <span style={S.hint}>会删文件的那两种放下面。</span>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                  {MIRROR_STRATEGIES.map((s) => {
                    const on = strategy === s.id;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        className="ns-opt"
                        style={Object.assign({}, S.opt, { flexDirection: "row", alignItems: "center", gap: 8 }, on ? Object.assign({}, S.optOn, { borderColor: C.err, background: tint("status-error-text", 0.07), boxShadow: "0 0 0 1px " + tint("status-error-text", 0.3) }) : null)}
                        onClick={() => {
                          if (on) return;
                          patch({ strategy: s.id });
                          setPlan(null);
                        }}
                        aria-pressed={on}
                      >
                        <Icon name="alert" size={13} style={{ color: C.err, flex: "0 0 auto" }} />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={Object.assign({}, S.optLabel, { color: C.err })}>{s.label}</span>
                          <span style={S.optHint}>{s.hint}</span>
                        </span>
                        {on ? <Icon name="check" size={12} width={2.4} style={{ color: C.err }} /> : null}
                      </button>
                    );
                  })}
                </div>
              </div>

              <hr style={S.hr} />

              {/* 冲突 */}
              <div style={S.field}>
                <span style={S.label}>同一个文件两边都改过时</span>
                <div style={S.opts}>
                  {CONFLICTS.map((c) => {
                    const on = conflictStrategy === c.id;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className="ns-opt"
                        style={Object.assign({}, S.opt, on ? S.optOn : null)}
                        onClick={() => {
                          if (on) return;
                          patch({ conflictStrategy: c.id });
                          setPlan(null);
                        }}
                        aria-pressed={on}
                      >
                        <span style={S.optLabel}>
                          {c.label}
                          {on ? <Icon name="check" size={12} width={2.4} style={{ marginLeft: "auto", color: C.primary }} /> : null}
                        </span>
                        <span style={S.optHint}>{c.hint}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <hr style={S.hr} />

              {/* 过滤 */}
              <div style={S.field}>
                <span style={S.label}>不传这些目录（点一下切换）</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {TEMP_DIRS.map((d) => {
                    const list = (cfg && Array.isArray(cfg.excludes) ? cfg.excludes : []).map(normRule);
                    const on = list.indexOf(normRule(d.id)) >= 0;
                    return (
                      <button
                        key={d.id}
                        type="button"
                        className="ns-chip"
                        style={Object.assign(
                          {},
                          {
                            display: "flex",
                            flexDirection: "column",
                            gap: 1,
                            textAlign: "left",
                            padding: "6px 10px",
                            borderRadius: R.md,
                            border: "1px solid " + (on ? C.primary : C.line),
                            background: on ? tint("primary", 0.08) : "transparent",
                            color: C.fg,
                            fontFamily: "inherit",
                            cursor: "pointer",
                            fontSize: 11.5,
                          },
                        )}
                        onClick={() => {
                          const cur = (cfg && Array.isArray(cfg.excludes) ? cfg.excludes : []).filter((x) => normRule(x) !== normRule(d.id));
                          if (!on) cur.push(d.id);
                          patch({ excludes: cur });
                          setPlan(null);
                        }}
                        aria-pressed={on}
                      >
                        <span style={{ fontWeight: 600 }}>
                          {on ? "✓ " : ""}
                          {d.label}
                        </span>
                        <span style={{ fontSize: 10.5, color: C.muted }}>{d.hint}</span>
                      </button>
                    );
                  })}
                </div>
                <span style={S.hint}>
                  .git、node_modules、.notrat 始终跳过，不受这里影响。自定义规则可以直接写进配置项的 excludes。
                </span>
              </div>

              <hr style={S.hr} />

              {/* 敏感性 */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
                <Field label="扫描方式" hint={cfg && cfg.scanMode === "strict" ? "严格：比对修改时间 + 大小，更准但更慢" : "宽松：只比大小，大目录快很多"}>
                  <div style={{ display: "flex", gap: 6 }}>
                    {[
                      { id: "loose", label: "宽松" },
                      { id: "strict", label: "严格" },
                    ].map((m) => (
                      <Btn
                        key={m.id}
                        variant={cfg && cfg.scanMode === m.id ? null : "2"}
                        onClick={() => patch({ scanMode: m.id })}
                        style={{ flex: 1, padding: "5px 8px", fontSize: 12 }}
                      >
                        {m.label}
                      </Btn>
                    ))}
                  </div>
                </Field>
                <Field label="单文件上限" hint="超过就跳过，不会切片上传">
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <TextInput
                      type="number"
                      value={cfg ? cfg.maxFileSizeMB : ""}
                      onChange={(v) => setCfg((c) => Object.assign({}, c, { maxFileSizeMB: v }))}
                      onBlur={(v) => {
                        const n = Math.max(1, Math.min(500, Number(v) || 100));
                        if (cfg && n !== cfg.maxFileSizeMB) patch({ maxFileSizeMB: n });
                        else setCfg((c) => Object.assign({}, c, { maxFileSizeMB: n }));
                      }}
                      style={{ width: 80 }}
                    />
                    <span style={S.hint}>MB</span>
                  </div>
                </Field>
                <Field label="请求间隔" hint="坚果云免费版 600 次 / 30 分钟，别调太小">
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <TextInput
                      type="number"
                      value={cfg ? cfg.minGapMs : ""}
                      onChange={(v) => setCfg((c) => Object.assign({}, c, { minGapMs: v }))}
                      onBlur={(v) => {
                        const n = Math.max(0, Math.min(3000, Number(v) || 120));
                        if (cfg && n !== cfg.minGapMs) patch({ minGapMs: n });
                        else setCfg((c) => Object.assign({}, c, { minGapMs: n }));
                      }}
                      style={{ width: 80 }}
                    />
                    <span style={S.hint}>ms</span>
                  </div>
                </Field>
              </div>

              <hr style={S.hr} />

              {/* 跟随 */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ flex: 1, minWidth: 180 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 550 }}>跟随当前工作区</span>
                  <div style={S.hint}>打开后，切项目时电脑那个文件夹和云端目标一起自动换</div>
                </span>
                <Btn
                  variant={cfg && cfg.autoFollow !== false ? null : "2"}
                  onClick={() => patch({ autoFollow: !(cfg && cfg.autoFollow !== false) })}
                  style={{ padding: "5px 12px", fontSize: 12 }}
                >
                  {cfg && cfg.autoFollow !== false ? "已开启" : "已关闭"}
                </Btn>
              </div>

              <hr style={S.hr} />

              {/* 日志 */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1, fontSize: 12.5, fontWeight: 550 }}>最近发生了什么</span>
                <Btn variant="ghost" onClick={() => { loadLogs(); setShowLogs((v) => !v); }}>
                  {showLogs ? "收起" : "展开"}
                </Btn>
              </div>
              {showLogs ? (
                <div style={{ maxHeight: 220, overflow: "auto" }} className="ns-scroll">
                  {logs.length ? (
                    logs.map((l, i) => (
                      <div key={i} style={Object.assign({}, S.item, { paddingLeft: 0 })}>
                        <span style={{ color: C.muted, flex: "0 0 auto", fontSize: 11 }}>{fmtTime(l.at)}</span>
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {LOG_LABEL[l.event] || l.event}
                          {l.event === "plan" && l.summary
                            ? " · 上传 " + (l.summary.push || 0) + " / 下载 " + (l.summary.pull || 0)
                            : ""}
                          {l.event === "run" && l.result
                            ? " · 上传 " + (l.result.pushed || 0) + " / 下载 " + (l.result.pulled || 0) + (l.result.failed ? " / 失败 " + l.result.failed : "")
                            : ""}
                          {l.event === "run-error" && l.error ? " · " + String(l.error).slice(0, 120) : ""}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div style={S.empty}>还没有记录</div>
                  )}
                </div>
              ) : null}

              <hr style={S.hr} />

              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={Object.assign({}, S.hint, { flex: 1, minWidth: 200 })}>
                  数据目录：{cfg && cfg.dataDir ? cfg.dataDir : "（未知）"}
                </span>
                <Btn variant="ghost" onClick={() => { loadConfig(); loadStatus(); loadLogs(); }}>
                  重新读取
                </Btn>
              </div>
            </div>
          ) : null}
        </div>

        <div style={Object.assign({}, S.hint, { textAlign: "center", paddingTop: 4 })}>
          账号和同步记录只存在本机，不随同步上传。同步前会先给你看改动清单，删除动作永远要二次确认。
        </div>
      </div>
    </div>
  );
}
