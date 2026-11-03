import { describe, expect, it } from "vitest";
import { pruneActivityRecords } from "./stats-service";
import type { ActivityEntry } from "./models";

function makeEntry(addedWords = 0, edits = 0, paths: string[] = []): ActivityEntry {
  return { addedWords, edits, paths };
}

describe("pruneActivityRecords", () => {
  // 固定 now = 2026-07-31（周五），用 retentionDays = 10 方便断言
  const NOW = new Date(2026, 6, 31);

  it("超窗口的旧日期被删", () => {
    const activity: Record<string, ActivityEntry> = {
      "2026-07-10": makeEntry(100, 2, ["a.md"]),
      "2026-07-15": makeEntry(50, 1, ["b.md"]),
      "2026-07-25": makeEntry(80, 3, ["c.md"])
    };
    const changed = pruneActivityRecords(activity, 10, NOW);
    expect(changed).toBe(true);
    // retentionDays=10，窗口 = 2026-07-22 ~ 2026-07-31
    // oldestRetained = "2026-07-22"
    // "2026-07-10" < "2026-07-22" → 删
    // "2026-07-15" < "2026-07-22" → 删
    // "2026-07-25" >= "2026-07-22" → 留
    expect(activity).toEqual({
      "2026-07-25": makeEntry(80, 3, ["c.md"])
    });
    expect(activity["2026-07-10"]).toBeUndefined();
    expect(activity["2026-07-15"]).toBeUndefined();
  });

  it("窗口内的日期保留，窗口边界保留", () => {
    const oldest = "2026-07-22"; // retentionDays=10, oldestRetained
    const activity: Record<string, ActivityEntry> = {
      [oldest]: makeEntry(10, 1, ["edge.md"]),
      "2026-07-26": makeEntry(20, 2, ["mid.md"]),
      "2026-07-31": makeEntry(30, 3, ["today.md"])
    };
    const changed = pruneActivityRecords(activity, 10, NOW);
    expect(changed).toBe(false); // 没有旧条目、没有重复 paths
    expect(Object.keys(activity).sort()).toEqual([oldest, "2026-07-26", "2026-07-31"].sort());
  });

  it("paths 重复项被收敛，保持首次出现顺序", () => {
    const activity: Record<string, ActivityEntry> = {
      "2026-07-30": {
        addedWords: 100,
        edits: 5,
        paths: ["a.md", "b.md", "a.md", "c.md", "b.md", "a.md"]
      }
    };
    const changed = pruneActivityRecords(activity, 10, NOW);
    expect(changed).toBe(true);
    expect(activity["2026-07-30"]!.paths).toEqual(["a.md", "b.md", "c.md"]);
    // 其他字段不变
    expect(activity["2026-07-30"]!.addedWords).toBe(100);
    expect(activity["2026-07-30"]!.edits).toBe(5);
  });

  it("窗口内无重复 paths → changed=false", () => {
    const activity: Record<string, ActivityEntry> = {
      "2026-07-25": makeEntry(10, 1, ["x.md"]),
      "2026-07-30": makeEntry(20, 2, ["y.md"])
    };
    const changed = pruneActivityRecords(activity, 10, NOW);
    expect(changed).toBe(false);
    expect(Object.keys(activity).length).toBe(2);
  });

  it("空 activity 不报错", () => {
    const activity: Record<string, ActivityEntry> = {};
    const changed = pruneActivityRecords(activity, 10, NOW);
    expect(changed).toBe(false);
    expect(activity).toEqual({});
  });

  it("裁剪旧条目 + 收敛 paths 同时发生 → changed=true 且两边都生效", () => {
    const activity: Record<string, ActivityEntry> = {
      "2026-07-01": makeEntry(50, 1, ["old.md"]), // 旧条目，应被删
      "2026-07-25": {
        addedWords: 80,
        edits: 4,
        paths: ["c.md", "c.md", "d.md", "c.md"] // 重复项，应收敛
      }
    };
    const changed = pruneActivityRecords(activity, 10, NOW);
    expect(changed).toBe(true);
    expect(activity["2026-07-01"]).toBeUndefined();
    expect(activity["2026-07-25"]!.paths).toEqual(["c.md", "d.md"]);
  });
});
