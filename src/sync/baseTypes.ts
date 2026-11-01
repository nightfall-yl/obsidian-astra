/**
 * vendored from nightfall-yl/obsidian-third-party-sync@6240bcc (src/baseTypes.ts)
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
  /** 上次成功同步时的远端完整快照（key → RemoteItem）。用于 delta 续传时合并增量变化，
   *  避免每次全量枚举。delta 条目标记为 deleted 的项会从快照中移除。 */
  remoteSnapshot?: Record<string, RemoteItem>;
  username: string;
  credentialsShouldBeDeletedAtTime?: number;
  remoteBaseDir?: string;
}

export interface RemoteItem {
  key: string;
  lastModified: number;
  size: number;
  remoteType: "onedrive";
  etag?: string;
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
