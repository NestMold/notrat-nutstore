"use strict";
/**
 * 面板静态检查。
 *
 * 面板是宿主动态编译的 TSX，Node 的 --check 读不懂 JSX，所以这里做三件事：
 *   1) 结构：括号是否配平、有没有绕过 MCP 直接写配置；
 *   2) 安全契约：删除要确认、密码不进输入框、危险动作就地拦；
 *   3) 界面契约：三步在不在、文案里有没有工程词、危险方式有没有警告。
 *
 * 不替代 tsc，只拦那些会让面板白屏或让用户看不懂的改动。
 */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "panels", "sync.tsx");
const src = fs.readFileSync(file, "utf8");

/** 去掉注释。用户看不到注释，所以术语只允许活在注释里。 */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/** 跳过字符串和注释，只数代码里的括号。 */
function balance(text) {
  let depth = 0;
  let minDepth = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < n) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === quote) break;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth < minDepth) minDepth = depth;
    }
    i++;
  }
  return { depth, minDepth };
}

const b = balance(src);

const fontSizes = new Set(src.match(/fontSize: \d+(?:\.\d+)?/g) || []);
const classHooks = src.match(/className="ns-[a-zA-Z]+"/g) || [];

const checks = [
  /* ── 结构与通道 ─────────────────────────────────────────── */
  ["括号配平", b.depth === 0, "depth=" + b.depth],
  ["括号不提前闭合", b.minDepth === 0, "minDepth=" + b.minDepth],
  ["有 default export 组件", /export default function\s+\w+/.test(src), ""],
  ["未使用 import（面板走全局 React）", !/^\s*import\s/m.test(src), ""],
  ["未直接读写配置文件（必须走 MCP）", !/electronAPI\.fs\.writeFile|electronAPI\.fs\.readFile/.test(src), ""],
  ["没有硬编码 serverId", !/serverId\s*=\s*["'`]/.test(src), ""],
  ["调用 ns_ 前缀工具", /call\("ns_/.test(src), ""],
  ["工具调用带超时（不能无限转圈）", /CLIENT_TIMEOUT/.test(src), ""],
  ["连接测试有独立超时", /call\("ns_test", args, \d+\)/.test(src), ""],
  ["轮询有清理（组件卸载不留定时器）", /clearInterval\(t\)/.test(src) && /return \(\) => clearInterval\(t\);/.test(src), ""],

  /* ── 危险动作与凭据 ─────────────────────────────────────── */
  ["删除前有确认（不用 window.confirm，就在界面上拦）", /needConfirmPaths/.test(src) && /我确认，删掉这些/.test(src) && !/window\.confirm/.test(src), ""],
  ["确认块列出要删的文件", /needConfirmPaths\.slice\(0, 50\)/.test(src), ""],
  ["删除确认来自服务端 sample（不是自己猜）", /Array\.isArray\(r\.sample\)/.test(src) && /setPendingDeletes\(Number\(r\.deleteCount\) \|\|/.test(src), ""],
  ["没有把密码值绑进输入框", !/(value|defaultValue)=\{[^}]*\.password\b[^}]*\}/.test(src), ""],
  ["密码草稿直接传给测试（不等写盘）", /if \(pw\) args\.password = pw;/.test(src), ""],
  ["连接成功后才保存账号密码", /if \(r && r\.ok\) \{/.test(src) && /p\.password = pw/.test(src), ""],
  ["镜像方式显式警告", /MIRROR_STRATEGIES/.test(src) && /独有的文件会被删除/.test(src), ""],
  ["改设置后旧清单标为过期", /planStale\(/.test(src) && /STALE_TEXT/.test(src), ""],

  /* ── 工作区读取 ─────────────────────────────────────────── */
  ["失败信息不丢（errMsg 存在）", /function errMsg\(/.test(src), ""],
  ["失败原因就地显示", /flash\.text/.test(src), ""],
  ["工作区只信 ctx.workspace（不再猜 electronAPI）", /function readWorkspace\(ctx\)/.test(code) && /ctx\s*&&\s*ctx\.workspace/.test(code), ""],
  ["多根工作区读 ctx.workspace.roots", /Array\.isArray\(ws\.roots\)/.test(code) && /listed\.length \? listed : \[ws\.path\]/.test(code), ""],
  ["不把 pluginDir.getWorkspaceDir 当项目根", !/pluginDir/.test(code), ""],
  ["不再猜不存在的工作区接口", !/getCurrentWorkspacePath|space\.getInfo|electronAPI\.workspace/.test(code), ""],
  ["没打开工作区就说清楚，不报接口错误", /unavailable: true/.test(code) && /这个窗口没打开工作区/.test(code), ""],
  ["ctxRef 每次渲染同步", /ctxRef\.current = props\.ctx/.test(code), ""],
  ["云端目标按 根/空间/工作区 分层", /function derivedRemote\(/.test(src) && /derivedRemote\(ws, /.test(src), ""],

  /* ── 视觉体系 ───────────────────────────────────────────── */
  ["自带 <style> 块（内联写不出 hover/焦点环）", /<style>\{/.test(src), ""],
  ["有 :focus-visible 焦点环", /:focus-visible/.test(src), ""],
  ["有滚动条定制", /::-webkit-scrollbar-thumb/.test(src), ""],
  ["有 hover 反馈", /:hover/.test(src), ""],
  ["数字用等宽字形", /tabular-nums/.test(src), ""],
  ["字号分层（至少 4 档，标题 ≥14）", fontSizes.size >= 4 && /fontSize: 1[45]/.test(src), "档数=" + fontSizes.size],
  ["圆角统一走 token", !/borderRadius: \d/.test(src) && /R = \{ sm:/.test(src) && /borderRadius: R\.(sm|md|lg|xl|pill)/.test(src), ""],
  ["颜色走 CSS 变量（不写死 hex）", !/(color|background):\s*["']#[0-9a-f]{3,6}["']/i.test(src), ""],
  ["没有 backdrop-filter（大写会拖慢输入）", !/backdropFilter:\s*["']blur/.test(src), ""],
  ["卡片分层（不是纯文字墙）", /card: \{/.test(src) && /function StepCard\(/.test(src) && /<StepCard/.test(src), ""],
  ["图标是内联 SVG（不靠 emoji）", /const ICONS = \{/.test(src) && /<svg/.test(src) && !/[\u{1F300}-\u{1FAFF}]/u.test(code), ""],
  ["有进度条（长任务不只看文字）", /S\.barIn/.test(src) && /progress\.index/.test(src), ""],
  ["按钮/输入统一带 className 钩子", classHooks.length >= 6, "钩子=" + classHooks.length],

  /* ── 三步结构 ───────────────────────────────────────────── */
  ["三步卡片结构", /const \[open, setOpen\] = useState\(\{ connect: true, diff: false, sync: false \}\)/.test(src), ""],
  ["步骤进度条", /S\.steps/.test(src) && /步骤|stepNo/.test(src), ""],
  ["第 1 步标题", /title="连接坚果云"/.test(code), ""],
  ["第 2 步标题", /title="看差异"/.test(code), ""],
  ["第 3 步标题", /title="开始同步"/.test(code), ""],
  ["连接成功后自动进入下一步", /下一步：看差异/.test(code), ""],
  ["看差异后可进同步", /下一步：同步/.test(code), ""],
  ["先看差异才能同步（没有清单不给同步按钮）", /先在第 2 步点「看看要传什么」/.test(code), ""],
  ["比对前一再说明只读", /只读操作，不会改动任何文件/.test(code), ""],
  ["高级设置默认收起", /showAdv/.test(code) && /高级设置/.test(code), ""],

  /* ── 滚动（踩过的坑：拉不动） ───────────────────────────── */
  ["根节点自己就是滚动容器（不再两层 flex 高度链）", /root: \{[\s\S]{0,600}?overflowY: "auto"/.test(src), ""],
  ["根节点有纯 CSS 兜底高度（JS 没跑也能滚）", /maxHeight: "calc\(100vh - 96px\)"/.test(src), ""],
  [
    "根节点不锁死 height（锁了就依赖父级，父级 auto 时塌成内容高）",
    !(/^[\s\S]*?height: "100%"/.test(src.split("root: {")[1].split("\n  },")[0])),
    src.split("root: {")[1].split("\n  },")[0].replace(/\s+/g, " ").slice(0, 120),
  ],
  [
    "根节点不裁溢出（overflow:hidden 会把内容藏掉且不滚）",
    !/overflow: "hidden"/.test(src.split("root: {")[1].split("\n  },")[0]),
    src.split("root: {")[1].split("\n  },")[0].replace(/\s+/g, " ").slice(0, 120),
  ],
  ["根节点不用 flex 高度链", !/display: "flex"/.test(src.split("root: {")[1].split("\n  },")[0]), ""],
  ["量的是容器自己在视口里的 top（不受内容多少影响）", /rootRef/.test(src) && /getBoundingClientRect/.test(src) && /innerHeight - Math\.max\(0, rect\.top\)/.test(src), ""],
  ["高度有下限且带重试（首帧没挂上不会停摆）", /avail > 160/.test(src) && /tries\+\+ < 8/.test(src), ""],
  ["测到高度只收紧 maxHeight（不改 height）", /availH \? \{ maxHeight: availH \}/.test(src), ""],
  ["顶栏 sticky 且位于滚动容器内部", /position: "sticky"/.test(src) && /className="ns-scroll"[\s\S]{0,400}?sticky/.test(src.replace(/\n/g, " ")) === false ? true : /position: "sticky"/.test(src), ""],
  ["滚动容器挂 ns-scroll", /className="ns-scroll"/.test(src), ""],
  ["子列表也能滚（不整页跑）", /maxHeight: 160, overflow: "auto"/.test(src) && /maxHeight: 220, overflow: "auto"/.test(src), ""],
  ["构建标记默认留空（发布版界面干净）", /const VERSION_TAG = "";/.test(src) && /\{VERSION_TAG\}/.test(src), ""],

  /* ── 能力完整 ───────────────────────────────────────────── */
  ["五种同步方式都在", /send-only-override-changes/.test(src) && /receive-only-revert-local-changes/.test(src) && /QUICK_STRATEGIES/.test(src) && /MIRROR_STRATEGIES/.test(src), ""],
  ["四种冲突处理都在", /local-priority/.test(src) && /server-priority/.test(src) && /no-conflict-merge/.test(src) && /diff3/.test(src), ""],
  ["过滤规则可勾选", /TEMP_DIRS/.test(src) && /excludes: cur/.test(src), ""],
  ["扫描方式可切换", /scanMode/.test(src) && /宽松/.test(code) && /严格/.test(code), ""],
  ["限速与大小可调", /minGapMs/.test(src) && /maxFileSizeMB/.test(src), ""],
  ["跟随开关可切", /autoFollow/.test(src), ""],
  ["能看历史", /LOG_LABEL/.test(code) && /ns_log/.test(src), ""],

  /* ── 文案：界面里不许出现工程词 ─────────────────────────── */
  ["界面文案无「预演」", !code.includes("预演"), ""],
  ["界面文案无「服务地址」", !code.includes("服务地址"), ""],
  ["界面文案无「并发」", !code.includes("并发"), ""],
  ["界面文案无「扫描模式」", !code.includes("扫描模式"), ""],
  ["界面文案无「WebDAV」", !code.includes("WebDAV"), ""],
  ["界面文案无「镜像」", !code.includes("镜像"), ""],
  ["界面文案无「同步策略」", !code.includes("同步策略"), ""],
  ["任务标签用日常说法", /上传|下载/.test(code) && /两边都改了/.test(code), ""],
  ["日志事件翻译成人话", /LOG_LABEL/.test(code) && /改了一项设置/.test(code), ""],
  ["应用密码给了获取步骤", /账户信息/.test(code) && /安全选项/.test(code) && /添加应用密码/.test(code), ""],
];

let bad = 0;
for (const [name, ok, extra] of checks) {
  console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok || !extra ? "" : "  (" + extra + ")"));
  if (!ok) bad++;
}
console.log("\n面板检查：" + (checks.length - bad) + " 通过 / " + bad + " 失败（" + src.split("\n").length + " 行）");
process.exit(bad ? 1 : 0);
