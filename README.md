# 坚果云同步 · notrat-nutstore

![license](https://img.shields.io/badge/license-AGPL--3.0-blue)
![version](https://img.shields.io/badge/version-2.1.0-green)
![platform](https://img.shields.io/badge/platform-Notrat-lightgrey)

把电脑上的文件夹与 **坚果云** 做增量同步的 Notrat 插件。界面只有三步：**连接 → 看差异 → 同步**。

动手前先看清会改什么，删文件必须你点头，两边都改过的文件默认各留一份。

- **零依赖**：只用 Node 内置模块，不装任何 npm 包
- **只读预演**：点「看差异」不改动任何文件，先给你看清单
- **删除要确认**：把要删的路径直接铺在按钮上方
- **不静默覆盖**：冲突默认保留双方，云端那份另存副本
- **本机存储**：账号与同步记录只在你自己的机器上，不随同步上传

## 安装

**通过社区货架（推荐）**

Notrat 会从 GitHub 上带 `notrat-plugin` 标签的公开仓库自动发现插件。装法：
设置 → 插件 → 搜索「坚果云同步」。

**手动安装**

```bash
git clone https://github.com/<你的用户名>/notrat-nutstore.git
cd notrat-nutstore
node install.mjs
```

装完在状态栏「插件箱」里打开，或命令面板搜「坚果云同步」。

**要求**：Notrat `1.3.5` 及以上。

## 三步怎么用

1. **连接**：坚果云网页版 → 头像 → **账户信息 → 安全选项 → 添加应用密码**（拿到的不是登录密码）。
   填邮箱 + 应用密码，点「测试连接」。通了会变成「已连接」。
2. **看差异**：点「看看要传什么」。这一步**只读**，列出要上传 / 下载 / 删除 / 冲突各多少、
   哪些文件、预计流量和请求次数。改过同步方式会提示「重新比对」。
3. **同步**：点「开始同步（N 项）」。后台跑，可以关掉页面。要删文件时会先把清单摊出来，
   你确认才动。

## 面板只有一个位置

完整页面，标签页形态（`location: "page"`，`openMode: "page"`）—— 像文件标签一样能关掉。

v1 曾经把同一个组件同时铺到活动栏、右侧栏、对话输入框、欢迎屏、完整页面五处。同一件事
五个入口，用户得一个个去关。现在只留一个：状态栏「插件箱」点开，或命令面板搜「坚果云同步」。

想换位置自己右键面板 →「面板位置」（14 个位置，选择会记住）。

## 五种同步方式

日常用的三种摆在「高级设置」上方，会删文件的两种单独放在下面并标红。

| 方式 | 行为 | 适合 |
|---|---|---|
| 双向同步 | 两边的新增 / 修改 / 删除都同步 | 多设备日常（默认） |
| 只上传 | 上传本地新增与修改；云端独有或已变的内容保留 | 本地为主，云端当备份 |
| 只下载 | 下载云端新增与修改；本地独有内容保留 | 云端为主，本地保留独立内容 |
| 只上传，并删掉云端多的 | 让云端与本地一致（**会删云端多余文件**） | 本地是唯一主副本 |
| 只下载，并删掉本地多的 | 让本地与云端一致（**会删本地多余文件**） | 云端是唯一主副本 |

## 四种冲突处理

两端都改过同一文件时：

| 处理 | 结果 |
|---|---|
| 两个都留着（默认） | 本地留原名，云端那份另存为 `名字.conflict-remote-时间.md`，随后把本地版推回云端 |
| 用电脑上这份 | 用本地覆盖云端 |
| 用坚果云这份 | 用云端覆盖本地（本地旧版另存 `.conflict-local-时间`） |
| 试着合在一起 | 本插件**不保存基线内容**，实际退化为「两个都留着」，计划里会注明 |

冲突**不会静默覆盖**：任何覆盖动作都能在「看差异」的清单里看到。

## 增量同步是怎么判断的

每个文件记一条记录：上次同步时两端的 `mtime` + `size`（存 `state.json`）。

| 本地变了 | 云端变了 | 结果 |
|---|---|---|
| 否 | 否 | 跳过 |
| 是 | 否 | 上传 |
| 否 | 是 | 下载 |
| 是 | 是 | 冲突 |

- **时间容差 2 秒**：WebDAV 的 `getlastmodified` 只到秒，不设容差会永远判「变了」。
- **宽松 / 严格**：宽松模式 size 相同即视为未变（大目录扫描快）；严格模式看 mtime + size。
- **上传后回填**：PUT 之后服务器给的 mtime 是接收时间，不能猜。所以上传完成后按目录做一次
  `PROPFIND` 把真实 mtime/size 写回记录，否则下一轮会把刚上传的文件判成「云端变了」而反向覆盖。

## 请求量与限额（重要）

坚果云官方（[帮助中心 p=2064](https://help.jianguoyun.com/?p=2064)）：

| 项 | 免费版 | 付费版 |
|---|---|---|
| 请求频率 | **600 次 / 30 分钟** | 1500 次 / 30 分钟 |
| 单次列目录 | **750 项**（客户端分页） | 同左 |
| 单文件上传 | 500 MB | 500 MB |

本插件的应对：

- 默认 `minGapMs=120`、`concurrency=2`（不是「越快越好」——600 次 / 30 分钟等于平均 3 秒一次）。
- `PROPFIND` 已实现 `Link: rel="next"` 分页，750 项上限不会截断。
- 429 / 500 / 502 / 503 / 504 自动指数退避重试（1.2s → 2.4s → 4.8s）。
- **看差异时会估算请求量并预警**：`预计请求：420 次（免费版限额 600 次 / 30 分钟，约占 70%）`。
  超过 100% 时 `notes` 里给三条建议（收紧过滤 / 分次同步 / 首次全量交给官方客户端）。

## 过滤规则

Gitignore 风格，**最后一条匹配生效**，`!` 表示重新包含：

```
node_modules/
dist/
preview/
!keep.log
附件/
**/temp/**
```

默认已排除：`.git/`、`node_modules/`、`.notrat/`、`.DS_Store`、`Thumbs.db`、`*.tmp`、`*.swp`、`~$*`。
面板「高级设置 → 不传这些目录」是常用几类的勾选，写进 `excludes`，自定义规则可直接编辑配置项。

## 安全设计

- **删除必须确认**：计划里有删除动作时，执行会返回 `requiresConfirmation` + `sample`（删除清单），
  面板把清单铺在按钮上方，点了「我确认，删掉这些」才执行（配置里 `autoDelete` 可关掉这层，不推荐）。
- **云端扫描不全时禁止删除**：只要有目录读取失败，本轮所有删除动作自动降级为跳过——
  扫描不全 + 删除 = 误删整棵树，这是最贵的 bug。
- **首次接入不猜**：两端都有但无记录、且内容不一致 → 判冲突，不静默覆盖。
- **本地删除保守**：双向同步下，若本地删了但云端**改过**，保留云端版本并拉回，不跟着删。
- **原子写**：配置 / 记录 / 下载都用临时文件 + rename，中断不会留半个文件。
- **损坏不静默清零**：`state.json` 解析失败先备份 `.broken-<ts>`，再退回空记录。
- **密码**：只存在 `~/.notrat/plugins/data/notrat-nutstore/config.json`（权限 600），
  不随同步上传，工具返回与面板显示都永远脱敏。
- **不偷改目标**：跟随当前工作区只影响界面上的默认值，改配置要你按按钮。

## MCP 工具

| 工具 | 作用 |
|---|---|
| `ns_guide` | 使用指引（方式怎么选、密码在哪生成） |
| `ns_config` | 读 / 改配置（密码脱敏） |
| `ns_test` | 测试连接，可顺便检查云端目录 |
| `ns_ls` | 浏览云端目录 |
| `ns_plan` | 算一遍要传什么，不改文件，返回清单 + 请求量估算 |
| `ns_conflicts` | 列出最近一次计划里的冲突 |
| `ns_run` | 执行（可 `async:true` 后台跑、返回 jobId） |
| `ns_job` | 查任务进度 / 结果 |
| `ns_cancel` | 取消（当前文件做完就停） |
| `ns_resolve` | 手动解决冲突（本地 / 云端 / 保留双方） |
| `ns_status` | 状态总览 + 最近日志 |
| `ns_log` | 读 / 清日志 |

命令：`/nutstore-status`、`/nutstore-plan`、`/nutstore-sync`。

## 数据文件

```
~/.notrat/plugins/data/notrat-nutstore/
├── config.json      配置（含应用密码，权限 600）
├── state.json       同步记录（每文件的本地/云端 mtime + size）
├── last-plan.json   最近一次计划（10 分钟内可被 ns_run 复用）
└── sync.log.jsonl   运行日志（环形，保留最近 2000 行）
```

要改位置：设置 → 坚果云同步 → 数据目录（改动会重启本插件的 MCP server）。

## 仓库结构

```
notrat-nutstore/
├── manifest.json          清单（社区货架从仓库根读它）
├── panels/sync.tsx        面板源码（宿主运行时编译）
├── server/index.js        MCP server 入口（stdio JSON-RPC）
├── server/lib/            同步引擎，按职责拆分
│   ├── webdav.js          WebDAV 客户端（分页 / 退避 / 原子写）
│   ├── scan.js            本地扫描
│   ├── plan.js            远端遍历 + 计划编排
│   ├── decide.js          决策引擎（纯函数，不做 IO）
│   ├── exec.js            执行
│   ├── rules.js           过滤规则
│   └── state.js           配置 / 同步记录 / 日志
├── docs/SPEC.md           规格说明（验收基准）
├── tests/                 12 套测试
├── install.mjs            本地安装器
├── LICENSE                AGPL-3.0 全文
└── README.md
```

## 开发与测试

```bash
node tests/run.cjs               # 全部 12 套
node tests/run.cjs --verbose     # 逐条列出
node install.mjs --dry-run       # 看会装哪些文件
node install.mjs                 # 装到 ~/.notrat/plugins/notrat-nutstore/
```

面板 TSX 由宿主用 esbuild 在运行时编译。本地想先验证语法：

```bash
# 用 Notrat 自带的 esbuild
"<Notrat>/resources/app.asar.unpacked/node_modules/@esbuild/win32-x64/esbuild.exe" \
  panels/sync.tsx --target=es2020 --format=cjs --outfile=/tmp/check.js
```

测试覆盖：

| 套件 | 内容 |
|---|---|
| `_manifest.cjs` | manifest 必填字段、sourceFile / server 存在、命令指向真实工具 |
| `_panel-syntax.cjs` | 括号配平、安全契约（删除确认 / 密码）、三步结构、文案里不许出现工程词 |
| `_panel-jsx.cjs` | 真实 TSX 编译（esbuild） |
| `_panel-render.cjs` | 用极简 React 替身跑 10 种状态，抓白屏和 undefined / NaN 泄漏 |
| `_panel-collapse.cjs` | 纯函数：计划过期判定、云端目标计算、路径处理、大小格式化 |
| `_panel-errmsg.cjs` | 失败信息契约（不许只说一句「失败」） |
| `decide-matrix.cjs` | 5 种方式 × 10 种状态的决策矩阵 |
| `_mcp-handshake.cjs` | JSON-RPC 握手 / tools/list / tools/call |
| `e2e-webdav.cjs` | 起内存 WebDAV 服务器跑完整链路 |

## 许可与出处

本插件**按 AGPL-3.0 发布**（`AGPL-3.0-or-later`，全文见包内 `LICENSE`）。

它迁移自 [nutstore/obsidian-nutstore-sync](https://github.com/nutstore/obsidian-nutstore-sync)，
该项目采用 **AGPL-3.0** —— 因此本项目作为衍生作品同样使用 AGPL-3.0，不能改用 MIT 或闭源分发。
原项目版权归其作者所有。

### 迁移了什么

同步模型：5 种同步策略、4 种冲突处理、三方比对、gitignore 规则、分页 PROPFIND、503 退避。

### 没迁移什么

Obsidian Vault API、混元 / LLM 助手、增量 delta API、移动端分块下载、Obsidian 配置目录同步。

### 用 AGPL 意味着什么

- 你可以自由使用、修改、再分发，前提是**保留同样的 AGPL 许可**并**提供完整源码**。
- 如果你把这个插件作为网络服务提供给他人使用，也有义务让他们拿到源码。
- 商业使用不禁止，但闭源分发不行。

> 另需说明：本插件通过 Notrat 插件机制运行在你自己的机器上，与 Obsidian 无关；
> 上游代码是 Obsidian 插件，这里只移植了同步算法与 WebDAV 客户端行为。
