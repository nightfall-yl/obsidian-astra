import { describe, expect, it } from "vitest";

import {
  composeStatusBarProgress,
  parseProgressMessage,
} from "./statusBarText";

describe("parseProgressMessage", () => {
  it("parses a fraction and rounds the percentage", () => {
    expect(parseProgressMessage("12/300")).toEqual({
      done: 12,
      total: 300,
      pct: 4,
    });
    expect(parseProgressMessage("1/3")?.pct).toBe(33);
    expect(parseProgressMessage("2/3")?.pct).toBe(67);
  });

  it("clamps the percentage to 100", () => {
    expect(parseProgressMessage("300/300")?.pct).toBe(100);
    expect(parseProgressMessage("301/300")?.pct).toBe(100);
  });

  it("rejects non-fractions and zero / negative totals", () => {
    expect(parseProgressMessage("")).toBeUndefined();
    expect(parseProgressMessage("abc")).toBeUndefined();
    expect(parseProgressMessage("1/2/3")).toBeUndefined();
    expect(parseProgressMessage("1/0")).toBeUndefined();
    expect(parseProgressMessage("1/-5")).toBeUndefined();
    expect(parseProgressMessage("a/b")).toBeUndefined();
  });
});

describe("composeStatusBarProgress", () => {
  it("uses the zh dot-separated suffix with exactly one space", () => {
    expect(composeStatusBarProgress("同步中", "12/300", " · 4%")).toBe(
      "同步中 12/300 · 4%"
    );
  });

  it("uses the en dot-separated suffix with exactly one space", () => {
    expect(composeStatusBarProgress("Syncing", "12/300", " · 4%")).toBe(
      "Syncing 12/300 · 4%"
    );
  });

  it("returns the step label alone when there is no message", () => {
    expect(composeStatusBarProgress("解析远端状态", undefined, " · 4%")).toBe(
      "解析远端状态"
    );
    expect(composeStatusBarProgress("解析远端状态", "", " · 4%")).toBe(
      "解析远端状态"
    );
  });

  it("appends a non-fraction message verbatim and drops the percentage", () => {
    expect(composeStatusBarProgress("同步中", "retrying", " · 4%")).toBe(
      "同步中 retrying"
    );
  });

  it("never emits double spaces or full-width parentheses", () => {
    const en = composeStatusBarProgress("Syncing", "1/2", " · 50%");
    expect(en).toBe("Syncing 1/2 · 50%");
    expect(en).not.toContain("（");
    expect(en.match(/ {2}/g)).toBeNull();

    const zh = composeStatusBarProgress("同步中", "1/2", " · 50%");
    expect(zh).toBe("同步中 1/2 · 50%");
    expect(zh).not.toContain("（");
    expect(zh.match(/ {2}/g)).toBeNull();
  });

  it("tolerates surrounding whitespace without doubling spaces", () => {
    expect(composeStatusBarProgress(" Syncing ", " 12/300 ", " · 4%")).toBe(
      "Syncing 12/300 · 4%"
    );
    expect(composeStatusBarProgress("Syncing", "12/300", "   · 4%")).toBe(
      "Syncing 12/300 · 4%"
    );
  });
});
