/**
 * Unit tests for the response-based request paths (`throw: false`):
 * - binary content download: a non-2xx response must surface as an error that
 *   carries `status` / `code`, so `isRemoteItemNotFoundError` recognises a gone
 *   item and the sync engine can drop the snapshot key and skip the entry;
 * - deleteJson: 404 means "already gone", i.e. the delete goal is reached.
 *
 * No network is involved: these are the pure helpers the request paths use.
 */

import { describe, expect, it } from "vitest";
import type { RequestUrlResponse } from "obsidian";

import type { RemoteItem } from "./baseTypes";
import { isRemoteItemNotFoundError } from "./remote";
import {
  buildRemoteApiError,
  buildSnapshotIndex,
  fromDriveItemToRemoteItem,
  hasLegacySnapshotEntries,
  httpStatusText,
  isBareErrorStatus,
  isDeleteResponseDone,
  isHttpNotFoundStatus,
  isHttpSuccessStatus,
  oneDriveApiRequest,
  parseJsonBodySafe,
  removeSnapshotEntriesForDeletedItem,
} from "./remoteForOnedrive";

const itemNotFoundBody = {
  error: {
    code: "itemNotFound",
    message: "The resource could not be found.",
  },
};

describe("isHttpSuccessStatus / isHttpNotFoundStatus", () => {
  it("accepts 2xx as success", () => {
    expect(isHttpSuccessStatus(200)).toBe(true);
    expect(isHttpSuccessStatus(204)).toBe(true);
    expect(isHttpSuccessStatus(206)).toBe(true);
  });

  it("treats non-2xx as not success", () => {
    expect(isHttpSuccessStatus(302)).toBe(false);
    expect(isHttpSuccessStatus(404)).toBe(false);
    expect(isHttpSuccessStatus(429)).toBe(false);
    expect(isHttpSuccessStatus(500)).toBe(false);
  });

  it("404 and 410 count as not-found", () => {
    expect(isHttpNotFoundStatus(404)).toBe(true);
    expect(isHttpNotFoundStatus(410)).toBe(true);
    expect(isHttpNotFoundStatus(403)).toBe(false);
    expect(isHttpNotFoundStatus(429)).toBe(false);
    expect(isHttpNotFoundStatus(500)).toBe(false);
  });
});

describe("binary content download: 404 is classified as remote-deleted", () => {
  const downloadError = (status: number, text: unknown) =>
    buildRemoteApiError(
      "GET",
      "/drive/special/approot:/Obsidian Vault/02 System/02 Assets/x.jpg",
      status,
      text
    );

  it("carries status+code and hits the forget-snapshot / skip path", () => {
    const err = downloadError(404, JSON.stringify(itemNotFoundBody));
    expect(err.status).toBe(404);
    expect(err.code).toBe("itemNotFound");
    // This is the exact condition the sync engine branches on:
    // remove the key from remoteSnapshot, skip the item, count no error.
    expect(isRemoteItemNotFoundError(err)).toBe(true);
  });

  it("recovers the Graph code from the raw text body", () => {
    const err = downloadError(404, JSON.stringify(itemNotFoundBody));
    expect(err.status).toBe(404);
    expect(err.code).toBe("itemNotFound");
    expect(isRemoteItemNotFoundError(err)).toBe(true);
  });

  it("still recognises 404 when the body is not JSON", () => {
    const err = downloadError(404, "<html>not found</html>");
    expect(err.status).toBe(404);
    expect(err.code).toBeUndefined();
    expect(isRemoteItemNotFoundError(err)).toBe(true);
  });

  it("keeps auth / throttling / server failures counting as errors", () => {
    for (const status of [401, 403, 429, 500, 503]) {
      const err = downloadError(status, "");
      expect(err.status).toBe(status);
      expect(isRemoteItemNotFoundError(err)).toBe(false);
    }
  });
});

describe("deleteJson: 404 is success (delete goal already reached)", () => {
  it("treats 2xx as done", () => {
    expect(isDeleteResponseDone(200)).toBe(true);
    expect(isDeleteResponseDone(204)).toBe(true);
  });

  it("treats 404 as done, so the caller still clears history and snapshot", () => {
    expect(isDeleteResponseDone(404)).toBe(true);
  });

  it("keeps auth / throttling / server failures as errors", () => {
    for (const status of [400, 401, 403, 409, 429, 500, 503]) {
      expect(isDeleteResponseDone(status)).toBe(false);
    }
  });
});

////////////////////////////////////////////////////////////////////////////////
// Layer 2: snapshot stores driveItem.id; delta deletions are matched by id
////////////////////////////////////////////////////////////////////////////////

const BASE = "Obsidian Vault";
const parentPathOf = (sub = ""): string =>
  `/drive/root:/Apps/astral-trek/${BASE}${sub}`;

const snapshotItem = (key: string, id?: string): RemoteItem => {
  const item: RemoteItem = {
    key,
    lastModified: 1,
    size: 10,
    remoteType: "onedrive",
    etag: "etag",
  };
  if (id !== undefined) {
    item.id = id;
  }
  return item;
};

const makeSnapshot = (...items: RemoteItem[]): Record<string, RemoteItem> => {
  const snapshot: Record<string, RemoteItem> = {};
  for (const item of items) {
    snapshot[item.key] = item;
  }
  return snapshot;
};

describe("snapshot index + delta deletion by driveItem.id", () => {
  it("removes the entry when the delete item carries ONLY an id", () => {
    const snapshot = makeSnapshot(
      snapshotItem("a.md", "id-a"),
      snapshotItem("b.md", "id-b")
    );
    const index = buildSnapshotIndex(snapshot);

    const removed = removeSnapshotEntriesForDeletedItem(
      snapshot,
      index,
      { id: "id-a" }, // no name, no parentReference
      BASE
    );

    expect(removed).toBe(1);
    expect(snapshot["a.md"]).toBeUndefined();
    expect(snapshot["b.md"]).toBeDefined();
  });

  it("falls back to name/path when the id does not match any snapshot entry", () => {
    const snapshot = makeSnapshot(
      snapshotItem("Notes/a.md", "id-a"),
      snapshotItem("b.md", "id-b")
    );
    const index = buildSnapshotIndex(snapshot);

    const removed = removeSnapshotEntriesForDeletedItem(
      snapshot,
      index,
      {
        id: "id-unknown",
        name: "a.md",
        parentReference: { path: parentPathOf("/Notes") },
      },
      BASE
    );

    expect(removed).toBe(1);
    expect(snapshot["Notes/a.md"]).toBeUndefined();
    expect(snapshot["b.md"]).toBeDefined();
  });

  it("removes nothing and does not throw when neither id nor name matches", () => {
    const snapshot = makeSnapshot(snapshotItem("b.md", "id-b"));
    const index = buildSnapshotIndex(snapshot);

    expect(() =>
      removeSnapshotEntriesForDeletedItem(
        snapshot,
        index,
        { id: "id-unknown" },
        BASE
      )
    ).not.toThrow();
    expect(removeSnapshotEntriesForDeletedItem(
      snapshot,
      index,
      { id: "id-unknown" },
      BASE
    )).toBe(0);
    expect(Object.keys(snapshot)).toEqual(["b.md"]);
  });

  it("keeps both plaintext and encrypted keys of the same item removable by id", () => {
    // Same driveItem stored twice: a plaintext key left over from before
    // encryption was enabled, plus the current encrypted key.
    const snapshot = makeSnapshot(
      snapshotItem("secret.md", "id-same"),
      snapshotItem("c2VjcmV0Lm1k", "id-same"),
      snapshotItem("other.md", "id-other")
    );
    const index = buildSnapshotIndex(snapshot);

    expect(index.byId.get("id-same")).toEqual(["secret.md", "c2VjcmV0Lm1k"]);

    const removed = removeSnapshotEntriesForDeletedItem(
      snapshot,
      index,
      { id: "id-same" },
      BASE
    );

    expect(removed).toBe(2);
    expect(snapshot["secret.md"]).toBeUndefined();
    expect(snapshot["c2VjcmV0Lm1k"]).toBeUndefined();
    expect(snapshot["other.md"]).toBeDefined();
  });

  it("does not delete a recreated item through a stale index entry", () => {
    const snapshot = makeSnapshot(snapshotItem("a.md", "id-old"));
    const index = buildSnapshotIndex(snapshot);
    // Path deleted then recreated: same key, new id.
    snapshot["a.md"] = snapshotItem("a.md", "id-new");

    const removed = removeSnapshotEntriesForDeletedItem(
      snapshot,
      index,
      { id: "id-old" },
      BASE
    );

    expect(removed).toBe(0);
    expect(snapshot["a.md"]?.id).toBe("id-new");
  });

  it("indexes a large batch without duplicate key conflicts", () => {
    const snapshot: Record<string, RemoteItem> = {};
    for (let i = 0; i < 500; i += 1) {
      snapshot[`dir${i}/f${i}.md`] = snapshotItem(`dir${i}/f${i}.md`, `id-${i}`);
    }
    snapshot["dup.md"] = snapshotItem("dup.md", "id-1"); // second key, same id

    const index = buildSnapshotIndex(snapshot);

    expect(index.byId.get("id-1")).toEqual(["dir1/f1.md", "dup.md"]);
    expect(index.byId.get("id-1")?.length).toBe(2);
    // One map entry per id: repeated ids do not create extra map entries.
    expect(index.byId.size).toBe(500);
    // No duplicated key inside a bucket.
    for (const keys of index.byId.values()) {
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe("legacy snapshot (entries without driveItem.id)", () => {
  it("detects legacy entries so listFromRemote rebuilds once", () => {
    const legacy = makeSnapshot(snapshotItem("a.md"), snapshotItem("b.md"));
    expect(hasLegacySnapshotEntries(legacy)).toBe(true);
  });

  it("does not trigger again once every entry has an id", () => {
    const rebuilt = makeSnapshot(
      snapshotItem("a.md", "id-a"),
      snapshotItem("b.md", "id-b")
    );
    expect(hasLegacySnapshotEntries(rebuilt)).toBe(false);
  });

  it("rebuild from full enumeration yields entries that all carry an id", () => {
    // The shape a delta full enumeration returns (id + name + parentReference).
    const driveItems = [
      {
        id: "id-a",
        name: "a.md",
        parentReference: { path: parentPathOf() },
        file: {},
        size: 12,
        fileSystemInfo: { lastModifiedDateTime: "2026-01-01T00:00:00Z" },
        cTag: "ctag-a",
      },
      {
        id: "id-b",
        name: "b.md",
        parentReference: { path: parentPathOf() },
        file: {},
        size: 34,
        fileSystemInfo: { lastModifiedDateTime: "2026-01-02T00:00:00Z" },
        cTag: "ctag-b",
      },
    ];

    const rebuilt: Record<string, RemoteItem> = {};
    for (const driveItem of driveItems) {
      const remoteItem = fromDriveItemToRemoteItem(driveItem, BASE);
      rebuilt[remoteItem.key] = remoteItem;
    }

    expect(Object.keys(rebuilt).sort()).toEqual(["a.md", "b.md"]);
    expect(rebuilt["a.md"]?.id).toBe("id-a");
    expect(rebuilt["b.md"]?.id).toBe("id-b");
    // After the rebuild the legacy trigger can no longer fire → full
    // enumeration happens exactly once.
    expect(hasLegacySnapshotEntries(rebuilt)).toBe(false);
  });
});

////////////////////////////////////////////////////////////////////////////////
// Upstream 26.2.8 parity: non-2xx without a Graph error body must still throw
////////////////////////////////////////////////////////////////////////////////

const fakeResponse = (
  status: number,
  body: { json?: unknown; text?: string } = {}
): RequestUrlResponse => ({
  status,
  headers: {},
  json: body.json ?? null,
  text: body.text ?? "",
  arrayBuffer: new ArrayBuffer(0),
});

const callApi = async (
  status: number,
  body: { json?: unknown; text?: string } = {}
): Promise<(Error & { status?: number; code?: string }) | undefined> => {
  try {
    await oneDriveApiRequest(
      "GET",
      "/drive/special/approot:/Obsidian Vault/a.md",
      {},
      undefined,
      async () => fakeResponse(status, body)
    );
    return undefined;
  } catch (err) {
    return err as Error & { status?: number; code?: string };
  }
};

describe("oneDriveApiRequest: bare non-2xx responses", () => {
  it("throws with status when the body is empty (used to return {})", async () => {
    const err = await callApi(404);

    expect(err).toBeDefined();
    expect(err?.status).toBe(404);
    expect(err?.code).toBeUndefined();
    expect(err?.message).toContain("(HTTP 404)");
    expect(err?.message).toContain("Not Found");
    // A bare 404 is still recognised as "remote item gone".
    expect(isRemoteItemNotFoundError(err)).toBe(true);
  });

  it("throws with status when the body is an HTML error page (gateway 502)", async () => {
    const err = await callApi(502, { text: "<html><body>Bad Gateway</body></html>" });

    expect(err).toBeDefined();
    expect(err?.status).toBe(502);
    expect(err?.code).toBeUndefined();
    expect(err?.message).toContain("(HTTP 502)");
    expect(err?.message).toContain("Bad Gateway");
    const cause = (err as Error & { cause?: { rawBody?: string } }).cause;
    expect(cause?.rawBody).toContain("<html>");
    // Not a deletion: auth/throttling/server failures keep counting.
    expect(isRemoteItemNotFoundError(err)).toBe(false);
  });

  it("keeps the success path unchanged: 2xx with empty body resolves {}", async () => {
    await expect(
      oneDriveApiRequest("DELETE", "/drive/.../a.md", {}, undefined, async () =>
        fakeResponse(204)
      )
    ).resolves.toEqual({});
  });

  it("keeps the Graph error branch unchanged: 404 body still yields code", async () => {
    const err = await callApi(404, {
      json: itemNotFoundBody,
      text: JSON.stringify(itemNotFoundBody),
    });

    expect(err?.status).toBe(404);
    expect(err?.code).toBe("itemNotFound");
    expect(err?.message).toContain("itemNotFound");
    expect(isRemoteItemNotFoundError(err)).toBe(true);
  });

  it("keeps a 2xx JSON body as the parsed object", async () => {
    await expect(
      oneDriveApiRequest("GET", "/drive/.../delta", {}, undefined, async () =>
        fakeResponse(200, { json: { value: [] }, text: JSON.stringify({ value: [] }) })
      )
    ).resolves.toEqual({ value: [] });
  });
});

/** Simulates Obsidian's lazy `json` getter, which throws on non-JSON bodies. */
const fakeResponseWithThrowingJson = (
  status: number,
  text: string
): RequestUrlResponse => {
  const resp = {
    status,
    headers: {},
    text,
    arrayBuffer: new ArrayBuffer(0),
  } as unknown as RequestUrlResponse;
  Object.defineProperty(resp, "json", {
    get() {
      throw new SyntaxError(
        `Unexpected token '<', "${text.slice(0, 20)}" is not valid JSON`
      );
    },
  });
  return resp;
};

const callApiWithThrowingJson = async (
  status: number,
  text: string
): Promise<(Error & { status?: number; code?: string }) | undefined> => {
  try {
    await oneDriveApiRequest(
      "GET",
      "/drive/special/approot:/Obsidian Vault/a.md",
      {},
      undefined,
      async () => fakeResponseWithThrowingJson(status, text)
    );
    return undefined;
  } catch (err) {
    return err as Error & { status?: number; code?: string };
  }
};

describe("oneDriveApiRequest: lazy resp.json getter must never swallow status", () => {
  it("404 + empty body: status survives, no SyntaxError", async () => {
    const err = await callApiWithThrowingJson(404, "");

    expect(err).toBeDefined();
    expect(err?.constructor).toBe(Error);
    expect(err?.name).toBe("Error");
    expect(err?.status).toBe(404);
    expect(err?.message).toContain("(HTTP 404)");
    expect(isRemoteItemNotFoundError(err)).toBe(true);
  });

  it("502 + HTML body: status survives, no SyntaxError", async () => {
    const err = await callApiWithThrowingJson(502, "<html>502 Bad Gateway</html>");

    expect(err?.constructor).toBe(Error);
    expect(err?.status).toBe(502);
    expect(err?.code).toBeUndefined();
    const cause = (err as Error & { cause?: { rawBody?: string } }).cause;
    expect(cause?.rawBody).toContain("<html>");
    expect(isRemoteItemNotFoundError(err)).toBe(false);
  });

  it("2xx JSON body: success path does not depend on the json getter", async () => {
    await expect(
      oneDriveApiRequest("GET", "/drive/.../delta", {}, undefined, async () =>
        fakeResponseWithThrowingJson(200, JSON.stringify({ value: ["a"] }))
      )
    ).resolves.toEqual({ value: ["a"] });
  });
});

describe("parseJsonBodySafe", () => {
  it("never throws and returns undefined for non-object bodies", () => {
    expect(parseJsonBodySafe("")).toBeUndefined();
    expect(parseJsonBodySafe("<html></html>")).toBeUndefined();
    expect(parseJsonBodySafe("null")).toBeUndefined();
    expect(parseJsonBodySafe(undefined)).toBeUndefined();
    expect(parseJsonBodySafe(null)).toBeUndefined();
    expect(parseJsonBodySafe(42)).toBeUndefined();
  });

  it("parses JSON objects", () => {
    expect(parseJsonBodySafe(JSON.stringify(itemNotFoundBody))).toEqual(
      itemNotFoundBody
    );
    expect(parseJsonBodySafe('{"value":[]}')).toEqual({ value: [] });
  });
});

describe("isBareErrorStatus / httpStatusText", () => {
  it("only 4xx/5xx are bare errors (2xx and 3xx are not)", () => {
    expect(isBareErrorStatus(200)).toBe(false);
    expect(isBareErrorStatus(204)).toBe(false);
    expect(isBareErrorStatus(302)).toBe(false);
    expect(isBareErrorStatus(400)).toBe(true);
    expect(isBareErrorStatus(404)).toBe(true);
    expect(isBareErrorStatus(502)).toBe(true);
  });

  it("falls back to a status text, then to the numeric code", () => {
    expect(httpStatusText(404)).toBe("Not Found");
    expect(httpStatusText(429)).toBe("Too Many Requests");
    expect(httpStatusText(502)).toBe("Bad Gateway");
    expect(httpStatusText(418)).toBe("HTTP 418");
  });
});
