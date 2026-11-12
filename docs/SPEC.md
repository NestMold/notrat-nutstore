# notrat-nutstore 规格说明（SPEC）

对齐 `nutstore/obsidian-nutstore-sync` 的行为，按 Notrat 插件模型落地。本文是**验收基准**：
测试用例与本文逐条对应。

## 1. 数据模型

三个表，全部以**相对路径**（`/` 分隔、无前导斜杠）为键：

```ts
type Stat = { path: string; isDir: boolean; size: number; mtime: number }  // mtime 毫秒
type Record = { localMtime: number; localSize: number; remoteMtime: number; remoteSize: number; syncedAt: string }
```

- `local: Map<string, Stat>` —— 本地扫描结果（`scan.js`）
- `remote: Map<string, Stat>` —— 云端遍历结果（`plan.js` 的 `walkRemote`）
- `records: Record<string, Record>` —— 同步记录（`state.json`）

`decide()` 只吃这三张表 + config，**不做任何 IO**（纯函数，可单测）。

## 2. 变更判定

```
本地变了 = !record ? true
         : scanMode==='loose'   ? local.size !== record.localSize
         : local.size !== record.localSize || !sameTime(local.mtime, record.localMtime)
云端变了 = !record ? true
         : remote.size !== record.remoteSize || !sameTime(remote.mtime, record.remoteMtime)
sameTime(a,b) = a===0||b===0 ? false : |a-b| <= 2000ms
```

为什么宽松模式只看 size：大型目录里 mtime 会因为「保存但内容没变」频繁抖动，
每次都传一遍整个仓库不现实。这是参考实现的默认行为（`SyncMode.LOOSE`）。

为什么 2 秒容差：`getlastmodified` 只到秒，客户端本地毫秒精度必然有偏差。

## 3. 五种策略 × 状态矩阵

状态（两端是否存在 + 各自是否变化）：

| # | 状态 | two-way | send-only | send-only-override | receive-only | receive-only-revert |
|---|---|---|---|---|---|---|
| 1 | 仅本地有，无记录 | push | push | push | skip | **remove-local** |
| 2 | 仅云端有，无记录 | pull | skip | **remove-remote** | pull | pull |
| 3 | 仅本地有，有记录（云端删了） | remove-local¹ | push（推回去） | push | skip | **remove-local** |
| 4 | 仅云端有，有记录（本地删了） | remove-remote² | remove-remote / skip³ | **remove-remote** | pull | pull |
| 5 | 两端都有，都未变 | skip | skip | skip | skip | skip |
| 6 | 两端都有，仅本地变 | push | push | push | skip | skip |
| 7 | 两端都有，仅云端变 | pull | skip | skip | pull | pull |
| 8 | 两端都有，都变了 | **冲突** | **冲突** | **冲突** | **冲突** | **冲突** |
| 9 | 两端都有，无记录但 size+mtime 相同 | skip（identical-new） | 同 | 同 | 同 | 同 |
| 10 | 两端都没有 | skip（清记录） | 同 | 同 | 同 | 同 |

¹ 双向同步下，若本地**改过**而云端删了 → 不跟着删，转冲突（保留本地并推回）。
² 双向同步下，若云端**改过**而本地删了 → 不跟着删，保留云端并拉回（`notes` 里说明）。
³ 仅发送模式下，本地删了：云端未变 → 删云端；云端变过 → 跳过（保留云端）。

**目录**：只建不删（`mkdir-local` / `mkdir-remote`）。空目录残留比误删安全。

## 4. 四种冲突策略（展开阶段）

冲突 task 会被展开成具体动作：

| 策略 | 展开结果 |
|---|---|
| `local-priority` | 单个 `push`（本地覆盖云端） |
| `server-priority` | 单个 `pull`（云端覆盖本地） |
| `no-conflict-merge` | `pull(dest=冲突副本)` + `push`（保留双方） |
| `diff3` | 同 `no-conflict-merge`，并在 `notes` 里说明「无基线，已降级」 |
| 云端已被删（`remoteSize == null`） | 只 `push`（无法 pull 一个不存在的文件） |

冲突副本命名：`<stem>.conflict-<label>-<YYYYMMDDTHHmmss>.<ext>`，
`label` 来自 `os.hostname()`（多设备时能看出是哪台机器的版本）。

## 5. 执行语义

顺序固定：**mkdir → push/pull（并发池）→ remove → 回填远程 mtime**。

| 动作 | 实现要点 |
|---|---|
| push | 读本地 Buffer → `PUT` → 记录 `pendingRemoteStat:true`，远程 mtime 留 0 |
| pull | `GET` → 原子写（`.part-*` + rename）→ 记录实际本地 stat + 规划阶段的远程 stat |
| pull(dest) | 写到冲突副本，**故意不写记录**（让它下一轮当 local-only 正常上传） |
| remove | 删成功后**删除记录**（否则下轮会以为文件被删了又拉回来） |
| mkdir | 逐段 `MKCOL`（WebDAV 不自动建父目录，409 = 父目录缺失） |

**回填**：flush 结束后，对每个发生过 push 的目录做一次 `PROPFIND Depth:1`，
把真实 `mtime`/`size` 写回记录。不回填的后果：下一轮把刚上传的文件判成「云端变了」，
反向把旧内容拉回来覆盖 —— 这是增量同步最隐蔽的数据丢失路径。

## 6. 安全规则（硬约束）

| 规则 | 位置 | 理由 |
|---|---|---|
| 有删除动作时默认拒绝执行 | `exec.execute` / `ns_run` | 删除不可撤销 |
| 云端扫描有目录失败 → 本轮删除全部降级 skip | `plan.buildPlan` | 扫描不全 + 删除 = 误删整棵树 |
| 首次接入两端不一致 → 冲突，不静默覆盖 | `decide`（`!record` 分支） | 无法判断哪边可信 |
| 上传/下载都走原子写 | `exec.writeFileAtomic` | 中断不留半个文件 |
| 配置/记录损坏 → 备份 `.broken-<ts>` | `state.readJson` | 不静默清零用户数据 |
| 写文件前校验路径不越出同步根 | `scan.safeJoin` | 防 `..` 穿越 |
| 拒绝非法 Windows 文件名落到本地 | `decide.hasInvalidName` | 避免 pull 时崩在中途 |

## 7. WebDAV 调用约定

| 项 | 约定 |
|---|---|
| 端点 | `https://dav.jianguoyun.com/dav`（可配，企业版自定义） |
| 认证 | `Authorization: Basic base64(email:应用密码)` |
| 列目录 | `PROPFIND Depth:1` + `<propfind>` 请求 displayname/resourcetype/getlastmodified/getcontentlength |
| 分页 | 响应头 `Link: <...>; rel="next"` 循环跟随（单次上限 750 项） |
| 解析 | 自写正则解析 207，`%XX` 解码 + XML 实体解码，按 endpoint path 裁出相对路径 |
| 重试 | 429/500/502/503/504 指数退避（1.2s→2.4s→4.8s），默认 3 次 |
| 并发 | 信号量，默认 2；`minGapMs` 控制最小间隔（默认 120ms） |
| **重试不得在并发闸门内递归** | 否则自己等自己 → 死锁。结构：`_send`（闸门+单次） ← `_withRetry`（退避） |

## 8. 请求量估算

```
estimate = remoteScan(实际 PROPFIND 次数)
         + (push + pull + mkdirRemote + removeRemote)
         + min(push, 云端目录数 + mkdirRemote)   // 回填
```

- `> 限额` → `notes` 加一条带三条建议的警告
- `> 80%` → 温和提醒
- 限额常量集中在 `state.QUOTA`（来源：坚果云帮助中心 p=2064）

## 9. 不做的事（明确边界）

- 不做内容级 diff / 三方合并（无基线存储，`diff3` 降级为保留双方）
- 不做断点续传 / 分块下载（单文件上限 500MB，整读整写）
- 不做双向实时监听（只有手动触发 + 可选定时，见 `autoSync` 配置项 —— 目前未接调度器）
- 不移除空目录
- 不处理符号链接目录（跳过，防环）
