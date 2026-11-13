/**
 * Trimmed to the OneDrive service only — astral-trek ports just that backend.
 */

import type { Vault } from "obsidian";

import type { OnedriveConfig } from "./baseTypes";
import * as onedrive from "./remoteForOnedrive";
import type { TokenStorage } from "./onedrive/auth/tokenStorage";
import type { DeviceCodeFlowClient } from "./onedrive/auth/deviceCodeFlow";

/**
 * True only when the error is positive evidence that the remote item no longer
 * exists: HTTP 404, HTTP 410, or Graph code "itemNotFound".
 *
 * OneDrive 410 是软删除（回收站）或租户 retention 策略触发，语义同物理删除；
 * 与 404 一并归类为「远端已不存在」，使 syncEngine 能安全摘除快照键、跳过条目。
 */
export const isRemoteItemNotFoundError = (err: unknown): boolean => {
  if (err === null || typeof err !== "object") {
    return false;
  }
  const e = err as { status?: unknown; code?: unknown };
  const status = typeof e.status === "number" ? e.status : undefined;
  const code = typeof e.code === "string" ? e.code : undefined;
  if (status !== undefined) {
    // Any HTTP status present is authoritative: 404 or 410 means "gone".
    return status === 404 || status === 410;
  }
  return code === "itemNotFound";
};

export class RemoteClient {
  readonly serviceType: "onedrive";
  readonly onedriveClient?: onedrive.WrappedOnedriveClient;
  readonly onedriveConfig?: OnedriveConfig;

  constructor(
    serviceType: "onedrive",
    onedriveConfig: OnedriveConfig | undefined,
    vaultName: string | undefined,
    tokenStorage: TokenStorage,
    flowClient: DeviceCodeFlowClient,
    saveSettingsCb?: () => Promise<void>
  ) {
    if (serviceType !== "onedrive") {
      throw Error(`not supported service type ${String(serviceType)}`);
    }
    if (!vaultName) {
      throw Error("remember to provide vault name while init onedrive client");
    }
    this.serviceType = serviceType;
    const remoteBaseDir = onedriveConfig?.remoteBaseDir || vaultName;
    this.onedriveConfig = onedriveConfig;
    this.onedriveClient = onedrive.getOnedriveClient(
      onedriveConfig ?? onedrive.DEFAULT_ONEDRIVE_CONFIG,
      remoteBaseDir,
      tokenStorage,
      flowClient,
      saveSettingsCb
    );
  }

  uploadToRemote = async (
    fileOrFolderPath: string,
    vault: Vault,
    isRecursively: boolean = false,
    password: string = "",
    remoteEncryptedKey: string = "",
    foldersCreatedBefore: Set<string> | undefined = undefined,
    uploadRaw: boolean = false,
    rawContent: string | ArrayBuffer = ""
  ) => {
    return await onedrive.uploadToRemote(
      this.onedriveClient as onedrive.WrappedOnedriveClient,
      fileOrFolderPath,
      vault,
      isRecursively,
      password,
      remoteEncryptedKey,
      foldersCreatedBefore,
      uploadRaw,
      rawContent
    );
  };

  listFromRemote = async (prefix?: string) => {
    return await onedrive.listFromRemote(
      this.onedriveClient as onedrive.WrappedOnedriveClient,
      prefix
    );
  };

  downloadFromRemote = async (
    fileOrFolderPath: string,
    vault: Vault,
    mtime: number,
    password: string = "",
    remoteEncryptedKey: string = "",
    skipSaving: boolean = false
  ) => {
    return await onedrive.downloadFromRemote(
      this.onedriveClient as onedrive.WrappedOnedriveClient,
      fileOrFolderPath,
      vault,
      mtime,
      password,
      remoteEncryptedKey,
      skipSaving
    );
  };

  deleteFromRemote = async (
    fileOrFolderPath: string,
    password: string = "",
    remoteEncryptedKey: string = ""
  ) => {
    return await onedrive.deleteFromRemote(
      this.onedriveClient as onedrive.WrappedOnedriveClient,
      fileOrFolderPath,
      password,
      remoteEncryptedKey
    );
  };

  /** Forget one entry in the persisted remote snapshot (per-key delete). */
  removeFromRemoteSnapshot = async (key: string) => {
    return await onedrive.removeFromRemoteSnapshot(key);
  };

  checkConnectivity = async (callbackFunc?: (err?: unknown) => void) => {
    return await onedrive.checkConnectivity(
      this.onedriveClient as onedrive.WrappedOnedriveClient,
      callbackFunc
    );
  };

  getUser = async () => {
    return await onedrive.getUserDisplayName(
      this.onedriveClient as onedrive.WrappedOnedriveClient
    );
  };

  revokeAuth = async () => {
    // OneDrive doesn't need revoke in this context
    return;
  };
}
