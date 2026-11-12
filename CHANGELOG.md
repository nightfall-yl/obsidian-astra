# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> 说明：本更新日志自 `26.1.1` 起维护。


## [26.3.7] - 2026-11-12

### 修复
- **同步配置文件夹开关失效（re-entrant bug）**：开启开关触发二次确认弹窗 → 确认后 toggle.setValue(true) 再次触发 onChange → 落入无条件 else 分支把 data.json 写回 false；UI 看似已开、重启后变回关闭，功能 100% 失效。修复：加 pendingConfirm guard，re-entrant 回调什么都不做
- **OneDrive 410 软删除被当成远端暂不可达**：HTTP 410（软删除/租户 retention）此前被 syncEngine 当作普通错误累计凑够 3 条整轮中止且每轮重复重试；现 404/410 统一视为「远端已不存在」，摘除快照键、跳过条目、不计入错误累计

### 调整
- **「同步配置文件夹」去掉实验性质标签**：中英双语标题移除 "（实验性质）" / "(experimental)" 后缀，风险提示文案保留


## [26.3.6] - 2026-11-05

### 新增
- **函数调用与函数注册表**：`parseExpression` 支持函数调用，内置函数改为注册表分发，未知函数抛 `不支持的函数：X`；新增 `dateformat`、`contains`、`startswith`、`endswith`
- **内置数值字段 `file.mtime` / `file.ctime` / `file.size`**：取 `TFile.stat` 的毫秒时间与字节数；`file.mtime` / `file.ctime` 单元格默认渲染为 `yyyy-MM-dd HH:mm`
- **`[[wikilink]]` 字面量**：支持 `[[path]]`、`[[path#heading]]`、`[[path|alias]]` 三种写法（`|alias` 忽略、`#heading` 不参与路径比较），可用于函数实参与比较右值
- **`file.outlinks` 字段**：合并 `metadataCache` 的 `links` 与 `embeds`（embed 计入，对齐 Dataview），按解析后库内路径去重，解析不到的链接直接丢弃，纯 `#heading` 自引用归一为源文件路径
- **`contains` / `startswith` / `endswith` 语义**：`contains` 左侧须为数组，逐项按解析后路径严格全等；`startswith` / `endswith` 区分大小写，左侧为 `null`、`undefined` 或数组时返回 `false`；`!函数(...)` 复用既有 `!` 分支取反，`!` 语义不变

### 调整
- **OneDrive 鉴权入口改造（授权等待窗口与撤回鉴权）**：两处交互集中在同步设置页——授权等待窗口补齐手动打开入口，撤回鉴权改为两步确认，避免移动端无法跳转浏览器时流程卡死
  - **授权等待窗口**：窗口内始终渲染可点击授权链接与「复制链接」按钮，桌面端保留自动跳转、移动端跳过自动跳转；此前只显示等待提示，iOS 上点了没反应
  - **撤回鉴权**：改为两步 Modal（先引导去 Microsoft 账号侧移除授权，再点「清理」），清理范围补齐 `deltaLink`、IndexedDB 远端快照、`lastSynced` 复位；`account.live.com` 链接改普通链接渲染；不删除本地笔记、远端文件与 `prevSync` 基线
- **主设置页新增状态栏开关**：状态栏此前只能跟随同步总开关存在；现在新增设置项「在状态栏显示同步状态」（`settings.sync.showStatusBar`，默认开启，旧配置缺字段按开启补齐），关闭立即移除状态栏条目、开启立即重建并刷新文案，无需重启，也不会残留或重复注册
- **状态栏进度文案改为中点分隔**：进度百分比后缀统一为 ` · {pct}%`（例如 `OneDrive Syncing 12/300 · 4%`），文案走 i18n 键 `sync.statusbar.progress`，中英文的空格与分隔符均由模板和拼接函数保证，不再有硬编码标点
- **进度态的无障碍标签未跟随可见文案**：同步进行中 `aria-label` 仍停留在空闲态的上次同步日期，读屏内容与状态栏实际显示不一致；现在进度刷新时同步更新 `aria-label`（步骤名 + 进度），空闲态的日期提示逻辑不变


## [26.3.5] - 2026-11-04

### 调整
- **data.json 废弃字段清理（v2 → v3 一次性迁移）**：清除多轮功能裁剪后残留的 12 个孤儿键
  - 旧「固定 todo 文件」`todoFilePath`、旧「快捷插件入口」`quickPluginIds`/`quickPluginsInitialized`、一次性调试快照 `flomoDebug`
  - 已整块移除的「机会看板」`boardTitle`/`opportunityFile`/`currentOppView`/`boardStages`
  - 已裁剪的搜索设置 `settings.search.ribbonIcon`/`showCreateButton`、同步设置 `settings.sync.syncOnRemoteChangesAfterMilliseconds`/`enableStatusBarInfo`/`encryptionEnabled`
  - 迁移幂等，首次加载即执行；无需迁移的新安装不受影响

### 修复
- **OneDrive vault 根目录识别误判**：vault 根目录检测用 `includes("/VaultName")` 子串匹配，当 OneDrive 应用文件夹名恰好以 vault 名开头（如应用文件夹叫 `Obsidian Vault Sync`、vault 名叫 `Obsidian Vault`）时会误判，导致每次同步枚举远端时控制台刷 `skip unrecognized onedrive item` 警告；改为路径段精确匹配（`endsWith` / `includes` 前后均要求 `/` 边界）
- **删除文件后同步中止（远端快照幽灵条目）**：删除笔记后远端快照未移除对应键，下一轮被判为"远端新增"，元数据查询或二进制下载遇 HTTP 404，累计 3 条错误后整轮中止且每轮重复；下载链路的两次请求（`downloadFromRemoteRaw` 的元数据查询与内容下载）现都按状态码判断，404 视为"远端已不存在"——摘除快照键、跳过该条目、不计入错误累计（401/403/429/5xx 与网络错误仍正常报错）
- **快照键与远端状态不同步**：远端删除成功后立即移除对应快照键，不再等下一轮 delta（远端文件已被别处删除时，`deleteJson` 的 404 视为删除达成，清快照键与清删除/改名历史照常执行）；全量枚举改为从空快照重建，不再以旧快照为基底
- **远端快照未记录 `driveItem.id`**：delta 删除项缺少 `name` / `parentReference` 时整条被跳过，快照残留幽灵键；快照现持久化 `driveItem.id`，删除优先按 id 反查（一次构建 id→键索引）摘除，id 缺失或不匹配才回退路径/文件名，同一文件的明文键与密文键一并移除。旧快照（条目缺 `id`）在下一次同步时清空并全量枚举重建一次，`deltaLink` 保留，重建后条目都带 id，条件不再成立，不退化每轮全量
- **非 2xx 且响应体无 Graph 错误字段被当成成功**：`oneDriveApiRequest` 只在响应体含 `error` 字段时抛错，其余非 2xx 一律返回 `{}`；元数据 404 会使 `downloadUrl` 取值为空、随后抛出不带状态码的错误并计入熔断，delta 分页则被当成零条目、把快照整体清空。现补 `status >= 400` 兜底，非 2xx 一律抛带状态码的错误，空响应体用状态文本填充
- **双向同步空文件覆盖非空文件**：每日笔记等插件在本地「先删后建」重建空文件时，空文件因 mtime 最新会走 mtime 比较路径覆盖远端非空副本；原空文件保护只覆盖 prevSync 不存在的无基线场景。现升级为 blanket rule——只要一边空一边非空就选非空侧，无论 prevSync 是否存在

### 性能
- **远端快照迁出 data.json**：`settings.sync.onedriveConfig.remoteSnapshot`（约 1,600+ 路径的 OneDrive delta 续传快照）搬到 IndexedDB `astra-sync-db` 的独立 object store `remoteSnapshot`（keyPath=`key`，库版本 1→2）。首次启动自动写 IDB、删内存字段、一次 saveSettings 落盘；幂等标记 `remoteSnapshotMigrated`。IDB 读失败时一律降级为空快照，同步走全量枚举不抛异常。`deltaLink`（小字符串）仍留 settings
- **activity 裁剪**：写作用量记录（`activity`）首次有了裁剪逻辑——保留窗口 `max(activityHistoryDays + 30, 400)` 天，scan 末尾一次性删除超窗口旧日期；同时收敛历史遗留的 `paths` 重复项。裁剪逻辑抽成纯函数 `pruneActivityRecords` 可独立单测
- **热力图复用 scan 归组结果**：热力图改为直接读 stats.scan() 已经完成的全库按 mtime 归组结果 `dailyNoteCounts`，消除每次刷新时的第二次全库遍历；约 5000 文件量级可省 ~11ms/次刷新（估算值）。仅 FILE_MTIME 模式走新路径，FILE_CTIME / FILE_NAME / PAGE_PROPERTY 三种模式保持原遍历逻辑
- **删除停用的指标卡片 UI 代码**：此前用 `void this.renderMetrics` 禁用的 4 个统计大卡片（`renderMetrics` / `createMetricCard` / `noteDetail`）及其全套 CSS（`.astra-metrics` ~45 行）、i18n key（`dv.stats.*` × 6）一次性清除；数据层暂保留


## [26.3.4] - 2026-11-03

### 调整
- **自动同步触发时机收敛**：设置页 Vault Sync 保留两项，统一调度器 `SyncAutoScheduler`（含可测试纯函数 `computeScheduledRunTime`）承接原先三个定时器的职责；任意两次自动同步之间强制最小间隔 30s（手动同步不受此限制）
  - 「自动同步」(`autoRunEveryMilliseconds`，单下拉四档：不设置 / 每 5 分钟 / 每 10 分钟 / 每 30 分钟；非「不设置」时启动后 5 秒先跑一次)
  - 「保存后同步延迟」(`syncOnSaveEnabled`，布尔开关，文件保存后固定 5 秒触发)；同时删除「启动后自动运行一次」(`initRunAfterMilliseconds`)
- **旧配置兼容**：`syncOnSaveAfterMilliseconds > 0` 自动映射为新布尔开关 true，用户显式设置的新字段优先；`autoRunEveryMilliseconds` 非四档值（如 1min / 15min）在 `normalizeSyncSettings` 中按最近差值映射到合法档位；两个废弃字段在归一化时被显式删除，用户已保存的数值不会误被解释为开启

### 修复
- **OneDrive 同步重复触发**：syncRun 成功收尾调用 `saveSettings()` 写 data.json → vault modify 事件 → 被自身注册的 syncOnSave 防抖监听捕获 → 再次触发 syncRun，形成可无限迭代的反馈环；现在 modify handler 排除插件目录下的 `data.json` / `static-data.json`
- **IndexedDB Promise rejection 规范化**：`open oldDB` / `open newDB` / `write tx` 三处 `reject(req.error)` 加 `?? new Error("...")` 兜底，消 `prefer-promise-reject-errors` 警告；顺带删 `value as unknown` 多余断言

### 性能
- **Dashboard 刷新事件合并**：vault modify/create/delete/rename 统一 100ms trailing debounce、metadataCache resolved 300ms debounce，500ms maxWait 持续事件流强制刷新兜底；saveSettings / saveDashboardPreferences 等即时反馈路径保留同步刷新不受影响；onunload 清理定时器并兜底执行待刷新


## [26.3.3] - 2026-11-02

### 调整
- **设置页分组渲染加异常隔离**：四个 tab（Astra / Markdown+ / Vault Search / Vault Sync）各自 try/catch，单个分组渲染失败不再牵连后续分组，容器内显示简短错误提示（"该设置分组加载失败，请尝试重启插件"），控制台打印分组名与异常
- **IndexedDB 库名 `astral-trek-sync-db` → `astra-sync-db`**：首次启动检测旧库存在时，读全量 kv store，写入新库后删除旧库；迁移幂等、失败静默，降级为空新库。已授权用户的 OneDrive 同步状态、删除历史、mapping 全部保留
-  **「检测远端变更后同步延迟」功能整体删除**
- **manifest / package description 更新**：反映当前实际功能（聚合工作台、全文搜索、OneDrive 同步、Markdown+、astra 查询块），移除已不再是核心卖点的知识图谱、插件管理、库健康等过时描述
- **CODE_WIKI 仓库地址修正**：`obsidian-astral-trek` → `obsidian-astra`


## [26.3.2] - 2026-11-01

### 调整
- **设置页多组名精简**：「主页模块」→「组件」、「移动端模块显隐」→「移动端组件」、「视图模式」→「视图」、OneDrive 设置 →「账户」、「基本设置」→「通用」、「同步内容」→「同步」、「进阶设置」→「高级」
- **Astra「通用」组**：「启动时打开主页」提至第一，「启动方式」第二，「昵称」第三，「短笔记词数阈值」垫底
- **Astra「Minimal 设置」组**：「图片网格」与「极简状态栏」互换位置
- **Markdown+「视图」组**：「启用光标位置」提至组内第一；其余视图强制开关（启用强制视图模式 / 忽略已打开文件 / 未指定时忽略强制）顺序保留，文件夹与文件规则不动
- **Vault Search 设置顺序**：「高亮匹配词」提至第二；「简单搜索」与「模糊度」放至组末（分别倒数第二、倒数第一）
- **Vault Sync「同步」组**：「同步 _ 文件或文件夹」置顶，以下依次为同步 .trash / 同步书签 / 同步配置文件夹
- **Astra「移动端组件」组新增「显示设置项」开关**：与 Minimal 主题同语义——组内首项开关常显，打开后显示下方所有移动端组件勾选项，关闭时收起仅保留开关本身；默认关闭；状态持久化到 data.json（字段 `mobileShowSettings`），关闭不影响已勾选生效；每个勾选项新增统一 desc 说明开关作用；实现复用 Minimal 已有的「显示设置项」i18n key（p4.10261），push settingEl + applyVisibility 模式对齐

### 性能
- **OneDrive 同步「获取远端文件列表」提速（量级改善）**：`listFromRemote` 重写，修复 deltaLink 只存不用 bug
  - **Delta 续传**：首次同步存下完整远端快照（key → RemoteItem）和 `@odata.deltaLink`；后续同步直接用 deltaLink 只拉增量变化（增/改/删），合并到本地快照后返回完整 Contents——O(N) 变 O(Δ)，无改动时亚秒级
  - **分页尺寸 `$top=200`**：OneDrive Graph 默认每页 20 条，全量枚举 1000 文件需 50 次串行往返；改传 `?$top=200` 拉满 API 上限，同场景降到 5 次往返，首次同步也有 10× 提速
  - **删除语义补全**：原代码直接跳过 delta 返回的 `deleted` 标记条目，导致续传时远端删除会被吞掉；现在删除条目正常解析 key 后从快照移除（元数据异常时按路径后缀反查兜底）
  - **失败回退**：deltaLink 过期（410 Gone）或网络异常时自动清空 deltaLink + 快照，回退全量枚举，下次同步自动恢复


## [26.3.1] - 2026-10-31

### 修复
- **OneDrive 授权成功后设置页不刷新**：根因是 `notifySettingsRefresh()` 从未实现，授权状态已写入但设置页收不到通知；新增重渲染钩子（打开注册、关闭解除），授权成功 / 撤回后立即刷新且不跳走当前 tab
- **同步删除的「系统回收站」选项从未生效**：删除回调误用 `vault.trash(f, false)`（实际进 Obsidian `.trash`），与「Obsidian .trash」选项行为相同；改用 `adapter.trashSystem()`（移动端不支持时自动回退 `.trash`），该选项首次真正生效，顺带清零 `prefer-file-manager-trash-file` lint 警告
- **同步引擎硬编码配置文件夹 `.obsidian`**：`doActualSyncV3` 的 `configDir` 默认参数写死 `".obsidian"`，而 Obsidian 允许用户自定义配置文件夹名；改为默认引用 `vault.configDir`（唯一调用方本就显式传入真实值，运行时行为不变，默认值对未来的调用方自洽）


## [26.3.0] - 2026-10-31

### 新增
- **Vault Sync**（OneDrive 同步）：引擎自上游 obsidian-third-party-sync 移植并裁剪为 OneDrive 专用（新增 `src/sync/` 约 6000 行）
  - 授权：OAuth2 PKCE 登录（`obsidian://astral-trek-onedrive` 回调），可随时撤回授权
  - 同步方向：双向（互为镜像）/ 仅上传（本库为基准的备份）/ 仅下载（从云端拉取），均含删除操作；冲突按保留较新或保留较大处理；删除可送系统回收站或 Obsidian `.trash`
  - 同步范围：`.obsidian` 配置目录（默认关）、书签 `bookmarks.json` 可单独同步、`.trash`（默认关）、下划线开头隐藏文件（默认关）、单文件大小上限
  - 安全防护：保护阈值（待修改/删除文件占比超限时中止本次同步）；可选密码端到端加密
  - 触发方式：ribbon 按钮与命令手动同步、定时自动、启动后首次延迟、保存笔记防抖、远端变更检测，均可独立配置或关闭
  - 界面：设置页 4 组（状态 / 基本 / 同步内容 / 高级）；状态栏显示上次同步相对时间（刚刚 / N 分钟前…，30 秒自动刷新）与同步中实时步骤；ribbon「Astra同步」按钮同步中图标切换
- **Vault Search**：全文搜索升级为独立功能 tab（自 Astra tab 内的设置组迁出，名称固定 `Vault Search`，图标 search）
  - 设置：单组 7 项、无组名——尊重 Obsidian 的「排除的文件」/ 简单搜索 / 显示摘录 / 高亮匹配词 / 显示上一次的查询 / 定位到命中文本（6 个开关）+ 模糊度（下拉，垫底）；索引范围与结果权重固定为内置默认值
  - 入口：ribbon「Astra搜索」常驻 + 命令「打开全文搜索」（可在「设置 → 热键」自行绑定）；
  - 索引持久化：索引落盘至插件目录 `search-index.json`（含格式版本 + 设置指纹 + 文件 mtime 表），重启后跳过全量重建、毫秒级恢复可用；启动时后台按 mtime 对账，自动修复 Obsidian 关闭期间因同步等外部改动增删改的文件；增量编辑 5 秒防抖写盘（串行队列防交错），插件卸载时立即 flush；缓存损坏或写失败静默降级为全量重建；修复 `rebuild()` 会重复注册事件监听的问题（新增 `computeFingerprint` / `planReconcile` 纯函数，vitest +4 例）
- **数据版本清退机制**：主数据新增 `dataVersion` 字段，一次性迁移收口为 `DATA_MIGRATIONS` 注册表（每条带 `to` 目标版本与 `introducedIn` 引入版本标注）；低于 `RETIRED_BELOW_DATA_VERSION` 清退线的历史数据放弃迁移、直接回默认值——`data.json` 只存配置与统计，用户内容全在 Markdown 文件里，重置代价可控。今后删除旧迁移 = 删注册表条目 + 抬清退线 + 删对应测试
  - 快速捕获旧字段（storagePath/namingPattern/templateFile → filePath）收编为注册表首条目（v1→v2）
  - 热力图空值归一化、sync 方向回退 / clientID 回填 / 已移除设置项钳制等防御性逻辑归并为永驻 `normalizeHeatmapSettings` / `normalizeSyncSettings`（不占版本号）
  - `loadPluginData` 由 ~160 行散装迁移缩为 ~72 行骨架；Section2 forceViewMode 迁移补 `introducedIn` 与自清退说明

### 调整
- **设置页四 tab 架构**（同步整合前置，Phase 1）：固定名称 `Astra / Markdown+ / Vault Search / Vault Sync`，图标 layout-dashboard / file-text / search / cloud
  - Minimal 主题设置自 Markdown+ 迁入 Astra（工作台 + 日历 + 主题）
  - tab 栏移动端适配：窄面板下横向滑动（隐藏滚动条），桌面端无变化；修复移动端暗色模式下设置组背景框
- **Ribbon 按钮 i18n 化命名**：Astra主页 / Astra日历 / Astra搜索 / Astra同步
- **Minimal 组新增「显示设置项」开关**（默认收起 5 项）

### 性能
- **光标位置记忆**：固定 100ms 常驻轮询改为快慢自适应——状态有变化保持 100ms 快采，连续静默约 1 秒后回退 1s 慢采，切换文件或状态变化立即恢复快采；活跃编辑时采样精度与原版一致，空闲轮询频率降 90%（滚动/光标无官方事件，保留轮询仅降频）
- **写作统计**：`recordFileChange` 复用 metricCache 的 mtime+size 指纹，stat 未变化跳过全文 `cachedRead + countWords`（lint 回写、防抖连击等同内容多次 modify 场景由 O(全文) 降为 O(1)），重算后回写最新词数供后续 modify 与全库扫描复用

### CSS 质量
- **主页模块拖到垃圾桶的「即将删除」视觉从未生效**：卡片 DOM 基类为 `.astra-surface`，CSS 选择器更正为 `.astra-surface.astra-card--doomed`，半透明 + 红虚线反馈恢复
- **死规则审计**：478 个类选择器全量反查 `src/` 语料，删除 8 组零引用规则（约 60 行）；保留 3 个 Obsidian 原生类（`.mod-root` 等）与 8 个有意预留的 `--ad-*` 调色板 token；

### 测试
- **lint 回写应用层集成测试**（+5 例）：真实 `LinterManager` + 最小 Editor 替身，锁死差异区间回写（防整文替换退化与跳光标回归）、跨行区间、无变化零回写、`lastLintedContent` 防重复 lint 记录、`isApplyingLint` 防重入门禁时序
- **数据迁移与 normalization 测试**（+9 例）：heatmap / sync 归一化、quickCapture 迁移两分支、注册表不变量（`to` 单调递增且 ≤ 当前数据版本）
- 全项目 12 文件 125 例通过


## [26.2.4] - 2026-10-28

### 修复
- **编辑笔记时光标反复跳回文档顶部**（社区反馈）：lint 内容回写由整文替换改为按「最长公共前缀/后缀」定位的差异区间替换（新增 `src/linter/diff-range.ts`，vitest 4 例覆盖），光标与滚动位于公共区域内时保持原位
- **编辑触发模式不再刷新 YAML 时间戳**：`date modified` 的维护回归保存时语义——打字间隙刷新既非幂等（时间持续前进）又会反向制造 diff，是跳光标的主要触发源；保存触发（Cmd+S）行为不变
- **设置页「文件夹规则 / 文件规则」增删后跳回设置页顶部**：改为增量渲染单行（添加只 append、删除只移除该行 DOM），不再整页重渲染，滚动位置与输入焦点得以保留


## [26.2.3] - 2026-10-24

### 社区审核整改

社区插件审核报告的 4 条 Warning 代码侧全部清零，用户可见行为不变：

- **Direct Filesystem Access**：i18n 语言探测原先经 Node.js `fs` 读库外全局配置 `obsidian.json`（vault API 够不到该文件，属审核器标记的「库外文件访问能力」），改为 `moment.locale()`——Obsidian 启动时会把应用语言同步给 Moment，桌面/移动端一致，词典选择行为不变；bundle 中 `require("fs")` 清零
- **默认热键**：全文搜索命令移除内置 `Mod+Shift+F` 默认热键（审核 guideline 要求不替用户预设热键），命令与 ribbon 按钮保留，可在「设置 → 热键」自行绑定
- **CSS multicolumn 误报**：审核器把热力图的 `column-gap` 归入「多栏布局」特性（实际作用于 `display: grid`，是列间距，所有 Obsidian 版本完整支持，属粗粒度误报）；改用通用 `gap` 简写一行合并行列间距——注意 `gap` 语法为「行 列」顺序，与原两行语义严格等价
- **依赖漏洞公告（katex，GHSA-238p-pmpm-9mq7）**：上游 micromark-extension-math 把 katex 声明为运行时依赖（实际只使用其类型声明，katex 代码从未被打包），导致 lockfile 携带公告覆盖的版本。处理：按 MIT 将其语法层 vendor 为 `src/linter/micromark-math.ts`（约 420 行 TS 化，含 `TokenTypeMap` 显式扩充，html 渲染层未随行），卸载整个依赖并把实际引用的三个 micromark util 包提升为显式依赖——katex / @types/katex 从依赖树连根消失（`npm ls` 为空、lockfile 零匹配）；新增 2 例冒烟测试守护 vendor 代码（行内/块级切分 + 未闭合 `$` 不误判），全项目测试 54 → 56 例
- 顺带清理 eslint.config.mjs 三块失效豁免（默认热键 / i18n 的 `require` / 早已删除的 heatmap 目录）


## [26.2.2] - 2026-10-23

### 新增

- **全文搜索**：ribbon 搜索按钮 + 命令「打开全文搜索」（按社区审核要求不设默认热键，可在「设置 → 热键」自行绑定），打开全库搜索弹窗（交互与视觉复刻 omnisearch；其源码为 GPL-3，仅复刻体验、未搬运代码）
  - 引擎：minisearch（MIT）+ 浏览器原生 `Intl.Segmenter` 中文分词（ICU 词级切分，零外部依赖）；字段权重对齐 omnisearch 默认（文件名 10 / H1 6 / H2 5 / H3 4），fuzzy 0.2 + prefix
  - 索引：懒启动（首次使用才构建）、20 文件分批构建、frontmatter 剔除、`metadataCache` 事件增量更新（changed 500ms 防抖 + delete/rename 同步）
  - 弹窗交互：↑↓/Tab 选择、`Enter` 打开、`Mod+Enter` 新标签、`Alt+Enter` 插入链接、`Alt+↑↓` 搜索历史（持久化）、`Mod+G` 临时切换摘录；IME 组合中 Enter 不触发；结果含文件名 + 摘录 `<mark>` 高亮，悬停预览
  - 弹窗 UI：融入式输入行（聚焦/失焦/悬停均无框线，特异性 0-3-0/0-4-0 压过原生 `input[type=text]` 样式）、分隔线伪元素绘制且左右各内缩 16px、空态紧凑（无输入不渲染占位）、不显示建索引进度文字
  - 设置：「搜索」组位于 Astra tab 日历组之后，4 项（Ribbon 按钮 / 显示摘录 / 摘录渲染换行 / 高亮匹配词），默认中文
  - 实现：新增 `src/search/`（tokenizer / search-service / search-modal，纯函数层 vitest 15 例覆盖分词与排序摘录）


## [26.2.1] - 2026-10-23

### 新增

- **通用查询代码块 ```astra**：在笔记中写 DQL 查询，三种查询头共享子句管线，执行顺序固定 FROM → WHERE → SORT → LIMIT（与 Dataview 一致）
  - TABLE：`TABLE [WITHOUT ID] 字段 [AS "别名"] ...`，渲染为 Dataview 风格表格；支持 `file.name/path/folder/link` 内置字段 + 任意 frontmatter 字段，表头文件列自带结果计数 (N)
  - LIST：`LIST [WITHOUT ID] [字段]`，渲染为文件链接列表，语义对齐 Dataview（无字段 = 文件链接；有字段 = "链接: 值"；WITHOUT ID = 仅值），不支持 AS 别名
  - TASK：`TASK [WHERE !completed]`，渲染为任务列表（复用 Obsidian 原生 task-list-item 样式，悬停显示"来源路径:行号"），checkbox 可勾选并写回源文件；任务位置取官方 `metadataCache.listItems`、章节名取 `cache.headings`，不支持 WITHOUT ID / 字段定义
  - 勾选写回：新增 `src/query/taskWriteback.ts` 纯函数（vitest 11 例）——`vault.process` 原子读改写，只替换 checkbox 单字符（保留缩进/列表标记/EOL 风格）；乐观锁两级定位（快照行文本命中 → 漂移时 ±5 行窗口按文本唯一匹配），stale / ambiguous 均零写入并在 checkbox 旁 inline 提示（5 秒自动消失）；已处于目标状态时幂等；成功后原地更新 UI，不订阅全局事件
  - 子句：`FROM` 支持 `"路径"` 与 `#tag`（正文内联标签 + frontmatter 标签，含子标签命中、大小写不敏感）；`WHERE` 支持 `=`/`!=` 与布尔形式（`WHERE 字段` / `WHERE !字段`）；`LIMIT N`（非负整数）
  - 实现：`src/query/parser.ts` 纯解析器（无 Obsidian 依赖）重构为判别联合（TableQuery / ListQuery / TaskQuery + CommonClauses），`src/query/manager.ts` 泛型子句管线 `applyClauses`；测试 10 → 33 例（全项目 39 例通过）

### 修复

- **与思维导图插件（simple-mind-map）冲突**：其全局 markdown post-processor 会清空 markdown-embed 预览容器、替换为「该文件中没有可预览图片」占位。根因：`renderLink` 经 `MarkdownRenderer.render` 渲染 `[[链接]]`，嵌套触发了该处理器（Dataview 因直接构造 DOM 而幸免）。修复：`renderLink` 改为直接构造 `<a class="internal-link" data-href>`，点击/悬停预览由 Obsidian 全局委托处理，不再触发任何第三方 post-processor，渲染也更快
- **描述列末尾多余空行**：两处根因——① YAML 多行块标量（`description: |`）值内含换行：统一 `replace(/\s+/g, " ").trim()` 归一化；② `MarkdownRenderer` 给链接包裹的 `<p>` 上下 margin 撑高行：`renderLink` 渲染后剥离 `<p>`，CSS 补 `td > p { margin: 0 }` 兜底
- **表格样式对齐 Dataview 原生**：去竖线/斑马纹/表头底色，表头 3px 粗线；文件列 `nowrap + max-width 12em` 省略号截断
- **frontmatter 对象字段显示 `[object Object]`**：新增 `stringifyValue`（对象转 JSON、null/undefined 转空串），WHERE 比较、SORT 排序、单元格渲染统一走它；顺带清零 4 个 `no-base-to-string` lint error
- **裸 `FROM` / `LIMIT` 行被静默吞掉**：子句值为空串时因 falsy 判断被当作"未提供"（裸 `FROM` 静默变整库查询），改为 `!== null` 判断 + 显式 `QueryParseError`（含空标签 `#`、空路径 `""`）

### 移除

- **devDependencies 中未使用的 obsidian-dataview**：源码零引用，esbuild external 同步清理。


## [26.1.9] - 2026-09-30

### 交互优化

- **主页问候语自动更新**：Dashboard 打开时只算一次段边界（0 / 6 / 11 / 14 / 18），setTimeout 睡到下一个整点触发局部 DOM 更新，不再需要手动重载 Dashboard。Dashboard 生命周期内最多 setTimeout 5 次，零主动轮询
  - 实现：`scheduleNextGreeting()` 排下一次、`updateGreeting()` 只改 h1 的 textContent（不重建整个 Dashboard）、`onClose()` 清理 timer
  - 已知限制：浏览器 throttle 切后台 setTimeout 可能延后数秒，但对问候语这种低频 UI 可接受

### 修复

- **Flomo 弹窗面板日期重复"周"字**：zh.ts 的 `dv.flomo.weekdayFormat` 原本硬写 `"周{wd}"`，与 `dayHeader "{date} 周{wd}"` 叠加，JS 两层 `$t()` 嵌套后输出变成 "2026-09-29 周周日"
  - 修复：`weekdayFormat` 改为纯 `"{wd}"`，让"周"字只由 `dayHeader` 系列模板单一负责
  - 零风险：en.ts 本来就是 `"{wd}"` 没问题；grep 确认该键只在 flomo/panel.ts 4 处使用；不改 JS/CSS，不引入新 bug


## [26.1.8] - 2026-09-25

### 依赖收敛与安全

- **esbuild-svelte 0.9.5 → 0.7.4**：0.9.5 要求 svelte ≥4.2.1，和 obsidian-calendar-ui 锁的 svelte@3.x 冲突；0.7.4 peer dep 为 `>=3.43.0 <5`，与 svelte 3.59.2 兼容。消除 GHSA-wv8q-r932-8hc7 ReDoS 警告的触发源
- **纯 type import 依赖归位 devDependencies**：`obsidian-calendar-ui`、`svelte`、`obsidian-daily-notes-interface` 从 dependencies 移到 devDependencies，声明它们仅被 `import type` 使用，不在 Obsidian 用户运行时链路。消除 `npm audit --omit=dev` 剩余漏洞
- 新增 `npm run audit:prod` / `npm run audit:all` 脚本，明确生产/开发期漏洞扫描边界

### CSS 质量

- **移除全部 `!important` 属性声明**
  - `.flomo-submit-btn` 锁定微信风格（空=灰、有输入=蓝、hover 不变）改用提特异性方案：选择器从 `.flomo-submit-btn:hover`（0,1,1）提升到 `body .flomo-input-card .flomo-submit-btn:hover`（0,3,1），空输入灰色规则升至 0,4,1
  - Obsidian 注释中的 `!important` 关键词（L857/L3277）改写措辞，避免 scanner 误报
- **`.ad-modal-btn--primary` 前景色修复**：`color` 从主题相关的 `--ad-on-accent`（亮黑/暗白）改为 Obsidian 原生 `--text-on-accent`（亮暗主题统一白色），`:hover` 中显式再次声明防止原生覆盖。"取消/保存"组保存按钮在亮色主题下 hover 字体不再变黑色


## [26.1.7] - 2026-09-24

### 修复

- **发送按钮微信风格（Flomo / 主页快速捕获）**
  - 输入框空 → 按钮灰胶囊（`background: var(--background-modifier-hover); color: var(--text-faint)`）
  - 有输入 → 实色胶囊（默认 `.flomo-submit-btn` 定义）
  - hover/active/focus 全部锁死不额外变色（防止 Obsidian 原生 `.modal button:hover { background: transparent }` 覆盖）
  - `.flomo-submit-btn:hover` 整条规则被 Obsidian 原生压掉；用祖先类提特异性 + 精确 `!important` 修复
- **保存按钮（`.ad-modal-btn--primary`）hover 高亮消失**
  - 方案：`.ad-modal-btn--primary:hover` 显式声明 `background: var(--ad-accent); border-color: var(--ad-accent); filter: brightness(1.08)`
- **textarea hover 背景变（Obsidian 默认主题特有）** ：使用祖先类提特异性到 0,2,1：`.astra-dashboard .flomo-input:hover` 覆盖主页卡片、`.mod-root .flomo-input:hover` 覆盖弹窗面板
- **Flomo 弹窗面板搜索框双重框**：给 `.flomo-search-wrap input.flomo-search` 加 `border: none; box-shadow: none`，清除 Obsidian 默认主题强加的 inset box-shadow
- **「项目情况」模块改名「项目管理」**：主页卡片标题 `auto.221` 与设置页模块名 `mod.projects` 两处 i18n 键同步更新（zh：项目情况→项目管理；en：Project Status/Projects→Project Management），主页卡片与设置开关联动一致
- **i18n 文案修正**：`dv.header.heatmapSettings`「热图设置」→「设置热图」；`dv.countdown.emptyHint`「点击右上角齿轮添加」→「点击右上角编辑」

### 重构（设计系统）

- **.ad-task-modal 成为弹窗统一Shell**：所有 Modal 类弹窗（快捷链接 / 热力图 / 倒计时 / 项目编辑）共享同一份 CSS 定义（padding 18px、border-radius 16px、三行跨平台滚动条隐藏），避免双源漂移
- **主页设置弹窗（AstraSettingsModal）滚动条彻底隐藏** ：新增 `.astra-settings-modal`（modalEl 唯一类）的 `scrollbar-width:none` + `::-webkit-scrollbar { display:none }` 规则，覆盖真实滚动容器；
- **CSS 特异性收敛**：只有 Obsidian 原生也带 `!important` 或加载顺序在我们之后的场景才用 `!important`（如 `.flomo-submit-btn` 四种状态）
- **Astra 共用方形图标按钮尺寸升级**：容器 26×26px、内部 SVG 14×14px → 18×18px（保留 Astra 自感）；作用范围：主页头图齿轮 / 热图设置 / 快捷链接管理 / TODO 刷新设置等共用 `.astra-icon-btn` 的按钮
- **每日英语卡片按钮组视觉间距**：左右箭头 + 骰子三者之间 `gap` 6px → 14px，改善按钮拥挤感
- **移动端弹窗按钮适配（.ad-modal-btn）** ：移动端按钮圆角对齐 `var(--button-radius)`（Obsidian 移动端触摸胶囊语言），配色仍走 `--ad-s1/--ad-h1` token；布局沿用并排 `row`，不堆叠，保证两胶囊始终同一行


## [26.1.6] - 2026-09-23

### 新增（设计系统）

- **设计系统代号：Astra Pill Item**。核心 token：`ad-r3`（选中/hover 圆角）、`ad-line`（默认边框）、`ad-h1`（hover 背景）、`ad-accent-dim`（active 背景）、accent 30% mix（active 边框）、accent 色文字

### 修复

- **Project 侧栏 active 圆角**：`.po-sidebar__item.is-active` 补显式 `border-radius: var(--ad-r3)`，选中态悬停/不悬停视觉一致
- **项目阶段管道颜色**：连接线和圆点从硬编码 `#40c463` 改为 `var(--proj-color)`，跟随甘特图项目色；`project-board-view.ts` 和 `dashboard-view.ts` 两处渲染器均补 `--proj-color` 容器变量
- **Astra Pill Item token 作用域**：给 `.astra-dashboard` 补全 `--ad-accent/dim/h1/line/text/text-mute/r1/r2/r3`，Dashboard 主视图组件可安全引用
- **--ad-h1/line/text/text-mute 统一 Obsidian 变量**：`.po-board-view, .ad-task-modal` 基础块移除上游 shadcn 硬编码暗色值和亮色块覆盖的 okLch 值，全部改为原生变量

### 重构

- **Project 侧栏 → Flomo 侧栏风格对齐**：默认态改为 Flomo 无边框+r1（`gap 10px` / `padding 7px 12px` / `margin 1px 2px` / `font-size 13px`）；hover/active 沿用 Astra Pill Item（r3 + ad-h1 + accent-dim）；`.po-count` 从胶囊改为纯文字
- **Astra Pill Item 应用于快捷链接胶囊**：`.astra-plugin-shortcut` 对齐 Pill Item border/padding/gap/hover/active；保留 5 色 mark 色块；border-radius 12px
- **嵌入态清除 Project 侧栏强制覆盖**：移除 `.po-board-host.po-board-view .po-sidebar__item:hover/.is-active` 的 `background: transparent` 和硬编码 Obsidian 变量规则


## [26.1.5] - 2026-09-13

### 修复

- **移动端语言探测**：iOS / Android 从硬编码回退英文改为读取 `navigator.language`；`initI18n` 去掉 `_cachedLang` 短路，Reload 时总是重新读取 obsidian.json
- **settings.ts 第 733 行**：强制视图文件匹配 placeholder 补齐 i18n（最后一处设置页遗漏）
- **快捷链接管理弹窗**：段落说明、上移 / 下移 / 删除按钮、名称 / 图标 / 链接字段 label 补齐 i18n
- **热力图设置弹窗**：Date field 下拉 4 个选项（文件创建时间 / 修改时间 / 文件名 / 文档属性）改为引用字典
- **快速捕获弹窗**：工具栏 6 个按钮（插入标签 / 图片 / 列表 / 任务 / 表格）aria-label 补齐 i18n
- **Flomo 便签面板**：预设分组标题 11 处（置顶·共N条 / 收藏·共N条 / 今天·共N条 ...）、日期分组标题（`2026-09-12 周五` / `今天 周五`）、3 个工具栏按钮（切换视图密度 / 导出 / 侧栏）全部 i18n
- **Flomo 导出**：header 移除中文 "共 N 条"，英文环境下仅保留数字
- **Daily Phrase**：上一句 / 下一句 / 换一句按钮补齐 i18n
- **新建任务弹窗**：PRIORITIES / STATUSES / TYPES / REPEAT_FREQS / WEEKDAYS / REMINDER_OPTIONS 全部改为 `t()` 调用；表单标签（任务名称 / 所属项目 / 父任务 / 类型 / 提醒 / 标签 / 备注 / 日期）补齐 i18n；修复替换脚本导致的构造函数损坏（字段声明混入构造函数体、出现重复构造函数）
- **倒计时设置弹窗**：说明段落改为 `dv.countdown.cardHint` 字典模板
- **逾期提醒**：section 标题、逾期角标 tooltip、本周 footer 汇总、逾期 N 天 badge 4 处硬编码补齐 i18n
- **甘特图 / 看板**：状态筛选激活后无匹配时工具栏消失（提前渲染到空态检查之前）；筛选按钮文本 / 菜单状态名补齐 i18n；日历星期表头、甘特月份 band、热力图月份标签改用 `Intl.DateTimeFormat` 动态格式化
- **新建 / 编辑项目弹窗**：标题、表单标签（名称/类型/颜色/日期/描述/阶段）全部补齐 i18n；PROJECT_TYPE_LIST 的阶段项目 / 非阶段项目改为渲染时查字典翻译
- **任务编辑弹窗**：标题、表单字段、优先级、状态、类型、日期标签、每日节点星期表头全部 i18n；日期输入框添加 `lang` 属性以适配不同语言环境的日期选择器
- **确认弹窗**：默认取消 / 确定按钮、删除项目 / 任务正文补齐 i18n；confirm-modal 独立抽出可复用


## [26.1.4] - 2026-09-12

### 新增

- **i18n 国际化：支持中文和英文**
  - 新增 `src/i18n/`（index.ts + zh.ts + en.ts），752 字典 key、283 处 `t()` 调用，覆盖全部用户可见 UI（Dashboard 主视图、设置页、Flomo 面板、项目看板、任务弹窗等）
  - 语言检测：读取 Obsidian 全局配置 `obsidian.json`（macOS → `~/Library/Application Support/`，Windows → 多候选：`%APPDATA%` → `~/AppData/Roaming/` → `~/.obsidian/`，Linux → `~/.config/`），`Platform.isDesktop` 守卫 Node 模块（移动端自动回退英文），Reload 插件时重新读取
  - 日期/数字按语言格式化：英文模式下 42.1 万 → 421K、星期六 → Saturday
  - UI 文本全覆盖：Header stats、问候语/相对时间、项目计数、Flomo 导出模板、任务优先级排序、强制视图 placeholder 等
  - 英文模块标题（Task Progress / Project Status / Daily Phrase）统一标题大小写
  - frontmatter 字段（`状态: 待办` / `优先级: 高`）保持中文不翻译；农历日期双语均显示中文，标签在英文下为 `Lunar`

### 修复

- **快速捕获（Flomo）编辑工具栏重排**
  - 桌面端：时间输入框独立成行与取消/发送居右对齐，间距 8px
  - 移动端（<680px）：取消/发送回到工具行，时间输入框占满整行
  - 时间输入框圆角统一 6px
- Linter 组「忽略文件夹」→「忽略文件/文件夹」，说明文案更新


## [26.1.2] - 2026-09-06

### 修复

- 主页模块拖拽排序时出现向下偏移超过一个模块的高度的错位：根因是 CSS 优先级冲突——`.astra-modules-grid .astra-surface`（`position: relative`，特异性 `0,2,0`）覆盖了 `.astra-card--dragging`（`position: absolute`，特异性 `0,1,0`），导致被拖卡片未能真正脱流，占位符插入后 dense 网格重排又将其挤下一行，叠加相对偏移形成大幅错位。修复：起手时用内联样式 `card.style.position = "absolute"` 强制脱流（内联优先级最高，无法被样式表覆盖）。


## [26.1.1] - 2026-09-04

### 破坏性变更：插件 ID 变更

- 插件 ID `attention` → **`astral-trek`**；视图类型改为 `astra-dashboard-view`。升级后需重新放置插件目录、旧 `data.json` 需手动拷贝到新目录（ID 变更后默认丢失）
- 代码品牌词 `attend` → `astra`（类名、常量、CSS 类/变量），`ad-*` 缩写保持不变
- 用户可见名称统一为 **Astra**：`manifest.json` 的 `name`、Ribbon 标签、设置分区标题
- npm 包名、仓库地址、`versions.json` minAppVersion 统一回填为 1.11.0

### 功能

- 快捷链接管理：描述中的「[Lucide](https://lucide.dev/icons/)」改为超链接；「链接」与「命令」同行显示；「命令」改为框内联想输入
- 移除全部 Minimal 主题命令（49 条）及 4 条核心命令，现不注册任何命令；统一通过 Ribbon 图标进入
- 项目默认阶段命名改为英文：`Charter, PDCP, TR, ADCP, COR`
- 移动端便签编辑：日期输入框独占整行，取消/保存按钮换行靠右

### 修复

- DetailModal 关闭位移：覆盖 `animateClose()` 直接 resolve
- `CalendarView` 的 `moment` 未声明、`cursorPosition` 类型运算、统计值兜底 `[object Object]` 等 6 处问题
- 3 处 `confirm()` 替换为 Obsidian 原生确认弹窗（新增 `confirm-modal.ts`）
- 热图方格间距在 multicolumn 标记恢复 `row-gap` / `column-gap`

### 工程

- ESLint 全量问题 189 → 100；移除 `console` 日志 27 处；`!important` 28 → 19
- `AstraSettingTab` 补声明式设置 API 三件套（返回空数组），规避 Obsidian 1.13+ 告警
- `styles.css` 移除 4 处 `:has()` 与 1 处 `display: contents`

