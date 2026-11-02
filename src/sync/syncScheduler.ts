/**
 * 统一自动同步调度器：合并「启动首次运行 / 定时周期 / 保存后触发」三个来源，
 * 用一个定时器 + 一个最小间隔约束来替代原先三个独立定时器。
 *
 * 设计要点：
 * - 任何自动同步之间至少间隔 AUTO_MIN_INTERVAL_MS（30s），防止反馈环与密集触发
 * - 保存后同步固定 ON_SAVE_DEBOUNCE_MS（5s） trailing debounce，不再可配置
 * - 自动同步开启后，STARTUP_FIRST_DELAY_MS（5s）后跑首次，之后按 autoRunEveryMilliseconds 周期
 * - 手动同步不受最小间隔约束；同步进行中所有自动请求被挂起
 * - 对外暴露纯函数，便于独立单测
 */

// ─────────────────────────── 常量 ───────────────────────────

/** 两次自动同步之间的最小间隔（毫秒）。手动同步不受此约束。 */
export const AUTO_MIN_INTERVAL_MS = 30_000;

/** 保存后 .md 修改 → 同步的固定 trailing debounce（毫秒）。 */
export const ON_SAVE_DEBOUNCE_MS = 5_000;

/** 自动同步开启后首次运行的延后（毫秒）。给 vault / metadataCache 就绪留时间。 */
export const STARTUP_FIRST_DELAY_MS = 5_000;

// ─────────────────────────── 类型 ───────────────────────────

/** 自动同步的触发来源（传给 syncRun 的 triggerSource 字符串） */
export type AutoSyncSource = "auto" | "autoOnceInit";

interface SyncRequest {
  /** 哪个来源（影响 syncRun 的 triggerSource 字符串） */
  source: AutoSyncSource;
  /** 最早可以执行的绝对时间戳；debounce 会不断把这个推远 */
  earliestAt: number;
}

// ─────────────────────────── 纯函数（可单测） ───────────────────────────

/**
 * 计算一次请求实际应当在什么时间执行——考虑最小间隔约束。
 *
 * 规则：
 * 1. 如果 lastAutoSyncAt = 0（从未自动同步过），且来源是 onStartup → 可以按 earliestAt 立即执行
 * 2. 否则必须 >= lastAutoSyncAt + AUTO_MIN_INTERVAL_MS
 * 3. 返回 Math.max(earliestAt, minIntervalBoundary)
 *
 * 这是纯粹函数，无副作用，便于直接单测。
 */
export function computeScheduledRunTime(
  requestEarliestAt: number,
  lastAutoSyncAt: number,
  autoMinIntervalMs: number = AUTO_MIN_INTERVAL_MS
): number {
  const minBoundary =
    lastAutoSyncAt <= 0 ? requestEarliestAt : lastAutoSyncAt + autoMinIntervalMs;
  return Math.max(requestEarliestAt, minBoundary);
}

// ─────────────────────────── 类（生产使用） ───────────────────────────

/**
 * 统一自动同步调度器。
 *
 * 使用方式（由 SyncManager 持有一个实例）：
 *   scheduler.start(periodMs)       // 开启：注册周期定时器 + 首次延后
 *   scheduler.onSaveModified()      // .md 保存：trailing debounce
 *   scheduler.markRunStarted()      // syncRun 开头标记
 *   scheduler.markRunFinished()     // syncRun 结尾标记
 *   scheduler.stop()                // unload / 关闭自动同步
 *
 * 每个 source（定时 / 启动 / 保存后）独立维护自己的 pending，
 * 但真正执行时统一走 computeScheduledRunTime 计算延迟。
 */
export class SyncAutoScheduler {
  /** 唯一挂起的 setTimeout（任何来源被截断会 clear 并重置） */
  private pendingTimer: number | null = null;
  /** 周期 setInterval（开启 autoRunEveryMilliseconds > 0 时注册） */
  private periodTimer: number | null = null;
  /** 自动同步执行过的最后时间戳；-1 = 从未 */
  private lastAutoSyncAt = -1;
  /** 当前挂起的自动请求（按 source 去重：每个 source 只保留 earliestAt 最晚的那个） */
  private pending = new Map<AutoSyncSource, SyncRequest>();
  /** 当前同步执行中：自动请求被挂起直到 finished；但 debounce 计时继续 */
  private syncInProgress = false;
  /** 最近一次 set "要执行的"请求时间（供 debounce 截断判断） */
  private scheduledRunAt = 0;

  constructor(
    /** 自动同步的执行函数；由 SyncManager 传入 */
    private readonly runAutoSync: (source: AutoSyncSource) => Promise<void>,
    /** 注入时间函数（生产用 Date.now，单测用 fake now） */
    private readonly getNow: () => number = () => Date.now(),
    private readonly onSaveDebounceMs: number = ON_SAVE_DEBOUNCE_MS,
    private readonly autoMinIntervalMs: number = AUTO_MIN_INTERVAL_MS,
    private readonly startupFirstDelayMs: number = STARTUP_FIRST_DELAY_MS,
    /** timer 实现（生产 window.setTimeout/clearTimeout/setInterval；单测注入 fake） */
    private readonly timer: {
      setTimeout: (cb: () => void, ms: number) => number;
      clearTimeout: (id: number) => void;
      setInterval?: (cb: () => void, ms: number) => number;
      clearInterval?: (id: number) => void;
    } = window
  ) {}

  /**
   * 开启自动同步：注册周期定时器，并在 STARTUP_FIRST_DELAY_MS 后跑首次。
   * 幂等——stop() 后可再 start()。
   */
  start(periodMs: number): void {
    this.stop(); // 幂等：先清旧的

    // 首次运行：按来源 "autoOnceInit" 挂起一个 STARTUP_FIRST_DELAY_MS 的请求
    if (periodMs > 0) {
      this.requestRun("autoOnceInit", this.startupFirstDelayMs);
    }

    // 周期运行：setInterval + 每次 requestRun("auto", 0)
    if (periodMs > 0 && this.timer.setInterval) {
      this.periodTimer = this.timer.setInterval(() => {
        this.requestRun("auto", 0);
      }, periodMs);
    }
  }

  /**
   * 停止所有自动调度——清空定时器、清空挂起请求。
   * unload 时或用户关闭自动同步时调用。
   */
  stop(): void {
    if (this.pendingTimer !== null) {
      this.timer.clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.periodTimer !== null && this.timer.clearInterval) {
      this.timer.clearInterval(this.periodTimer);
      this.periodTimer = null;
    }
    this.pending.clear();
    this.scheduledRunAt = 0;
  }

  /**
   * vault .md modify 事件：触发 trailing debounce 的保存后同步请求。
   * 这是 registerVaultEvents 里 modify handler 应调用的方法。
   */
  onSaveModified(): void {
    this.requestRun("auto", this.onSaveDebounceMs);
  }

  /**
   * 标记自动同步开始。会让挂起的自动请求等待到 run 结束后再继续调度。
   */
  markRunStarted(): void {
    this.syncInProgress = true;
  }

  /**
   * 标记自动同步结束。根据 lastAutoSyncAt 立即重新评估一次挂起请求是否该跑了。
   */
  markRunFinished(): void {
    this.syncInProgress = false;
    this.lastAutoSyncAt = this.getNow();
    // 重新评估挂起请求——minInterval 起点已推到刚刚，大部分会被顺延到 30s 后
    this.reschedule();
  }

  /** 距上次自动同步的剩余最小等待毫秒数（外部可读，供 StatusBar 等使用） */
  getMsUntilNextAuto(): number {
    if (this.pending.size === 0) return -1;
    if (this.syncInProgress) return this.autoMinIntervalMs; // 跑完再等
    const now = this.getNow();
    let earliest = Infinity;
    for (const req of this.pending.values()) {
      const scheduled = computeScheduledRunTime(
        req.earliestAt,
        this.lastAutoSyncAt,
        this.autoMinIntervalMs
      );
      if (scheduled < earliest) earliest = scheduled;
    }
    return Math.max(0, earliest - now);
  }

  // ─────────────────────────── 内部 ───────────────────────────

  /**
   * 按来源提交/截断一个请求。
   * debounce 截断语义：同一个 source 再次触发时，只把 earliestAt 推远（不会并行堆积）。
   */
  private requestRun(source: AutoSyncSource, debounceMs: number): void {
    const now = this.getNow();
    const earliestAt = now + debounceMs;

    // 同 source 的 pending 只保留最晚的 earliestAt（debounce 截断）
    const existing = this.pending.get(source);
    if (existing && existing.earliestAt >= earliestAt) {
      return; // 已有更晚的，忽略这次
    }
    this.pending.set(source, { source, earliestAt });

    // 用最早的 pending 来设定时器（每次都 clear + set，形成 trailing 效果）
    this.reschedule();
  }

  /**
   * 根据 pending + lastAutoSyncAt + syncInProgress 重新设 pendingTimer。
   * syncInProgress 时不设 timer（等 markRunFinished 再 reschedule）。
   */
  private reschedule(): void {
    if (this.pending.size === 0) return;
    if (this.syncInProgress) return; // 执行中，等 finished 再算

    const now = this.getNow();

    // 挑最早的 pending 作为当前要跑的（多 source 之间谁先到谁执行）
    let earliestReq: SyncRequest | null = null;
    let earliestAt = Infinity;
    for (const req of this.pending.values()) {
      if (req.earliestAt < earliestAt) {
        earliestAt = req.earliestAt;
        earliestReq = req;
      }
    }
    if (earliestReq === null) return;

    // 计算 minInterval 约束后的实际执行时间
    const scheduledRunAt = computeScheduledRunTime(
      earliestAt,
      this.lastAutoSyncAt,
      this.autoMinIntervalMs
    );
    const delay = scheduledRunAt - now;

    // 如果 scheduledRunAt 没变化（没有更早），不要重置 timer——否则会不断向后拖
    if (this.pendingTimer !== null && scheduledRunAt === this.scheduledRunAt && delay > 0) {
      return;
    }

    if (this.pendingTimer !== null) {
      this.timer.clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.scheduledRunAt = scheduledRunAt;

    // 如果 delay <= 0，立即执行（用 setTimeout 0 保持异步、避免栈内递归）
    this.pendingTimer = this.timer.setTimeout(() => {
      this.pendingTimer = null;
      this.executeOne();
    }, Math.max(0, delay));
  }

  /**
   * 执行最早的那个 pending 请求。执行后 reschedule 一次检查是否还有下一个。
   */
  private executeOne(): void {
    if (this.syncInProgress) return; // 刚好有人手动开跑了，这次让位
    if (this.pending.size === 0) return;

    const now = this.getNow();

    // 再挑最早的 pending——可能在 reschedule 之后又被 debounce 推远了
    let earliestReq: SyncRequest | null = null;
    let earliestAt = Infinity;
    for (const req of this.pending.values()) {
      if (req.earliestAt < earliestAt) {
        earliestAt = req.earliestAt;
        earliestReq = req;
      }
    }
    if (earliestReq === null) return;

    // 检查 minInterval 是否已过
    const scheduledRunAt = computeScheduledRunTime(
      earliestAt,
      this.lastAutoSyncAt,
      this.autoMinIntervalMs
    );
    if (scheduledRunAt > now) {
      // 还没到，重新设 timer
      this.scheduledRunAt = scheduledRunAt;
      this.pendingTimer = this.timer.setTimeout(
        () => {
          this.pendingTimer = null;
          this.executeOne();
        },
        scheduledRunAt - now
      );
      return;
    }

    // 可以执行——从 pending 中摘掉，标记执行中，调外部 runAutoSync
    this.pending.delete(earliestReq.source);
    this.markRunStarted();
    // 注意：runAutoSync 结束后 SyncManager 会调 markRunFinished()，那是最终的 lastAutoSyncAt 落点
    void this.runAutoSync(earliestReq.source).finally(() => {
      // 兜底：如果 SyncManager 那边没调 markRunFinished，这里补一下，避免 syncInProgress 卡死
      if (this.syncInProgress) this.markRunFinished();
      // 还有没有剩余 pending？
      if (this.pending.size > 0) {
        this.reschedule();
      }
    });
  }
}
