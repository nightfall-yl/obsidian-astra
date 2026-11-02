import { initI18n, t as $t } from "./i18n";
import type { App, PluginManifest} from "obsidian";
import { Plugin, TFile } from "obsidian";
import {
  AstraDashboardView,
  VIEW_TYPE_ASTRA_DASHBOARD
} from "./dashboard-view";
import {
  CURRENT_DATA_VERSION,
  DATA_MIGRATIONS,
  DEFAULT_DATA,
  DEFAULT_SETTINGS,
  DEFAULT_CURSOR_POSITION_SETTINGS,
  DEFAULT_CALENDAR_SETTINGS,
  RETIRED_BELOW_DATA_VERSION,
  normalizeHeatmapSettings,
  normalizeSyncSettings,
  type AstraPluginData,
  type AstraSettings,
  type ForceViewModeSettings,
  type StartupMode
} from "./models";
import { AstraSettingTab } from "./settings";
import { StatsService } from "./stats-service";
import { ForceViewModeManager } from "./forceViewMode";
import { CursorPositionManager } from "./cursorPosition";
import { CalendarView } from "./calendar/CalendarView";
import { VIEW_TYPE_CALENDAR } from "./calendar/constants";
import { calendarSettings } from "./calendar/ui/stores";
import { defaultCalendarSettings } from "./calendar/settings";
import { MinimalManager } from "./minimal/manager";
import { LinterManager } from "./linter/manager";
import { QueryManager } from "./query/manager";
import { SearchService } from "./search/search-service";
import { AstraSearchModal } from "./search/search-modal";
import { DEFAULT_SEARCH_SETTINGS } from "./models";
import { SyncManager } from "./sync/sync-manager";
import { StaticStore } from "./static-store";
import type { IWeekStartOption } from "obsidian-calendar-ui";

export default class AstraDashboardPlugin extends Plugin {
  data: AstraPluginData = structuredClone(DEFAULT_DATA);
  stats!: StatsService;
  forceViewModeManager!: ForceViewModeManager;
  cursorPositionManager!: CursorPositionManager;
  minimalManager!: MinimalManager;
  linterManager!: LinterManager;
  queryManager!: QueryManager;
  searchService!: SearchService;
  /** Vault Sync（OneDrive 同步，Phase 2 移植，详见 src/sync/） */
  syncManager!: SyncManager;
  private searchRibbonEl: HTMLElement | null = null;

  /** Section2「Markdown+」三功能（视图模式/Minimal/Linter）的统一设置存储。 */
  section2Store: StaticStore;
  private saveTimer: number | null = null;
  private vaultEventsRegistered = false;

  /** Dashboard 刷新合并调度器：把连续 vault/metadataCache 事件合并成一次刷新。
   *  writeDebounce = 100ms（vault modify/create/delete/rename 统一）
   *  resolvedDebounce = 300ms（metadataCache resolved，启动阶段密集）
   *  maxWait = 500ms（持续事件流强制刷新上限）
   *  saveSettings() 等即时路径直接调 refreshDashboardViews()，不走调度器。 */
  private refreshCoalesceTimer: number | null = null;
  /** maxWait 窗口起点，-1 表示未启用（定时器为空、首次进入时设为 now）。 */
  private refreshFirstScheduleAt = -1;
  private refreshHasPendingForce = false;
  private readonly REFRESH_WRITE_DEBOUNCE = 100;
  private readonly REFRESH_RESOLVED_DEBOUNCE = 300;
  private readonly REFRESH_MAX_WAIT = 500;

  /** 调度一次延迟刷新。trailing debounce + maxWait。
   *  force=true 时会让下一次实际刷新带上 invalidate 标记。 */
  private scheduleRefresh(delayMs: number, force = false): void {
    const now = Date.now();
    if (force) this.refreshHasPendingForce = true;

    // maxWait：距首次调度已超过 REFRESH_MAX_WAIT，强制走一次
    if (
      this.refreshFirstScheduleAt >= 0 &&
      now - this.refreshFirstScheduleAt >= this.REFRESH_MAX_WAIT
    ) {
      this.doScheduledRefresh();
      // doScheduledRefresh 把 firstScheduleAt 清成 -1，fall through 到下面重新开启新窗口
    }

    // 首次进入 debounce 窗口（timer 为空）或 maxWait 刚触发过，都设为当前窗口起点
    if (this.refreshFirstScheduleAt < 0) {
      this.refreshFirstScheduleAt = now;
    }

    if (this.refreshCoalesceTimer !== null) {
      window.clearTimeout(this.refreshCoalesceTimer);
    }
    this.refreshCoalesceTimer = window.setTimeout(() => {
      this.doScheduledRefresh();
    }, delayMs);
  }

  /** 真正执行调度器合并后的刷新；清空 debounce 状态。 */
  private doScheduledRefresh(): void {
    this.refreshCoalesceTimer = null;
    this.refreshFirstScheduleAt = -1;
    const force = this.refreshHasPendingForce;
    this.refreshHasPendingForce = false;
    this.refreshDashboardViews(force);
  }

  constructor(app: App, pluginManifest: PluginManifest) {
    super(app, pluginManifest);
    this.section2Store = new StaticStore(this);
  }

  async onload(): Promise<void> {
    initI18n(this.app);
    await this.loadPluginData();
    this.stats = new StatsService(this.app, this);

    this.registerView(
      VIEW_TYPE_ASTRA_DASHBOARD,
      (leaf) => new AstraDashboardView(leaf, this)
    );

    this.addRibbonIcon("home", $t("ribbon.home"), () => {
      void this.openDashboard("new-tab");
    });

    this.addSettingTab(new AstraSettingTab(this.app, this));

    // Calendar
    this.registerView(VIEW_TYPE_CALENDAR, (leaf) => new CalendarView(leaf));
    this.updateCalendarStore();
    if (this.data.settings.calendar.enabled) {
      this.addRibbonIcon("calendar-days", $t("ribbon.calendar"), () => {
        void this.activateCalendarView();
      });
    }

    // Force View Mode（设置存于 Section2 的 static-data.json）
    this.forceViewModeManager = new ForceViewModeManager(this, this.section2Store.settings.forceViewMode);
    this.forceViewModeManager.onload();

    // Cursor Position
    this.cursorPositionManager = new CursorPositionManager(this, this.data.settings.cursorPosition);
    void this.cursorPositionManager.onload();

    // Minimal 主题设置（存于 Section2 的 static-data.json，挂在 Markdown+ Section）
    this.minimalManager = new MinimalManager(this.app, this, this.section2Store);
    await this.minimalManager.onload();

    // Linter 设置（存于 Section2 的 static-data.json，挂在 Markdown+ Section）
    this.linterManager = new LinterManager(this.app, this, this.section2Store);
    try {
      await this.linterManager.onload();
    } catch {
      // LinterManager 初始化失败不影响其余功能
    }

    this.queryManager = new QueryManager(this.app, this);
    await this.queryManager.onload();

    // 全文搜索（ribbon 入口，懒建索引；search 默认值已在 loadPluginData 字段级合并）
    this.searchService = new SearchService(this.app, this);
    this.addSearchRibbon();
    this.addCommand({
      id: "open-search",
      name: $t("search.commandName"),
      // 社区审核要求不设默认热键（避免与用户已有绑定冲突）；请在「设置 → 热键」自行绑定
      callback: () => {
        new AstraSearchModal(this, this.searchService).open();
      },
    });

    // Vault Sync（OneDrive 同步引擎移植自 third-party-sync；OAuth 回调始终注册）
    this.syncManager = new SyncManager(this);
    await this.syncManager.onload();
    // Vault Sync ribbon（移植自上游：点击立即同步，同步中图标切换为 refresh-ccw）
    this.syncManager.syncRibbon = this.addRibbonIcon(
      "rotate-ccw",
      $t("sync.ribbon.tip"),
      () => void this.syncManager.syncRun("manual")
    );
    this.addCommand({
      id: "onedrive-sync",
      name: $t("sync.command.name"),
      callback: () => {
        void this.syncManager.syncRun("manual");
      },
    });

    this.app.workspace.onLayoutReady(() => {
      this.registerVaultEvents();
      if (this.data.settings.openOnStartup) {
        window.setTimeout(() => {
          void this.openDashboard(this.data.settings.startupMode);
        }, 0);
      }
    });
  }

  onunload(): void {
    this.forceViewModeManager?.onunload();
    this.cursorPositionManager?.onunload();
    this.minimalManager?.onunload();
    this.linterManager?.onunload();
    this.queryManager?.onunload();
    this.syncManager?.onunload();
    void this.searchService?.flush(); // 搜索索引立即写盘（取消防抖）
    this.removeSearchRibbon();

    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      void this.saveData(this.data);
    }

    // 清理刷新合并调度器，兜底执行最后一次
    if (this.refreshCoalesceTimer !== null) {
      window.clearTimeout(this.refreshCoalesceTimer);
      this.refreshCoalesceTimer = null;
      if (this.refreshFirstScheduleAt >= 0 || this.refreshHasPendingForce) {
        this.refreshFirstScheduleAt = -1;
        const force = this.refreshHasPendingForce;
        this.refreshHasPendingForce = false;
        this.refreshDashboardViews(force);
      }
    }
  }

  /** 主页齿轮直达：打开 Obsidian 原生设置页的本插件 tab（桌面/移动端通用） */
  openSettingsTab(): void {
    const setting = (
      this.app as unknown as {
        setting?: { open(): void; openTabById(id: string): void };
      }
    ).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  /** ribbon 搜索按钮（常驻，点击立即打开弹窗；首次建索引由弹窗内部处理） */
  addSearchRibbon(): void {
    if (this.searchRibbonEl) return;
    // 立即打开弹窗；首次建索引由弹窗内部显示进度（对齐 omnisearch，避免点击无反馈）
    this.searchRibbonEl = this.addRibbonIcon("search", $t("search.ribbonTip"), () => {
      new AstraSearchModal(this, this.searchService).open();
    });
  }

  removeSearchRibbon(): void {
    this.searchRibbonEl?.remove();
    this.searchRibbonEl = null;
  }

  async openDashboard(
    mode: StartupMode = this.data.settings.startupMode
  ): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_ASTRA_DASHBOARD
    )[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }

    const leaf =
      mode === "new-tab"
        ? this.app.workspace.getLeaf("tab")
        : this.app.workspace.getLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE_ASTRA_DASHBOARD,
      active: true
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  /** 打开首页看板并内嵌跳转到「全部项目」（不新开独立标签页）。 */
  async openProjectBoard(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_ASTRA_DASHBOARD
    );
    const existing = leaves[0];
    if (!existing) {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: VIEW_TYPE_ASTRA_DASHBOARD,
        active: true
      });
      await this.app.workspace.revealLeaf(leaf);
      // 等新面板完成 onOpen 的首次渲染后再导航，避免被后续渲染覆盖
      await new Promise((resolve) => window.setTimeout(resolve, 60));
      const view = leaf.view;
      if (view instanceof AstraDashboardView) {
        await view.navigateProjectBoard(null);
      }
      return;
    }
    await this.app.workspace.revealLeaf(existing);
    if (existing.view instanceof AstraDashboardView) {
      await existing.view.navigateProjectBoard(null);
    }
  }

  requestDataSave(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
    }
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveData(this.data);
    }, 500);
  }

  async saveSettings(): Promise<void> {
    this.stats.invalidate();
    await this.saveData(this.data);
    this.refreshDashboardViews(true);
    this.forceViewModeManager?.updateSettings(this.section2Store.settings.forceViewMode);
    this.cursorPositionManager?.updateSettings(this.data.settings.cursorPosition);
    this.updateCalendarStore();
  }

  /**
   * 仅持久化当前数据，不刷新任何 dashboard 视图。
   * 用于编辑态内的模块拖拽/删除等即时操作：DOM 顺序已是最终结果，无需整页重建，
   * 避免刷新导致编辑态丢失、用户来不及点击「完成」。
   */
  async saveLayoutSilently(): Promise<void> {
    await this.saveData(this.data);
  }

  async saveDashboardPreferences(): Promise<void> {
    await this.saveData(this.data);
    this.refreshDashboardViews();
  }

  refreshDashboardViews(force = false): void {
    if (force) this.stats.invalidate();
    this.app.workspace
      .getLeavesOfType(VIEW_TYPE_ASTRA_DASHBOARD)
      .forEach((leaf) => {
        if (leaf.view instanceof AstraDashboardView) {
          leaf.view.requestRefresh();
        }
      });
  }

  async activateCalendarView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]!);
      return;
    }
    const position = this.data.settings.calendar.position || "left";
    const leaf =
      position === "left"
        ? this.app.workspace.getLeftLeaf(false)
        : this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({
        type: VIEW_TYPE_CALENDAR,
        active: true,
      });
    }
    const calendarLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)[0];
    if (calendarLeaf) {
      await this.app.workspace.revealLeaf(calendarLeaf);
    }
  }

  private updateCalendarStore(): void {
    const calSettings = this.data.settings.calendar;
    calendarSettings.set({
      ...defaultCalendarSettings,
      wordsPerDot: calSettings.wordsPerDot,
      weekStart: calSettings.weekStart as IWeekStartOption,
      shouldConfirmBeforeCreate: calSettings.shouldConfirmBeforeCreate,
      position: calSettings.position || "left",
      highlightToday: calSettings.highlightToday !== false,
    });
  }

  private async loadPluginData(): Promise<void> {
    const saved = (await this.loadData()) as Partial<AstraPluginData> | null;
    // 旧数据无 dataVersion 字段，视为 v1（进入迁移链）；全新安装（无存档）跳过迁移
    const savedVersion =
      typeof saved?.dataVersion === "number" ? saved.dataVersion : 1;

    // 一次性迁移：注册表见 models.ts 的 DATA_MIGRATIONS（含 introducedIn 清退标注）。
    // 低于清退线的历史数据放弃迁移、直接回默认值——data.json 只存配置与统计，
    // 用户内容全在 Markdown 文件里，重置代价可控。
    if (saved && savedVersion >= RETIRED_BELOW_DATA_VERSION) {
      for (const migration of DATA_MIGRATIONS) {
        if (savedVersion < migration.to) {
          migration.run(saved);
        }
      }
    }

    this.data = {
      ...structuredClone(DEFAULT_DATA),
      ...saved,
      dataVersion: CURRENT_DATA_VERSION,
      settings: {
        ...DEFAULT_SETTINGS,
        ...(saved?.settings ?? {}),
        heatmap: normalizeHeatmapSettings(saved?.settings?.heatmap),
        cursorPosition: {
          ...DEFAULT_CURSOR_POSITION_SETTINGS,
          ...(saved?.settings?.cursorPosition ?? {})
        },
        calendar: {
          ...DEFAULT_CALENDAR_SETTINGS,
          ...(saved?.settings?.calendar ?? {})
        },
        sync: normalizeSyncSettings(saved?.settings?.sync),
        // 全文搜索：字段级合并。旧数据只有 4 个 UI 字段，若整体覆盖会丢掉
        // 权重/分词/索引范围等新字段（undefined 会中断设置页渲染并连带
        // 其后的 OneDrive Sync 段不渲染）。
        search: {
          ...DEFAULT_SEARCH_SETTINGS,
          ...(saved?.settings?.search ?? {})
        }
      },
      activity: saved?.activity ?? {},
      linkSnapshots: saved?.linkSnapshots ?? {},
      fileWordCounts: saved?.fileWordCounts ?? {},
      trackingStartedAt: saved?.trackingStartedAt ?? null,
      linkTrackingStartedAt: saved?.linkTrackingStartedAt ?? null
    };

    // Section2「Markdown+」设置迁移（一次性，introducedIn ≈26.1.x）：
    // forceViewMode 旧版存于主 data.json，现统一并入 static-data.json（与 Minimal/Linter 一起）。
    // 自清退：迁移完成后主数据不再写回该键，重复加载自动 no-op；
    // 待 RETIRED_BELOW_DATA_VERSION 覆盖 26.2.5 之前版本时可整段删除。
    await this.section2Store.load();
    await this.section2Store.migrateFromLegacy();
    const legacyFV = (
      saved?.settings as Partial<AstraSettings> & {
        forceViewMode?: ForceViewModeSettings;
      }
    )?.forceViewMode;
    if (legacyFV) {
      this.section2Store.settings.forceViewMode = {
        ...this.section2Store.settings.forceViewMode, // 保留 store 默认值与已有别名配置
        ...legacyFV,
      };
      await this.section2Store.save();
    }
    // 主数据内的残留 forceViewMode 字段（运行时由展开保留，类型上已移除）显式删除，
    // 避免 saveData 把旧值写回。
    if ("forceViewMode" in (this.data.settings as unknown as Record<string, unknown>)) {
      delete (this.data.settings as unknown as Record<string, unknown>).forceViewMode;
    }
  }

  private registerVaultEvents(): void {
    if (this.vaultEventsRegistered) return;
    this.vaultEventsRegistered = true;

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        void this.stats.recordFileChange(file).then(() => {
          this.scheduleRefresh(this.REFRESH_WRITE_DEBOUNCE);
        });
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        void this.stats.recordFileChange(file, true).then(() => {
          this.scheduleRefresh(this.REFRESH_WRITE_DEBOUNCE);
        });
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        this.stats.recordDelete(file);
        this.scheduleRefresh(this.REFRESH_WRITE_DEBOUNCE);
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        this.stats.recordRename(file, oldPath);
        this.scheduleRefresh(this.REFRESH_WRITE_DEBOUNCE);
      })
    );

    // Obsidian 类型声明对 resolved 回调签名有误，运行时实际传 (file?: TFile)
    const resolvedCb = (file: TFile | undefined): void => {
      // 启动全量解析完成时 file 为 undefined，此时需要刷新；
      // 单文件解析完成时只关心 .md，过滤 data.json 等插件数据变更。
      if (
        file !== undefined &&
        (!(file instanceof TFile) || file.extension !== "md")
      ) {
        return;
      }
      this.scheduleRefresh(this.REFRESH_RESOLVED_DEBOUNCE);
    };
    this.registerEvent(
      this.app.metadataCache.on("resolved", resolvedCb as () => void)
    );
  }
}
