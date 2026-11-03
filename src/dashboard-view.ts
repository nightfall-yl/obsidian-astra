import { t as $t, getLocaleCode } from "./i18n";
import { ItemView, Menu, Notice, Platform, TFile, TFolder, normalizePath, setIcon } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { DateTime } from "luxon";
import { formatCompactNumber } from "./core";
import { confirmDialog } from "./confirm-modal";
import { DetailModal, type DetailItem } from "./detail-modal";
import type AstraDashboardPlugin from "./main";
import { parseDailyPhrases, type PhraseItem } from "./daily-phrase/parser";
import type {
  DashboardSnapshot,
  HeatmapSettings,
  QuickLink
} from "./models";
import { QuickLinkModal, quickLinkInitial } from "./quick-link-modal";
import { HeatmapSettingsModal } from "./heatmap-settings-modal";
import { ProjectBoardPanel } from "./project-board-view";
import { FlomoBoardPanel } from "./flomo/panel";
import { appendFlomoToFile } from "./flomo/store";
import { ProjectModal, type ProjectFormData } from "./project-modal";
import { TaskModal, type TaskFormData } from "./task-modal";
import { createTaskFile as createTaskFileShared } from "./data/taskFileCreator";
import { CountdownModal } from "./countdown-modal";
import { TaskStore } from "./data/taskStore";
import {
  calcNextRemindDate,
  getTodayTasks,
  getTodayUniverse,
  isDoneToday,
  isSkipToday,
  nowFmt,
  overdueDays,
  todayStr,
  urgencyMeta
} from "./data/taskLogic";
import { priorityWeight } from "./data/taskParseCore";
import { writeFrontmatter, yamlScalar } from "./data/frontmatterWriter";
import { TaskEditModal } from "./task-edit-modal";
import type { ProjectInfo, TaskItem, TaskStatus } from "./data/taskParser";

export const VIEW_TYPE_ASTRA_DASHBOARD = "astra-dashboard-view";

/** 从结构化重复设置生成嵌套「重复规则」block（迁移自 obsidian-dashboard-main）。 */
/** 农历日期 → "五月廿二" 样式（复用 obsidian-dashboard-main 的 Intl 农历历法实现，无额外依赖） */
function getLunarDate(d: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", {
      timeZone: "Asia/Shanghai",
      month: "long",
      day: "numeric"
    }).formatToParts(d);
    const monthStr = parts.find((p) => p.type === "month")?.value ?? "";
    const dayStr = parts.find((p) => p.type === "day")?.value ?? "";
    if (/[\u4e00-\u9fff]/.test(monthStr)) {
      const dayNum = parseInt(dayStr);
      if (!isNaN(dayNum) && dayNum >= 1 && dayNum <= 30) {
        const LUNAR_DAYS = [
          "初一","初二","初三","初四","初五","初六","初七","初八","初九","初十",
          "十一","十二","十三","十四","十五","十六","十七","十八","十九","二十",
          "廿一","廿二","廿三","廿四","廿五","廿六","廿七","廿八","廿九","三十"
        ];
        return monthStr + (LUNAR_DAYS[dayNum - 1] ?? dayStr);
      }
      return monthStr + dayStr.replace("日", "");
    }
    const m = parseInt(monthStr) || 1;
    const day = parseInt(dayStr) || 1;
    const MONTHS = ["正月","二月","三月","四月","五月","六月","七月","八月","九月","十月","冬月","腊月"];
    const DAYS = [
      "初一","初二","初三","初四","初五","初六","初七","初八","初九","初十",
      "十一","十二","十三","十四","十五","十六","十七","十八","十九","二十",
      "廿一","廿二","廿三","廿四","廿五","廿六","廿七","廿八","廿九","三十"
    ];
    return MONTHS[m - 1] + (DAYS[day - 1] ?? "");
  } catch {
    return "";
  }
}

/* ---- 热力图常量与工具（对齐 obsidian-dashboard-main） ---- */
const HM_CELL = 15; // 格子尺寸固定不变，只调间距
const HM_GAP_MIN = 3;
const HM_GAP_MAX = 14;
const HM_DOW_W = 32; // 星期列实际宽(22px) + grid 列间距(10px)
const HM_RPAD = 20; // 热区右侧留白，与 CSS 的 .ad-ns__heat padding-right 一致
const HM_MIN_WEEKS = 10;
const HM_RGAP_MAX = 8; // 行间距上限小于列间距，避免高屏上行距过大

/* ---- 主页模块：拖拽调宽（对齐 obsidian-dashboard-main） ---- */
const MOD_MAX_SPAN = 4; // 单卡最多占的格数（宽/高上限 = 4）
const MOD_MIN_CARD_W = 260; // 单卡可读下限宽度（px）
/** 部分卡片的最低列数：响应到更窄列数时只填充满，不强行跨列 */
const MOD_MIN_COLS: Record<string, number> = {
  projects: 2 // 项目情况：横向至少占 2 列，避免被压成窄竖条
};
/** 部分卡片的最低宽:高比，限制缩放夹紧，避免关键卡被拉成过窄过高的竖条 */
const MOD_MIN_RATIO: Record<string, number> = {
  projects: 2 // 项目情况：最低 2:1
};
/** 把任意输入夹到合法的格数区间（非法值回退为 1） */
function clampModSpan(v: unknown): number {
  // 只有 number / 数字字符串可解析；其余（含 null、对象）落到 NaN 再回退为 1。
  // 不要对 unknown 直接 String()，对象会被字符串化成 "[object Object]"。
  const n =
    typeof v === "number"
      ? Math.round(v)
      : typeof v === "string"
        ? parseInt(v, 10)
        : NaN;
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MOD_MAX_SPAN, n);
}
/** 指针是否落在卡片边缘区域（用于「仅边缘长按进入编辑态」） */
function isOnCardEdge(card: HTMLElement, x: number, y: number): boolean {
  const r = card.getBoundingClientRect();
  const EDGE = 18;
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
  return (
    x - r.left <= EDGE ||
    r.right - x <= EDGE ||
    y - r.top <= EDGE ||
    r.bottom - y <= EDGE
  );
}

/** 主页模块卡片模板（用于渲染 + 添加卡片菜单） */
interface ModuleTemplate {
  id: string;
  title: string;
  subtitle: string;
  cls: string;
  build: (surface: HTMLElement) => void | Promise<void>;
}

/** 拖拽重排中的瞬时状态（手机桌面图标式重排） */
interface ModuleDragState {
  card: HTMLElement;
  placeholder: HTMLElement;
  /** 卡片拖动定位的基准容器（modulesGridEl），absolute 相对它，避免 transform 祖先劫持 fixed 导致偏移 */
  grid: HTMLElement;
  /** 拖拽前 grid 的 position 值，结束后恢复，避免污染布局 */
  prevGridPos: string;
  offsetX: number;
  offsetY: number;
  /** 起手时卡片在 grid 内的基准位置（px）。拖动全程只按指针增量移动，
   *  不再每帧重算 grid.getBoundingClientRect()——避免 placeholder 插入引发的
   *  grid 重排/FLIP 让 gr.top 变化，导致卡片瞬间跳位（10px+ 偏移） */
  baseLeft: number;
  baseTop: number;
  /** 起手指针坐标，作为拖动增量基准 */
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  overTrash: boolean;
  moved: boolean;
  raf: number | null;
}

/** 格式化为 YYYY-MM-DD（本地时区） */
function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 确定性字符串哈希（FNV-1a），用于按日期种子选句 */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class AstraDashboardView extends ItemView {
  private refreshTimer: number | null = null;
  private renderDisposers: Array<() => void> = [];
  /** 当前是否正在显示子面板（FlomoBoardPanel / ProjectBoardPanel 等），
   *  为 true 时跳过 vault 事件触发的刷新，避免重建摧毁子面板。 */
  private showingPanel = false;
  /** 视图根容器（包含常驻 header + 可重建 body）。结构对齐 obsidian-dashboard-main：
   *    astra-dashboard-root  ← contentEl 下唯一稳定节点
   *      ├─ astra-dashboard-header   ← 常驻（欢迎/日期/按钮），不随页面切换重建
   *      └─ astra-dashboard-body     ← 可替换区域，render/navigate 只重建这一层 */
  private dashboardRootEl: HTMLElement | null = null;
  /** 常驻 header 中的「笔记数 · 字数」统计行，每次渲染都刷新文案（header 只建一次） */
  private headerStatsEl: HTMLElement | null = null;
  /** 可替换内容区（与 dashboardRootEl 配合使用） */
  private dashboardBodyEl: HTMLElement | null = null;
  private greetingTimer: number | null = null;
  private headingEl: HTMLElement | null = null;
  private heatmapObs: ResizeObserver | null = null;
  private heatmapObsTarget: HTMLElement | null = null;
  private heatmapCard: HTMLElement | null = null;
  private hmWeekMonths: number[] = [];
  private hmKey = "";
  private hmSubtitleEl: HTMLElement | null = null;
  private lastSnapshot: DashboardSnapshot | null = null;
  /** 主页模块网格列数观测器（对齐原项目：JS 动态算列 + 固定 4 列上限） */
  private modulesColsObs: ResizeObserver | null = null;
  /** 主页模块网格容器（编辑态/拖拽调宽作用域） */
  private modulesGridEl: HTMLElement | null = null;
  /** 主页模块包裹容器（固定占位，供增删/重排时原地重建网格） */
  private modulesWrapEl: HTMLElement | null = null;
  /** 编辑态标识：进入后显示「⤢ 拖拽调宽」手柄与「完成」编辑条 */
  private adEditMode = false;
  private adEditBar: HTMLElement | null = null;
  private adClickGuard: ((e: Event) => void) | null = null;
  private adLongPressTimer: number | null = null;
  private adLastColCount = 0;
  /** 拖拽调宽进行中的状态 */
  private adResize: {
    card: HTMLElement;
    modId: string;
    startCols: number;
    startRows: number;
    x0: number;
    y0: number;
    moved: boolean;
  } | null = null;
  /** 拖拽重排（排序）进行中的状态 */
  private moduleDrag: ModuleDragState | null = null;
  /** 老家主模块数据层（迁移自 obsidian-dashboard-main） */
  private taskStore: TaskStore;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: AstraDashboardPlugin
  ) {
    super(leaf);
    this.taskStore = new TaskStore(
      this.app,
      () => ({
        projectsFolder: this.plugin.data.settings.projectsFolder,
        npdpStages: this.plugin.data.settings.npdpStages
      }),
      (msg) => {
        if (msg) new Notice(msg);
      }
    );
    // 修改/新增任务文件时清掉共享扫描缓存，避免首页展示陈旧数据
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile) this.taskStore.invalidate();
    }));
  }

  getViewType(): string {
    return VIEW_TYPE_ASTRA_DASHBOARD;
  }

  getDisplayText(): string {
    return "Dashboard";
  }

  getIcon(): string {
    return "home";
  }

  /** 确保视图根容器存在：
   *  contentEl 下创建稳定的 dashboardRootEl，内含常驻 header 和可重建 body。
   *  仅在首次调用时创建 header（欢迎/日期/按钮行），后续页面切换只替换 body。 */
  private ensureDashboardRoot(snapshot: DashboardSnapshot | null): HTMLElement {
    if (this.dashboardRootEl && this.dashboardRootEl.isConnected) {
      // body 重建前先清掉旧的 body，并复位嵌入态标记
      this.contentEl.removeClass("is-po-board");
      if (this.dashboardBodyEl) {
        this.dashboardBodyEl.remove();
        this.dashboardBodyEl = null;
      }
    } else {
      // 首次构建：清空 contentEl，创建 root + header
      this.contentEl.empty();
      const root = this.contentEl.createDiv("astra-dashboard astra-dashboard-root");
      this.dashboardRootEl = root;
      // 常驻 header：欢迎/日期/按钮（对齐 obsidian-dashboard-main 的 ad-header，
      //  作为内容区顶部行，与 Obsidian 原生 view-header（标签栏）并存）
      const header = root.createDiv("astra-dashboard-header");
      const copy = header.createDiv("astra-dashboard-heading");
      const displayName = this.plugin.data.settings.displayName;
      const h1 = copy.createEl("h1", {
        cls: "astra-dashboard-greeting",
        text: `${greeting()}${displayName ? `，${displayName}` : ""}`
      });
      this.headingEl = h1;
      this.scheduleNextGreeting();
      const statsEl = copy.createEl("p", {
        text: $t("dv.header.stats", { vault: this.app.vault.getName(), notes: snapshot?.noteCount ?? 0, words: formatCompactNumber(snapshot?.totalWords ?? 0) }),
      });
      this.headerStatsEl = statsEl;
      const actions = header.createDiv("astra-dashboard-actions");
      const dateRow = actions.createDiv("astra-dashboard-date");
      const lunarRow = actions.createDiv("astra-dashboard-lunar");
      const buttons = actions.createDiv("astra-dashboard-tools");
      const homeBtn = this.createIconButton(buttons, "home", $t("dv.header.home"));
      // 常驻 header 按钮用 Component 的 registerDomEvent 注册：只在视图关闭时清理，
      // 不会被每次 render 的 clearRenderResources() 清掉监听器
      this.registerDomEvent(homeBtn, "click", () => this.navigateHome());
      const settingsBtn = this.createIconButton(buttons, "settings", $t("dv.header.openSettings"));
      this.registerDomEvent(settingsBtn, "click", () => {
        // 直接跳转 Obsidian 原生设置页的本插件 tab（不再弹自建设置弹窗）
        this.plugin.openSettingsTab();
      });
      // 实时刷新日期时间/星期/农历
      const updateClock = (): void => {
        const now = new Date();
        const dateStr = now.toLocaleDateString(getLocaleCode(), {
          timeZone: "Asia/Shanghai",
          year: "numeric",
          month: "2-digit",
          day: "2-digit"
        });
        const timeStr = now.toLocaleTimeString(getLocaleCode(), {
          timeZone: "Asia/Shanghai",
          hour: "2-digit",
          minute: "2-digit"
        });
        dateRow.setText(`${dateStr} ${timeStr}`);
        lunarRow.setText(
          `${now.toLocaleDateString(getLocaleCode(), {
            timeZone: "Asia/Shanghai",
            weekday: "long"
          })} · ${$t("dv.header.lunar", { date: getLunarDate(now) })}`
        );
      };
      updateClock();
      this.registerInterval(window.setInterval(updateClock, 30000));
    }
    // body 始终新建（切换内容时重建 body，保留 header）
    // 每次渲染都刷新 header 统计行（header 只创建一次，不能只写初值）
    if (this.headerStatsEl) {
      this.headerStatsEl.setText(
        $t("dv.header.stats", { vault: this.app.vault.getName(), notes: snapshot?.noteCount ?? 0, words: formatCompactNumber(snapshot?.totalWords ?? 0) })
      );
    }
    const body = this.dashboardRootEl.createDiv("astra-dashboard-body");
    this.dashboardBodyEl = body;
    return body;
  }

  async onOpen(): Promise<void> {
    this.showingPanel = false;
    this.contentEl.addClass("astra-dashboard-view-content");
    this.renderLoading();
    await this.refresh(true);
  }

  onClose(): Promise<void> {
    this.clearRenderResources();
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.greetingTimer !== null) {
      window.clearTimeout(this.greetingTimer);
      this.greetingTimer = null;
    }
    return Promise.resolve();
  }

  /** 问候语段边界（小时）：0 / 6 / 11 / 14 / 18
   *  只在段边界那一秒触发一次 DOM 局部更新（setTimeout 到点，不是 setInterval 轮询）。
   *  浏览器 throttle 切后台 setTimeout 可能延后数秒，但对问候语这种低频 UI 可接受。 */
  private scheduleNextGreeting(): void {
    if (this.greetingTimer !== null) {
      window.clearTimeout(this.greetingTimer);
      this.greetingTimer = null;
    }
    const now = new Date();
    const hours = now.getHours();
    // 找到下一个段边界小时（0 点次日单独处理）
    const boundaries = [6, 11, 14, 18];
    let nextHour = boundaries.find(b => b > hours) ?? 0;
    const next = new Date(now);
    next.setHours(nextHour, 0, 0, 0);
    if (nextHour === 0) next.setDate(next.getDate() + 1);
    const ms = next.getTime() - now.getTime();
    this.greetingTimer = window.setTimeout(() => {
      this.updateGreeting();
      this.scheduleNextGreeting();
    }, ms);
  }

  /** 只改 header 里问候语那一行，不重建整个 Dashboard */
  private updateGreeting(): void {
    if (!this.headingEl) return;
    const name = this.plugin.data.settings.displayName;
    this.headingEl.textContent = `${greeting()}${name ? `，${name}` : ""}`;
  }

  requestRefresh(): void {
    // 子面板显示中时跳过刷新，避免 contentEl.empty() 摧毁 FlomoBoardPanel/ProjectBoardPanel
    if (this.showingPanel) return;
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 900);
  }

  async refresh(force = false): Promise<void> {
    // 子面板显示中时跳过刷新，避免 contentEl.empty() 摧毁子面板
    if (this.showingPanel && !force) return;
    try {
      const snapshot = await this.plugin.stats.scan(force);
      this.render(snapshot);
    } catch (error) {
      this.renderError(error);
    }
  }

  private renderLoading(): void {
    const body = this.ensureDashboardRoot(this.lastSnapshot);
    body.empty();
    const mark = body.createDiv("astra-loading-mark");
    setIcon(mark, "loader-circle");
    body.createEl("h2", { text: $t("dv.scanning") });
    body.createEl("p", { text: $t("dv.scanningTip") });
  }

  private renderError(error: unknown): void {
    this.clearRenderResources();
    const body = this.ensureDashboardRoot(this.lastSnapshot);
    body.empty();
    const mark = body.createDiv("astra-error-mark");
    setIcon(mark, "circle-alert");
    body.createEl("h2", { text: $t("dv.unable") });
    body.createEl("p", {
      text: error instanceof Error ? error.message : "发生未知错误"
    });
    const retry = body.createEl("button", {
      cls: "mod-cta",
      text: $t("dv.reload"),
      attr: { type: "button" }
    });
    retry.addEventListener("click", () => void this.refresh(true));
  }

  private render(
    snapshot: DashboardSnapshot
  ): void {
    this.clearRenderResources();
    const body = this.ensureDashboardRoot(snapshot);

    this.renderQuickLinks(body);

    // 热力图固定独占一行（副标题位 = 热图窗口文案「近 N 周」）
    const activitySurface = this.createSurface(body, "写作活动", "");
    activitySurface.addClass("astra-activity-surface");
    activitySurface.addClass("astra-surface-fullrow");
    // 与其它模块一致：把副标题紧跟标题（gap 8px），而非 space-between 推到最右
    this.alignHeaderTitlesLeft(activitySurface, "astra-activity-titles");
    this.hmSubtitleEl = activitySurface.querySelector(
      ".astra-surface-header span"
    );
    if (this.hmSubtitleEl) this.hmSubtitleEl.setText($t("dv.heatmap.subtitle", { n: 52 }));
    this.addHeatmapSettingsButton(activitySurface);
    this.renderHeatmap(activitySurface, snapshot);

    // 主页模块卡片：顺序/显隐/增删由 homeModuleOrder 驱动（拖拽排序/删除/添加持久化）
    const modulesWrap = body.createDiv("astra-modules-wrap");
    this.modulesWrapEl = modulesWrap;
    this.lastSnapshot = snapshot; // 供网格重建（增删/重排）时补渲最近笔记
    this.buildModuleCards(modulesWrap);
  }

  private renderQuickLinks(root: HTMLElement): void {
    const section = root.createDiv("astra-quick-plugins");
    const scroller = section.createDiv("astra-quick-plugins-scroll");
    this.listen(scroller, "wheel", (event) => {
      if (
        scroller.scrollWidth > scroller.clientWidth &&
        Math.abs(event.deltaY) > Math.abs(event.deltaX)
      ) {
        scroller.scrollLeft += event.deltaY;
        event.preventDefault();
      }
    });

    const links = this.plugin.data.settings.quickLinks;

    if (links.length === 0) {
      scroller.createSpan({
        cls: "astra-quick-plugins-empty",
        text: $t("dv.addLink")
      });
    } else {
      links.forEach((link) => {
        const item = scroller.createDiv({
          cls: "astra-plugin-shortcut",
          attr: {
            role: "button",
            tabindex: "0",
            "aria-label": `打开 ${link.label}`
          }
        });
        const mark = item.createSpan({ cls: "astra-plugin-shortcut-mark" });
        if (link.icon) {
          setIcon(mark, link.icon);
        } else {
          mark.setText(quickLinkInitial(link.label));
        }
        item.createSpan({
          cls: "astra-plugin-shortcut-name",
          text: link.label
        });
        this.listen(item, "click", () => this.openQuickLink(link));
        this.listen(item, "keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.openQuickLink(link);
          }
        });
      });
    }

    const manage = this.createIconButton(section, "sliders-horizontal", $t("auto.331"));
    manage.addClass("astra-quick-plugins-manage");
    this.listen(manage, "click", () => {
      new QuickLinkModal(this.app, this.plugin).open();
    });
  }

  private openQuickLink(link: QuickLink): void {
    if (link.action) {
      const commands = (this.app as unknown as {
        commands?: { executeCommandById?: (id: string) => void };
      }).commands;
      if (commands?.executeCommandById) {
        commands.executeCommandById(link.action);
        return;
      }
    }
    if (link.url) {
      void this.app.workspace.openLinkText(link.url, "", false);
    }
  }

  private addHeatmapSettingsButton(surface: HTMLElement): void {
    const header = surface.querySelector<HTMLElement>(".astra-surface-header");
    if (!header) return;
    const btn = this.createIconButton(header, "sliders-horizontal", $t("dv.header.heatmapSettings"));
    btn.addClass("astra-heatmap-settings-btn");
    this.listen(btn, "click", () => {
      new HeatmapSettingsModal(this.app, this.plugin).open();
    });
  }

  // 热力图：完全照搬 obsidian-dashboard-main 的 ad-ns 实现——
  // 一年（1月1日→12月31日）全部数据一次性渲染，再由 layoutHeatmap 按实际宽度
  // 决定展示最近几周；格子尺寸恒为 HM_CELL(15px) 只调间距，物理屏幕越宽 Cell 间隔越宽。
  // 数据按 astra 弹窗的「日期字段」设置统计每日笔记数，主题为 GitHub 绿。
  private renderHeatmap(surface: HTMLElement, snapshot: DashboardSnapshot): void {
    const card = surface.createDiv("astra-heatmap-wrapper ad-ns");
    this.heatmapCard = card;

    const noteCounts = this.getHeatmapNoteCounts(snapshot);
    const today = new Date();
    const todayTime = today.getTime();
    const todayKey = fmtDate(today);

    // 滚动窗口：以「本周」为右端，往前固定 52 周（不再按自然年全年）
    const totalWeeks = 52;
    // 本周周一（周一为一周起点）
    const todayStart = new Date(today);
    todayStart.setHours(0, 0, 0, 0);
    const thisMonday = new Date(todayStart);
    thisMonday.setDate(todayStart.getDate() - ((todayStart.getDay() + 6) % 7));
    // 起始周一 = 本周周一 往前回推 (totalWeeks-1) 周
    const startMonday = new Date(thisMonday);
    startMonday.setDate(thisMonday.getDate() - (totalWeeks - 1) * 7);
    const startMs = startMonday.getTime();

    const heat = card.createDiv({ cls: "ad-ns__heat" });
    heat.createDiv({ cls: "ad-ns__months" });

    // 缓存每周所属月份（取该周周四所在月），供 layoutHeatmap 重建月份标签
    const weekMonths: number[] = [];
    for (let w = 0; w < totalWeeks; w++) {
      const thu = new Date(startMs + (w * 7 + 3) * 86400000);
      weekMonths.push(thu.getMonth());
    }
    this.hmWeekMonths = weekMonths;
    this.hmKey = ""; // DOM 已重建，强制重新布局

    const grid = heat.createDiv({ cls: "ad-ns__grid" });
    const dow = grid.createDiv({ cls: "ad-ns__dow" });
    ["", "二", "", "四", "", "六", ""].forEach((t) => dow.createSpan({ text: t }));

    const cells = grid.createDiv({ cls: "ad-ns__cells" });
    for (let w = 0; w < totalWeeks; w++) {
      for (let r = 0; r < 7; r++) {
        const cellDate = new Date(startMs + (w * 7 + r) * 86400000);
        const cellTime = cellDate.getTime();
        const cell = cells.createDiv({ cls: "ad-ns__cell" });

        const dateStr = fmtDate(cellDate);
        const count = noteCounts.get(dateStr) ?? 0;
        const isFuture = cellTime > todayTime;

        if (!isFuture && count > 0) {
          if (count === 1) cell.addClass("l1");
          else if (count <= 3) cell.addClass("l2");
          else if (count <= 6) cell.addClass("l3");
          else cell.addClass("l4");
        }
        if (isFuture) cell.addClass("is-future");
        if (dateStr === todayKey) cell.addClass("is-today"); // 当天格子：边缘光晕

        const mm = String(cellDate.getMonth() + 1).padStart(2, "0");
        const dd = String(cellDate.getDate()).padStart(2, "0");
        cell.title = isFuture
          ? `${mm}-${dd} · 未来`
          : `${mm}-${dd} · ${count} 篇笔记`;

        if (!isFuture && count > 0) {
          cell.addClass("astra-heat-cell--clickable");
          this.listen(cell, "click", () => {
            const files = this.getHeatmapNotesForDate(dateStr);
            if (files.length === 0) return;
            this.openDetails(
              `${mm}-${dd} 的笔记`,
              `${files.length} 篇笔记`,
              files.map((f) => ({ file: f, title: f.basename, subtitle: f.path })),
              false
            );
          });
        }
      }
    }

    // 底部：图例（Less … More）
    const foot = card.createDiv({ cls: "ad-ns__foot" });
    const legend = foot.createSpan({ cls: "ad-ns__legend" });
    legend.createSpan({ cls: "ad-ns__lbl", text: "Less" });
    ["l1", "l2", "l3", "l4"].forEach((lv) => {
      legend.createSpan({ cls: "ad-ns__sw " + lv });
    });
    legend.createSpan({ cls: "ad-ns__lbl", text: "More" });

    // 按容器实际宽度摊开列间距，并监听尺寸变化实时重排
    this.layoutHeatmap(card);
    if (this.heatmapObsTarget !== heat) {
      this.heatmapObs?.disconnect();
      this.heatmapObs = new ResizeObserver(() => {
        if (this.heatmapCard) this.layoutHeatmap(this.heatmapCard);
      });
      this.heatmapObs.observe(heat);
      this.heatmapObsTarget = heat;
    }
  }

  /**
   * 热力图自适应布局：格子尺寸固定为 HM_CELL，只调间距。
   * 1) 按最小间距算当前宽度最多放几周；放不下全年就只显示最近 N 周；
   * 2) 剩余宽度摊进列间距，整行填满（上限 HM_GAP_MAX）；
   * 3) 行间距按可用高度摊开，让热力区纵向饱满；
   * 4) 月份标签按可见周窗口 + 实际间距重建，与格子列严格对齐。
   */
  private layoutHeatmap(card: HTMLElement): void {
    const heat = card.querySelector<HTMLElement>(".ad-ns__heat");
    const cells = card.querySelector<HTMLElement>(".ad-ns__cells");
    const dow = card.querySelector<HTMLElement>(".ad-ns__dow");
    const monthsRow = card.querySelector<HTMLElement>(".ad-ns__months");
    if (!heat || !cells || !dow || !monthsRow) return;
    const total = this.hmWeekMonths.length;
    if (total === 0) return;

    // 读取实际渲染的 Cell 尺寸（移动端 CSS 会缩到 10px，桌面端 15px），保证周数/间距计算与显示一致
    const cellSample = cells.querySelector<HTMLElement>(".ad-ns__cell");
    const hmCell = cellSample
      ? parseFloat(getComputedStyle(cellSample).width) || HM_CELL
      : HM_CELL;

    const availW = Math.max(
      hmCell * HM_MIN_WEEKS,
      heat.clientWidth - HM_DOW_W - HM_RPAD
    );
    let weeks = Math.floor((availW + HM_GAP_MIN) / (hmCell + HM_GAP_MIN));
    weeks = Math.max(HM_MIN_WEEKS, Math.min(total, weeks));
    let cgap =
      weeks > 1 ? (availW - weeks * hmCell) / (weeks - 1) : HM_GAP_MIN;
    cgap = Math.max(HM_GAP_MIN, Math.min(HM_GAP_MAX, Math.round(cgap * 10) / 10));

    const availH = heat.clientHeight - monthsRow.offsetHeight - 10;
    let rgap = (availH - 7 * hmCell) / 6;
    rgap = Math.max(HM_GAP_MIN, Math.min(HM_RGAP_MAX, Math.round(rgap * 10) / 10));

    const key = `${weeks}|${cgap}|${rgap}`;
    if (key === this.hmKey) return; // 幂等，避免 ResizeObserver 自激循环
    this.hmKey = key;

    cells.style.setProperty("--hm-cgap", cgap + "px");
    cells.style.setProperty("--hm-rgap", rgap + "px");
    dow.style.setProperty("--hm-rgap", rgap + "px");

    // 月份标签行与格子列左对齐：整体左移「星期列实际宽 + 网格列间距」
    const gridEl = cells.parentElement;
    const gridGap = gridEl
      ? parseFloat(getComputedStyle(gridEl).columnGap) || 4
      : 4;
    monthsRow.style.paddingLeft = dow.offsetWidth + gridGap + "px";

    // 只显示最近 weeks 周：隐藏最早的整列
    const hiddenCells = (total - weeks) * 7;
    const kids = cells.children;
    for (let i = 0; i < kids.length; i++) {
      (kids[i] as HTMLElement).style.display =
        i < hiddenCells ? "none" : "";
    }

    // 月份标签按可见周窗口重建
    const monthNames = Array.from({ length: 12 }, (_, i) => new Intl.DateTimeFormat(getLocaleCode(), { month: "short" }).format(new Date(2020, i, 1)));
    const visible = this.hmWeekMonths.slice(total - weeks);
    monthsRow.empty();
    const unit = hmCell + cgap;
    let curM = visible[0] ?? 0;
    let curS = 1;
    const flush = (m: number, span: number): void => {
      const label = monthsRow.createSpan({ text: monthNames[m] ?? "" });
      label.style.minWidth = span * unit + "px";
    };
    for (let w = 1; w < visible.length; w++) {
      const m = visible[w] ?? curM;
      if (m === curM) {
        curS++;
        continue;
      }
      flush(curM, curS);
      curM = m;
      curS = 1;
    }
    flush(curM, curS);

    // 副标题同步窗口文案（随可见周数变化）
    if (this.hmSubtitleEl) {
      this.hmSubtitleEl.setText($t("dv.heatmap.subtitle", { n: weeks }));
    }
  }

  /** 每日笔记数：优先复用 scan 的全库按 mtime 归组结果，避免每次渲染再做一次全库遍历。
   *  非 mtime 模式（FILE_CTIME / FILE_NAME / PAGE_PROPERTY）走原全库遍历路径，行为不变。 */
  private getHeatmapNoteCounts(snapshot?: DashboardSnapshot): Map<string, number> {
    const settings = this.plugin.data.settings.heatmap;
    // 只有 mtime 模式（默认）才尝试复用 scan 结果
    if (settings.dateFieldType === "FILE_MTIME" && snapshot?.dailyNoteCounts) {
      const counts = new Map<string, number>();
      for (const [date, n] of Object.entries(snapshot.dailyNoteCounts)) {
        if (n > 0) counts.set(date, n);
      }
      return counts;
    }

    // 原全库遍历路径（FILE_CTIME / FILE_NAME / PAGE_PROPERTY / snapshot 缺失时 fallback）
    const counts = new Map<string, number>();
    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      const d = this.resolveNoteDate(file, settings);
      if (!d) continue;
      const key = fmtDate(d);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }

  /** 获取指定日期的笔记列表（用于热图 Cell 点击展示） */
  private getHeatmapNotesForDate(dateStr: string): TFile[] {
    const settings = this.plugin.data.settings.heatmap;
    const result: TFile[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const d = this.resolveNoteDate(file, settings);
      if (d && fmtDate(d) === dateStr) result.push(file);
    }
    return result;
  }

  private resolveNoteDate(
    file: TFile,
    settings: HeatmapSettings
  ): Date | null {
    switch (settings.dateFieldType) {
      case "FILE_CTIME":
        return new Date(file.stat.ctime);
      case "FILE_MTIME":
        return new Date(file.stat.mtime);
      case "FILE_NAME":
        return this.parseHeatmapDate(file.basename, settings.dateFormat);
      case "PAGE_PROPERTY":
        return this.readPagePropertyDate(file, settings);
      default:
        return new Date(file.stat.ctime);
    }
  }

  private readPagePropertyDate(
    file: TFile,
    settings: HeatmapSettings
  ): Date | null {
    const prop = settings.dateFieldValue?.trim();
    if (!prop) return null;
    const cache = this.app.metadataCache.getFileCache(file);
    const raw = cache?.frontmatter?.[prop] as string | number | Date | null | undefined;
    if (raw == null) return null;
    if (typeof raw === "number") return new Date(raw);
    if (raw instanceof Date) return raw;
    return this.parseHeatmapDate(String(raw), settings.dateFormat);
  }

  /** 与热图插件 toDateTime 同口径的宽松日期解析（luxon） */
  private parseHeatmapDate(
    date: string,
    dateFieldFormat?: string
  ): Date | null {
    if (typeof date !== "string" || !date.trim()) return null;
    try {
      if (dateFieldFormat) {
        const dt = DateTime.fromFormat(date, dateFieldFormat);
        if (dt.isValid) return dt.toJSDate();
      }
      const iso = DateTime.fromISO(date);
      if (iso.isValid) return iso.toJSDate();
      const rfc = DateTime.fromRFC2822(date);
      if (rfc.isValid) return rfc.toJSDate();
      const sql = DateTime.fromSQL(date);
      if (sql.isValid) return sql.toJSDate();
      const hm = DateTime.fromFormat(date, "yyyy-MM-dd HH:mm");
      if (hm.isValid) return hm.toJSDate();
      const ht = DateTime.fromFormat(date, "yyyy-MM-dd'T'HH:mm");
      if (ht.isValid) return ht.toJSDate();
    } catch {
      /* 忽略解析失败 */
    }
    return null;
  }

  private renderRecentNotes(
    surface: HTMLElement,
    snapshot: DashboardSnapshot
  ): void {
    const list = surface.createDiv("astra-recent-list");
    if (snapshot.recentNotes.length === 0) {
      list.createDiv({ cls: "astra-empty-state", text: $t("dv.recent.noNotes") });
      return;
    }
    snapshot.recentNotes.forEach((note) => {
      const row = list.createEl("button", {
        cls: "astra-recent-row",
        attr: { type: "button" }
      });
      const icon = row.createSpan("astra-recent-icon");
      setIcon(icon, "file-text");
      const copy = row.createSpan("astra-recent-copy");
      copy.createSpan({
        cls: "astra-recent-title",
        text: note.file.basename
      });
      copy.createSpan({
        cls: "astra-recent-path",
        text: note.file.parent?.path ?? "/"
      });
      row.createSpan({
        cls: "astra-recent-time",
        text: relativeTime(note.file.stat.mtime)
      });
      const arrow = row.createSpan("astra-row-arrow");
      setIcon(arrow, "chevron-right");
      this.listen(row, "click", () => {
        void this.app.workspace.getLeaf(false).openFile(note.file);
      });
    });
  }

  /* ============================================================
     迁入的主页模块卡片（迁移自 obsidian-dashboard-main/data 层）
     ============================================================ */

  /** 每张卡片的数据获取都单独 try/catch，失败显示空态「暂无数据」，绝不让整页挂了 */
  private renderEmpty(
    container: HTMLElement,
    opts: { title: string; hint?: string }
  ): void {
    const e = container.createDiv("ad-empty");
    e.createDiv({ cls: "ad-empty__title", text: opts.title });
    if (opts.hint) e.createDiv({ cls: "ad-empty__hint", text: opts.hint });
  }

  /* ---- 通用头部布局工具 ---- */

  /** 将卡片头部的 h2 + span 包裹进居左容器（副标题紧跟标题后面） */
  private alignHeaderTitlesLeft(surface: HTMLElement, titlesCls: string): HTMLElement | null {
    const header = surface.querySelector<HTMLElement>(".astra-surface-header");
    if (!header) return null;
    if (header.querySelector(`.${titlesCls}`)) return header.querySelector<HTMLElement>(`.${titlesCls}`);
    const h2 = header.querySelector<HTMLElement>(":scope > h2");
    const subtitle = header.querySelector<HTMLElement>(":scope > span");
    const titles = header.createDiv(titlesCls);
    if (h2) titles.appendChild(h2);
    if (subtitle) titles.appendChild(subtitle);
    header.prepend(titles);
    return titles;
  }

  /* ---- 快速捕获 ---- */
  /** 在快速捕获模块头部右侧添加「全部便签」图标按钮，点击内嵌打开便签面板。 */
  private layoutQuickCaptureHeader(surface: HTMLElement): void {
    const header = surface.querySelector<HTMLElement>(".astra-surface-header");
    if (!header) return;
    // 将标题与副标题包裹在居左容器中（副标题紧跟在标题之后）
    this.alignHeaderTitlesLeft(surface, "astra-qc-titles");
    // 右侧按钮
    if (header.querySelector(".astra-icon-btn")) return;
    const actions = header.createDiv("astra-actions");
    const allBtn = actions.createEl("button", {
      cls: "astra-icon-btn clickable-icon",
      attr: { type: "button", "aria-label": $t("auto.246") }
    });
    setIcon(allBtn, "clipboard-list");
    this.listen(allBtn, "click", () => void this.navigateFlomoBoard());
  }

  /** 内嵌打开「全部便签」面板：复用常驻 header，仅替换 body 内容区。 */
  async navigateFlomoBoard(): Promise<void> {
    this.showingPanel = true;
    this.clearRenderResources();
    const body = this.ensureDashboardRoot(this.lastSnapshot);
    body.empty();
    this.contentEl.addClass("is-po-board");
    // 面板宿主容器
    const host = body.createDiv("po-board-host");
    const panel = new FlomoBoardPanel(
      host,
      this.plugin,
      this.plugin.data.settings.quickCapture.filePath
    );
    this.renderDisposers.push(() => panel.destroy());
    await panel.open();
  }

  private renderQuickCapture(surface: HTMLElement): void {
    this.layoutQuickCaptureHeader(surface);
    const qc = surface.createDiv("ad-qc");
    // 复用「全部便签」面板主区的输入卡样式；不渲染左侧 6 个工具栏图标
    const card = qc.createDiv("flomo-input-card qc-input-card");
    const area = card.createEl("textarea", {
      cls: "flomo-input",
      attr: { rows: "1", placeholder: $t("dv.quickCapture.placeholder") }
    });
    const toolbar = card.createDiv("flomo-input-toolbar qc-toolbar");
    const submit = toolbar.createEl("button", {
      cls: "flomo-submit-btn clickable-icon",
      attr: { type: "button", "aria-label": "发送" }
    });
    setIcon(submit, "send");

    const syncState = (): void => {
      if (area.value.trim()) card.addClass("has-content");
      else card.removeClass("has-content");
      this.autoGrowQuickCapture(area);
    };
    area.addEventListener("input", syncState);

    area.addEventListener("focus", () => {
      card.addClass("is-focused");
    });
    area.addEventListener("blur", () => {
      card.removeClass("is-focused");
      syncState();
    });
    card.addEventListener("click", (e) => {
      if (e.target === card) area.focus();
    });

    const submitAction = async (): Promise<void> => {
      const content = area.value.trim();
      if (!content) {
        area.focus();
        return;
      }
      submit.addClass("is-flashing");
      try {
        const savedPath = await this.appendCaptureNote(content);
        area.value = "";
        syncState();
        new Notice(`✨ 已写入 ${savedPath}`);
        void this.refresh();
      } catch {
        new Notice($t("p4.10246"));
      } finally {
        window.setTimeout(() => submit.removeClass("is-flashing"), 400);
      }
    };
    this.listen(submit, "click", () => void submitAction());
    area.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submitAction();
      }
    });
  }

  /** 跟随内容自动伸缩输入框高度（与便签面板一致，上限 240px） */
  private autoGrowQuickCapture(area: HTMLTextAreaElement): void {
    area.setCssProps({ height: "auto" });
    area.style.height = `${Math.min(area.scrollHeight, 240)}px`;
  }

  /** 确保文件夹存在（递归建父目录） */
  private async ensureFolder(path: string): Promise<void> {
    if (!path || path === "/") return;
    if (this.app.vault.getAbstractFileByPath(path)) return;
    const parts = path.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        await this.app.vault.createFolder(cur);
      }
    }
  }

  /** 快速捕获：把内容追加写入用户指定的单个笔记文件（与「全部便签」面板共用同一文件）。
   *  返回实际写入的文件路径，供调用方提示。
   */
  private async appendCaptureNote(content: string): Promise<string> {
    const filePath = (this.plugin.data.settings.quickCapture.filePath ?? "").trim();
    if (!filePath) throw new Error("未设置快速捕获文件");
    return appendFlomoToFile(this.app, filePath, content);
  }

  /* ---- 任务动作 ---- */

  /** 打开任务源笔记 */
  private openTaskSourceFile(task: TaskItem): void {
    if (task.sourceFile) void this.app.workspace.openLinkText(task.sourceFile, "", true);
  }

  /** 打开任务详情编辑弹窗（对齐上游 host openTaskEditModal），保存后刷新首页。 */
  private async openTaskEditModal(task: TaskItem): Promise<void> {
    const [allTasks, allProjects] = await Promise.all([
      this.taskStore.scanAllTasks(),
      this.taskStore.scanAllProjects(),
    ]);
    new TaskEditModal({
      app: this.app,
      task,
      allTasks,
      projects: allProjects,
      projectsFolder: this.plugin.data.settings.projectsFolder || "Projects",
      onSave: () => void this.refresh(true),
    }).open();
  }

  /** 打开项目详情编辑弹窗（复用 ProjectModal 编辑模式），保存后写回 frontmatter 并刷新首页。 */
  private openProjectEditModal(p: ProjectInfo): void {
    const stages = this.plugin.data.settings.npdpStages || ["Charter", "PDCP", "TR", "ADCP", "COR"];
    new ProjectModal({
      app: this.app,
      editData: {
        name: p.name,
        color: p.color,
        startDate: p.startDate || "",
        endDate: p.endDate || "",
        description: p.description,
        stage: p.stage ?? 0,
        type: p.type,
      },
      stages,
      onSave: (data) => void this.saveProjectEdit(p, data),
    }).open();
  }

  /** 保存项目编辑：若改名则重命名文件夹+文件，再写回 frontmatter，刷新模块。 */
  private async saveProjectEdit(p: ProjectInfo, data: ProjectFormData): Promise<void> {
    const oldName = p.name;
    const newName = data.name.trim();
    const safeNewName = newName.replace(/[*"/<>:|?\\]/g, "-");
    const rootPath = this.plugin.data.settings.projectsFolder || "Projects";
    const oldFolderPath = p.path;
    const newFolderPath = `${rootPath}/${safeNewName}`;
    let targetFile: TFile | null = null;

    // 改名：重命名文件夹 + project-<name>.md 文件
    if (newName && newName !== oldName) {
      const oldFile = this.app.vault.getAbstractFileByPath(`${oldFolderPath}/project-${oldName}.md`);
      if (!(oldFile instanceof TFile)) {
        new Notice($t("p4.10248"));
        return;
      }
      const oldFolder = this.app.vault.getAbstractFileByPath(oldFolderPath);
      if (oldFolder instanceof TFolder) {
        await this.app.vault.rename(oldFolder, newFolderPath);
      }
      // rename(folder) 会带走子文件，但文件名仍是 project-<旧名>.md，需要再 rename 文件
      const renamedFile = this.app.vault.getAbstractFileByPath(`${newFolderPath}/project-${oldName}.md`);
      if (renamedFile instanceof TFile) {
        await this.app.vault.rename(renamedFile, `${newFolderPath}/project-${safeNewName}.md`);
        targetFile = renamedFile;
      } else {
        targetFile = oldFile; // 回退
      }
    } else {
      const f = this.app.vault.getAbstractFileByPath(`${oldFolderPath}/project-${oldName}.md`);
      if (!(f instanceof TFile)) {
        new Notice($t("p4.10248"));
        return;
      }
      targetFile = f;
    }

    // 写回 frontmatter
    const typeLabel = data.type === "nostage" ? "非阶段项目" : "阶段项目";
    await writeFrontmatter(this.app, targetFile, {
      项目名称: newName,
      颜色: data.color,
      项目类型: typeLabel,
      描述: data.description,
      开始日期: data.startDate,
      结束日期: data.endDate,
      阶段: String(data.stage),
    });
    new Notice($t("p4.10249"));
    this.taskStore.invalidate();
    void this.refresh(true);
  }

  /** 切换任务完成状态（中文 frontmatter）；重复任务用 calcNextRemindDate 推进 */
  private async toggleTask(task: TaskItem, row: HTMLElement): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(task.sourceFile);
    if (!(file instanceof TFile)) return;
    // 重复任务：不切换状态，而是推进提醒日期
    if (task.type === "重复" && task.status !== "已完成") {
      const nextDate = calcNextRemindDate(task);
      if (nextDate) {
        await this.writeTaskField(task, "提醒日期", nextDate);
        task.remindDate = nextDate;
        const now = nowFmt();
        await this.writeTaskField(task, "完成时间", now);
        task.completeTime = now;
        new Notice("✨ 重复任务，下次提醒: " + nextDate);
        void this.refresh();
        return;
      }
    }
    const newStatus: TaskStatus = task.status === "已完成" ? "待办" : "已完成";
    const now = nowFmt();
    await writeFrontmatter(this.app, file, {
      状态: newStatus,
      完成时间: newStatus === "已完成" ? now : null
    });
    task.status = newStatus;
    task.completeTime = newStatus === "已完成" ? now : null;
    row.toggleClass("is-done", newStatus === "已完成");
  }

  private async writeTaskField(task: TaskItem, fieldKey: string, value: string): Promise<void> {
    if (!task.sourceFile) return;
    const file = this.app.vault.getAbstractFileByPath(task.sourceFile);
    if (!(file instanceof TFile)) return;
    await writeFrontmatter(this.app, file, { [fieldKey]: value });
  }

  /** 删除任务源笔记 */
  private async deleteTask(task: TaskItem): Promise<void> {
    if (!task.sourceFile) return;
    const confirmed = await confirmDialog(this.app, {
      title: $t("dv.deleteTask"),
      message: `确定删除任务 "${task.content}"？`,
      confirmText: $t("set.remaining.758"),
      danger: true
    });
    if (!confirmed) return;
    const file = this.app.vault.getAbstractFileByPath(task.sourceFile);
    if (file instanceof TFile) {
      await this.app.fileManager.trashFile(file);
      new Notice("❌ 任务已删除: " + task.content);
      void this.refresh();
    }
  }

  /* ---- TODO（每日 / 重复任务） ---- */
  /** 「TODO」头部：标题 + 副标题（左上），右上角「新建任务」图标按钮 */
  private layoutTodoHeader(surface: HTMLElement): void {
    const header = surface.querySelector<HTMLElement>(".astra-surface-header");
    if (!header) return;
    // 标题与副标题居左
    this.alignHeaderTitlesLeft(surface, "astra-todo-titles");
    if (header.querySelector(".astra-todo-new-btn")) return;
    // 右上角「新建任务」图标按钮
    const actions = header.createDiv("astra-actions");
    const btn = actions.createEl("button", {
      cls: "astra-todo-new-btn astra-icon-btn clickable-icon",
      attr: { type: "button", "aria-label": $t("dv.header.newTask") }
    });
    setIcon(btn, "plus");
    this.listen(btn, "click", () => this.createTask());
  }

  private async renderTodo(surface: HTMLElement): Promise<void> {
    this.layoutTodoHeader(surface);
    const summaryEl = surface.querySelector<HTMLElement>(".astra-surface-header span");
    const list = surface.createDiv("ad-todo");
    try {
      const tasks = await this.taskStore.scanAllTasks();
      const todayTasks = getTodayTasks(tasks);
      const sorted = todayTasks.slice().sort((a, b) => {
        if (a.isOverdue && !b.isOverdue) return -1;
        if (!a.isOverdue && b.isOverdue) return 1;
        return priorityWeight(a.priority) - priorityWeight(b.priority);
      });
      if (sorted.length === 0) {
        const empty = list.createDiv("ad-todo__empty");
        const iconWrap = empty.createDiv("ad-todo__empty-icon");
        setIcon(iconWrap, "coffee");
        empty.createDiv({ cls: "ad-todo__empty-text", text: $t("dv.t.none") });
      } else {
        sorted.forEach((task) => {
          const isDone = task.status === "已完成";
          const row = list.createDiv(
            "ad-todo__item" +
              (isDone ? " is-done" : "") +
              (task.isOverdue ? " is-overdue" : "")
          );
          const check = row.createSpan("ad-todo__check");
          setIcon(check, isDone ? "check-circle" : "circle");
          this.listen(check, "click", (e) => {
            e.stopPropagation();
            void this.toggleTask(task, row);
          });
          const text = row.createSpan({ cls: "ad-todo__text", text: task.content });
          this.listen(text, "click", () => {
            void this.openTaskEditModal(task);
          });
          const prioLabel = task.priority || "未设置";
          row.createSpan({
            cls: "ad-todo__tag",
            text: prioLabel,
            attr: { "data-prio": task.priority || "" }
          });
          this.listen(row, "contextmenu", (e) => {
            e.preventDefault();
            const menu = new Menu();
            menu.addItem((item) =>
              item
                .setTitle($t("p4.10006"))
                .setIcon("file")
                .onClick(() => this.openTaskSourceFile(task))
            );
            menu.addItem((item) =>
              item
                .setTitle($t("dv.deleteTask"))
                .setIcon("trash")
                .onClick(() => void this.deleteTask(task))
            );
            menu.showAtMouseEvent(e);
          });
        });
      }
      const universe = getTodayUniverse(tasks);
      const doneCount = universe.filter((t) => isDoneToday(t)).length;
      const skipCount = universe.filter((t) => isSkipToday(t)).length;
      const totalForSummary = universe.length - skipCount;
      summaryEl?.setText(`${doneCount} / ${totalForSummary} done · ${$t("dv.biz.priorityHint")}`);
    } catch {
      summaryEl?.setText("0 / 0 done");
      list.createDiv({ cls: "ad-todo__empty", text: $t("dv.empty") });
    }
  }

  /* ---- 任务进展 ---- */
  /** 「任务进展」头部：标题居左（副标题留空），无右上角按钮；逾期角标随渲染动态插入标题右侧 */
  private layoutWeeklyHeader(surface: HTMLElement): void {
    const header = surface.querySelector<HTMLElement>(".astra-surface-header");
    if (!header) return;
    // 标题居左
    this.alignHeaderTitlesLeft(surface, "astra-weekly-titles");
  }

  /** 头部右上角逾期角标（红色闪烁，逾期数 > 0 才显示；数字变化时重建） */
  private renderWeeklyBadge(surface: HTMLElement, count: number): void {
    const header = surface.querySelector<HTMLElement>(".astra-surface-header");
    if (!header) return;
    const old = header.querySelector<HTMLElement>(":scope > .ad-badge");
    old?.remove();
    if (count <= 0) return;
    const badge = header.createSpan({
      cls: "ad-badge ad-badge--danger",
      text: String(count)
    });
    badge.title = $t("dv.tmpl.overdueCount", { count });
  }

  private async renderWeekly(surface: HTMLElement): Promise<void> {
    this.layoutWeeklyHeader(surface);
    const list = surface.createDiv("ad-wo");
    try {
      const tasks = await this.taskStore.scanAllTasks();
      const today = todayStr();
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      const dow = (now.getDay() + 6) % 7; // 0 = 周一
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - dow);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 7);
      const weekStartStr = fmtDate(weekStart);
      const weekEndStr = fmtDate(weekEnd);
      const isDone = (t: TaskItem): boolean =>
        t.status === "已完成" || t.status === "已取消";

      const overdue = tasks.filter((t) => t.isOverdue);
      overdue.sort((a, b) =>
        a.dueDate! < b.dueDate! ? -1 : a.dueDate! > b.dueDate! ? 1 : 0
      );

      const thisWeek = tasks.filter((t) => {
        if (isDone(t)) return false;
        if (t.type === "重复" && t.remindDate) {
          return t.remindDate < weekEndStr && t.remindDate >= weekStartStr;
        }
        if (!t.dueDate) return false;
        if (t.dueDate < today) return false;
        const start = t.startDate || t.dueDate;
        return start < weekEndStr && t.dueDate >= weekStartStr;
      });
      thisWeek.sort((a, b) =>
        a.dueDate! < b.dueDate! ? -1 : a.dueDate! > b.dueDate! ? 1 : 0
      );

      this.renderWeeklyBadge(surface, overdue.length);

      if (overdue.length > 0) {
        const og = list.createDiv("ad-wo__group ad-wo--overdue");
        const oh4 = og.createEl("h4");
        oh4.createSpan({ cls: "ad-wo__mark", text: "▲" });
        oh4.appendText($t("p4.10250"));
        const ul = og.createEl("ul", { cls: "ad-wo__list" });
        overdue.forEach((t) => this.renderWeeklyRow(ul, t, true));
      }
      list.createDiv("ad-wo__sep");
      const wg = list.createDiv("ad-wo__group");
      const wh4 = wg.createEl("h4");
      wh4.createSpan({ cls: "ad-wo__mark", text: "◆" });
      wh4.appendText($t("dv.taskProgress.weeklyTodos"));
      const ul = wg.createEl("ul", { cls: "ad-wo__list" });
      if (thisWeek.length === 0 && overdue.length === 0) {
        list.createDiv({ cls: "ad-wo__empty", text: $t("auto.211") });
      } else {
        thisWeek.forEach((t) => this.renderWeeklyRow(ul, t, false));
      }
      const foot = surface.createDiv("ad-wo__foot");
      foot.textContent = $t("dv.tmpl.weeklySummary", { thisWeekLen: thisWeek.length, overdueLen: overdue.length });
    } catch {
      list.createDiv({ cls: "ad-wo__empty", text: $t("dv.empty") });
    }
  }

  private renderWeeklyRow(ul: HTMLElement, task: TaskItem, isOverdue: boolean): void {
    const li = ul.createEl("li");
    const due = task.dueDate || task.remindDate || "";
    li.createSpan({ cls: "ad-wo__date", text: due ? due.slice(5) : "—" });
    li.createSpan({ cls: "ad-wo__text", text: task.content });
    if (isOverdue) {
      const days = overdueDays(task.dueDate);
      li.createSpan({ cls: "ad-wo__over", text: $t("dv.tmpl.overdueDays", { days }) });
      li.classList.add("is-overdue-row");
    } else {
      const urg = urgencyMeta(task.priority);
      if (urg) {
        li.createSpan({
          cls: "ad-wo__urg",
          text: urg.label,
          attr: { "data-urg": urg.key }
        });
      }
    }
    this.listen(li, "click", () => {
      void this.openTaskEditModal(task);
    });
    this.listen(li, "contextmenu", (e) => {
      e.preventDefault();
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle($t("p4.10006"))
          .setIcon("file")
          .onClick(() => this.openTaskSourceFile(task))
      );
      menu.addItem((item) =>
        item
          .setTitle($t("dv.deleteTask"))
          .setIcon("trash")
          .onClick(() => void this.deleteTask(task))
      );
      menu.showAtMouseEvent(e);
    });
  }

  /** 内嵌打开「全部项目」看板：复用常驻 header，仅替换 body 内容区。 */
  async navigateProjectBoard(projectName: string | null): Promise<void> {
    this.showingPanel = true;
    this.clearRenderResources();
    const body = this.ensureDashboardRoot(this.lastSnapshot);
    body.empty();
    this.contentEl.addClass("is-po-board");
    // 看板宿主容器（标题交给 Obsidian 原生头部 view-header）
    const host = body.createDiv("po-board-host");
    const panel = new ProjectBoardPanel(host, this.plugin);
    this.renderDisposers.push(() => panel.destroy());
    await panel.open(projectName);
  }

  /** 返回首页（重渲模块网格）。 */
  navigateHome(): void {
    this.showingPanel = false;
    if (this.lastSnapshot) this.render(this.lastSnapshot);
  }

  /* ---- 项目情况（阶段管道） ---- */
  private async renderProjects(surface: HTMLElement): Promise<void> {
    const summaryEl = surface.querySelector<HTMLElement>(".astra-surface-header span");
    this.layoutProjectsHeader(surface);
    const stages = this.plugin.data.settings.npdpStages;
    const maxStageFilter = this.plugin.data.settings.npdpProgressFilter ?? stages.length;
    let projects: ProjectInfo[] = [];
    try {
      projects = await this.taskStore.scanAllProjects();
    } catch {
      /* 保持空 */
    }
    const stageProjects = projects.filter((p) => (p.type ?? "stage") === "stage");
    const filtered =
      maxStageFilter < stages.length
        ? stageProjects.filter((p) => (p.stage ?? 0) <= maxStageFilter)
        : stageProjects;

    summaryEl?.setText($t("dv.biz.projects.count", { filteredLen: filtered.length, stageProjectsLen: stageProjects.length }));

    const proj = surface.createDiv("ad-proj");
    if (filtered.length === 0) {
      this.renderEmpty(proj, {
        title: $t("dv.projects.none"),
        hint: "在「项目文件夹」下新建带 project.md 的文件夹，阶段管道就会显示在这里。"
      });
      return;
    }
    const list = proj.createDiv("ad-proj__list");
    let activeCount = 0;
    filtered.forEach((p) => {
      const projStage = p.stage ?? 0;
      if (projStage > 0 && projStage < (p.stages?.length ?? stages.length)) activeCount++;
      const pct = p.taskCount > 0 ? Math.round((p.activeCount / p.taskCount) * 100) : 0;
      const row = list.createDiv("ad-proj__row");
      row.createSpan("ad-proj__dot").setCssProps({ "--ad-proj-dot": p.color });
      const name = row.createDiv("ad-proj__name");
      name.appendText(p.name);
      name.createSpan({
        cls: "ad-meta",
        text: `${p.taskCount} 任务 · ${p.activeCount}活跃 · ${pct}%`
      });
      const track = row.createDiv("ad-proj__track");
      const stageNodes = track.createDiv("ad-proj__stages");
      const projStages = p.stages || stages;
      const stageMinW = Math.max(20, Math.min(36, Math.floor(160 / projStages.length)));
      const stageGap = Math.max(1, Math.floor(4 / (projStages.length / 4)));
      stageNodes.style.setProperty("--pip-w", stageMinW + "px");
      stageNodes.style.setProperty("--pip-gap", stageGap + "px");
      stageNodes.style.setProperty("--proj-color", p.color || "#40c463");
      projStages.forEach((label, i) => {
        // 点击哪个阶段，它及其之前的阶段都算"已完成"（前置圆点高亮）
        const isDone = i <= projStage;
        const s = stageNodes.createDiv(
          "ad-proj__stage" + (isDone ? " is-done" : "")
        );
        s.style.width = stageMinW + "px";
        s.createSpan("ad-pip");
        s.appendText(label);
      });
      // 行点击打开编辑弹窗；右侧箭头点击跳转看板（移动端屏蔽箭头入口，弹窗显示不全）
      this.listen(row, "click", () => {
        this.openProjectEditModal(p);
      });
      if (!Platform.isMobile) {
        const chev = row.createDiv("ad-proj__chev");
        setIcon(chev, "chevron-right");
        chev.addEventListener("click", (e: MouseEvent) => {
          e.stopPropagation();
          void this.navigateProjectBoard(p.name);
        });
      }
    });
    const sum = proj.createDiv("ad-proj__sum");
    const filterLabel =
      maxStageFilter < stages.length ? $t("dv.tmpl.progressMinMax", { stages: stages[maxStageFilter - 1] ?? "" }) : $t("dv.pb.filter.all");
    sum.createSpan().appendText($t("dv.tmpl.projectsSummary", { activeCount, filterLabel }));
  }

  /** 「项目情况」头部：标题 + 计数（左上），右上角「新建」按钮 */
  private layoutProjectsHeader(surface: HTMLElement): void {
    const header = surface.querySelector<HTMLElement>(".astra-surface-header");
    if (!header) return;
    // 标题与计数居左（计数紧跟在标题之后）
    this.alignHeaderTitlesLeft(surface, "astra-projects-titles");
    if (header.querySelector(".astra-projects-new-btn")) return;
    // 右上角按钮组（居右排列：右1「新建」、右2「全部项目」图标）
    const actions = header.createDiv("astra-actions");
    // 「全部项目」图标按钮：移动端屏蔽（看板面板显示不全）
    if (!Platform.isMobile) {
      const allBtn = actions.createEl("button", {
        cls: "astra-projects-all-btn astra-icon-btn clickable-icon",
        attr: { type: "button", "aria-label": $t("dv.pb.actions.allProjects") }
      });
      setIcon(allBtn, "list");
      this.listen(allBtn, "click", () => void this.navigateProjectBoard(null));
    }
    // 「新建」按钮（纯加号图标）
    const btn = actions.createEl("button", {
      cls: "astra-projects-new-btn astra-icon-btn clickable-icon",
      attr: { type: "button", "aria-label": $t("auto.320") }
    });
    setIcon(btn, "plus");
    this.listen(btn, "click", () => this.createProjectFile());
  }

  private createProjectFile(): void {
    new ProjectModal({
      app: this.app,
      onSave: (data) => {
        void this.createProjectFolder(data);
      },
    }).open();
  }

  private async createProjectFolder(data: ProjectFormData): Promise<void> {
    const name = data.name;
    const rootPath = this.plugin.data.settings.projectsFolder || "Projects";
    await this.ensureFolder(rootPath);
    const safeName = name.replace(/[*"/<>:|?\\]/g, "-");
    const projectFolderPath = `${rootPath}/${safeName}`;
    await this.ensureFolder(projectFolderPath);
    const now = new Date();
    const createDate =
      now.getFullYear() +
      "-" +
      String(now.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(now.getDate()).padStart(2, "0");
    const typeLabel = data.type === 'nostage' ? '非阶段项目' : '阶段项目';
    const projectFilePath = `${projectFolderPath}/project-${safeName}.md`;
    if (!(this.app.vault.getAbstractFileByPath(projectFilePath) instanceof TFile)) {
      const lines = [
        "---",
        `项目名称: ${yamlScalar(name)}`,
        `颜色: ${yamlScalar(data.color)}`,
        `项目类型: ${yamlScalar(typeLabel)}`,
        "tags: [配置]",
        `描述: ${yamlScalar(data.description)}`,
        `开始日期: ${yamlScalar(data.startDate)}`,
        `结束日期: ${yamlScalar(data.endDate)}`,
        `创建时间: ${createDate}`,
        "---",
        "",
        `# ${name}`,
        ""
      ];
      await this.app.vault.create(projectFilePath, lines.join("\n"));
      new Notice(`✨ 项目已创建：${name}`);
    }
    this.taskStore.invalidate();
    this.rebuildModuleGrid();
  }

  /** 打开「新建任务」弹窗（数据源扫描完成后）。 */
  private createTask(): void {
    this.allProjects()
      .then((projects) => {
        new TaskModal({
          app: this.app,
          projects: projects.map((p) => ({ name: p.name, path: p.path })),
          onSave: (data) => {
            void this.createTaskFile(data);
          },
        }).open();
      })
      .catch(() => {
        new Notice($t("p4.10252"));
      });
  }

  private allProjects(): Promise<ProjectInfo[]> {
    return this.taskStore.scanAllProjects();
  }

  /** 创建任务文件：委托给共享模块（首页与项目板共用同一套 frontmatter 逻辑）。 */
  private async createTaskFile(data: TaskFormData): Promise<void> {
    const projectsFolder = this.plugin.data.settings.projectsFolder || "Projects";
    await createTaskFileShared(this.app, projectsFolder, data);
    this.taskStore.invalidate();
    this.rebuildModuleGrid();
  }

  /* ---- 倒计时 ---- */
  /** 「倒计时」头部：标题 + 副标题（左上），右上角设置图标按钮 */
  private layoutCountdownHeader(surface: HTMLElement): void {
    const header = surface.querySelector<HTMLElement>(".astra-surface-header");
    if (!header) return;
    // 标题与副标题居左
    this.alignHeaderTitlesLeft(surface, "astra-countdown-titles");
    if (header.querySelector(".astra-countdown-cal-btn")) return;
    // 右上角设置图标按钮
    const actions = header.createDiv("astra-actions");
    const btn = actions.createEl("button", {
      cls: "astra-countdown-cal-btn astra-icon-btn clickable-icon",
      attr: { type: "button", "aria-label": $t("f.1092") }
    });
    setIcon(btn, "sliders-horizontal");
    this.listen(btn, "click", () => {
      const surface = btn.closest<HTMLElement>(".astra-surface");
      new CountdownModal({
        app: this.app,
        plugin: this.plugin,
        onApply: () => {
          if (surface && surface.isConnected) this.refreshCountdownCard(surface);
        },
      }).open();
    });
  }

  /** 保存后仅重建倒计时卡片正文，保留卡片 header（标题/设置按钮），避免整板重渲染导致的移位 */
  private refreshCountdownCard(surface: HTMLElement): void {
    Array.from(surface.children).forEach((child) => {
      if (child.classList.contains("astra-surface-header")) return;
      child.remove();
    });
    this.renderCountdownBody(surface);
  }

  private renderCountdown(surface: HTMLElement): void {
    this.layoutCountdownHeader(surface);
    this.renderCountdownBody(surface);
  }

  private renderCountdownBody(surface: HTMLElement): void {
    const cfg = this.plugin.data.settings.countdown;
    const name = (cfg.eventName ?? "").trim();
    const dateStr = (cfg.targetDate ?? "").trim();

    // 空态：没有有效配置时显示引导
    if (!name || !dateStr) {
      const cd = surface.createDiv("ad-cd");
      const hint = cd.createDiv("ad-cd__empty");
      hint.setText($t("dv.countdown.emptyHint"));
      return;
    }

    const target = this.parseCountdownDate(dateStr);
    if (!target) {
      const cd = surface.createDiv("ad-cd");
      const hint = cd.createDiv("ad-cd__empty");
      hint.setText($t("dv.countdown.emptyHint"));
      return;
    }

    const now = new Date();
    const today = this.startOfDay(now);
    const targetDay = this.startOfDay(target);
    const diffDays = Math.round((targetDay.getTime() - today.getTime()) / 86400000);

    const cd = surface.createDiv("ad-cd");
    cd.createDiv({ cls: "ad-cd__sub", text: `距离 ${name}` });

    if (diffDays > 0) {
      const periodStart = new Date(target.getFullYear() - 1, target.getMonth(), target.getDate());
      const total = Math.max(1, target.getTime() - periodStart.getTime());
      const elapsed = now.getTime() - periodStart.getTime();
      const pct = Math.max(0, Math.min(100, (elapsed / total) * 100));
      const big = cd.createDiv("ad-cd__big");
      big.createSpan({ text: String(diffDays) });
      big.createSpan({ cls: "ad-unit", text: "DAYS" });
      const bottom = cd.createDiv("ad-cd__bottom");
      const row = bottom.createDiv("ad-cd__row");
      row.createSpan({ text: $t("u.20731") }).createEl("strong", {
        text: String(Math.ceil(diffDays / 7))
      });
      // 分隔圆点（内联样式，跟随主题文字色，避免新增 CSS 变量依赖）
      row.createSpan({
        cls: "ad-dot",
        attr: { style: "display:inline-block;width:3px;height:3px;background:var(--astra-text);opacity:.4;border-radius:50%;" }
      });
      row.createSpan({ text: $t("u.20732") }).createEl("strong", {
        text: pct.toFixed(1) + "%"
      });
      const barWrap = bottom.createDiv("ad-cd__bar");
      const fill = barWrap.createDiv("ad-fill");
      fill.style.width = pct + "%";
    } else if (diffDays === 0) {
      cd.createDiv({ cls: "ad-cd__arrived", text: $t("auto.213") });
      const bottom = cd.createDiv("ad-cd__bottom");
      const barWrap = bottom.createDiv("ad-cd__bar");
      barWrap.createDiv("ad-fill");
    } else {
      cd.createDiv({ cls: "ad-cd__arrived", text: $t("auto.214") });
      const bottom = cd.createDiv("ad-cd__bottom");
      const barWrap = bottom.createDiv("ad-cd__bar");
      barWrap.createDiv("ad-fill");
    }
  }

  /** 解析 ISO yyyy-mm-dd 为目标 Date（当地 0 点）；非法或留空回退到「下一年 1 月 1 日」 */
  /** 每日口语的当前浏览状态（按天保持，整页重渲不丢失手动翻页位置） */
  private dailyPhraseState: { date: string; index: number } | null = null;

  /**
   * 每日口语模块：读设置指定的 .md，解析为条目，按日期种子确定性随机展示当天一句；
   * 支持上一句/下一句（循环）与「换一句」（即时随机）。
   */
  private async renderDailyPhrase(surface: HTMLElement): Promise<void> {
    // 将标题与副标题包裹进居左容器，与其他模块使用同一设计语言
    this.alignHeaderTitlesLeft(surface, "astra-daily-phrase-titles");
    const wrap = surface.createDiv("ad-dp");
    const hint = (msg: string): void => {
      wrap.createDiv({ cls: "ad-dp__hint", text: msg });
    };

    const cfg = this.plugin.data.settings.dailyPhrase;
    const path = (cfg?.filePath ?? "").trim();
    if (!path) {
      hint("未指定数据源：设置 › 主页模块 › 每日口语来源 选择一个 .md 文件");
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile)) {
      hint(`未找到文件：${path}`);
      return;
    }

    let items: PhraseItem[];
    try {
      const content = await this.app.vault.cachedRead(file);
      items = parseDailyPhrases(content);
    } catch (e) {
      hint(`读取或解析失败：${(e as Error).message}`);
      return;
    }
    if (items.length === 0) {
      hint("未能从该文件解析出任何口语条目（检查 en/zh/scene 格式）");
      return;
    }

    const today = fmtDate(new Date());
    if (!this.dailyPhraseState || this.dailyPhraseState.date !== today) {
      // 以日期为种子做确定性哈希 → 当天稳定、隔天换
      const seed = hashString(`${today}:${items.length}`);
      this.dailyPhraseState = { date: today, index: seed % items.length };
    }
    const total = items.length;

    const content = wrap.createDiv("ad-dp__content");
    const enEl = content.createDiv("ad-dp__en");
    const zhEl = content.createDiv("ad-dp__zh");
    const sceneEl = content.createDiv("ad-dp__scene");
    sceneEl.createSpan({ cls: "ad-dp__scene-label", text: $t("auto.215") });
    const sceneText = sceneEl.createSpan("ad-dp__scene-text");

    const btns = wrap.createDiv("ad-dp__btns");
    const prev = this.createIconButton(btns, "chevron-left", $t("p4.10255"));
    const shuffle = this.createIconButton(btns, "dice", $t("p4.10256"));
    const next = this.createIconButton(btns, "chevron-right", $t("p4.10257"));

    const show = (i: number): void => {
      const idx = ((i % total) + total) % total;
      this.dailyPhraseState = { date: today, index: idx };
      const it = items[idx]!;
      enEl.setText(it.en);
      zhEl.setText(it.zh);
      sceneText.setText(it.scene || "—");
    };

    prev.addEventListener("click", () => show(this.dailyPhraseState!.index - 1));
    next.addEventListener("click", () => show(this.dailyPhraseState!.index + 1));
    shuffle.addEventListener("click", () => {
      if (total <= 1) {
        show(0);
        return;
      }
      let r = Math.floor(Math.random() * total);
      if (r === this.dailyPhraseState!.index) r = (r + 1) % total;
      show(r);
    });

    show(this.dailyPhraseState.index);
  }

  /** 解析 ISO yyyy-mm-dd 为目标 Date（当地 0 点）；非法或留空返回 null */
  private parseCountdownDate(s: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((s ?? "").trim());
    if (m) {
      const y = parseInt(m[1]!, 10);
      const mo = parseInt(m[2]!, 10) - 1;
      const d = parseInt(m[3]!, 10);
      const dt = new Date(y, mo, d);
      if (!Number.isNaN(dt.getTime()) && dt.getFullYear() === y && dt.getDate() === d) return dt;
    }
    return null;
  }

  /** 取某日当地 0 点，用于按「天」比较 */
  private startOfDay(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  /**
   * 主页模块网格：JS 动态算列 + 固定 4 列上限（对齐 obsidian-dashboard-main）。
   * 与参考一致，列数不用 CSS auto-fit/minmax(320px,…)（会在宽屏压出太多列、把卡片挤窄），
   * 而是按板面实际宽度按 MIN_CARD_W 可读下限推算列数，写进 --astra-mod-cols。
   */
  private initModulesCols(container: HTMLElement): void {
    if (this.modulesColsObs) {
      this.modulesColsObs.disconnect();
      this.modulesColsObs = null;
    }
    const MIN_CARD_W = 260; // 单卡可读下限，与参考一致
    const MAX_COLS = 4;
    const GAP = 14; // 与 .astra-modules-grid 的 gap 一致
    const apply = () => {
      const width = container.getBoundingClientRect().width;
      if (width <= 0) return; // 未布局时等 ResizeObserver 再来
      const fit = Math.floor((width + GAP) / (MIN_CARD_W + GAP));
      const colCount = Math.max(1, Math.min(MAX_COLS, fit));
      container.style.setProperty("--astra-mod-cols", String(colCount));
      // 行高 = 单列宽：与 CSS 的 minmax(0,1fr) 等宽轨道算法一致，1×1 卡正方
      const unit = Math.max(40, (width - GAP * (colCount - 1)) / colCount);
      container.style.setProperty("--astra-mod-row", `${Math.round(unit)}px`);
      // 列数变化时重夹紧全部卡片（防 2 列卡在仅剩 1 列时撑出隐式列被挤压）
      if (colCount !== this.adLastColCount) {
        this.adLastColCount = colCount;
        this.reapplyModuleSpans();
      }
    };
    apply();
    this.modulesColsObs = new ResizeObserver(() => apply());
    this.modulesColsObs.observe(container);
  }

  private createModuleCard(
    parent: HTMLElement,
    title: string,
    subtitle: string,
    modId: string
  ): HTMLElement {
    const surface = this.createSurface(parent, title, subtitle);
    surface.setAttribute("data-mod", modId);
    const cfg = this.plugin.data.settings.moduleSizes?.[modId];
    this.applyCardSpan(surface, modId, cfg?.cols, cfg?.rows);
    return surface;
  }

  /** 当前模块网格列数（1~4，由 initModulesCols 写入 --astra-mod-cols） */
  private currentModColCount(): number {
    const grid = this.modulesGridEl;
    if (!grid) return MOD_MAX_SPAN;
    const v = parseInt(grid.style.getPropertyValue("--astra-mod-cols"), 10);
    if (v > 0) return Math.max(1, Math.min(MOD_MAX_SPAN, v));
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 14;
    const width = grid.getBoundingClientRect().width;
    if (width > 0) {
      return Math.max(1, Math.min(MOD_MAX_SPAN, Math.floor((width + gap) / (MOD_MIN_CARD_W + gap))));
    }
    return MOD_MAX_SPAN;
  }

  /** 单个基础尺寸单元（单列宽）与列间距（用于把指针位置换算成「几格」） */
  private moduleGridUnit(): { unit: number; gap: number; colCount: number } {
    const grid = this.modulesGridEl;
    const colCount = this.currentModColCount();
    if (!grid) return { unit: 200, gap: 14, colCount };
    const cs = getComputedStyle(grid);
    const gap = parseFloat(cs.columnGap) || 14;
    const width = grid.getBoundingClientRect().width;
    const unit = Math.max(40, (width - gap * (colCount - 1)) / colCount);
    return { unit, gap, colCount };
  }

  /** 把「宽 cols 格 × 高 rows 格」写进卡片的 CSS 变量（grid-column/grid-row span 由此驱动），统一经过 resolveModSpan 夹紧 */
  private applyCardSpan(el: HTMLElement, modId: string, cols?: number, rows?: number): void {
    const { cols: c, rows: r } = this.resolveModSpan(modId, clampModSpan(cols), clampModSpan(rows));
    el.style.setProperty("--cols", String(c));
    el.style.setProperty("--rows", String(r));
  }

  /** 把一个（可能非法的）宽/高格数解析成合法组合，渲染 / 拖拽 / 响应式夹紧共用，保证规则一致 */
  private resolveModSpan(modId: string, cols: number, rows: number): { cols: number; rows: number } {
    const colCount = this.currentModColCount();
    let c = this.clampMinModCols(modId, Math.min(colCount, clampModSpan(cols)), colCount);
    let r = clampModSpan(rows);
    const ratio = MOD_MIN_RATIO[modId];
    if (ratio) {
      const maxRows = Math.max(1, Math.floor(c / ratio));
      if (r > maxRows) r = maxRows;
    }
    return { cols: c, rows: r };
  }

  /** 把宽度按「模块最低列数」与「当前实际列数」双重夹紧；硬上限 = 当前列数，防撑出隐式列 */
  private clampMinModCols(modId: string, cols: number, colCount: number): number {
    const min = MOD_MIN_COLS[modId] ?? 1;
    const c = colCount >= min ? Math.max(min, cols) : cols;
    return Math.max(1, Math.min(colCount, c));
  }

  /** 响应式列数变化时，用保存的比例重新夹紧所有卡片 */
  private reapplyModuleSpans(): void {
    const grid = this.modulesGridEl;
    if (!grid) return;
    const sizes = this.plugin.data.settings.moduleSizes ?? {};
    grid.querySelectorAll(".astra-surface").forEach((card) => {
      const el = card as HTMLElement;
      const modId = el.getAttribute("data-mod") ?? "";
      // 最近笔记无 data-mod，单独处理
      if (!modId) return;
      const cfg = sizes[modId];
      if (!cfg) return;
      const { cols, rows } = this.resolveModSpan(modId, clampModSpan(cfg.cols), clampModSpan(cfg.rows));
      el.style.setProperty("--cols", String(cols));
      el.style.setProperty("--rows", String(rows));
    });
    // 最近笔记：重算剩余列数
    const colCount = this.currentModColCount();
    let occupied = 0;
    grid.querySelectorAll(":scope > .astra-surface:not(.astra-recent-surface)").forEach((el) => {
      const cols = parseInt((el as HTMLElement).style.getPropertyValue("--cols") || "1", 10);
      occupied += Math.max(1, Math.min(colCount, cols));
    });
    const remainder = occupied % colCount;
    const span = remainder === 0 ? colCount : colCount - remainder;
    const recent = grid.querySelector<HTMLElement>(".astra-recent-surface");
    if (recent) {
      recent.setCssProps({ "--recent-span": String(span), "--rows": "1" });
    }
  }

  /** 绑定模块网格交互（每次重建时绑定，随 render 释放）：长按卡片边缘进入编辑态 */
  private wireModuleInteractions(container: HTMLElement): void {
    this.listen(container, "pointerdown", (e) => this.onModulePointerDown(e));
  }

  private onModulePointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    // 比例手柄的按下：交给缩放逻辑，绝不触发长按进入编辑态
    if ((e.target as HTMLElement).closest(".astra-card__resize")) return;
    const grid = this.modulesGridEl;
    if (!grid) return;
    const target = (e.target as HTMLElement).closest<HTMLElement>(".astra-surface");
    // 表单控件内的按下不进入编辑态（如快速捕捉文本框）
    if ((e.target as HTMLElement).closest("input, textarea, button, select")) {
      if (!this.adEditMode) return;
    }

    // 1) 编辑态：按住卡片主体并拖动 → 拖拽重排（无需 CMD、无需长按）
    //    加入移动阈值：真正移动才提起卡片，避免轻点误触跳位。
    //    锚点锁定「最初按下点」x0/y0：若用 move 后的坐标算 offset，
    //    会让卡片提起后的抓取点相对鼠标点击点产生偏移（错位根因）
    if (this.adEditMode) {
      if (!target) return;
      if ((e.target as HTMLElement).closest("input, textarea, button, select")) return;
      const x0 = e.clientX;
      const y0 = e.clientY;
      let dragStarted = false;
      const move = (ev: PointerEvent): void => {
        if (dragStarted) return;
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) <= 8) return;
        dragStarted = true;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        this.beginModuleDrag(target, x0, y0);
      };
      const up = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
      return;
    }

    // 2) 非编辑态：仅在「卡片边缘」长按时进入编辑态（调宽/删除/添加）
    if (!target || !isOnCardEdge(target, e.clientX, e.clientY)) return;

    const x0 = e.clientX;
    const y0 = e.clientY;
    const timer = window.setTimeout(() => {
      this.enterModuleEdit();
    }, 450);
    this.adLongPressTimer = timer;
    const move = (ev: PointerEvent): void => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 10) {
        window.clearTimeout(timer);
        window.removeEventListener("pointermove", move);
      }
    };
    const up = (): void => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private enterModuleEdit(): void {
    const wasEdit = this.adEditMode;
    this.adEditMode = true;
    this.modulesGridEl?.classList.add("astra-mod-edit");
    this.showModuleEditBar();
    this.injectModuleResizeButtons();
    if (wasEdit) return; // 已编辑态（重渲染后补挂）只重挂手柄，不重复挂点击守卫
    // 编辑态下拦截卡片内容的点击，避免误触发模块自身的点击行为
    this.adClickGuard = (e: Event): void => {
      const t = e.target as HTMLElement;
      if (t.closest(".astra-card__resize")) return;
      if (t.closest(".astra-addmenu-backdrop")) return; // 放行添加卡片菜单，避免误拦截卡项点击
      e.stopPropagation();
      e.preventDefault();
    };
    this.modulesGridEl?.addEventListener("click", this.adClickGuard, true);
  }

  private exitModuleEdit(): void {
    if (!this.adEditMode) return;
    this.adEditMode = false;
    this.modulesGridEl?.classList.remove("astra-mod-edit");
    this.modulesGridEl?.querySelectorAll(".astra-card__resize, .astra-card__ratio, .astra-ph").forEach((b) => b.remove());
    if (this.adClickGuard) {
      this.modulesGridEl?.removeEventListener("click", this.adClickGuard, true);
      this.adClickGuard = null;
    }
    this.hideModuleEditBar();
  }

  private showModuleEditBar(): void {
    if (this.adEditBar || !this.modulesGridEl) return;
    const bar = this.contentEl.createDiv({ cls: "astra-mod-editbar" });
    this.modulesGridEl.after(bar);
    const trash = bar.createEl("button", { cls: "astra-mod-editbar__trash", text: $t("auto.216") });
    trash.setAttribute("aria-label", "把卡片拖到这里删除（仅从首页隐藏，数据保留）");
    bar.createDiv({ cls: "astra-mod-editbar__spacer" });
    const add = bar.createEl("button", { cls: "astra-mod-editbar__add", text: $t("auto.217") });
    add.addEventListener("click", () => this.openModuleAddMenu());
    const done = bar.createEl("button", { cls: "mod-cta", text: $t("auto.218") });
    done.addEventListener("click", () => this.exitModuleEdit());
    this.adEditBar = bar;
  }

  private hideModuleEditBar(): void {
    this.adEditBar?.remove();
    this.adEditBar = null;
  }

  /** 编辑态：给每张卡片追加「⤢ 拖拽调宽」手柄（重复调用安全：先清后加） */
  private injectModuleResizeButtons(): void {
    const grid = this.modulesGridEl;
    if (!grid) return;
    grid.querySelectorAll(".astra-card__resize").forEach((b) => b.remove());
    grid.querySelectorAll(".astra-surface").forEach((card) => {
      const c = card as HTMLElement;
      const modId = c.getAttribute("data-mod") ?? "";
      if (!modId) return;
      const btn = c.createDiv({ cls: "astra-card__resize", text: "⤢" });
      btn.setAttribute("aria-label", "调整卡片比例（拖动缩放）");
      btn.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        this.beginModuleResize(c, modId, ev);
      });
    });
  }

  /** 从右下角手柄开始拖拽缩放：按指针绝对位置换算格数，所见即所得 */
  private beginModuleResize(card: HTMLElement, modId: string, e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const cfg = this.plugin.data.settings.moduleSizes?.[modId];
    const startCols = clampModSpan(cfg?.cols);
    const startRows = clampModSpan(cfg?.rows);
    this.adResize = { card, modId, startCols, startRows, x0: e.clientX, y0: e.clientY, moved: false };
    card.classList.add("astra-card--resizing");
    const move = (ev: PointerEvent): void => this.onModuleResizeMove(ev);
    const up = (ev: PointerEvent): void => {
      this.onModuleResizeEnd(ev);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  private onModuleResizeMove(ev: PointerEvent): void {
    const st = this.adResize;
    if (!st) return;
    if (!st.moved && Math.hypot(ev.clientX - st.x0, ev.clientY - st.y0) < 4) return; // 4px 死区
    st.moved = true;
    const { unit, gap, colCount } = this.moduleGridUnit();
    const r = st.card.getBoundingClientRect();
    // 卡片左上角是锚点：指针到锚点的距离 ÷ 单元格尺寸 = 目标格数
    const wantCols = Math.round((ev.clientX - r.left + gap) / (unit + gap));
    const wantRows = Math.round((ev.clientY - r.top + gap) / (unit + gap));
    const rawCols = Math.max(1, Math.min(colCount, wantCols));
    const rawRows = Math.max(1, Math.min(MOD_MAX_SPAN, wantRows));
    const { cols, rows } = this.resolveModSpan(st.modId, rawCols, rawRows);
    st.card.style.setProperty("--cols", String(cols));
    st.card.style.setProperty("--rows", String(rows));
    this.showModuleResizeBadge(st.card, cols, rows);
    this.setModuleResizeLimit(st.card, wantCols !== cols || wantRows !== rows);
  }

  /** 缩放触达限制的视觉反馈：边框转红（状态翻转时才切类，避免动画每帧重启） */
  private setModuleResizeLimit(card: HTMLElement, limited: boolean): void {
    const on = card.classList.contains("is-limit");
    if (limited === on) return;
    card.classList.toggle("is-limit", limited);
  }

  private onModuleResizeEnd(_ev: PointerEvent): void {
    const st = this.adResize;
    if (!st) return;
    this.adResize = null;
    st.card.classList.remove("astra-card--resizing");
    st.card.classList.remove("is-limit");
    st.card.querySelector(".astra-card__ratio")?.remove();
    if (!st.moved) return; // 几乎没拖动：视为误触，不改
    const cols = clampModSpan(st.card.style.getPropertyValue("--cols"));
    const rows = clampModSpan(st.card.style.getPropertyValue("--rows"));
    if (!this.plugin.data.settings.moduleSizes) this.plugin.data.settings.moduleSizes = {};
    this.plugin.data.settings.moduleSizes[st.modId] = { cols, rows };
    void this.plugin.saveSettings();
  }

  /** 缩放过程中在卡片中央显示当前比例，如「2 × 1」 */
  private showModuleResizeBadge(card: HTMLElement, cols: number, rows: number): void {
    let badge = card.querySelector(".astra-card__ratio");
    if (!badge) badge = card.createDiv({ cls: "astra-card__ratio" });
    badge.setText(`${cols} × ${rows}`);
  }

  /* ---- 主页模块：渲染注册表 + 增删/重排 ---- */

  /** 全部可用的主页模块模板（渲染 + 「添加卡片」菜单共用） */
  private getModuleTemplates(): ModuleTemplate[] {
    return [
      { id: "qc", title: $t("dv.quickCapture.title"), subtitle: $t("auto.219"), cls: "astra-qc-surface", build: (s) => this.renderQuickCapture(s) },
      { id: "todo", title: "TODO", subtitle: "", cls: "astra-todo-surface", build: (s) => void this.renderTodo(s) },
      { id: "weekly", title: $t("auto.220"), subtitle: "", cls: "astra-weekly-surface", build: (s) => void this.renderWeekly(s) },
      { id: "projects", title: $t("auto.221"), subtitle: "", cls: "astra-projects-surface", build: (s) => void this.renderProjects(s) },
      { id: "countdown", title: $t("auto.222"), subtitle: "Days Left", cls: "astra-countdown-surface", build: (s) => this.renderCountdown(s) },
      { id: "dailyPhrase", title: $t("auto.223"), subtitle: "Daily Phrase", cls: "astra-daily-phrase-surface", build: (s) => void this.renderDailyPhrase(s) }
    ];
  }

  /** 当前可见模块 id（按 homeModuleOrder 保序，自动滤掉已隐藏/未知 id；移动端额外滤掉 mobileHiddenModules） */
  private visibleModuleIds(): string[] {
    const order = this.plugin.data.settings.homeModuleOrder ?? [];
    const known = new Set(this.getModuleTemplates().map((t) => t.id));
    const hidden = Platform.isMobile
      ? new Set(this.plugin.data.settings.mobileHiddenModules ?? [])
      : new Set<string>();
    return order.filter((id) => known.has(id) && !hidden.has(id));
  }

  /** 在容器内重建模块网格（每次重建都重跑列数/交互；进入编辑态则重挂手柄，保证「添加/删除」后不丢编辑态） */
  private buildModuleCards(root: HTMLElement): void {
    root.empty();
    const grid = root.createDiv("astra-dashboard-grid astra-modules-grid");
    this.modulesGridEl = grid;
    const templates = new Map(this.getModuleTemplates().map((t) => [t.id, t]));
    const ids = this.visibleModuleIds();
    if (ids.length === 0) {
      grid.createDiv({ cls: "astra-modules-empty", text: $t("auto.224") });
    }
    for (const id of ids) {
      const t = templates.get(id);
      if (!t) continue;
      const surface = this.createModuleCard(grid, t.title, t.subtitle, t.id);
      surface.addClass(t.cls);
      const r = t.build(surface);
      if (r && typeof (r).then === "function") void r;
    }
    this.initModulesCols(grid);
    this.wireModuleInteractions(grid);
    // 最近笔记作为常驻卡合并进网格末尾（随列数 4×1 ↔ 1×1），增删/重排重建网格时一并重建
    this.buildRecentCard(grid);
  }

  /** 在模块网格末尾追加「最近笔记」常驻卡（无 data-mod，不参与顺序持久化/编辑调宽/垃圾桶删除）。
   宽度 = 最后一行剩余列数（前面已占 1×1 → 补 3×1/2×1/1×1）。 */
  private buildRecentCard(grid: HTMLElement): void {
    // 移动端如果设置中隐藏了最近笔记，则跳过
    if (Platform.isMobile && this.plugin.data.settings.mobileHiddenModules?.includes("recent")) {
      return;
    }
    const snap = this.lastSnapshot;
    const surface = this.createSurface(
      grid,
      $t("dv.recent.title"),
      snap ? `${$t("dv.recent.modifiedToday", { n: snap.modifiedToday })}` : ""
    );
    surface.addClass("astra-recent-surface");

    // 精确计算最近笔记应占的列数：累加前面模块的 --cols，取模得到最后一行已用列数，剩余列数即为最近笔记跨度
    const colCount = this.currentModColCount();
    let occupied = 0;
    grid.querySelectorAll(":scope > .astra-surface:not(.astra-recent-surface)").forEach((el) => {
      const cols = parseInt((el as HTMLElement).style.getPropertyValue("--cols") || "1", 10);
      occupied += Math.max(1, Math.min(colCount, cols));
    });
    const remainder = occupied % colCount;
    const span = remainder === 0 ? colCount : colCount - remainder;
    surface.setCssProps({ "--recent-span": String(span), "--rows": "1" });

    if (snap) this.renderRecentNotes(surface, snap);
  }

  /** 原地重建网格（增删/重排后调用；保留/退出编辑态由调用方控制） */
  private rebuildModuleGrid(): void {
    const wrap = this.modulesWrapEl;
    if (!wrap) return;
    const wasEdit = this.adEditMode;
    this.exitModuleEdit();
    this.buildModuleCards(wrap);
    if (wasEdit) this.enterModuleEdit();
  }

  /** 移除模块（仅从显示列表移除，不影响数据）：删除 DOM 卡并持久化顺序 */
  private removeModuleCard(id: string): void {
    const order = this.plugin.data.settings.homeModuleOrder;
    const idx = order.indexOf(id);
    if (idx >= 0) {
      order.splice(idx, 1);
      void this.plugin.saveSettings();
    }
    this.modulesGridEl?.querySelector(`[data-mod="${id}"]`)?.remove();
  }

  /** 把当前 DOM 中卡片顺序写回 homeModuleOrder 并持久化（拖拽排序落点后调用） */
  private syncModuleOrderFromDom(): void {
    const grid = this.modulesGridEl;
    if (!grid) return;
    const domain = new Set(this.visibleModuleIds());
    const order: string[] = [];
    grid.querySelectorAll(".astra-surface").forEach((el) => {
      const id = el.getAttribute("data-mod");
      if (id && domain.has(id)) order.push(id);
    });
    if (order.length === 0) return; // 防御：读不到 data-mod 时绝不写入空顺序
    this.plugin.data.settings.homeModuleOrder = order;
    // 仅持久化顺序，不整页刷新，避免编辑态丢失（见 plugin.saveLayoutSilently）
    void this.plugin.saveLayoutSilently();
  }

  /** 重新启用被隐藏的模块并追加到末尾，随后保持编辑态重建 */
  private addModuleCard(id: string): void {
    const order = this.plugin.data.settings.homeModuleOrder;
    if (!order.includes(id)) order.push(id);
    void this.plugin.saveSettings();
    this.rebuildModuleGrid(); // 保持编辑态，便于继续排序/调比例
  }

  /* ---- 主页模块：拖拽重排 + 拖入垃圾桶删除（对齐 obsidian-dashboard-main） ---- */

  private beginModuleDrag(card: HTMLElement, clientX: number, clientY: number): void {
    if (this.moduleDrag) return;
    const board = this.modulesGridEl;
    if (!board) return;
    const rect = card.getBoundingClientRect();
    const cols = card.style.getPropertyValue("--cols") || "1";
    const rows = card.style.getPropertyValue("--rows") || "1";
    // 占位符：保留当前卡片在网格中的尺寸与槽位，其余卡片据此让位
    const ph = createDiv();
    ph.className = "astra-ph";
    ph.style.setProperty("--cols", cols);
    ph.style.setProperty("--rows", rows);
    ph.style.gridColumn = `span ${cols}`;
    ph.style.gridRow = `span ${rows}`;
    board.insertBefore(ph, card);

    // 提起：用 absolute 相对 grid 定位。不搬移 DOM（保留 Obsidian 渲染上下文/markdown 样式）。
    // 全程用「grid 相对坐标」(rect里 gridRect) 计算，避免 viewport clientX 与 fixed 基准不一致而错位。
    const gridRect = board.getBoundingClientRect();
    const prevGridPos = board.style.position || "";
    board.setCssProps({ position: "relative" }); // 确保 absolute 以 grid 为定位基准
    card.classList.add("astra-card--dragging"); // 提供 position:absolute / z-index / pointer-events
    // 同类名 `.astra-card--dragging` 的特异性(0,1,0)低于 `.astra-modules-grid .astra-surface`(0,2,0)，
    // 后者会把 position 留在 relative，导致卡片作为网格项被 placeholder 挤下一行，再叠加 inline top 偏移 → 向下错位一个模块。
    // 内联样式优先级最高，强制脱流为 absolute。
    card.setCssProps({ position: "absolute" });
    card.style.width = rect.width + "px";
    card.style.height = rect.height + "px";
    card.style.left = rect.left - gridRect.left + "px";
    card.style.top = rect.top - gridRect.top + "px";

    this.moduleDrag = {
      card,
      placeholder: ph,
      grid: board,
      prevGridPos,
      offsetX: clientX - rect.left,
      offsetY: clientY - rect.top,
      baseLeft: rect.left - gridRect.left,
      baseTop: rect.top - gridRect.top,
      startX: clientX,
      startY: clientY,
      lastX: clientX,
      lastY: clientY,
      overTrash: false,
      moved: false,
      raf: null
    };

    const move = (ev: PointerEvent): void => this.onModuleDragMove(ev);
    const up = (ev: PointerEvent): void => {
      this.onModuleDragEnd(ev);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  /** 指针是否落在编辑条的「删除区」上（矩形命中，外扩热区更易命中） */
  private isOverModuleTrash(x: number, y: number): boolean {
    const trash = this.adEditBar?.querySelector(".astra-mod-editbar__trash") as HTMLElement | null;
    if (!trash) return false;
    const r = trash.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const PAD = 28;
    return x >= r.left - PAD && x <= r.right + PAD && y >= r.top - PAD && y <= r.bottom + PAD;
  }

  private onModuleDragMove(ev: PointerEvent): void {
    const ds = this.moduleDrag;
    if (!ds) return;
    ds.moved = true;
    ds.lastX = ev.clientX;
    ds.lastY = ev.clientY;
    // 增量式定位：起手记录 baseLeft/baseTop（卡在 grid 内的基准）与 startX/startY，
    // 此后只按指针增量移动，不再每帧重算 gridRect——避免 placeholder 插入后的
    // grid 重排/FLIP 让基准跳动（10px+ 偏移根因）
    ds.card.style.left = ds.baseLeft + (ev.clientX - ds.startX) + "px";
    ds.card.style.top = ds.baseTop + (ev.clientY - ds.startY) + "px";

    // 悬停垃圾桶：高亮并暂停重排，避免边删边抖
    const overTrash = this.isOverModuleTrash(ev.clientX, ev.clientY);
    ds.overTrash = overTrash;
    this.adEditBar?.querySelector(".astra-mod-editbar__trash")?.classList.toggle("is-over", overTrash);
    ds.card.classList.toggle("astra-card--doomed", overTrash);
    if (overTrash) return;

    // 每帧最多重排一次（pointermove 频率远比刷新率高，不节流会白跑多次布局计算）
    if (ds.raf !== null) return;
    ds.raf = window.requestAnimationFrame(() => {
      ds.raf = null;
      if (this.moduleDrag === ds) this.reflowModuleDuringDrag(ds);
    });
  }

  /** 手机桌面图标式重排：把占位符插到「指针在阅读顺序上刚好领先」的那张卡之前，其余卡片 FLIP 平滑挤开 */
  private reflowModuleDuringDrag(ds: ModuleDragState): void {
    const board = this.modulesGridEl;
    if (!board) return;
    const x = ds.lastX;
    const y = ds.lastY;
    const cards = Array.from(
      board.querySelectorAll<HTMLElement>(".astra-surface:not(.astra-card--dragging)")
    );

    let ref: HTMLElement | null = null;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (y < r.top) { ref = c; break; } // 指针在该卡上方
      if (y > r.bottom) continue; // 指针在该卡下方
      if (x < r.left + r.width / 2) { ref = c; break; } // 同一行且在左半边
    }

    // 位置没变就不要动 DOM，否则每帧都会打断 FLIP 过渡
    if (ds.placeholder.nextElementSibling === ref) return;
    if (!ref && ds.placeholder === board.lastElementChild) return;

    const before = this.captureModuleCardRects(board);
    board.insertBefore(ds.placeholder, ref);
    this.playModuleFlip(before);
  }

  /** FLIP 第一步：记录移动前所有卡片的位置 */
  private captureModuleCardRects(board: HTMLElement): Map<HTMLElement, DOMRect> {
    const map = new Map<HTMLElement, DOMRect>();
    board.querySelectorAll(".astra-surface:not(.astra-card--dragging)").forEach((el) => {
      map.set(el as HTMLElement, el.getBoundingClientRect());
    });
    return map;
  }

  /** FLIP 第二步：位移卡片先「拉回」旧位置，再动画归零 → 视觉上被挤开 */
  private playModuleFlip(before: Map<HTMLElement, DOMRect>): void {
    before.forEach((r0, el) => {
      if (!el.isConnected) return;
      const r1 = el.getBoundingClientRect();
      const dx = r0.left - r1.left;
      const dy = r0.top - r1.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.setCssProps({ transition: "none", transform: `translate(${dx}px, ${dy}px)` });
      void el.offsetWidth; // 强制回流，让上面的「倒带」立即生效
      el.setCssProps({ transition: "transform 220ms cubic-bezier(0.2, 0, 0, 1)", transform: "" });
      window.setTimeout(() => {
        el.style.removeProperty("transition");
        el.style.removeProperty("transform");
      }, 240);
    });
  }

  private onModuleDragEnd(_ev: PointerEvent): void {
    const ds = this.moduleDrag;
    if (!ds) return;
    this.moduleDrag = null;
    if (ds.raf !== null) window.cancelAnimationFrame(ds.raf);
    const card = ds.card;
    const id = card.getAttribute("data-mod") || "";
    // 还原卡片样式，使其回到网格流
    card.classList.remove("astra-card--dragging");
    card.classList.remove("astra-card--doomed");
    card.style.removeProperty("position");
    card.style.removeProperty("left");
    card.style.removeProperty("top");
    card.style.removeProperty("width");
    card.style.removeProperty("height");
    card.style.removeProperty("z-index");
    card.style.removeProperty("pointer-events");
    // 恢复 grid 的 position（拖拽时临时设为 relative）
    ds.grid.style.position = ds.prevGridPos;
    this.adEditBar?.querySelector(".astra-mod-editbar__trash")?.classList.remove("is-over");

    // 落点复检垃圾桶（最后一次 move 可能未触发，漏判会导致「拖过去了却没删」）
    const overTrash = ds.overTrash || this.isOverModuleTrash(ds.lastX, ds.lastY);
    if (overTrash && id) {
      ds.placeholder.remove();
      this.removeModuleCard(id);
      return;
    }
    ds.placeholder.parentNode?.insertBefore(card, ds.placeholder);
    ds.placeholder.remove();
    this.syncModuleOrderFromDom();
  }

  /* ---- 编辑条：垃圾桶 / 添加卡片 / 完成 ---- */

  private openModuleAddMenu(): void {
    const grid = this.modulesGridEl;
    if (!grid) return;
    // 以 homeModuleOrder 判定已显示（而非 visibleModuleIds），避免移动端隐藏的模块误出现在添加菜单
    const visible = new Set(this.plugin.data.settings.homeModuleOrder ?? []);
    const disabled = this.getModuleTemplates().filter((t) => !visible.has(t.id));
    const backdrop = grid.createDiv({ cls: "astra-addmenu-backdrop" });
    const menu = backdrop.createDiv({ cls: "astra-addmenu" });
    menu.createDiv({ cls: "astra-addmenu__title", text: $t("auto.225") });
    if (disabled.length === 0) {
      menu.createDiv({ cls: "astra-addmenu__empty", text: $t("auto.226") });
    }
    for (const t of disabled) {
      const item = menu.createDiv({ cls: "astra-addmenu__item" });
      item.createSpan({ text: t.title });
      // 使用 pointerup 替代 click，避免 Obsidian 事件拦截导致 click 不触发
      item.addEventListener("pointerup", () => {
        backdrop.remove();
        this.addModuleCard(t.id);
      });
    }
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) backdrop.remove();
    });
  }

  private createSurface(
    parent: HTMLElement,
    title: string,
    subtitle: string
  ): HTMLElement {
    const surface = parent.createDiv("astra-surface");
    const header = surface.createDiv("astra-surface-header");
    header.createEl("h2", { text: title });
    header.createSpan({ text: subtitle });
    return surface;
  }

  private createIconButton(
    parent: HTMLElement,
    iconName: string,
    label: string
  ): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: "astra-icon-btn clickable-icon",
      attr: { type: "button", "aria-label": label }
    });
    setIcon(button, iconName);
    return button;
  }

  private openDetails(
    title: string,
    description: string,
    items: DetailItem[],
    showSearch = true
  ): void {
    new DetailModal(this.app, title, description, items, showSearch).open();
  }

  private listen<K extends keyof HTMLElementEventMap>(
    element: HTMLElement,
    eventName: K,
    handler: (event: HTMLElementEventMap[K]) => void
  ): void {
    element.addEventListener(eventName, handler);
    this.renderDisposers.push(() =>
      element.removeEventListener(eventName, handler)
    );
  }

  private clearRenderResources(): void {
    this.renderDisposers.forEach((dispose) => dispose());
    this.renderDisposers = [];
    // 清理模块编辑/拖拽状态（render 会整体重建页面）
    this.exitModuleEdit();
    this.adResize = null;
    this.moduleDrag = null;
    this.modulesGridEl = null;
    this.modulesWrapEl = null;
    if (this.adLongPressTimer !== null) {
      window.clearTimeout(this.adLongPressTimer);
      this.adLongPressTimer = null;
    }
    this.heatmapObs?.disconnect();
    this.heatmapObs = null;
    this.heatmapObsTarget = null;
    this.heatmapCard = null;
    this.hmSubtitleEl = null;
  }
}

function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 6) return $t("greet.lateNight");
  if (hour < 11) return $t("greet.morning");
  if (hour < 14) return $t("greet.noon");
  if (hour < 18) return $t("greet.afternoon");
  return $t("greet.evening");
}

function relativeTime(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 60_000) return $t("time.justNow");
  if (diff < 3_600_000) return $t("time.minutesAgo", { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return $t("time.hoursAgo", { n: Math.floor(diff / 3_600_000) });
  if (diff < 604_800_000) return $t("time.daysAgo", { n: Math.floor(diff / 86_400_000) });
  return new Intl.DateTimeFormat(getLocaleCode(), {
    month: "numeric",
    day: "numeric"
  }).format(timestamp);
}
