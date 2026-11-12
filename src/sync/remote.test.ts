/**
 * Unit tests for the "remote item is gone" classifier used by the 404
 * self-healing path. Only 404 / itemNotFound may be treated as deletion —
 * auth, throttling, server and network errors must keep counting as failures.
 */

import { describe, expect, it } from "vitest";

import { isRemoteItemNotFoundError } from "./remote";

const apiError = (status: number, code?: string): Error => {
  const err = new Error(`OneDrive API GET ... 失败 (HTTP ${status})`) as Error & {
    status?: number;
    code?: string;
  };
  err.status = status;
  if (code !== undefined) {
    err.code = code;
  }
  return err;
};

describe("isRemoteItemNotFoundError", () => {
  it("classifies HTTP 404 as remote-deleted (clears snapshot, no error counted)", () => {
    expect(isRemoteItemNotFoundError(apiError(404, "itemNotFound"))).toBe(true);
    expect(isRemoteItemNotFoundError(apiError(404))).toBe(true);
  });

  it("classifies HTTP 410 (soft-delete / retention) as remote-deleted", () => {
    expect(isRemoteItemNotFoundError(apiError(410))).toBe(true);
  });

  it("classifies a bare itemNotFound code as remote-deleted", () => {
    const err = new Error("itemNotFound") as Error & { code?: string };
    err.code = "itemNotFound";
    expect(isRemoteItemNotFoundError(err)).toBe(true);
  });

  it("does NOT treat 401 as deletion", () => {
    expect(isRemoteItemNotFoundError(apiError(401))).toBe(false);
  });

  it("does NOT treat 403 as deletion, even with an itemNotFound code", () => {
    expect(isRemoteItemNotFoundError(apiError(403, "itemNotFound"))).toBe(false);
  });

  it("does NOT treat 429 as deletion", () => {
    expect(isRemoteItemNotFoundError(apiError(429, "activityLimitReached"))).toBe(false);
  });

  it("does NOT treat 5xx as deletion", () => {
    expect(isRemoteItemNotFoundError(apiError(500, "generalException"))).toBe(false);
    expect(isRemoteItemNotFoundError(apiError(503))).toBe(false);
  });

  it("does NOT treat network errors without an HTTP status as deletion", () => {
    expect(isRemoteItemNotFoundError(new Error("net::ERR_INTERNET_DISCONNECTED"))).toBe(false);
  });

  it("does NOT classify the normal 200 flow (no error is ever built)", () => {
    expect(isRemoteItemNotFoundError({ status: 200 })).toBe(false);
    expect(isRemoteItemNotFoundError(undefined)).toBe(false);
    expect(isRemoteItemNotFoundError(null)).toBe(false);
    expect(isRemoteItemNotFoundError("404")).toBe(false);
  });
});
