import { describe, expect, it } from "vitest";
import {
  CURRENT_DATA_VERSION,
  DATA_MIGRATIONS,
  DEFAULT_HEATMAP_SETTINGS,
  DEFAULT_SYNC_SETTINGS,
  normalizeHeatmapSettings,
  normalizeSyncSettings,
  type OneDriveSyncSettings
} from "./models";

describe("normalizeHeatmapSettings", () => {
  it("畸形空值（旧对账 bug 的 \"\"/\" \"/'\"\"'）归一化为默认值", () => {
    const normalized = normalizeHeatmapSettings({
      ...DEFAULT_HEATMAP_SETTINGS,
      dataSourceValue: '""',
      dateFieldValue: " ",
      dateFormat: "",
      countFieldValue: "  ",
      excludeFolders: '" "'
    });
    expect(normalized.dataSourceValue).toBe(
      DEFAULT_HEATMAP_SETTINGS.dataSourceValue
    );
    expect(normalized.dateFieldValue).toBe(
      DEFAULT_HEATMAP_SETTINGS.dateFieldValue
    );
    expect(normalized.dateFormat).toBe(DEFAULT_HEATMAP_SETTINGS.dateFormat);
    expect(normalized.countFieldValue).toBe(
      DEFAULT_HEATMAP_SETTINGS.countFieldValue
    );
    expect(normalized.excludeFolders).toBe(
      DEFAULT_HEATMAP_SETTINGS.excludeFolders
    );
  });

  it("有效值原样保留，未提供字段回默认", () => {
    const normalized = normalizeHeatmapSettings({
      dataSourceValue: "Projects"
    });
    expect(normalized.dataSourceValue).toBe("Projects");
    expect(normalized.dateFieldType).toBe(
      DEFAULT_HEATMAP_SETTINGS.dateFieldType
    );
  });

  it("undefined 返回完整默认值", () => {
    expect(normalizeHeatmapSettings()).toEqual(DEFAULT_HEATMAP_SETTINGS);
  });
});

describe("normalizeSyncSettings", () => {
  it("已裁剪的旧同步方向回退为双向，合法方向保留", () => {
    const legacy = {
      syncDirection: "incremental_push_only"
    } as unknown as Partial<OneDriveSyncSettings>;
    expect(normalizeSyncSettings(legacy).syncDirection).toBe("bidirectional");
    expect(
      normalizeSyncSettings({
        syncDirection: "incremental_pull_and_delete_only"
      }).syncDirection
    ).toBe("incremental_pull_and_delete_only");
  });

  it("空/缺失 clientID 回填默认，用户自定义非空值保留", () => {
    const emptied = normalizeSyncSettings({
      onedriveConfig: {
        ...DEFAULT_SYNC_SETTINGS.onedriveConfig,
        clientID: ""
      }
    });
    expect(emptied.onedriveConfig.clientID).toBe(
      DEFAULT_SYNC_SETTINGS.onedriveConfig.clientID
    );
    const custom = normalizeSyncSettings({
      onedriveConfig: {
        ...DEFAULT_SYNC_SETTINGS.onedriveConfig,
        clientID: "my-client-id"
      }
    });
    expect(custom.onedriveConfig.clientID).toBe("my-client-id");
  });

  it("已移除的设置项固定为默认语义，数值类旧数据按上游语义修正", () => {
    const normalized = normalizeSyncSettings({
      concurrency: 9,
      protectModifyPercentage: 40,
      skipSizeLargerThan: 0
    });
    expect(normalized.concurrency).toBe(5);
    expect(normalized.protectModifyPercentage).toBe(100);
    expect(normalized.skipSizeLargerThan).toBe(-1);
    expect(normalized.deleteToWhere).toBe("system_trash");
  });

  it("旧配置缺 showStatusBar 时补默认开启，显式关闭保留", () => {
    expect(normalizeSyncSettings({}).showStatusBar).toBe(true);
    expect(normalizeSyncSettings(undefined).showStatusBar).toBe(true);
    expect(normalizeSyncSettings({ showStatusBar: false }).showStatusBar).toBe(
      false
    );
  });
});

describe("DATA_MIGRATIONS", () => {
  it("v1→v2：quickCapture 旧字段迁移为 filePath（继承目录）", () => {
    const saved: Record<string, unknown> = {
      settings: {
        quickCapture: {
          storagePath: "00 inbox/",
          namingPattern: "YYYY-MM-DD",
          templateFile: "tpl.md"
        }
      }
    };
    DATA_MIGRATIONS[0]!.run(saved);
    const settings = saved.settings as {
      quickCapture: { filePath: string };
    };
    expect(settings.quickCapture.filePath).toBe("00 inbox/快速捕获.md");
  });

  it("已有有效 filePath 时不覆盖", () => {
    const saved: Record<string, unknown> = {
      settings: { quickCapture: { filePath: "Notes/捕获.md" } }
    };
    DATA_MIGRATIONS[0]!.run(saved);
    const settings = saved.settings as {
      quickCapture: { filePath: string };
    };
    expect(settings.quickCapture.filePath).toBe("Notes/捕获.md");
  });

  it("注册表不变量：to 单调递增且 ≤ 当前数据版本", () => {
    DATA_MIGRATIONS.forEach((migration, index) => {
      expect(migration.to).toBeLessThanOrEqual(CURRENT_DATA_VERSION);
      if (index > 0) {
        expect(migration.to).toBeGreaterThan(DATA_MIGRATIONS[index - 1]!.to);
      }
    });
  });
});
