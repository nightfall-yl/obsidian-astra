/**
 * Trimmed to OneDrive-only sync: S3/WebDAV types removed, i18n/lang types removed.
 */

import { Platform, requireApiVersion } from "obsidian";

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export interface OnedriveConfig {
  accessToken: string;
  clientID: string;
  authority: string;
  refreshToken: string;
  accessTokenExpiresInSeconds: number;
  accessTokenExpiresAtTime: number;
  deltaLink: string;
  /** 已废弃：远端快照已迁移到 IndexedDB（store "remoteSnapshot"），
   *  保留字段仅为兼容旧版本 data.json，首次加载时会触发一次性迁移并删除。 */
  remoteSnapshot?: Record<string, RemoteItem>;
  /** 一次性迁移标记：remoteSnapshot 已搬出 data.json，后续不再序列化。 */
  remoteSnapshotMigrated?: boolean;
  username: string;
  credentialsShouldBeDeletedAtTime?: number;
  remoteBaseDir?: string;
}

/**
 * 一次性迁移的纯函数部分：从 OnedriveConfig 对象中移除 remoteSnapshot 字段、
 * 写入 remoteSnapshotMigrated 标记。不涉及任何 I/O（IDB、saveSettings），
 * 可独立单测。
 *
 * 幂等：已设 remoteSnapshotMigrated=true → 返回 { migrated: false, pathCount: 0 }。
 * 对快照内容不做深拷贝或验证；调用方在 async 层负责先把快照写入 IDB 再调用本函数。
 */
export function applyRemoteSnapshotMigration(
  odc: OnedriveConfig & Record<string, unknown>
): { migrated: boolean; pathCount: number } {
  if (odc.remoteSnapshotMigrated) {
    return { migrated: false, pathCount: 0 };
  }
  const snapshot = odc.remoteSnapshot as Record<string, unknown> | undefined;
  const pathCount = snapshot ? Object.keys(snapshot).length : 0;
  delete odc.remoteSnapshot;
  odc.remoteSnapshotMigrated = true;
  return { migrated: pathCount > 0, pathCount };
}

export interface RemoteItem {
  key: string;
  lastModified: number;
  size: number;
  remoteType: "onedrive";
  etag?: string;
  /** OneDrive driveItem id. Optional: snapshots written before this field
   *  existed do not carry it (handled by the one-time full rebuild). */
  id?: string;
}

export const COMMAND_CALLBACK_ONEDRIVE = "astral-trek-onedrive";

// 80 days
export const OAUTH2_FORCE_EXPIRE_MILLISECONDS = 1000 * 60 * 60 * 24 * 80;

type DecisionTypeForFile =
  | "skipUploading" // special, mtimeLocal === mtimeRemote
  | "uploadLocalDelHistToRemote" // "delLocalIfExists && delRemoteIfExists && cleanLocalDelHist && uploadLocalDelHistToRemote"
  | "keepRemoteDelHist" // "delLocalIfExists && delRemoteIfExists && cleanLocalDelHist && keepRemoteDelHist"
  | "uploadLocalToRemote" // "skipLocal && uploadLocalToRemote && cleanLocalDelHist && cleanRemoteDelHist"
  | "downloadRemoteToLocal"; // "downloadRemoteToLocal && skipRemote && cleanLocalDelHist && cleanRemoteDelHist"

type DecisionTypeForFileSize =
  | "skipUploadingTooLarge"
  | "skipDownloadingTooLarge"
  | "skipUsingLocalDelTooLarge"
  | "skipUsingRemoteDelTooLarge"
  | "errorLocalTooLargeConflictRemote"
  | "errorRemoteTooLargeConflictLocal";

type DecisionTypeForFileOneDriveEmpty = "skipUploadingOneDriveEmpty";

type DecisionTypeForFolder =
  | "createFolder"
  | "uploadLocalDelHistToRemoteFolder"
  | "keepRemoteDelHistFolder"
  | "skipFolder";

export type DecisionType =
  | DecisionTypeForFile
  | DecisionTypeForFileSize
  | DecisionTypeForFileOneDriveEmpty
  | DecisionTypeForFolder;

export interface FileOrFolderMixedState {
  key: string;
  existLocal?: boolean;
  existRemote?: boolean;
  mtimeLocal?: number;
  mtimeRemote?: number;
  deltimeLocal?: number;
  deltimeRemote?: number;
  sizeLocal?: number;
  sizeLocalEnc?: number;
  sizeRemote?: number;
  sizeRemoteEnc?: number;
  changeRemoteMtimeUsingMapping?: boolean;
  changeLocalMtimeUsingMapping?: boolean;
  decision?: DecisionType;
  syncDone?: "done";
  remoteEncryptedKey?: string;
  prevSync?: { mtime: number; size: number; keyType: "folder" | "file" };

  mtimeLocalFmt?: string;
  mtimeRemoteFmt?: string;
  deltimeLocalFmt?: string;
  deltimeRemoteFmt?: string;
}

export const API_VER_STAT_FOLDER = "0.13.27";
export const API_VER_REQURL = "0.13.26"; // desktop ver 0.13.26, iOS ver 1.1.1
export const API_VER_REQURL_ANDROID = "0.14.6"; // Android ver 1.2.1

export const VALID_REQURL =
  (!Platform.isAndroidApp &&
    !Platform.isMobileApp &&
    requireApiVersion(API_VER_REQURL)) ||
  (Platform.isAndroidApp && requireApiVersion(API_VER_REQURL_ANDROID)) ||
  (Platform.isMobileApp &&
    !Platform.isAndroidApp &&
    requireApiVersion(API_VER_REQURL)); // iOS uses the same version as desktop

export type SyncTriggerSourceType = "manual" | "auto" | "dry" | "autoOnceInit";

export type DeleteToWhereType = "system_trash" | "obsidian_trash";
export type ConflictActionType = "keep_newer" | "keep_larger";

export type SyncDirectionType =
  | "bidirectional"
  | "incremental_pull_and_delete_only"
  | "incremental_push_and_delete_only";

export interface SyncPlanType {
  ts: number;
  tsFmt?: string;
  syncTriggerSource?: SyncTriggerSourceType;
  remoteType: "onedrive";
  mixedStates: Record<string, FileOrFolderMixedState>;
}
