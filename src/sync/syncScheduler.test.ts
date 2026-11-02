import { describe, it, expect } from "vitest";
import {
  computeScheduledRunTime,
  SyncAutoScheduler,
  AUTO_MIN_INTERVAL_MS,
  ON_SAVE_DEBOUNCE_MS,
  STARTUP_FIRST_DELAY_MS,
} from "./syncScheduler";

// ─────────────────────── 纯函数 ───────────────────────

describe("computeScheduledRunTime 纯函数", () => {
  it("从未自动同步过 → 按请求时间执行，不被 minInterval 推远", () => {
    expect(computeScheduledRunTime(1000, -1, 30_000)).toBe(1000);
    expect(computeScheduledRunTime(5000, 0, 30_000)).toBe(5000);
  });

  it("距上次自动同步已满 minInterval → 按请求时间执行", () => {
    expect(computeScheduledRunTime(40_000, 10_000, 30_000)).toBe(40_000);
    expect(computeScheduledRunTime(50_000, 10_000, 30_000)).toBe(50_000);
  });

  it("距上次自动同步不足 minInterval → 推到 lastRun + minInterval", () => {
    expect(computeScheduledRunTime(15_000, 10_000, 30_000)).toBe(40_000);
    expect(computeScheduledRunTime(0, 10_000, 30_000)).toBe(40_000);
  });

  it("等于 minInterval 边界 → 按请求时间", () => {
    expect(computeScheduledRunTime(40_000, 10_000, 30_000)).toBe(40_000);
  });

  it("自定义 minInterval", () => {
    expect(computeScheduledRunTime(15_000, 10_000, 5_000)).toBe(15_000);
    expect(computeScheduledRunTime(14_999, 10_000, 5_000)).toBe(15_000);
  });
});

// ─────────────────────── Fake Timer ───────────────────────

function makeFakeTimer() {
  let now = 0;
  let idCounter = 0;
  type Entry = { cb: () => void; at: number };
  const timers = new Map<number, Entry>();

  const setTimeout = (cb: () => void, delay: number) => {
    const id = ++idCounter;
    timers.set(id, { cb, at: now + delay });
    return id;
  };
  const clearTimeout = (id: number) => timers.delete(id);
  const setInterval = (cb: () => void, period: number) => {
    // 简化：interval 第一次在 now+period 跑，后续按 period 递增
    const id = ++idCounter;
    const scheduleNext = () => {
      if (!timers.has(id)) return; // 已 clear
      timers.set(id, { cb: () => { cb(); scheduleNext(); }, at: now + period });
    };
    scheduleNext();
    return id;
  };
  const clearInterval = (id: number) => timers.delete(id);
  const getNow = () => now;

  const advanceTo = (target: number) => {
    const sorted = Array.from(timers.entries()).sort((a, b) => a[1].at - b[1].at);
    for (const [id, entry] of sorted) {
      if (entry.at <= target) {
        timers.delete(id);
        now = entry.at;
        entry.cb();
      }
    }
    now = target;
  };

  return { setTimeout, clearTimeout, setInterval, clearInterval, getNow, advanceTo };
}

function makeScheduler(
  runAutoSync: (source: "auto" | "autoOnceInit") => Promise<void>,
  timer: ReturnType<typeof makeFakeTimer>,
  overrides?: {
    onSaveDebounceMs?: number;
    autoMinIntervalMs?: number;
    startupFirstDelayMs?: number;
  }
) {
  return new SyncAutoScheduler(
    runAutoSync,
    timer.getNow,
    overrides?.onSaveDebounceMs ?? ON_SAVE_DEBOUNCE_MS,
    overrides?.autoMinIntervalMs ?? AUTO_MIN_INTERVAL_MS,
    overrides?.startupFirstDelayMs ?? STARTUP_FIRST_DELAY_MS,
    timer
  );
}

// ─────────────────────── SyncAutoScheduler ───────────────────────

describe("SyncAutoScheduler", () => {
  it("start(period) 后 STARTUP_FIRST_DELAY（5s）跑首次 autoOnceInit", () => {
    const timer = makeFakeTimer();
    const runs: string[] = [];
    const scheduler = makeScheduler(
      async (source) => { runs.push(source); scheduler.markRunFinished(); },
      timer
    );
    scheduler.start(60_000);

    timer.advanceTo(4_999);
    expect(runs).toEqual([]);
    timer.advanceTo(5_000);
    expect(runs).toEqual(["autoOnceInit"]);
  });

  it("minInterval：紧接首次后再触发 → 被推到 +30s", () => {
    const timer = makeFakeTimer();
    const runs: string[] = [];
    const scheduler = makeScheduler(
      async () => { runs.push("run"); scheduler.markRunFinished(); },
      timer
    );
    scheduler.start(60_000);

    // 首次（STARTUP_FIRST_DELAY=5s）
    timer.advanceTo(5_000);
    expect(runs).toEqual(["run"]);

    // 500ms 后 onSaveModified（earliestAt=5500+5000=10500，被 minInterval 推到 5000+30000=35000）
    timer.advanceTo(5_500);
    scheduler.onSaveModified();
    timer.advanceTo(34_999);
    expect(runs.length).toBe(1);
    timer.advanceTo(35_000);
    expect(runs.length).toBe(2);
  });

  it("debounce（5s trailing）：短时间内多个 onSaveModified 只触发一次", () => {
    const timer = makeFakeTimer();
    const runs: string[] = [];
    const scheduler = makeScheduler(
      async () => { runs.push("run"); scheduler.markRunFinished(); },
      timer
    );
    // 不 start，直接测 debounce
    scheduler.onSaveModified(); // earliestAt=5000 (now=0, +5000)
    timer.advanceTo(2_500);
    scheduler.onSaveModified(); // earliestAt=7500 (now=2500, +5000)
    timer.advanceTo(5_000);
    scheduler.onSaveModified(); // earliestAt=10000 (now=5000, +5000)
    timer.advanceTo(9_999);
    expect(runs).toEqual([]);
    timer.advanceTo(10_000);
    expect(runs).toEqual(["run"]);
  });

  it("syncInProgress 期间完成后 markRunFinished 触发 reschedule", () => {
    const timer = makeFakeTimer();
    const runs: string[] = [];
    let resolveRun: (() => void) | null = null;
    const scheduler = makeScheduler(
      () =>
        new Promise<void>((resolve) => {
          runs.push("start");
          resolveRun = () => {
            runs.push("end");
            scheduler.markRunFinished();
            resolve();
          };
        }),
      timer
    );
    scheduler.start(60_000);

    timer.advanceTo(5_000);
    expect(runs).toEqual(["start"]);
    timer.advanceTo(5_500);
    scheduler.onSaveModified(); // earliestAt = 10500

    // finish at t=5500. minInterval 边界 = 5500 + 30000 = 35500
    resolveRun!();
    timer.advanceTo(35_499);
    expect(runs.filter((r) => r === "start").length).toBe(1);
    timer.advanceTo(35_500);
    expect(runs.filter((r) => r === "start").length).toBe(2);
  });

  it("stop 后清空所有定时器", () => {
    const timer = makeFakeTimer();
    const runs: string[] = [];
    const scheduler = makeScheduler(
      async () => { runs.push("run"); scheduler.markRunFinished(); },
      timer
    );
    scheduler.start(60_000);
    scheduler.stop();
    timer.advanceTo(100_000);
    expect(runs).toEqual([]);
  });

  it("不 start 的情况下 onSaveModified 仍生效（minInterval 从 -1 开始）", () => {
    const timer = makeFakeTimer();
    const runs: string[] = [];
    const scheduler = makeScheduler(
      async () => { runs.push("run"); scheduler.markRunFinished(); },
      timer
    );
    scheduler.onSaveModified();
    timer.advanceTo(5_000);
    expect(runs).toEqual(["run"]);
  });

  it("minInterval 边界精确：首次跑完立即 onSave → 30s 后执行", () => {
    const timer = makeFakeTimer();
    const runs: string[] = [];
    const scheduler = makeScheduler(
      async () => { runs.push("run"); scheduler.markRunFinished(); },
      timer
    );
    scheduler.onSaveModified(); // 这次在 t=5000 跑，finish 后 lastAutoSyncAt=5000
    timer.advanceTo(5_000);

    scheduler.onSaveModified(); // earliestAt=10000, minInterval 边界 = 5000+30000=35000
    timer.advanceTo(34_999);
    expect(runs.length).toBe(1);
    timer.advanceTo(35_000);
    expect(runs.length).toBe(2);
  });

  // ─────────────────── 两开关组合边界 ───────────────────

  it("start(-1) 不启动任何定时器（包括启动首次），但实例仍可用", () => {
    const timer = makeFakeTimer();
    const runs: string[] = [];
    const scheduler = makeScheduler(
      async () => { runs.push("run"); scheduler.markRunFinished(); },
      timer
    );
    scheduler.start(-1); // 周期关闭

    // 启动首次不应触发
    timer.advanceTo(STARTUP_FIRST_DELAY_MS + 100);
    expect(runs).toEqual([]);
    // 周期也不应触发（没有 setInterval）
    timer.advanceTo(100_000);
    expect(runs).toEqual([]);

    // 但 onSaveModified 仍正常工作（调度器本身不感知 syncOnSaveEnabled，
    // 这个分支由 sync-manager.ts 的 modify handler 决定）
    scheduler.onSaveModified();
    timer.advanceTo(105_000); // 100000 + ON_SAVE_DEBOUNCE_MS(5000)
    expect(runs).toEqual(["run"]);
  });

  it("周期关闭时（不 start），连续保存仍受 30s minInterval 约束——不连发", () => {
    const timer = makeFakeTimer();
    const runs: string[] = [];
    const scheduler = makeScheduler(
      async () => { runs.push("run"); scheduler.markRunFinished(); },
      timer
    );

    // 第一次保存 → 5s 后跑（lastAutoSyncAt=-1，不被 minInterval 推远）
    scheduler.onSaveModified();
    timer.advanceTo(5_000);
    expect(runs.length).toBe(1);

    // 紧接着第二次保存 → 被 minInterval 推到 35_000（lastAutoSyncAt=5000, 边界=5000+30000）
    scheduler.onSaveModified();
    timer.advanceTo(34_999);
    expect(runs.length).toBe(1);
    timer.advanceTo(35_000);
    expect(runs.length).toBe(2);

    // 再紧接着第三次 → 被推到 65_000（lastAutoSyncAt=35000, 边界=35000+30000）
    scheduler.onSaveModified();
    timer.advanceTo(64_999);
    expect(runs.length).toBe(2);
    timer.advanceTo(65_000);
    expect(runs.length).toBe(3);
  });
});
