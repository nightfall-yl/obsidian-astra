/**
 * Minimal replacements for upstream's `p-queue` and `aggregate-error`
 * which used both in src/sync.ts). Only the API surface actually used by the
 * sync engine is implemented: bounded concurrency, pause/clear, onIdle.
 */

export class TaskQueue {
  private readonly concurrency: number;
  private pending: (() => void)[] = [];
  private runningCount = 0;
  private paused = false;
  private idleWaiters: (() => void)[] = [];

  constructor(concurrency: number) {
    this.concurrency = Math.max(1, concurrency);
  }

  add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.runningCount += 1;
        void fn()
          .then(resolve, reject)
          .finally(() => {
            this.runningCount -= 1;
            this.dequeue();
            this.notifyIdleIfIdle();
          });
      };
      if (!this.paused && this.runningCount < this.concurrency) {
        run();
      } else {
        this.pending.push(run);
      }
    });
  }

  private dequeue(): void {
    while (!this.paused && this.runningCount < this.concurrency) {
      const task = this.pending.shift();
      if (task === undefined) {
        return;
      }
      task();
    }
  }

  private notifyIdleIfIdle(): void {
    if (this.runningCount === 0 && this.pending.length === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const waiter of waiters) {
        waiter();
      }
    }
  }

  pause(): void {
    this.paused = true;
  }

  clear(): void {
    this.pending = [];
    this.notifyIdleIfIdle();
  }

  onIdle(): Promise<void> {
    if (this.runningCount === 0 && this.pending.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }
}

/**
 * Replaces `aggregate-error`: collects the individual errors of a failed sync
 * run so callers can display each item separately.
 */
export class MultiError extends Error {
  readonly errors: Error[];

  constructor(errors: Error[]) {
    super(errors.map((e) => e.message).join("\n"));
    this.name = "MultiError";
    this.errors = errors;
  }
}
