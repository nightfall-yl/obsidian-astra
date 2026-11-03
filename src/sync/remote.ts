/**
 * Trimmed to the OneDrive service only — astral-trek ports just that backend.
 */

import type { Vault } from "obsidian";

import type { OnedriveConfig } from "./baseTypes";
import * as onedrive from "./remoteForOnedrive";

/**
 * True only when the error is positive evidence that the remote item no longer
 * exists: HTTP 404 or Graph code "itemNotFound".
 *
 * Everything else — auth failures (401/403), throttling (429), server errors
 * (5xx), network failures with no response — must NOT be treated as deletion.
 * The API layer attaches `status` to thrown errors; reading those properties
 * keeps this predicate independent of the human-readable message.
 */
export const isRemoteItemNotFoundError = (err: unknown): boolean => {
  if (err === null || typeof err !== "object") {
    return false;
  }
  const e = err as { status?: unknown; code?: unknown };
  const status = typeof e.status === "number" ? e.status : undefined;
  const code = typeof e.code === "string" ? e.code : undefined;
  if (status !== undefined) {
    // Any HTTP status present is authoritative: only 404 means "gone".
    return status === 404;
  }
  return code === "itemNotFound";
};

export class RemoteClient {
  readonly serviceType: "onedrive";
  readonly onedriveClient?: onedrive.WrappedOnedriveClient;
  readonly onedriveConfig?: OnedriveConfig;

  constructor(
    serviceType: "onedrive",
    onedriveConfig?: OnedriveConfig,
    vaultName?: string,
    saveUpdatedConfigFunc?: () => Promise<void>
  ) {
    if (serviceType !== "onedrive") {
      throw Error(`not supported service type ${String(serviceType)}`);
    }
    this.serviceType = serviceType;
    // the client may modify the config inplace,
    // so we use a ref not a copy of config here
    if (vaultName === undefined || saveUpdatedConfigFunc === undefined) {
      throw Error(
        "remember to provide vault name and callback while init onedrive client"
      );
    }
    const remoteBaseDir = onedriveConfig?.remoteBaseDir || vaultName;
    this.onedriveConfig = onedriveConfig;
    this.onedriveClient = onedrive.getOnedriveClient(
      onedriveConfig ?? onedrive.DEFAULT_ONEDRIVE_CONFIG,
      remoteBaseDir,
      saveUpdatedConfigFunc
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
