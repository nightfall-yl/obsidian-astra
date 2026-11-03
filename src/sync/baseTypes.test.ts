import { describe, expect, it } from "vitest";
import { applyRemoteSnapshotMigration, type OnedriveConfig } from "./baseTypes";

type MigratableConfig = OnedriveConfig & Record<string, unknown>;

describe("applyRemoteSnapshotMigration", () => {
  const baseConfig = () => ({
    accessToken: "at",
    clientID: "cid",
    authority: "https://login.example",
    refreshToken: "rt",
    accessTokenExpiresInSeconds: 3600,
    accessTokenExpiresAtTime: 0,
    deltaLink: "",
    username: "test"
  });

  it("config 含 snapshot + 无 marker → 删除 snapshot，设 marker", () => {
    const odc: MigratableConfig = {
      ...baseConfig(),
      remoteSnapshot: {
        "a.md": { key: "a.md", lastModified: 1, size: 100, remoteType: "onedrive" },
        "b.md": { key: "b.md", lastModified: 2, size: 200, remoteType: "onedrive" }
      }
    };
    const r = applyRemoteSnapshotMigration(odc);
    expect(r).toEqual({ migrated: true, pathCount: 2 });
    expect(odc.remoteSnapshot).toBeUndefined();
    expect(odc.remoteSnapshotMigrated).toBe(true);
  });

  it("config 无 snapshot + 无 marker → 仅设 marker，migrated=false", () => {
    const odc: MigratableConfig = { ...baseConfig() };
    const r = applyRemoteSnapshotMigration(odc);
    expect(r).toEqual({ migrated: false, pathCount: 0 });
    expect(odc.remoteSnapshotMigrated).toBe(true);
  });

  it("marker 已存在 → 完全幂等，不动 config", () => {
    const odc: MigratableConfig = {
      ...baseConfig(),
      remoteSnapshotMigrated: true,
      // 旧 snapshot 残留（理论上不存在，但防御）
      remoteSnapshot: { "z.md": { key: "z.md", lastModified: 0, size: 0, remoteType: "onedrive" } }
    };
    const r = applyRemoteSnapshotMigration(odc);
    expect(r).toEqual({ migrated: false, pathCount: 0 });
    // 幂等分支直接返回，连 delete 都不做
    expect(odc.remoteSnapshot).toBeDefined();
  });

  it("幂等调用两次：第二次返回 migrated=false，config 状态不变", () => {
    const odc: MigratableConfig = {
      ...baseConfig(),
      remoteSnapshot: { "x.md": { key: "x.md", lastModified: 1, size: 10, remoteType: "onedrive" } }
    };
    const r1 = applyRemoteSnapshotMigration(odc);
    expect(r1.migrated).toBe(true);
    const r2 = applyRemoteSnapshotMigration(odc);
    expect(r2.migrated).toBe(false);
    expect(odc.remoteSnapshotMigrated).toBe(true);
    expect(odc.remoteSnapshot).toBeUndefined();
  });
});
