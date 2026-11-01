import { t as $t } from "./i18n";
import type { TFile } from "obsidian";
import type { OnedriveConfig, SyncDirectionType, ConflictActionType, DeleteToWhereType } from "./sync/baseTypes";
import { DEFAULT_ONEDRIVE_CONFIG } from "./sync/remoteForOnedrive";

export type StartupMode = "replace-active" | "new-tab";

export interface QuickLink {
  label: string;
  icon?: string;
  url?: string;
  action?: string;
}

export type HeatmapDataSourceType =
  | "PAGE"
  | "ALL_TASK"
  | "TASK_IN_SPECIFIC_PAGE";

export type HeatmapDateFieldType =
  | "FILE_CTIME"
  | "FILE_MTIME"
  | "FILE_NAME"
  | "PAGE_PROPERTY"
  | "TASK_PROPERTY";

export type HeatmapCountFieldType =
  | "DEFAULT"
  | "PAGE_PROPERTY"
  | "TASK_PROPERTY";

export type HeatmapDateRangeType =
  | "LATEST_DAYS"
  | "LATEST_MONTH"
  | "LATEST_YEAR"
  | "FIXED_DATE_RANGE";

export interface HeatmapDateField {
  type: HeatmapDateFieldType;
  value?: string;
  format?: string;
}

export interface HeatmapCountField {
  type: HeatmapCountFieldType;
  value?: string;
}

export interface HeatmapDataSource {
  type: HeatmapDataSourceType;
  value: string;
  dateField: HeatmapDateField;
  countField?: HeatmapCountField;
  excludeFolders?: string[];
}

export interface HeatmapSettings {
  title: string;
  dataSourceType: HeatmapDataSourceType;
  dataSourceValue: string;
  dateFieldType: HeatmapDateFieldType;
  dateFieldValue: string;
  dateFormat: string;
  countFieldType: HeatmapCountFieldType;
  countFieldValue: string;
  excludeFolders: string;
  dateRangeType: HeatmapDateRangeType;
  fromDate: string;
  toDate: string;
  startOfWeek: number;
  showCellRuleIndicators: boolean;
}

export interface ForceViewModeSettings {
  enabled: boolean;
  debounceTimeout: number;
  ignoreOpenFiles: boolean;
  ignoreForceViewAll: boolean;
  folders: { folder: string; viewMode: string }[];
  files: { filePattern: string; viewMode: string }[];
}

export interface CursorPositionSettings {
  enabled: boolean;
  delayAfterFileOpening: number;
  saveTimer: number;
}

export const SAFE_DB_FLUSH_INTERVAL = 5000;

export interface CalendarPluginSettings {
  enabled: boolean;
  wordsPerDot: number;
  weekStart: string;
  shouldConfirmBeforeCreate: boolean;
  position: "left" | "right";
  highlightToday: boolean;
}

export interface QuickCaptureSettings {
  /** 快速捕获的指定写入文件（相对仓库根），所有记录按日期分组合并追加到此文件 */
  filePath: string;
}

export interface DiarySettings {
  storagePath: string;
  namingPattern: string;
  templateFile: string;
}

export interface CountdownSettings {
  /** 事件名称，如「高考」「新年」；文案显示「距离 {eventName} 还有」 */
  eventName: string;
  /** 目标日期，ISO yyyy-mm-dd；非法或留空时回退到「下一年 1 月 1 日」 */
  targetDate: string;
}

export interface DailyPhraseSettings {
  /** 数据源 .md（相对仓库根），按 ## 分条 + en:/zh:/scene: 字段解析每日口语 */
  filePath: string;
}

export interface AstraSettings {
  displayName: string;
  openOnStartup: boolean;
  startupMode: StartupMode;
  shortNoteWordThreshold: number;
  excludedFolders: string[];
  showEstimatedHistory: boolean;
  activityHistoryDays: number;
  quickLinks: QuickLink[];
  heatmap: HeatmapSettings;
  cursorPosition: CursorPositionSettings;
  calendar: CalendarPluginSettings;
  quickCapture: QuickCaptureSettings;
  diary: DiarySettings;
  todoSourceFolder: string;
  projectsFolder: string;
  npdpStages: string[];
  npdpMaxStage: number;
  npdpProgressFilter: number;
  /** 全部项目视图当前激活的标签页（gantt / list） */
  currentPoView: string;
  /** 甘特图时间粒度 */
  poGanttScale: "day" | "week" | "month" | "quarter";
  /** 甘特图状态筛选 */
  poGanttStatusFilter: string[];
  /** 项目侧栏手动排序（drag & drop 持久化） */
  poProjectOrder: string[];
  /** 甘特图任务行手动排序（drag & drop 持久化） */
  poTaskOrder: string[];
  countdown: CountdownSettings;
  dailyPhrase: DailyPhraseSettings;
  /** 主页模块卡片的宽/高格数（拖拽调宽持久化；缺省视为 1×1） */
  moduleSizes: Record<string, { cols: number; rows: number }>;
  /** 主页模块的显示顺序与可见性（拖拽排序/删除/添加持久化；缺失 id 视为隐藏） */
  homeModuleOrder: string[];
  /** 移动端隐藏的模块 id 列表（桌面端不受影响） */
  mobileHiddenModules: string[];
  /** 移动端组件设置项显隐开关：默认关闭（收起）；打开后显示下方所有 mobileHiddenModules 勾选项 */
  mobileShowSettings: boolean;
  /** 全文搜索（迁移自 omnisearch User Interface 组，剔除嵌入引用项） */
  search: SearchSettings;
  /** Vault Sync（OneDrive 同步） */
  sync: OneDriveSyncSettings;
}

export interface OneDriveSyncSettings {
  /** 总开关：关闭后不记录删除/重命名历史、不自动同步 */
  enabled: boolean;
  /** OneDrive 凭据与远端配置 */
  onedriveConfig: OnedriveConfig;
  /** 端到端加密密码（空 = 不加密；与上游语义一致） */
  password: string;
  /** 同步方向（5 种，含带删除变体；与上游一致） */
  syncDirection: SyncDirectionType;
  /** 冲突策略：保留较新 / 保留较大 */
  conflictAction: ConflictActionType;
  /** 本地删除去向：系统回收站 / Obsidian .trash */
  deleteToWhere: DeleteToWhereType;
  /** 是否同步 .obsidian 配置目录（默认关） */
  syncConfigDir: boolean;
  /** 是否同步 .trash 回收站（默认关） */
  syncTrash: boolean;
  /** 单独同步书签文件 bookmarks.json（syncConfigDir 关闭时也生效） */
  syncBookmarks: boolean;
  /** 是否同步下划线开头的隐藏文件（默认关） */
  syncUnderscoreItems: boolean;
  /** 单文件大小上限（字节；-1 = 不限制） */
  skipSizeLargerThan: number;
  /** 保护阈值：待修改/删除文件占比超过该百分比时中止（100 = 去除保护，总是同步） */
  protectModifyPercentage: number;
  /** 上传/下载并发数 */
  concurrency: number;
  /** 自动同步间隔（毫秒；-1 = 关闭） */
  autoRunEveryMilliseconds: number;
  /** 启动后首次同步延迟（毫秒；-1 = 关闭） */
  initRunAfterMilliseconds: number;
  /** 保存笔记后防抖同步延迟（毫秒；-1 = 关闭） */
  syncOnSaveAfterMilliseconds: number;
  /** 检测到远端变更后触发同步的延迟（毫秒；-1 = 关闭） */
  syncOnRemoteChangesAfterMilliseconds: number;
  /** 上次成功同步时间戳（-1 = 尚未同步过） */
  lastSynced: number;
  /** 输出同步引擎调试日志 */
  debug: boolean;
}

export const DEFAULT_SYNC_SETTINGS: OneDriveSyncSettings = {
  enabled: true,
  // 作者自有的 PKCE 应用（与作者维护的上游 third-party-sync 共用同一注册，
  // 其 Azure 应用注册已含 obsidian://astral-trek-onedrive 重定向 URI）。
  onedriveConfig: { ...DEFAULT_ONEDRIVE_CONFIG },
  password: "",
  syncDirection: "bidirectional",
  conflictAction: "keep_newer",
  deleteToWhere: "system_trash",
  syncConfigDir: false,
  syncTrash: false,
  syncBookmarks: false,
  syncUnderscoreItems: false,
  skipSizeLargerThan: -1,
  protectModifyPercentage: 100,
  concurrency: 5,
  autoRunEveryMilliseconds: -1,
  initRunAfterMilliseconds: -1,
  syncOnSaveAfterMilliseconds: -1,
  syncOnRemoteChangesAfterMilliseconds: -1,
  lastSynced: -1,
  debug: false,
};

export interface SearchSettings {
  /* ---- Indexing（omnisearch 同名设置；Text Extractor 类功能因依赖缺失固定禁用） ---- */
  /** 文件名之外的扩展名白名单（空格分隔，如 "txt org csv"），按纯文本索引 */
  indexedFileTypes: string[];
  /** 是否索引无扩展名文件（按纯文本） */
  indexFilesWithoutExtension: boolean;
  /** 不受支持文件的索引策略：yes/no/default（跟随 Obsidian 检测所有扩展名） */
  unsupportedFilesIndexing: "yes" | "no" | "default";
  /** 以 frontmatter 属性作为结果标题；"#heading" 用首个标题；空 = 文件名 */
  displayTitle: string;

  /* ---- Behavior（omnisearch 同名设置） ---- */
  /** 打开弹窗时重新执行上一次查询 */
  showPreviousQueryResults: boolean;
  /** 打开笔记时把光标定位到首个命中处 */
  scrollToMatch: boolean;
  /** 尊重 Obsidian「排除的文件」：关闭=降权（默认），开启=完全隐藏 */
  hideExcluded: boolean;
  /** 降权文件夹（逗号分隔），其中的文件在结果中降权但仍被索引 */
  downrankedFoldersFilters: string[];
  /** 简单搜索：短词不做前缀匹配，降低卡顿、结果更少 */
  simpleSearch: boolean;
  /** URL 整体成词（影响索引性能） */
  tokenizeUrls: boolean;
  /** 模糊度："0" 精确 / "1" 适度模糊 / "2" 充分模糊 */
  fuzziness: "0" | "1" | "2";

  /* ---- User Interface（omnisearch 同名设置） ---- */
  /** 结果中显示命中摘录 */
  showExcerpt: boolean;
  /** 摘录中渲染换行 */
  renderLineReturnInExcerpts: boolean;
  /** 高亮结果中的匹配词 */
  highlight: boolean;

  /* ---- Results weighting（omnisearch 同名设置） ---- */
  /** 文件名 & 声明的别名权重（默认 10） */
  weightBasename: number;
  /** 文件目录权重（默认 7） */
  weightDirectory: number;
  /** 一级标题权重（默认 6） */
  weightH1: number;
  /** 二级标题权重（默认 5） */
  weightH2: number;
  /** 三级标题权重（默认 4） */
  weightH3: number;
  /** 标签权重（默认 2） */
  weightUnmarkedTags: number;
  /** 自定义 frontmatter 属性权重（<1 降权） */
  weightCustomProperties: { name: string; weight: number }[];

  /* ---- Danger Zone（omnisearch 同名设置） ---- */
  /** 忽略变音符号（brûlée → brulee）；变更触发索引重建 */
  ignoreDiacritics: boolean;
}

export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  indexedFileTypes: [],
  indexFilesWithoutExtension: false,
  unsupportedFilesIndexing: "default",
  displayTitle: "",

  showPreviousQueryResults: true,
  scrollToMatch: true,
  hideExcluded: false,
  downrankedFoldersFilters: [],
  simpleSearch: false,
  tokenizeUrls: false,
  fuzziness: "1",

  showExcerpt: true,
  renderLineReturnInExcerpts: false,
  highlight: true,

  weightBasename: 10,
  weightDirectory: 7,
  weightH1: 6,
  weightH2: 5,
  weightH3: 4,
  weightUnmarkedTags: 2,
  weightCustomProperties: [],

  ignoreDiacritics: true,
};

export interface ActivityEntry {
  addedWords: number;
  edits: number;
  paths: string[];
}

export interface AstraPluginData {
  /** 持久化数据版本号：一次性迁移的门控计数器（见 DATA_MIGRATIONS / RETIRED_BELOW_DATA_VERSION） */
  dataVersion: number;
  settings: AstraSettings;
  activity: Record<string, ActivityEntry>;
  linkSnapshots: Record<string, number>;
  fileWordCounts: Record<string, number>;
  trackingStartedAt: number | null;
  linkTrackingStartedAt: number | null;
}

export interface KnowledgeGraphNode {
  file: TFile;
  degree: number;
}

export interface KnowledgeGraphEdge {
  source: string;
  target: string;
}

export interface KnowledgeGraphSnapshot {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

export interface NoteMetric {
  file: TFile;
  words: number;
  backlinks: number;
  outgoingLinks: number;
}

export interface DailyActivity {
  date: string;
  addedWords: number;
  edits: number;
  estimated: boolean;
  files: TFile[];
}

export interface DailyLinkCount {
  date: string;
  count: number;
  estimated: boolean;
}

export interface FolderSummary {
  path: string;
  name: string;
  noteCount: number;
  wordCount: number;
  files: TFile[];
}

export interface DashboardSnapshot {
  generatedAt: number;
  notes: NoteMetric[];
  noteCount: number;
  totalWords: number;
  unlinkedNotes: NoteMetric[];
  shortNotes: NoteMetric[];
  recentNotes: NoteMetric[];
  modifiedToday: number;
  activity: DailyActivity[];
  trend: DailyActivity[];
  linkHistory: DailyLinkCount[];
  folders: FolderSummary[];
  graph: KnowledgeGraphSnapshot;
}

export interface AstraDataStore {
  data: AstraPluginData;
  requestDataSave(): void;
}

export const DEFAULT_HEATMAP_SETTINGS: HeatmapSettings = {
  title: $t("auto.318"),
  dataSourceType: "PAGE",
  dataSourceValue: "",
  dateFieldType: "FILE_MTIME",
  dateFieldValue: "",
  dateFormat: "",
  countFieldType: "DEFAULT",
  countFieldValue: "",
  excludeFolders: "",
  dateRangeType: "LATEST_DAYS",
  fromDate: "",
  toDate: "",
  startOfWeek: 1,
  showCellRuleIndicators: true
};

export const DEFAULT_FORCE_VIEW_MODE_SETTINGS: ForceViewModeSettings = {
  enabled: true,
  debounceTimeout: 300,
  ignoreOpenFiles: false,
  ignoreForceViewAll: false,
  folders: [{ folder: "", viewMode: "" }],
  files: [{ filePattern: "", viewMode: "" }],
};

export const DEFAULT_CURSOR_POSITION_SETTINGS: CursorPositionSettings = {
  enabled: true,
  delayAfterFileOpening: 100,
  saveTimer: SAFE_DB_FLUSH_INTERVAL,
};

export const DEFAULT_CALENDAR_SETTINGS: CalendarPluginSettings = {
  enabled: true,
  wordsPerDot: 250,
  weekStart: "locale",
  shouldConfirmBeforeCreate: true,
  position: "left",
  highlightToday: true,
};

export const DEFAULT_QUICK_CAPTURE_SETTINGS: QuickCaptureSettings = {
  filePath: "",
};

export const DEFAULT_DIARY_SETTINGS: DiarySettings = {
  storagePath: "Daily",
  namingPattern: "YYYY-MM-DD",
  templateFile: "",
};

export const DEFAULT_COUNTDOWN_SETTINGS: CountdownSettings = {
  eventName: "2027",
  targetDate: "2027-01-01",
};

export const DEFAULT_DAILY_PHRASE_SETTINGS: DailyPhraseSettings = {
  filePath: "",
};

export const DEFAULT_SETTINGS: AstraSettings = {
  displayName: "",
  openOnStartup: true,
  startupMode: "replace-active",
  shortNoteWordThreshold: 10,
  excludedFolders: [],
  showEstimatedHistory: true,
  activityHistoryDays: 365,
  quickLinks: [],
  heatmap: DEFAULT_HEATMAP_SETTINGS,
  cursorPosition: DEFAULT_CURSOR_POSITION_SETTINGS,
  calendar: DEFAULT_CALENDAR_SETTINGS,
  quickCapture: DEFAULT_QUICK_CAPTURE_SETTINGS,
  diary: DEFAULT_DIARY_SETTINGS,
  todoSourceFolder: "",
  projectsFolder: "Projects",
  npdpStages: ["Charter", "PDCP", "TR", "ADCP", "COR"],
  npdpMaxStage: 5,
  npdpProgressFilter: 5,
  currentPoView: "gantt",
  poGanttScale: "week",
  poGanttStatusFilter: [],
  poProjectOrder: [],
  poTaskOrder: [],
  countdown: DEFAULT_COUNTDOWN_SETTINGS,
  dailyPhrase: DEFAULT_DAILY_PHRASE_SETTINGS,
  moduleSizes: {},
  homeModuleOrder: ["qc", "dailyPhrase", "todo", "weekly", "projects", "countdown"],
  mobileHiddenModules: ["todo", "weekly", "projects", "countdown"],
  mobileShowSettings: false,
  search: DEFAULT_SEARCH_SETTINGS,
  sync: DEFAULT_SYNC_SETTINGS
};

/* ======================= 数据版本与迁移（清退机制） ======================= */

/** 当前数据版本：随一次性迁移递增；防御性 normalization 不占版本号。 */
export const CURRENT_DATA_VERSION = 2;

/**
 * 清退线：低于该版本号的持久化数据放弃迁移、直接回默认值。
 * 依据：data.json 只存配置与统计（活动/字数历史），用户内容全在 Markdown 文件里，
 * 重置代价可控。删除某条旧迁移时，把该值抬到那条迁移的 `to` 版本即可。
 */
export const RETIRED_BELOW_DATA_VERSION = 0;

/** 一次性数据迁移。run 就地修改加载到的原始数据；执行与否由 dataVersion 门控，天然幂等。 */
export interface DataMigration {
  /** 迁移完成后达到的数据版本（执行条件：savedVersion < to） */
  to: number;
  /** 引入该迁移的插件版本——清退时据此判断可否删除 */
  introducedIn: string;
  description: string;
  run: (saved: Record<string, unknown>) => void;
}

/** v1 → v2：快速捕获旧「每日新建」配置（storagePath/namingPattern/templateFile）迁移为单文件 filePath。 */
function migrateQuickCaptureLegacy(saved: Record<string, unknown>): void {
  const settings = saved.settings as Partial<AstraSettings> | undefined;
  if (!settings) return;
  const qc = settings.quickCapture as
    | (Partial<QuickCaptureSettings> & {
        storagePath?: string;
        namingPattern?: string;
        templateFile?: string;
      })
    | undefined;
  if (!qc || typeof qc.filePath !== "string" || !qc.filePath.trim()) {
    const dir = (qc?.storagePath ?? "").trim().replace(/\/+$/, "");
    // 只从旧字段继承目录；没有则留空，由用户在设置里自行选择
    settings.quickCapture = { filePath: dir ? `${dir}/快速捕获.md` : "" };
  }
}

export const DATA_MIGRATIONS: DataMigration[] = [
  {
    to: 2,
    introducedIn: "26.2.5",
    description:
      "quickCapture 旧字段（storagePath/namingPattern/templateFile）迁移为 filePath",
    run: migrateQuickCaptureLegacy
  }
];

/* ---- 防御性 normalization（永驻，不占 dataVersion）：遇到坏值就修，幂等且廉价 ---- */

// 旧版本对账 bug 可能把引号空串（""、" "、'""'）持久化进 data.json，
// 交给 dv.pages(...) 后静默产出零贡献，热力图有格子但全是灰色。
const HEATMAP_EMPTY_VALUE_PATTERN = /^\s*"?\s*"?\s*$/;
const HEATMAP_STRING_FIELDS = [
  "dataSourceValue",
  "dateFieldValue",
  "dateFormat",
  "countFieldValue",
  "excludeFolders"
] as const;

export function normalizeHeatmapSettings(
  saved?: Partial<HeatmapSettings>
): HeatmapSettings {
  const merged = { ...DEFAULT_HEATMAP_SETTINGS, ...(saved ?? {}) };
  HEATMAP_STRING_FIELDS.forEach((key) => {
    const value = merged[key];
    if (typeof value === "string" && HEATMAP_EMPTY_VALUE_PATTERN.test(value)) {
      merged[key] = DEFAULT_HEATMAP_SETTINGS[key];
    }
  });
  return merged;
}

/**
 * Vault Sync 设置 normalization：回退已裁剪的同步方向、回填旧版空 clientID、
 * 固定已从设置页移除的设置项为默认语义。
 */
export function normalizeSyncSettings(
  saved?: Partial<OneDriveSyncSettings>
): OneDriveSyncSettings {
  const merged: OneDriveSyncSettings = {
    ...DEFAULT_SYNC_SETTINGS,
    ...(saved ?? {})
  };
  // 同步方向已裁剪为 3 个选项；旧数据若保存了已删除的
  // "incremental_push_only"/"incremental_pull_only"，回退为双向同步
  const savedDirection = saved?.syncDirection;
  merged.syncDirection =
    savedDirection === "bidirectional" ||
    savedDirection === "incremental_push_and_delete_only" ||
    savedDirection === "incremental_pull_and_delete_only"
      ? savedDirection
      : "bidirectional";
  // 旧版本默认 clientID 为空且已被持久化；空值无法授权，
  // 回填新默认（用户自定义的非空值不受影响）
  const savedClientID = saved?.onedriveConfig?.clientID;
  merged.onedriveConfig = {
    ...DEFAULT_SYNC_SETTINGS.onedriveConfig,
    ...(saved?.onedriveConfig ?? {}),
    clientID:
      savedClientID !== "" && savedClientID !== undefined
        ? savedClientID
        : DEFAULT_SYNC_SETTINGS.onedriveConfig.clientID
  };
  // 数值/字段语义与上游对齐的旧数据迁移
  merged.deleteToWhere = saved?.deleteToWhere ?? "system_trash";
  merged.skipSizeLargerThan =
    saved?.skipSizeLargerThan === 0 ? -1 : (saved?.skipSizeLargerThan ?? -1);
  // 并行度设置已从设置页移除，固定上游默认值 5
  merged.concurrency = 5;
  // 该保护已从设置页移除，固定为 100（去除保护，总是同步）
  merged.protectModifyPercentage = 100;
  merged.syncOnRemoteChangesAfterMilliseconds =
    saved?.syncOnRemoteChangesAfterMilliseconds ?? -1;
  return merged;
}

export const DEFAULT_DATA: AstraPluginData = {
  dataVersion: CURRENT_DATA_VERSION,
  settings: DEFAULT_SETTINGS,
  activity: {},
  linkSnapshots: {},
  fileWordCounts: {},
  trackingStartedAt: null,
  linkTrackingStartedAt: null
};
