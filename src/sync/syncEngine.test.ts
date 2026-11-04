/**
 * Unit tests for the vendored V3 sync engine's three-way merge decisions
 */

import { describe, expect, it } from "vitest";

import { TFile, TFolder, type Vault } from "obsidian";

import type { FileOrFolderMixedState } from "./baseTypes";
import type { SyncDirectionType } from "./baseTypes";
import {
  assignOperationToFileInplaceV3Inner,
  getSyncPlanV3,
} from "./syncEngine";
import type { PrevSyncRecord } from "./localdb";

const mkState = (over: Partial<FileOrFolderMixedState>): FileOrFolderMixedState => {
  return {
    key: over.key ?? "note.md",
    ...over,
  };
};

const mkPrevSync = (
  key: string,
  mtime: number,
  size: number
): PrevSyncRecord => ({
  key: key,
  mtime: mtime,
  size: size,
  keyType: key.endsWith("/") ? "folder" : "file",
  vaultRandomID: "test-vault",
});

const kept = (): Set<string> => new Set<string>();

describe("assignOperationToFileInplaceV3Inner — bidirectional", () => {
  it("skips when both sides exist and are identical", () => {
    const r = assignOperationToFileInplaceV3Inner(
      mkState({
        key: "note.md",
        existLocal: true,
        existRemote: true,
        mtimeLocal: 1000,
        mtimeRemote: 1000,
        sizeLocal: 10,
        sizeRemote: 10,
      }),
      kept()
    );
    expect(r.decision).toBe("skipUploading");
  });

  it("uploads when local is newer", () => {
    const r = assignOperationToFileInplaceV3Inner(
      mkState({
        key: "note.md",
        existLocal: true,
        existRemote: true,
        mtimeLocal: 2000,
        mtimeRemote: 1000,
        sizeLocal: 10,
        sizeRemote: 5,
      }),
      kept()
    );
    expect(r.decision).toBe("uploadLocalToRemote");
  });

  it("downloads when remote is newer", () => {
    const r = assignOperationToFileInplaceV3Inner(
      mkState({
        key: "note.md",
        existLocal: true,
        existRemote: true,
        mtimeLocal: 1000,
        mtimeRemote: 2000,
        sizeLocal: 5,
        sizeRemote: 10,
      }),
      kept()
    );
    expect(r.decision).toBe("downloadRemoteToLocal");
  });

  it("uploads a brand-new local file and marks the parent folder kept", () => {
    const ks = kept();
    const r = assignOperationToFileInplaceV3Inner(
      mkState({ key: "a/b.md", existLocal: true, mtimeLocal: 1000, sizeLocal: 10 }),
      ks
    );
    expect(r.decision).toBe("uploadLocalToRemote");
    expect(ks.has("a/")).toBe(true);
  });

  it("propagates a remote deletion to local when prevSync exists", () => {
    const r = assignOperationToFileInplaceV3Inner(
      mkState({
        key: "gone.md",
        existLocal: true,
        mtimeLocal: 1000,
        sizeLocal: 10,
        prevSync: mkPrevSync("gone.md", 500, 10),
      }),
      kept()
    );
    expect(r.decision).toBe("keepRemoteDelHist");
  });

  it("downloads a brand-new remote file and marks the parent folder kept", () => {
    const ks = kept();
    const r = assignOperationToFileInplaceV3Inner(
      mkState({ key: "a/remote.md", existRemote: true, mtimeRemote: 1000, sizeRemote: 10 }),
      ks
    );
    expect(r.decision).toBe("downloadRemoteToLocal");
    expect(ks.has("a/")).toBe(true);
  });

  it("propagates a local deletion to remote when prevSync exists", () => {
    const r = assignOperationToFileInplaceV3Inner(
      mkState({
        key: "gone.md",
        existRemote: true,
        mtimeRemote: 1000,
        sizeRemote: 10,
        prevSync: mkPrevSync("gone.md", 500, 10),
      }),
      kept()
    );
    expect(r.decision).toBe("uploadLocalDelHistToRemote");
  });

  it("skips items deleted on both sides", () => {
    const r = assignOperationToFileInplaceV3Inner(
      mkState({ key: "gone.md", prevSync: mkPrevSync("gone.md", 500, 10) }),
      kept()
    );
    expect(r.decision).toBe("skipUploading");
  });
});

describe("assignOperationToFileInplaceV3Inner — direction modes", () => {
  const existLocal = {
    existLocal: true as const,
    mtimeLocal: 1000,
    sizeLocal: 10,
  };
  const existRemote = {
    existRemote: true as const,
    mtimeRemote: 1000,
    sizeRemote: 10,
  };

  it("push-and-delete: uploads new local files", () => {
    const r = assignOperationToFileInplaceV3Inner(
      mkState({ key: "note.md", ...existLocal }),
      kept(),
      "",
      "incremental_push_and_delete_only"
    );
    expect(r.decision).toBe("uploadLocalToRemote");
  });

  it("push-and-delete: never pulls remote-only files", () => {
    const r = assignOperationToFileInplaceV3Inner(
      mkState({ key: "note.md", ...existRemote }),
      kept(),
      "",
      "incremental_push_and_delete_only"
    );
    expect(r.decision).toBe("skipUploading");
  });

  it("push-and-delete: re-pushes local files whose remote copy vanished", () => {
    const r = assignOperationToFileInplaceV3Inner(
      mkState({
        key: "note.md",
        ...existLocal,
        prevSync: mkPrevSync("note.md", 500, 10),
      }),
      kept(),
      "",
      "incremental_push_and_delete_only"
    );
    expect(r.decision).toBe("uploadLocalToRemote");
  });

  it("push-and-delete: propagates local deletions to remote", () => {
    const r = assignOperationToFileInplaceV3Inner(
      mkState({
        key: "note.md",
        ...existRemote,
        prevSync: mkPrevSync("note.md", 500, 10),
      }),
      kept(),
      "",
      "incremental_push_and_delete_only"
    );
    expect(r.decision).toBe("uploadLocalDelHistToRemote");
  });

  it("pull-and-delete: never uploads local-only files", () => {
    const r = assignOperationToFileInplaceV3Inner(
      mkState({ key: "note.md", ...existLocal }),
      kept(),
      "",
      "incremental_pull_and_delete_only"
    );
    expect(r.decision).toBe("skipUploading");
  });

  it("pull-and-delete: downloads remote-only files", () => {
    const r = assignOperationToFileInplaceV3Inner(
      mkState({ key: "note.md", ...existRemote }),
      kept(),
      "",
      "incremental_pull_and_delete_only"
    );
    expect(r.decision).toBe("downloadRemoteToLocal");
  });

  it("pull-and-delete: propagates remote deletions to local", () => {
    const r = assignOperationToFileInplaceV3Inner(
      mkState({
        key: "note.md",
        ...existLocal,
        prevSync: mkPrevSync("note.md", 500, 10),
      }),
      kept(),
      "",
      "incremental_pull_and_delete_only"
    );
    expect(r.decision).toBe("keepRemoteDelHist");
  });

  it("pull-and-delete: keeps the remote copy of locally deleted files", () => {
    const r = assignOperationToFileInplaceV3Inner(
      mkState({
        key: "note.md",
        ...existRemote,
        prevSync: mkPrevSync("note.md", 500, 10),
      }),
      kept(),
      "",
      "incremental_pull_and_delete_only"
    );
    expect(r.decision).toBe("skipUploading");
  });
});

describe("assignOperationToFileInplaceV3Inner — conflict resolution", () => {
  it("keep_larger: uploads when local is bigger in a three-way conflict", () => {
    const r = assignOperationToFileInplaceV3Inner(
      mkState({
        key: "note.md",
        existLocal: true,
        existRemote: true,
        mtimeLocal: 2000,
        mtimeRemote: 2000,
        sizeLocal: 50,
        sizeRemote: 10,
        prevSync: mkPrevSync("note.md", 500, 10),
      }),
      kept(),
      "",
      "bidirectional",
      "keep_larger"
    );
    expect(r.decision).toBe("uploadLocalToRemote");
  });

  it("keep_larger: downloads when remote is bigger in a three-way conflict", () => {
    const r = assignOperationToFileInplaceV3Inner(
      mkState({
        key: "note.md",
        existLocal: true,
        existRemote: true,
        mtimeLocal: 2000,
        mtimeRemote: 2000,
        sizeLocal: 10,
        sizeRemote: 50,
        prevSync: mkPrevSync("note.md", 500, 10),
      }),
      kept(),
      "",
      "bidirectional",
      "keep_larger"
    );
    expect(r.decision).toBe("downloadRemoteToLocal");
  });

  it("never clobbers a non-empty remote file with an empty local one (no baseline)", () => {
    const r = assignOperationToFileInplaceV3Inner(
      mkState({
        key: "note.md",
        existLocal: true,
        existRemote: true,
        mtimeLocal: 2000,
        mtimeRemote: 1000,
        sizeLocal: 0,
        sizeRemote: 50,
      }),
      kept()
    );
    expect(r.decision).toBe("downloadRemoteToLocal");
  });

  it("never clobbers a non-empty local file with an empty remote one (no baseline)", () => {
    const r = assignOperationToFileInplaceV3Inner(
      mkState({
        key: "note.md",
        existLocal: true,
        existRemote: true,
        mtimeLocal: 1000,
        mtimeRemote: 2000,
        sizeLocal: 50,
        sizeRemote: 0,
      }),
      kept()
    );
    expect(r.decision).toBe("uploadLocalToRemote");
  });

  // With prevSync baseline: the original bug path — daily-note plugins do
  // "delete then recreate" locally, leaving a stale prevSync record, and
  // the freshly created empty file has a newer mtime. It must NOT cover
  // a non-empty remote copy.
  it("never clobbers a non-empty remote file with a local \"delete then recreate\" empty file (prevSync exists)", () => {
    const r = assignOperationToFileInplaceV3Inner(
      mkState({
        key: "note.md",
        existLocal: true,
        existRemote: true,
        mtimeLocal: 2000,
        mtimeRemote: 1500,
        sizeLocal: 0,
        sizeRemote: 50,
        prevSync: mkPrevSync("note.md", 500, 42),
      }),
      kept()
    );
    expect(r.decision).toBe("downloadRemoteToLocal");
  });

  it("never clobbers a non-empty local file with a remote \"delete then recreate\" empty file (prevSync exists)", () => {
    const r = assignOperationToFileInplaceV3Inner(
      mkState({
        key: "note.md",
        existLocal: true,
        existRemote: true,
        mtimeLocal: 1500,
        mtimeRemote: 2000,
        sizeLocal: 50,
        sizeRemote: 0,
        prevSync: mkPrevSync("note.md", 500, 42),
      }),
      kept()
    );
    expect(r.decision).toBe("uploadLocalToRemote");
  });

  it("empty-file protection works regardless of conflictAction (no disabled mode in our project)", () => {
    // upstream added conflictAction !== "disabled" but our project only has
    // keep_newer | keep_larger — no disabled option. The blanket protection
    // covers both conflict strategies equally.
    const rKeepNewer = assignOperationToFileInplaceV3Inner(
      mkState({
        key: "note.md",
        existLocal: true,
        existRemote: true,
        mtimeLocal: 2000,
        mtimeRemote: 1000,
        sizeLocal: 0,
        sizeRemote: 50,
      }),
      kept()
    );
    const rKeepLarger = assignOperationToFileInplaceV3Inner(
      mkState({
        key: "note.md",
        existLocal: true,
        existRemote: true,
        mtimeLocal: 2000,
        mtimeRemote: 1000,
        sizeLocal: 0,
        sizeRemote: 50,
      }),
      kept(),
      "",
      "bidirectional",
      "keep_larger"
    );
    expect(rKeepNewer.decision).toBe("downloadRemoteToLocal");
    expect(rKeepLarger.decision).toBe("downloadRemoteToLocal");
  });

  it("encrypted mode: local empty file with prevSync still protects (when both sizes are available)", () => {
    // The protection block requires r.sizeRemote !== undefined, so in real
    // encrypted-mode scenarios (where remote plaintext size is unknown,
    // sizeRemote=undefined) the block can't enter. But when both plaintext
    // sizes happen to be known, the local-empty check is safe because
    // password !== "" makes it short-circuit — it always pulls remote,
    // assuming remote might be non-empty.
    const r = assignOperationToFileInplaceV3Inner(
      mkState({
        key: "note.md",
        existLocal: true,
        existRemote: true,
        mtimeLocal: 2000,
        mtimeRemote: 1500,
        sizeLocal: 0,
        sizeRemote: 50,
        sizeLocalEnc: 16,
        sizeRemoteEnc: 32,
        prevSync: mkPrevSync("note.md", 500, 42),
      }),
      kept(),
      "p@s5w0rd"
    );
    expect(r.decision).toBe("downloadRemoteToLocal");
  });

  it("prevSync.size===0 baseline also protects (blanket rule, not wasNonEmpty)", () => {
    // Edge case: file was once synced as empty, then remote got content,
    // local recreates empty. Blanket rule still protects remote content.
    const r = assignOperationToFileInplaceV3Inner(
      mkState({
        key: "note.md",
        existLocal: true,
        existRemote: true,
        mtimeLocal: 2000,
        mtimeRemote: 1500,
        sizeLocal: 0,
        sizeRemote: 50,
        prevSync: mkPrevSync("note.md", 500, 0),
      }),
      kept()
    );
    expect(r.decision).toBe("downloadRemoteToLocal");
  });
});

describe("getSyncPlanV3 — integration", () => {
  const mkFile = (path: string, mtime: number, size: number): TFile => {
    const f = new TFile();
    f.path = path;
    f.stat = { ctime: mtime, mtime: mtime, size: size };
    return f;
  };

  const mkFolder = (path: string): TFolder => {
    const f = new TFolder();
    f.path = path;
    return f;
  };

  const vault = {} as Vault;

  const run = (
    local: Array<TFile | TFolder>,
    remoteStates: FileOrFolderMixedState[],
    prevSyncRecords: PrevSyncRecord[],
    syncDirection: SyncDirectionType = "bidirectional"
  ) => {
    return getSyncPlanV3(
      remoteStates,
      local,
      undefined,
      prevSyncRecords,
      "onedrive",
      "manual",
      vault,
      false,
      false,
      false,
      ".obsidian",
      false,
      0,
      "",
      syncDirection
    );
  };

  it("plans upload for new local files and folder creation for their parents", async () => {
    const plan = await run(
      [mkFolder("a"), mkFile("a/b.md", 1000, 10)],
      [],
      []
    );
    expect(plan.plan.mixedStates["a/b.md"]?.decision).toBe(
      "uploadLocalToRemote"
    );
    expect(plan.plan.mixedStates["a/"]?.decision).toBe("createFolder");
    expect(plan.deletions).toHaveLength(0);
  });

  it("plans download for remote-only files", async () => {
    const plan = await run(
      [],
      [
        {
          key: "remote.md",
          existRemote: true,
          mtimeRemote: 1000,
          sizeRemote: 10,
        },
      ],
      []
    );
    expect(plan.plan.mixedStates["remote.md"]?.decision).toBe(
      "downloadRemoteToLocal"
    );
  });

  it("detects a three-way conflict when both sides changed after prevSync", async () => {
    const plan = await run(
      [mkFile("note.md", 2000, 12)],
      [
        {
          key: "note.md",
          existRemote: true,
          mtimeRemote: 1500,
          sizeRemote: 8,
        },
      ],
      [mkPrevSync("note.md", 500, 10)]
    );
    const decision = plan.plan.mixedStates["note.md"]?.decision;
    expect(["uploadLocalToRemote", "downloadRemoteToLocal"]).toContain(decision);
  });

  it("propagates local deletions to remote via prevSync records", async () => {
    const plan = await run(
      [],
      [
        {
          key: "gone.md",
          existRemote: true,
          mtimeRemote: 1000,
          sizeRemote: 10,
        },
      ],
      [mkPrevSync("gone.md", 500, 10)]
    );
    expect(plan.plan.mixedStates["gone.md"]?.decision).toBe(
      "uploadLocalDelHistToRemote"
    );
    expect(plan.deletions).toHaveLength(1);
    expect(plan.deletions[0]?.key).toBe("gone.md");
  });

  it("propagates remote deletions to local via prevSync records", async () => {
    const plan = await run(
      [mkFile("gone.md", 1000, 10)],
      [],
      [mkPrevSync("gone.md", 500, 10)]
    );
    expect(plan.plan.mixedStates["gone.md"]?.decision).toBe(
      "keepRemoteDelHist"
    );
  });

  it("propagates local folder deletions to remote in bidirectional mode", async () => {
    const plan = await run(
      [],
      [
        {
          key: "old-folder/",
          existRemote: true,
          mtimeRemote: 1000,
          sizeRemote: 0,
        },
      ],
      [mkPrevSync("old-folder/", 500, 0)]
    );
    expect(plan.plan.mixedStates["old-folder/"]?.decision).toBe(
      "uploadLocalDelHistToRemoteFolder"
    );
    expect(plan.deletions).toHaveLength(1);
    expect(plan.deletions[0]?.key).toBe("old-folder/");
  });
});
