/**
 * V3 sync engine (prevSync-based three-way merge), remote-agnostic.
 *
 * Adaptations for astral-trek (zero new npm dependencies):
 * - `p-queue` → local TaskQueue, `aggregate-error` → local MultiError;
 * - upstream `log` → local syncLog;
 * - strict-mode fixes (noUncheckedIndexedAccess) and explicit types;
 * - getRemoteStates: entries whose encrypted key fails to decrypt are skipped
 *   with a warning instead of aborting the whole sync (upstream threw) — this
 *   keeps sync usable after toggling encryption on an already-synced remote.
 */

import type {
  TAbstractFile,
  Vault} from "obsidian";
import {
  TFile,
  TFolder
} from "obsidian";

import type {
  ConflictActionType,
  DecisionType,
  FileOrFolderMixedState,
  RemoteItem,
  SyncDirectionType,
  SyncPlanType,
  SyncTriggerSourceType,
} from "./baseTypes";
import {
  decryptBase64urlToString,
  encryptStringToBase64url,
  getSizeFromOrigToEnc,
} from "./encrypt";
import type {
  FileFolderHistoryRecord,
  InternalDBs,
  PrevSyncRecord,
} from "./localdb";
import {
  clearDeleteRenameHistoryOfKeyAndVault,
  getSyncMetaMappingByRemoteKeyAndVault,
  savePrevSyncRecordsByVault,
  upsertSyncMetaMappingDataByVault,
} from "./localdb";
import {
  atWhichLevel,
  getParentFolder,
  isHiddenPath,
  mkdirpInVault,
  unixTimeToStr,
} from "./misc";
import { MultiError, TaskQueue } from "./queue";
import type { RemoteClient } from "./remote";
import { isRemoteItemNotFoundError } from "./remote";
import type {
  DeletionOnRemote,
  MetadataOnRemote} from "./metadataOnRemote";
import {
  DEFAULT_FILE_NAME_FOR_METADATAONREMOTE,
  DEFAULT_FILE_NAME_FOR_METADATAONREMOTE2,
  LEGACY_FILE_NAME_FOR_METADATAONREMOTE,
  LEGACY_FILE_NAME_FOR_METADATAONREMOTE2,
  FILE_NAME_FOR_BOOKMARK_FILE,
  FILE_NAME_FOR_DATA_JSON,
  serializeMetadataOnRemote,
  deserializeMetadataOnRemote,
} from "./metadataOnRemote";
import { isInsideObsFolder, isInsideTrashFolder, type ObsConfigDirFileType } from "./obsFolderLister";

import { syncLog } from "./log";

export type SyncStatusType =
  | "idle"
  | "preparing"
  | "getting_remote_files_list"
  | "getting_remote_extra_meta"
  | "getting_local_meta"
  | "checking_password"
  | "generating_plan"
  | "syncing"
  | "cleaning"
  | "finish";

export interface PasswordCheckType {
  ok: boolean;
  reason:
    | "ok"
    | "empty_remote"
    | "password_matched"
    | "password_not_matched"
    | "invalid_text_after_decryption"
    | "remote_not_encrypted_local_has_password"
    | "no_password_both_sides";
}

export const isPasswordOk = async (
  remote: RemoteItem[],
  password: string = ""
) => {
  if (remote === undefined || remote.length === 0) {
    // remote empty
    return {
      ok: true,
      reason: "empty_remote",
    } as PasswordCheckType;
  }

  // Check if metadata is stored unencrypted if the password is blank.
  // Support both remotely-sync and legacy remotely-save metadata file names.
  const remoteHasAnyPlainMetadata = remote.some(
    (item) =>
      item.key === DEFAULT_FILE_NAME_FOR_METADATAONREMOTE ||
      item.key === DEFAULT_FILE_NAME_FOR_METADATAONREMOTE2 ||
      item.key === LEGACY_FILE_NAME_FOR_METADATAONREMOTE ||
      item.key === LEGACY_FILE_NAME_FOR_METADATAONREMOTE2
  );
  syncLog.debug(
    "password is blank? ",
    password == "",
    " remote has metadata? ",
    remoteHasAnyPlainMetadata
  );

  if (password == "") {
    // No password: check if remote has unencrypted metadata
    if (remoteHasAnyPlainMetadata) {
      return {
        ok: true,
        reason: "no_password_both_sides",
      } as PasswordCheckType;
    }
    // No password and no metadata - could be empty vault or all files unencrypted
    // Try to find any file that could be metadata (not base64 encoded)
    const couldBeMetadata = remote.some(
      (item) => !item.key.includes(".") || item.key.endsWith(".json")
    );
    if (couldBeMetadata) {
      return {
        ok: true,
        reason: "no_password_both_sides",
      } as PasswordCheckType;
    }
    // Can't determine, but let sync continue
    return {
      ok: true,
      reason: "no_password_both_sides",
    } as PasswordCheckType;
  }

  // Has password: try to decrypt first file's key
  const sanityCheckKey = remote[0]?.key;
  if (sanityCheckKey === undefined) {
    return {
      ok: true,
      reason: "empty_remote",
    } as PasswordCheckType;
  }
  try {
    await decryptBase64urlToString(sanityCheckKey, password);

    return {
      ok: true,
      reason: "password_matched",
    } as PasswordCheckType;
  } catch {
    return {
      ok: false,
      reason: "password_not_matched",
    } as PasswordCheckType;
  }
};

export const getRemoteMetadata = async (
  remote: RemoteItem[],
  client: RemoteClient,
  password: string = ""
) => {
  if (remote === undefined) return undefined;

  // Get all metadata files
  let metadataFiles: FileOrFolderMixedState[] = [];

  for (const entry of remote) {
    const remoteEncryptedKey = entry.key;

    let key = remoteEncryptedKey;

    if (password !== "") {
      try {
        key = await decryptBase64urlToString(remoteEncryptedKey, password);
      } catch (err) {
        syncLog.warn(
          `skip remote item whose key cannot be decrypted: ${remoteEncryptedKey}`,
          err
        );
        continue;
      }
    }

    if (
      key === DEFAULT_FILE_NAME_FOR_METADATAONREMOTE ||
      key === LEGACY_FILE_NAME_FOR_METADATAONREMOTE
    ) {
      metadataFiles.push({
        key: key,
        existRemote: true,
        mtimeRemote: entry.lastModified,
        mtimeRemoteFmt: unixTimeToStr(entry.lastModified),
        sizeRemote: password === "" ? entry.size : undefined,
        sizeRemoteEnc: password === "" ? undefined : entry.size,
        remoteEncryptedKey: remoteEncryptedKey,
        changeRemoteMtimeUsingMapping: false,
      });
    }
  }

  // Delete older duplicate metadata files. Keep legacy/new formats if both exist,
  // and only clean up exact duplicates of the same metadata name.
  if (metadataFiles.length > 1) {
    metadataFiles = metadataFiles.sort(
      (a, b) => (b.mtimeRemote ?? 0) - (a.mtimeRemote ?? 0)
    );

    const keepByKey = new Set<string>();
    metadataFiles.forEach((file) => {
      if (!keepByKey.has(file.key)) {
        keepByKey.add(file.key);
        return;
      }
      void client.deleteFromRemote(file.key, password, file.remoteEncryptedKey ?? "");
    });
  }

  // Return the latest modified metadata file
  return metadataFiles[0];
};

export const getRemoteStates = async (
  remote: RemoteItem[],
  db: InternalDBs,
  vaultRandomID: string,
  remoteType: "onedrive",
  password: string = ""
) => {
  const remoteStates = [] as FileOrFolderMixedState[];

  if (remote === undefined) {
    return remoteStates;
  }

  for (const entry of remote) {
    const remoteEncryptedKey = entry.key;

    let key = remoteEncryptedKey;

    if (password !== "") {
      try {
        key = await decryptBase64urlToString(remoteEncryptedKey, password);
      } catch (err) {
        // e.g. a leftover plaintext file from before encryption was enabled:
        // warn and skip instead of aborting the whole sync.
        syncLog.warn(
          `skip remote item whose key cannot be decrypted: ${remoteEncryptedKey}`,
          err
        );
        continue;
      }
    }

    const backwardMapping = await getSyncMetaMappingByRemoteKeyAndVault(
      remoteType,
      db,
      key,
      entry.lastModified,
      entry.etag ?? "",
      vaultRandomID
    );

    let r: FileOrFolderMixedState;

    if (backwardMapping !== undefined) {
      key = backwardMapping.localKey;
      const mtimeRemote =
        (backwardMapping.localMtime) || entry.lastModified;

      // the backwardMapping.localSize is the file BEFORE encryption
      // we want to split two sizes for comparation later

      r = {
        key: key,
        existRemote: true,
        mtimeRemote: mtimeRemote,
        mtimeRemoteFmt: unixTimeToStr(mtimeRemote),
        sizeRemote: backwardMapping.localSize,
        sizeRemoteEnc: password === "" ? undefined : entry.size,
        remoteEncryptedKey: remoteEncryptedKey,
        changeRemoteMtimeUsingMapping: true,
      };
    } else {
      // do not have backwardMapping
      r = {
        key: key,
        existRemote: true,
        mtimeRemote: entry.lastModified,
        mtimeRemoteFmt: unixTimeToStr(entry.lastModified),
        sizeRemote: password === "" ? entry.size : undefined,
        sizeRemoteEnc: password === "" ? undefined : entry.size,
        remoteEncryptedKey: remoteEncryptedKey,
        changeRemoteMtimeUsingMapping: false,
      };
    }

    remoteStates.push(r);
  }

  return remoteStates;
};

export const fetchMetadataFile = async (
  metadataFile: FileOrFolderMixedState,
  client: RemoteClient,
  vault: Vault,
  password: string = ""
) => {
  if (metadataFile === undefined) {
    syncLog.debug("no metadata file, so no fetch");
    return {
      deletions: [],
    } as MetadataOnRemote;
  }

  const buf = await client.downloadFromRemote(
    metadataFile.key,
    vault,
    metadataFile.mtimeRemote ?? 0,
    password,
    metadataFile.remoteEncryptedKey ?? "",
    true
  );
  const metadata = deserializeMetadataOnRemote(buf);
  return metadata;
};

/**
 * Extract actionable details from a remote sync error.
 */
const extractRemoteErrorDetails = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return JSON.stringify(error);
  }
  const message = error.message;
  const err = error as unknown as Record<string, unknown>;
  const extras: string[] = [];
  if (typeof err.Code === "string") {
    extras.push(`code=${err.Code}`);
  }
  if (error.name && error.name !== "Error") {
    extras.push(`type=${error.name}`);
  }
  return extras.length > 0 ? `${message} (${extras.join(", ")})` : message;
};

const isSkipItem = (
  key: string,
  syncConfigDir: boolean,
  syncUnderscoreItems: boolean,
  syncTrashDir: boolean,
  syncBookmarks: boolean,
  configDir: string
) => {
  const isBookmarkFile = key === configDir + FILE_NAME_FOR_BOOKMARK_FILE;
  if (isBookmarkFile) {
    return !syncBookmarks;
  }

  if (syncConfigDir && isInsideObsFolder(key, configDir)) {
    // Special exception for the sync plugin's own data.json file - always skip.
    // No point to sync our plugin settings, causes endless syncing because we
    // persist last sync time
    if (
      key ==
      configDir + "/plugins/astral-trek/" + FILE_NAME_FOR_DATA_JSON
    ) {
      return true;
    }
    return false;
  }

  if (syncTrashDir && isInsideTrashFolder(key)) {
    return true;
  }

  // Always skip metadata files - they are managed by the plugin itself
  if (
    key === DEFAULT_FILE_NAME_FOR_METADATAONREMOTE ||
    key === DEFAULT_FILE_NAME_FOR_METADATAONREMOTE2 ||
    key === LEGACY_FILE_NAME_FOR_METADATAONREMOTE ||
    key === LEGACY_FILE_NAME_FOR_METADATAONREMOTE2
  ) {
    return true;
  }

  const shouldSkip =
    isHiddenPath(key, true, false) ||
    (!syncUnderscoreItems && isHiddenPath(key, false, true));
  return shouldSkip;
};

const ensembleMixedStates = async (
  remoteStates: FileOrFolderMixedState[],
  local: TAbstractFile[],
  localConfigDirContents: ObsConfigDirFileType[] | undefined,
  remoteDeleteHistory: DeletionOnRemote[],
  localFileHistory: FileFolderHistoryRecord[],
  syncConfigDir: boolean,
  syncTrashDir: boolean,
  syncBookmarks: boolean,
  configDir: string,
  syncUnderscoreItems: boolean,
  password: string
) => {
  const results = {} as Record<string, FileOrFolderMixedState>;

  for (const r of remoteStates) {
    const key = r.key;

    if (
      isSkipItem(
        key,
        syncConfigDir,
        syncUnderscoreItems,
        syncTrashDir,
        syncBookmarks,
        configDir
      )
    ) {
      continue;
    }
    r.existLocal = false;
    results[key] = r;
  }

  for (const entry of local) {
    let r: FileOrFolderMixedState;
    let key = entry.path;

    if (entry.path === "/") {
      // ignore
      continue;
    } else if (entry instanceof TFile) {
      const mtimeLocal = Math.max(entry.stat.mtime ?? 0, entry.stat.ctime ?? 0);
      r = {
        key: entry.path,
        existLocal: true,
        mtimeLocal: mtimeLocal,
        mtimeLocalFmt: unixTimeToStr(mtimeLocal),
        sizeLocal: entry.stat.size,
        sizeLocalEnc:
          password === "" ? undefined : getSizeFromOrigToEnc(entry.stat.size),
      };
    } else if (entry instanceof TFolder) {
      key = `${entry.path}/`;
      r = {
        key: key,
        existLocal: true,
        mtimeLocal: undefined,
        mtimeLocalFmt: undefined,
        sizeLocal: 0,
        sizeLocalEnc: password === "" ? undefined : getSizeFromOrigToEnc(0),
      };
    } else {
      throw Error(`unexpected ${JSON.stringify(entry)}`);
    }

    if (
      isSkipItem(
        key,
        syncConfigDir,
        syncUnderscoreItems,
        syncTrashDir,
        syncBookmarks,
        configDir
      )
    ) {
      continue;
    }

    const cur = results[key];
    if (cur !== undefined) {
      cur.key = r.key;
      cur.existLocal = r.existLocal;
      cur.mtimeLocal = r.mtimeLocal;
      cur.mtimeLocalFmt = r.mtimeLocalFmt;
      cur.sizeLocal = r.sizeLocal;
      cur.sizeLocalEnc = r.sizeLocalEnc;
    } else {
      r.existRemote = false;
      results[key] = r;
    }
  }

  if (localConfigDirContents !== undefined) {
    for (const entry of localConfigDirContents) {
      const key = entry.key;
      const isBookmarkFile = key === configDir + FILE_NAME_FOR_BOOKMARK_FILE;
      // If we're not syncing the config dir, only keep bookmark file when
      // bookmark sync is enabled.
      if (!syncConfigDir && !(syncBookmarks && isBookmarkFile)) {
        continue;
      }
      let mtimeLocal: number | undefined = Math.max(
        entry.mtime ?? 0,
        entry.ctime ?? 0
      );
      if (Number.isNaN(mtimeLocal) || mtimeLocal === 0) {
        mtimeLocal = undefined;
      }
      const r: FileOrFolderMixedState = {
        key: key,
        existLocal: true,
        mtimeLocal: mtimeLocal,
        mtimeLocalFmt: unixTimeToStr(mtimeLocal),
        sizeLocal: entry.size,
        sizeLocalEnc:
          password === "" ? undefined : getSizeFromOrigToEnc(entry.size),
      };

      const cur = results[key];
      if (cur !== undefined) {
        cur.key = r.key;
        cur.existLocal = r.existLocal;
        cur.mtimeLocal = r.mtimeLocal;
        cur.mtimeLocalFmt = r.mtimeLocalFmt;
        cur.sizeLocal = r.sizeLocal;
        cur.sizeLocalEnc = r.sizeLocalEnc;
      } else {
        r.existRemote = false;
        results[key] = r;
      }
    }
  }

  for (const entry of remoteDeleteHistory) {
    const key = entry.key;
    const r = {
      key: key,
      deltimeRemote: entry.actionWhen,
      deltimeRemoteFmt: unixTimeToStr(entry.actionWhen),
    } as FileOrFolderMixedState;

    if (
      isSkipItem(
        key,
        syncConfigDir,
        syncUnderscoreItems,
        syncTrashDir,
        syncBookmarks,
        configDir
      )
    ) {
      continue;
    }

    const cur = results[key];
    if (cur !== undefined) {
      cur.key = r.key;
      cur.deltimeRemote = r.deltimeRemote;
      cur.deltimeRemoteFmt = r.deltimeRemoteFmt;
    } else {
      r.existLocal = false;
      r.existRemote = false;
      results[key] = r;
    }
  }

  for (const entry of localFileHistory) {
    let key = entry.key;
    if (entry.keyType === "folder") {
      if (!entry.key.endsWith("/")) {
        key = `${entry.key}/`;
      }
    } else if (entry.keyType === "file") {
      // pass
    } else {
      throw Error(`unexpected ${JSON.stringify(entry)}`);
    }

    if (
      isSkipItem(
        key,
        syncConfigDir,
        syncUnderscoreItems,
        syncTrashDir,
        syncBookmarks,
        configDir
      )
    ) {
      continue;
    }

    if (entry.actionType === "delete" || entry.actionType === "rename") {
      const r = {
        key: key,
        deltimeLocal: entry.actionWhen,
        deltimeLocalFmt: unixTimeToStr(entry.actionWhen),
      } as FileOrFolderMixedState;

      const cur = results[key];
      if (cur !== undefined) {
        cur.deltimeLocal = r.deltimeLocal;
        cur.deltimeLocalFmt = r.deltimeLocalFmt;
      } else {
        r.existLocal = false; // we have already checked local
        r.existRemote = false; // we have already checked remote
        results[key] = r;
      }
    } else if (entry.actionType === "renameDestination") {
      const r = {
        key: key,
        mtimeLocal: entry.actionWhen,
        mtimeLocalFmt: unixTimeToStr(entry.actionWhen),
        changeLocalMtimeUsingMapping: true,
      };
      const cur = results[key];
      if (cur !== undefined) {
        let mtimeLocal: number | undefined = Math.max(
          r.mtimeLocal ?? 0,
          cur.mtimeLocal ?? 0
        );
        if (Number.isNaN(mtimeLocal) || mtimeLocal === 0) {
          mtimeLocal = undefined;
        }
        cur.mtimeLocal = mtimeLocal;
        cur.mtimeLocalFmt = unixTimeToStr(mtimeLocal);
        cur.changeLocalMtimeUsingMapping = r.changeLocalMtimeUsingMapping;
      } else {
        // So, the file doesn't exist,
        // except that it existed in the "renamed to" history records.
        // Most likely because that the user deleted the file while Obsidian
        // was closed, so Obsidian could not track the deletions.
        // We are not sure how to deal with this, so do not generate anything
        // here!
      }
    } else {
      throw Error(
        `do not know how to deal with local file history ${entry.key} with ${String(
          entry.actionType
        )}`
      );
    }
  }

  return results;
};

const DELETION_DECISIONS: Set<DecisionType> = new Set([
  "uploadLocalDelHistToRemote",
  "keepRemoteDelHist",
  "uploadLocalDelHistToRemoteFolder",
  "keepRemoteDelHistFolder",
]);
const SIZES_GO_WRONG_DECISIONS: Set<DecisionType> = new Set([
  "errorLocalTooLargeConflictRemote",
  "errorRemoteTooLargeConflictLocal",
]);

export const getSyncPlanV3 = async (
  remoteStates: FileOrFolderMixedState[],
  local: TAbstractFile[],
  localConfigDirContents: ObsConfigDirFileType[] | undefined,
  prevSyncRecords: PrevSyncRecord[],
  remoteType: "onedrive",
  triggerSource: SyncTriggerSourceType,
  vault: Vault,
  syncConfigDir: boolean,
  syncTrashDir: boolean,
  syncBookmarks: boolean,
  configDir: string,
  syncUnderscoreItems: boolean,
  skipSizeLargerThan: number,
  password: string = "",
  syncDirection: SyncDirectionType = "bidirectional",
  conflictAction: ConflictActionType = "keep_newer"
) => {
  // Build prevSync map for quick lookup
  const prevSyncMap = new Map<string, PrevSyncRecord>();
  for (const record of prevSyncRecords) {
    prevSyncMap.set(record.key, record);
  }

  // Get mixed states from local and remote (without delete history)
  const mixedStates = await ensembleMixedStates(
    remoteStates,
    local,
    localConfigDirContents,
    [], // no remote delete history in V3
    [], // no local file history in V3
    syncConfigDir,
    syncTrashDir,
    syncBookmarks,
    configDir,
    syncUnderscoreItems,
    password
  );

  // Add prevSync info to mixed states
  for (const [key, record] of prevSyncMap) {
    if (mixedStates[key] === undefined) {
      // File existed in prevSync but not in local or remote now
      mixedStates[key] = {
        key: key,
        existLocal: false,
        existRemote: false,
      };
    }
    // Mark that this file was in prevSync
    const state = mixedStates[key];
    if (state !== undefined) {
      state.prevSync = record;
    }
  }

  const sortedKeys = Object.keys(mixedStates).sort(
    (k1, k2) => k2.length - k1.length
  );

  const sizesGoWrong: FileOrFolderMixedState[] = [];
  const deletions: DeletionOnRemote[] = [];

  const keptFolder = new Set<string>();
  for (let i = 0; i < sortedKeys.length; ++i) {
    const key = sortedKeys[i] as string;
    const val = mixedStates[key];
    if (val === undefined) {
      continue;
    }

    if (key.endsWith("/")) {
      await assignOperationToFolderInplaceV3(
        val,
        keptFolder,
        vault,
        password,
        syncDirection
      );
    } else {
      assignOperationToFileInplaceV3(
        val,
        keptFolder,
        skipSizeLargerThan,
        password,
        syncDirection,
        conflictAction,
        remoteType
      );
    }

    if (
      val.decision !== undefined &&
      SIZES_GO_WRONG_DECISIONS.has(val.decision)
    ) {
      sizesGoWrong.push(val);
    }

    if (val.decision !== undefined && DELETION_DECISIONS.has(val.decision)) {
      if (
        val.decision === "uploadLocalDelHistToRemote" ||
        val.decision === "keepRemoteDelHist" ||
        val.decision === "uploadLocalDelHistToRemoteFolder" ||
        val.decision === "keepRemoteDelHistFolder"
      ) {
        deletions.push({
          key: key,
          actionWhen: Date.now(),
        });
      } else {
        throw Error(`do not know how to delete for decision ${val.decision}`);
      }
    }
  }

  const currTs = Date.now();
  const currTsFmt = unixTimeToStr(currTs);
  const plan = {
    ts: currTs,
    tsFmt: currTsFmt,
    remoteType: remoteType,
    syncTriggerSource: triggerSource,
    mixedStates: mixedStates,
  } as SyncPlanType;
  return {
    plan: plan,
    sortedKeys: sortedKeys,
    deletions: deletions,
    sizesGoWrong: sizesGoWrong,
  };
};

/**
 * The pure per-file decision function of the V3 three-way merge.
 * Exported for unit tests.
 */
export const assignOperationToFileInplaceV3Inner = (
  origRecord: FileOrFolderMixedState,
  keptFolder: Set<string>,
  password: string = "",
  syncDirection: SyncDirectionType = "bidirectional",
  conflictAction: ConflictActionType = "keep_newer"
) => {
  let r = origRecord;

  if (r.key.endsWith("/")) {
    return r;
  }

  const existLocal = r.existLocal ?? false;
  const existRemote = r.existRemote ?? false;
  const existPrevSync = r.prevSync !== undefined;

  const isPullOnlyMode = syncDirection === "incremental_pull_and_delete_only";
  const isPushOnlyMode = syncDirection === "incremental_push_and_delete_only";
  const isPullDeleteMode = syncDirection === "incremental_pull_and_delete_only";
  const isPushDeleteMode = syncDirection === "incremental_push_and_delete_only";

  const sizeLocalComp = password === "" ? r.sizeLocal : r.sizeLocalEnc;
  const sizeRemoteComp = password === "" ? r.sizeRemote : r.sizeRemoteEnc;

  // Sanity checks
  if (existLocal && (r.mtimeLocal === undefined || r.mtimeLocal <= 0)) {
    throw Error(
      `Error: Abnormal last modified time locally: ${JSON.stringify(r, null, 2)}`
    );
  }
  if (existRemote && (r.mtimeRemote === undefined || r.mtimeRemote <= 0)) {
    throw Error(
      `Error: Abnormal last modified time remotely: ${JSON.stringify(r, null, 2)}`
    );
  }

  // V3 Three-way merge logic
  // Cases:
  // 1. local + remote + prevSync -> compare mtimes
  // 2. local + !remote + prevSync -> remote deleted
  // 3. !local + remote + prevSync -> local deleted
  // 4. local + !remote + !prevSync -> new local file, upload
  // 5. !local + remote + !prevSync -> new remote file, download
  // 6. !local + !remote + prevSync -> both deleted, skip

  if (existLocal && existRemote) {
    // Genuine conflict: both sides changed since the last sync (three-way
    // detection via prevSync). Bidirectional only. keep_newer (default) is
    // exactly the mtime flow below; keep_larger lets the bigger file win
    // (equal sizes fall through to the normal mtime flow).
    if (
      conflictAction === "keep_larger" &&
      !isPushOnlyMode &&
      !isPullOnlyMode &&
      r.prevSync !== undefined &&
      r.mtimeLocal !== undefined &&
      r.mtimeRemote !== undefined &&
      r.mtimeLocal > r.prevSync.mtime &&
      r.mtimeRemote > r.prevSync.mtime &&
      sizeLocalComp !== undefined &&
      sizeRemoteComp !== undefined &&
      sizeLocalComp !== sizeRemoteComp
    ) {
      if (sizeLocalComp > sizeRemoteComp) {
        r.decision = "uploadLocalToRemote";
      } else {
        r.decision = "downloadRemoteToLocal";
      }
      keptFolder.add(getParentFolder(r.key));
      return r;
    }
    // No-baseline creation conflicts (both sides exist, prevSync has no
    // record — e.g. auto-created daily journal files racing across two
    // devices): a brand-new EMPTY local file must not silently overwrite
    // a non-empty remote copy just because its mtime is newer, no matter
    // which conflict resolution is chosen. Symmetrically, an empty remote
    // file should not shadow a non-empty local one; in encrypted mode the
    // remote plaintext size is unknowable, so that check is limited to
    // plaintext syncs. Bidirectional with conflict resolution only.
    if (
      !isPushOnlyMode &&
      !isPullOnlyMode &&
      r.prevSync === undefined &&
      r.sizeLocal !== undefined &&
      r.sizeRemote !== undefined &&
      sizeLocalComp !== undefined &&
      sizeRemoteComp !== undefined
    ) {
      if (r.sizeLocal === 0 && (password !== "" || sizeRemoteComp > 0)) {
        r.decision = "downloadRemoteToLocal";
        keptFolder.add(getParentFolder(r.key));
        return r;
      }
      if (password === "" && sizeRemoteComp === 0 && sizeLocalComp > 0) {
        r.decision = "uploadLocalToRemote";
        keptFolder.add(getParentFolder(r.key));
        return r;
      }
    }
    // Both exist - compare mtimes
    if (r.mtimeLocal === r.mtimeRemote) {
      if (sizeLocalComp === sizeRemoteComp) {
        r.decision = "skipUploading";
      } else {
        // Same mtime but different sizes: ambiguous content. Pull modes
        // take the remote copy (they never write to remote); push and
        // bidirectional modes push the local copy up.
        if (isPullOnlyMode) {
          r.decision = "downloadRemoteToLocal";
        } else {
          r.decision = "uploadLocalToRemote";
        }
      }
    } else if ((r.mtimeLocal ?? 0) > (r.mtimeRemote ?? 0)) {
      // Local is newer
      if (isPullOnlyMode) {
        r.decision = "skipUploading";
      } else {
        r.decision = "uploadLocalToRemote";
      }
    } else {
      // Remote is newer
      if (isPushOnlyMode) {
        r.decision = "skipUploading";
      } else {
        r.decision = "downloadRemoteToLocal";
      }
    }
    keptFolder.add(getParentFolder(r.key));
    return r;
  }

  if (existLocal && !existRemote) {
    if (existPrevSync) {
      // Remote was deleted
      if (isPullDeleteMode) {
        // In pull-and-delete mode, remote deletion should propagate to local
        r.decision = "keepRemoteDelHist";
      } else if (isPushOnlyMode) {
        // Push modes (push_only and push_and_delete alike): local is the
        // source of truth and the remote is only a bridge/target. A file
        // that has vanished remotely — no matter why — is pushed again as
        // long as it still exists locally.
        r.decision = "uploadLocalToRemote";
        keptFolder.add(getParentFolder(r.key));
      } else if (isPullOnlyMode) {
        // Pull-only: remote deletion must NOT delete the local copy — the
        // local vault only accumulates. The file stays local-only and is
        // never uploaded.
        r.decision = "skipUploading";
      } else {
        // Bidirectional: remote deleted, delete local too
        r.decision = "keepRemoteDelHist";
      }
    } else {
      // New local file, upload to remote
      if (isPullOnlyMode) {
        // Pull modes: local-only file stays local; do NOT mark its parent
        // folder as must-be-kept, otherwise the folder decision would push
        // the folder to remote
        r.decision = "skipUploading";
      } else {
        r.decision = "uploadLocalToRemote";
        keptFolder.add(getParentFolder(r.key));
      }
    }
    return r;
  }

  if (!existLocal && existRemote) {
    if (existPrevSync) {
      // Local was deleted
      if (isPullDeleteMode && !isPushOnlyMode) {
        // In pull-and-delete mode, keep remote (don't delete)
        r.decision = "skipUploading";
      } else if (isPushDeleteMode) {
        // In push-and-delete mode, local deletion propagates to remote
        r.decision = "uploadLocalDelHistToRemote";
      } else if (isPullOnlyMode) {
        // Pull-only without delete: download remote
        r.decision = "downloadRemoteToLocal";
      } else if (isPushOnlyMode) {
        // Push-only (backup mode): local deletion must NOT propagate to
        // remote, and nothing may be downloaded either
        r.decision = "skipUploading";
      } else {
        // Bidirectional: local deleted, delete remote too
        r.decision = "uploadLocalDelHistToRemote";
      }
    } else {
      // New remote file, download to local
      if (isPushOnlyMode) {
        // Push-only: never download remote-only content, and do NOT mark
        // its parent folder as must-be-kept, otherwise the folder decision
        // would recreate the folder locally as an empty shell
        r.decision = "skipUploading";
      } else {
        r.decision = "downloadRemoteToLocal";
        keptFolder.add(getParentFolder(r.key));
      }
    }
    return r;
  }

  if (!existLocal && !existRemote && existPrevSync) {
    // Both deleted
    r.decision = "skipUploading";
    return r;
  }

  if (!existLocal && !existRemote && !existPrevSync) {
    // Should not happen, but skip just in case
    r.decision = "skipUploading";
    return r;
  }

  throw Error(`no decision for ${JSON.stringify(r)}`);
};

const assignOperationToFileInplaceV3 = (
  origRecord: FileOrFolderMixedState,
  keptFolder: Set<string>,
  skipSizeLargerThan: number,
  password: string = "",
  syncDirection: SyncDirectionType = "bidirectional",
  conflictAction: ConflictActionType = "keep_newer",
  remoteType: "onedrive" = "onedrive"
) => {
  const r = assignOperationToFileInplaceV3Inner(
    origRecord,
    keptFolder,
    password,
    syncDirection,
    conflictAction
  );
  // Size limit post-processing. The setting stores BYTES (the settings
  // dropdown offers MB values multiplied back to bytes). Files over the
  // limit are never uploaded or downloaded; when exactly one side is over
  // the limit while the other stays within it, surface a conflict so the
  // sizes-conflict modal can resolve it. Mirrors the legacy planner's
  // decision matrix (branches 18-27).
  if (skipSizeLargerThan > 0 && !r.key.endsWith("/")) {
    const sizeLocalComp = password === "" ? r.sizeLocal : r.sizeLocalEnc;
    const sizeRemoteComp = password === "" ? r.sizeRemote : r.sizeRemoteEnc;
    const localTooLarge =
      sizeLocalComp !== undefined && sizeLocalComp > skipSizeLargerThan;
    const remoteTooLarge =
      sizeRemoteComp !== undefined && sizeRemoteComp > skipSizeLargerThan;
    if (r.decision === "uploadLocalToRemote") {
      if (localTooLarge) {
        r.decision =
          remoteTooLarge || sizeRemoteComp === undefined
            ? "skipUploadingTooLarge"
            : "errorLocalTooLargeConflictRemote";
      } else if (remoteTooLarge) {
        r.decision = "errorRemoteTooLargeConflictLocal";
      }
    } else if (r.decision === "downloadRemoteToLocal") {
      if (remoteTooLarge) {
        r.decision = localTooLarge
          ? "skipDownloadingTooLarge"
          : "errorRemoteTooLargeConflictLocal";
      }
    }
  }

  // OneDrive cannot store 0-byte files without E2E encryption (upstream
  // limitation; encrypted payloads are never empty). Skip at the planning
  // stage with a decision that is NEVER saved to prevSync, so the next sync
  // still sees "local-only, never synced" instead of misreading the missing
  // remote copy as a remote deletion (which would trash the local empty file
  // in bidirectional mode). The stable loop is: upload planned -> skipped ->
  // no record -> replanned next time; the file simply stays local.
  if (
    remoteType === "onedrive" &&
    password === "" &&
    r.decision === "uploadLocalToRemote" &&
    r.sizeLocal === 0
  ) {
    r.decision = "skipUploadingOneDriveEmpty";
  }
  // Root-fix option for the OneDrive empty-file limitation: create the file
  // via Graph API JSON body instead of content upload
  // (POST /drive/items/{parent}/children with {"name": ..., "file": {}}),
  // then remove this skip. Needs verification against a live OneDrive.
  return r;
};

const assignOperationToFolderInplaceV3 = async (
  origRecord: FileOrFolderMixedState,
  keptFolder: Set<string>,
  _vault: Vault,
  _password: string = "",
  _syncDirection: SyncDirectionType = "bidirectional"
) => {
  const r = origRecord;

  if (!r.key.endsWith("/")) {
    return r;
  }

  const existLocal = r.existLocal ?? false;
  const existRemote = r.existRemote ?? false;
  const existPrevSync = r.prevSync !== undefined;

  const isPullOnlyMode =
    _syncDirection === "incremental_pull_and_delete_only";
  const isPushOnlyMode =
    _syncDirection === "incremental_push_and_delete_only";
  const isPullDeleteMode = _syncDirection === "incremental_pull_and_delete_only";
  const isPushDeleteMode = _syncDirection === "incremental_push_and_delete_only";

  if (!keptFolder.has(r.key)) {
    // Folder does NOT have any must-be-kept children

    if (existLocal && existRemote) {
      r.decision = "skipFolder";
    } else if (existLocal && !existRemote) {
      if (isPullDeleteMode && existPrevSync) {
        // Pull-and-delete: remote deletion propagates to local
        r.decision = "keepRemoteDelHistFolder";
      } else if (isPullOnlyMode) {
        // Pull modes never write to remote: a locally-created folder stays
        // local-only. In pull-only mode a remotely-deleted folder also keeps
        // its local copy (the local vault only accumulates).
        r.decision = "skipFolder";
      } else if (existPrevSync && !isPushOnlyMode) {
        // Bidirectional: remote deleted the folder; propagate to local
        r.decision = "keepRemoteDelHistFolder";
      } else {
        // Push modes re-push the local folder to remote
        r.decision = "createFolder";
      }
    } else if (!existLocal && existRemote) {
      if (isPushDeleteMode && existPrevSync) {
        // Local deleted the folder; in push-and-delete mode the deletion
        // propagates to remote
        r.decision = "uploadLocalDelHistToRemoteFolder";
      } else if (isPushOnlyMode) {
        // Push modes: remote is only a push target/backup, never pull
        // remote-only folder structure back into the local vault
        r.decision = "skipFolder";
      } else if (isPullDeleteMode && existPrevSync) {
        // In pull-and-delete mode a local folder deletion is intentional
        // and must not resurrect as an empty shell (files inside are also
        // skipped via branch 65); the remote copy stays untouched
        r.decision = "skipFolder";
      } else if (existPrevSync && !isPullOnlyMode) {
        // Bidirectional: local deleted the folder
        r.decision = "uploadLocalDelHistToRemoteFolder";
      } else {
        r.decision = "createFolder";
      }
    } else {
      // !existLocal && !existRemote
      r.decision = "skipFolder";
    }
  } else {
    // Folder has must-be-kept children
    keptFolder.add(getParentFolder(r.key));
    if (existLocal && existRemote) {
      r.decision = "skipFolder";
    } else if (existLocal || existRemote) {
      r.decision = "createFolder";
    } else {
      throw Error(
        `Error: Folder ${r.key} doesn't exist locally and remotely but is marked must be kept. Abort.`
      );
    }
  }

  keptFolder.delete(r.key);
  return r;
};

export const doActualSyncV3 = async (
  client: RemoteClient,
  db: InternalDBs,
  vaultRandomID: string,
  vault: Vault,
  syncPlan: SyncPlanType,
  sortedKeys: string[],
  sizesGoWrong: FileOrFolderMixedState[],
  localDeleteFunc: (key: string) => Promise<void>,
  password: string = "",
  lastSynced?: number,
  concurrency: number = 1,
  callbackSizesGoWrong?: (items: FileOrFolderMixedState[]) => void,
  callbackSyncProcess?: (index: number, total: number) => Promise<void>,
  protectModifyPercentage?: number,
  callbackProtectModifyPercentage?: (errorMsg: string) => void,
  configDir: string = vault.configDir,
  syncDirection: SyncDirectionType = "bidirectional"
) => {
  if (sizesGoWrong.length > 0) {
    syncLog.debug(`some sizes are larger than the threshold, abort and show hints`);
    if (callbackSizesGoWrong !== undefined) {
      callbackSizesGoWrong(sizesGoWrong);
    }
    return undefined;
  }

  syncLog.debug(`concurrency === ${concurrency}`);

  const { folderCreationOps, deletionOps, uploadDownloads, realTotalCount, allFilesCount, realModifyDeleteCount } =
    splitThreeSteps(syncPlan, sortedKeys);

  // Check protectModifyPercentage
  if (
    protectModifyPercentage !== undefined &&
    protectModifyPercentage >= 0 &&
    allFilesCount > 0
  ) {
    syncLog.debug(`protectModifyPercentage: ${protectModifyPercentage}`);
    syncLog.debug(
      `allFilesCount: ${allFilesCount}, realModifyDeleteCount: ${realModifyDeleteCount}`
    );

    if (
      protectModifyPercentage === 100 &&
      realModifyDeleteCount === allFilesCount
    ) {
      // Allow sync with 100% modification
    } else if (realModifyDeleteCount * 100 >= allFilesCount * protectModifyPercentage) {
      const percent = ((100 * realModifyDeleteCount) / allFilesCount).toFixed(1);
      const errorMsg = `syncrun_abort_protectmodifypercentage|${protectModifyPercentage}|${realModifyDeleteCount}|${allFilesCount}|${percent}`;
      syncLog.debug(`aborting sync due to protectModifyPercentage: ${errorMsg}`);
      if (callbackProtectModifyPercentage) {
        callbackProtectModifyPercentage(errorMsg);
      }
      return undefined;
    }
  }
  const nested = [folderCreationOps, deletionOps, uploadDownloads];

  syncLog.debug(
    "folderCreationOps: ",
    folderCreationOps.length,
    " deletionOps: ",
    deletionOps.length,
    " uploadDownloads: ",
    uploadDownloads.length
  );

  const queue = new TaskQueue(concurrency);
  const queueTotal = realTotalCount;
  let queueIndex = 0;

  syncLog.debug("Checking if lastSynced is set: ", lastSynced, "== -1?: ", lastSynced === -1);

  const potentialErrors: Error[] = [];
  // Keys skipped because the remote item returned 404: they must not be
  // carried over into prevSync records.
  const skippedRemoteNotFoundKeys = new Set<string>();

  for (const operation of nested) {
    const isDeleteOp = operation === deletionOps;
    for (const singleLevelOps of operation) {
      if (singleLevelOps === undefined || singleLevelOps === null) {
        continue;
      }

      for (const val of singleLevelOps) {
        const key = val.key;

        if (lastSynced === -1) {
          const skipKeys = [
            `${configDir}/app.json`,
            `${configDir}/appearance.json`,
            `${configDir}/core-plugins-migration.json`,
            `${configDir}/core-plugins.json`,
            `${configDir}/graph.json`,
            `${configDir}/workspace.json`,
          ];
          if (val.existRemote && skipKeys.includes(key)) {
            syncLog.debug("downloading from remote for first sync: ", key);
            val.decision = "downloadRemoteToLocal";
          }
        }

        const syncCall = queue.add(async () => {
          const result = await syncIndividualItem(
            key,
            isDeleteOp,
            val,
            vaultRandomID,
            client,
            db,
            vault,
            localDeleteFunc,
            password
          );

          if (result.remoteMissing) {
            skippedRemoteNotFoundKeys.add(key);
          }

          const decision = val.decision;
          if (!isDeleteOp && (decision === undefined || !decision.startsWith("createFolder"))) {
            queueIndex++;
            if (callbackSyncProcess !== undefined) {
              await callbackSyncProcess(queueIndex, queueTotal);
            }
          }

          return result;
        });

        syncCall.catch((error: unknown) => {
          const errMsg = extractRemoteErrorDetails(error);
          const message = `${key}: ${errMsg}`;
          potentialErrors.push(new Error(message));

          if (potentialErrors.length >= 3) {
            potentialErrors.push(new Error("too many errors, stop the remaining tasks"));
            queue.pause();
            queue.clear();
          }
        });
      }
    }
  }

  await queue.onIdle();

  if (potentialErrors.length > 0) {
    throw new MultiError(potentialErrors);
  }

  syncLog.debug(`V3 sync finished, saving prevSync records`);

  // Save current state as prevSync records
  const prevSyncRecords: PrevSyncRecord[] = [];
  for (const key of sortedKeys) {
    const state = syncPlan.mixedStates[key];
    if (state === undefined) {
      continue;
    }
    if (skippedRemoteNotFoundKeys.has(key)) {
      // Remote item was confirmed gone this run: nothing exists on either
      // side anymore, so it must not be recorded as synced.
      continue;
    }
    if (
      state.decision === "skipUploading" ||
      state.decision === "uploadLocalToRemote" ||
      state.decision === "downloadRemoteToLocal" ||
      state.decision === "createFolder" ||
      state.decision === "skipFolder"
    ) {
      // Do NOT record one-sided skipped items:
      // - push modes, remote-only skips: never part of the local vault;
      //   recording them would phantom-mark them as "locally deleted" in a
      //   later sync, causing the remote backup to be deleted unexpectedly.
      // - pull modes, local-only skips: never part of the remote vault;
      //   recording them would phantom-mark them as "remotely deleted" in a
      //   later sync, causing locally-created content to be deleted.
      // In pull-and-delete mode the remote-only record MUST be kept: it
      // encodes an intentional local deletion whose remote copy is preserved.
      const isPushMode = syncDirection === "incremental_push_and_delete_only";
      const isPullMode = syncDirection === "incremental_pull_and_delete_only";
      if (
        (state.decision === "skipUploading" || state.decision === "skipFolder") &&
        ((isPushMode && !state.existLocal && state.existRemote) ||
          (isPullMode && state.existLocal && !state.existRemote))
      ) {
        continue;
      }
      // Only save files/folders that exist after sync. For downloads the
      // post-sync local mtime equals the remote mtime; recording the
      // pre-download local mtime would false-positive the three-way
      // conflict detection (both-modified) in later syncs.
      const mtime =
        state.decision === "downloadRemoteToLocal"
          ? (state.mtimeRemote ?? state.mtimeLocal ?? Date.now())
          : (state.mtimeLocal ?? state.mtimeRemote ?? Date.now());
      const size = state.sizeLocal ?? state.sizeRemote ?? 0;
      prevSyncRecords.push({
        key: key,
        mtime: mtime,
        size: size,
        keyType: key.endsWith("/") ? "folder" : "file",
        vaultRandomID: vaultRandomID,
      });
    }
  }
  await savePrevSyncRecordsByVault(db, vaultRandomID, prevSyncRecords);

  syncLog.debug(`V3 sync finished, prevSync records saved`);

  return Date.now();
};

export const uploadExtraMeta = async (
  client: RemoteClient,
  vault: Vault,
  metadataFile: FileOrFolderMixedState | undefined,
  origMetadata: MetadataOnRemote | undefined,
  deletions: DeletionOnRemote[],
  password: string = ""
): Promise<number | undefined> => {
  void origMetadata;
  const key = DEFAULT_FILE_NAME_FOR_METADATAONREMOTE;
  let remoteEncryptedKey = key;

  if (password !== "") {
    if (metadataFile === undefined) {
      remoteEncryptedKey = "";
    } else {
      remoteEncryptedKey = metadataFile.remoteEncryptedKey ?? "";
    }
    if (remoteEncryptedKey === "") {
      remoteEncryptedKey = await encryptStringToBase64url(key, password);
    }
  }

  const newMetadata: MetadataOnRemote = {
    deletions: deletions,
  };

  // 序列化元数据
  const metadataContent = serializeMetadataOnRemote(newMetadata);

  // 上传元数据文件
  const remoteObjMeta = await client.uploadToRemote(
    key,
    vault,
    false, // isRecursively
    password,
    remoteEncryptedKey,
    undefined, // foldersCreatedBefore
    true, // uploadRaw
    metadataContent // rawContent
  );

  return remoteObjMeta.lastModified;
};

/**
 * Forget snapshot entries for a key that no longer exists remotely.
 * `remoteEncryptedKey` differs from `key` only when E2E encryption is on —
 * snapshot keys then hold the encrypted path, so both forms must be dropped.
 */
const forgetRemoteSnapshotEntries = async (
  client: RemoteClient,
  key: string,
  remoteEncryptedKey: string
) => {
  await client.removeFromRemoteSnapshot(key);
  if (remoteEncryptedKey !== "" && remoteEncryptedKey !== key) {
    await client.removeFromRemoteSnapshot(remoteEncryptedKey);
  }
};

const dispatchOperationToActual = async (
  key: string,
  vaultRandomID: string,
  r: FileOrFolderMixedState,
  client: RemoteClient,
  db: InternalDBs,
  vault: Vault,
  localDeleteFunc: (key: string) => Promise<void>,
  password: string = ""
) => {
  let remoteEncryptedKey = key;
  if (password !== "") {
    remoteEncryptedKey = r.remoteEncryptedKey ?? "";
    if (remoteEncryptedKey === "") {
      remoteEncryptedKey = await encryptStringToBase64url(key, password);
    }
  }

  if (r.decision === undefined) {
    throw Error(`unknown decision in ${JSON.stringify(r)}`);
  } else if (r.decision === "skipUploading") {
    // do nothing!
  } else if (r.decision === "uploadLocalDelHistToRemote") {
    if (r.existLocal) {
      await localDeleteFunc(r.key);
    }
    if (r.existRemote) {
      await client.deleteFromRemote(r.key, password, remoteEncryptedKey);
      // Keep the delta snapshot in lockstep with the actual remote state: do
      // not wait for a later delta round to discover our own deletion.
      await forgetRemoteSnapshotEntries(client, r.key, remoteEncryptedKey);
    }
    await clearDeleteRenameHistoryOfKeyAndVault(db, r.key, vaultRandomID);
  } else if (r.decision === "keepRemoteDelHist") {
    if (r.existLocal) {
      await localDeleteFunc(r.key);
    }
    if (r.existRemote) {
      await client.deleteFromRemote(r.key, password, remoteEncryptedKey);
      // Keep the delta snapshot in lockstep with the actual remote state: do
      // not wait for a later delta round to discover our own deletion.
      await forgetRemoteSnapshotEntries(client, r.key, remoteEncryptedKey);
    }
    await clearDeleteRenameHistoryOfKeyAndVault(db, r.key, vaultRandomID);
  } else if (r.decision === "uploadLocalToRemote") {
    if (client.serviceType === "onedrive" && r.sizeLocal === 0 && password === "") {
      // special treatment for empty files for OneDrive
      // do nothing, skip empty file without encryption
      // if it's empty folder, or it's encrypted file/folder, it continues to
      // be uploaded.
    } else {
      const remoteObjMeta = await client.uploadToRemote(
        r.key,
        vault,
        false,
        password,
        remoteEncryptedKey
      );
      await upsertSyncMetaMappingDataByVault(
        client.serviceType,
        db,
        r.key,
        r.mtimeLocal ?? 0,
        r.sizeLocal ?? 0,
        r.key,
        remoteObjMeta.lastModified,
        remoteObjMeta.size,
        remoteObjMeta.etag ?? "",
        vaultRandomID
      );
    }
    await clearDeleteRenameHistoryOfKeyAndVault(db, r.key, vaultRandomID);
  } else if (r.decision === "downloadRemoteToLocal") {
    try {
      await client.downloadFromRemote(
        r.key,
        vault,
        r.mtimeRemote ?? 0,
        password,
        remoteEncryptedKey
      );
    } catch (err) {
      // Self-healing: a stale remote snapshot entry can make a locally absent
      // file look like "new remote content". If the remote confirms the item
      // is gone (404/itemNotFound), forget the snapshot key and skip this item
      // instead of poisoning every subsequent sync run. Auth, throttling,
      // server and network errors are re-thrown and still count as failures.
      if (isRemoteItemNotFoundError(err)) {
        syncLog.warn(
          `remote item not found (404), dropping it from the remote snapshot: ${r.key}`
        );
        await forgetRemoteSnapshotEntries(client, r.key, remoteEncryptedKey);
        return true;
      }
      throw err;
    }
    await clearDeleteRenameHistoryOfKeyAndVault(db, r.key, vaultRandomID);
  } else if (r.decision === "createFolder") {
    if (!r.existLocal) {
      await mkdirpInVault(r.key, vault);
    }
    if (!r.existRemote) {
      const remoteObjMeta = await client.uploadToRemote(
        r.key,
        vault,
        false,
        password,
        remoteEncryptedKey
      );
      await upsertSyncMetaMappingDataByVault(
        client.serviceType,
        db,
        r.key,
        r.mtimeLocal ?? 0,
        r.sizeLocal ?? 0,
        r.key,
        remoteObjMeta.lastModified,
        remoteObjMeta.size,
        remoteObjMeta.etag ?? "",
        vaultRandomID
      );
    }
    await clearDeleteRenameHistoryOfKeyAndVault(db, r.key, vaultRandomID);
  } else if (r.decision === "uploadLocalDelHistToRemoteFolder") {
    if (r.existLocal) {
      await localDeleteFunc(r.key);
    }
    if (r.existRemote) {
      await client.deleteFromRemote(r.key, password, remoteEncryptedKey);
      // Keep the delta snapshot in lockstep with the actual remote state: do
      // not wait for a later delta round to discover our own deletion.
      await forgetRemoteSnapshotEntries(client, r.key, remoteEncryptedKey);
    }
    await clearDeleteRenameHistoryOfKeyAndVault(db, r.key, vaultRandomID);
  } else if (r.decision === "keepRemoteDelHistFolder") {
    if (r.existLocal) {
      await localDeleteFunc(r.key);
    }
    if (r.existRemote) {
      await client.deleteFromRemote(r.key, password, remoteEncryptedKey);
      // Keep the delta snapshot in lockstep with the actual remote state: do
      // not wait for a later delta round to discover our own deletion.
      await forgetRemoteSnapshotEntries(client, r.key, remoteEncryptedKey);
    }
    await clearDeleteRenameHistoryOfKeyAndVault(db, r.key, vaultRandomID);
  } else if (r.decision === "skipFolder") {
    // do nothing!
  } else if (r.decision === "skipUploadingTooLarge") {
    // do nothing!
  } else if (r.decision === "skipUploadingOneDriveEmpty") {
    // do nothing! Planned skip: OneDrive rejects 0-byte uploads without E2E
    // encryption; no prevSync record is written for this decision.
  } else if (r.decision === "skipDownloadingTooLarge") {
    // do nothing!
  } else if (r.decision === "skipUsingLocalDelTooLarge") {
    // do nothing!
  } else if (r.decision === "skipUsingRemoteDelTooLarge") {
    // do nothing!
  } else {
    throw Error(`unknown decision in ${JSON.stringify(r)}`);
  }
  return false;
};

const splitThreeSteps = (
  syncPlan: SyncPlanType,
  sortedKeys: string[]
): {
  folderCreationOps: FileOrFolderMixedState[][];
  deletionOps: FileOrFolderMixedState[][];
  uploadDownloads: FileOrFolderMixedState[][];
  realTotalCount: number;
  allFilesCount: number;
  realModifyDeleteCount: number;
} => {
  const folderCreationOps: FileOrFolderMixedState[][] = [];
  const deletionOps: FileOrFolderMixedState[][] = [];
  const uploadDownloads: FileOrFolderMixedState[][] = [];

  // For protectModifyPercentage calculation
  let allFilesCount = 0; // Total number of files in the sync plan (excluding folders)
  let realModifyDeleteCount = 0; // Files that will be modified or deleted
  let fileSyncCount = 0; // Actual file sync operations (upload/download)

  for (let i = 0; i < sortedKeys.length; ++i) {
    const key = sortedKeys[i] as string;
    const val: FileOrFolderMixedState = Object.assign(
      {},
      syncPlan.mixedStates[key]
    ); // copy to avoid issue

    // Count all files (not folders) for percentage calculation
    if (!key.endsWith("/")) {
      allFilesCount += 1;
    }

    if (
      val.decision === "skipFolder" ||
      val.decision === "skipUploading" ||
      val.decision === "skipDownloadingTooLarge" ||
      val.decision === "skipUploadingTooLarge" ||
      val.decision === "skipUploadingOneDriveEmpty" ||
      val.decision === "skipUsingLocalDelTooLarge" ||
      val.decision === "skipUsingRemoteDelTooLarge"
    ) {
      // pass
    } else if (val.decision === "createFolder") {
      const level = atWhichLevel(key);
      if (level == undefined) {
        continue;
      }
      if (folderCreationOps[level - 1] === undefined) {
        folderCreationOps[level - 1] = [val];
      } else {
        folderCreationOps[level - 1]?.push(val);
      }
    } else if (
      val.decision === "uploadLocalDelHistToRemoteFolder" ||
      val.decision === "keepRemoteDelHistFolder" ||
      val.decision === "uploadLocalDelHistToRemote" ||
      val.decision === "keepRemoteDelHist"
    ) {
      const level = atWhichLevel(key);
      if (level == undefined) {
        continue;
      }
      if (deletionOps[level - 1] === undefined) {
        deletionOps[level - 1] = [val];
      } else {
        deletionOps[level - 1]?.push(val);
      }
      // Count file deletions
      if (!key.endsWith("/")) {
        realModifyDeleteCount += 1;
      }
    } else if (
      val.decision === "uploadLocalToRemote" ||
      val.decision === "downloadRemoteToLocal"
    ) {
      if (uploadDownloads.length === 0) {
        uploadDownloads[0] = [val];
      } else {
        uploadDownloads[0]?.push(val); // only one level needed here
      }
      fileSyncCount += 1;
      // Count modifications
      if (!key.endsWith("/")) {
        realModifyDeleteCount += 1;
      }
    } else {
      throw Error(`unknown decision ${String(val.decision)} for ${key}`);
    }
  }

  // the deletionOps should be run from max level to min level
  // right now it is sorted by level from min to max (NOT length of key!)
  // so we need to reverse it!
  deletionOps.reverse(); // inplace reverse

  return {
    folderCreationOps: folderCreationOps,
    deletionOps: deletionOps,
    uploadDownloads: uploadDownloads,
    realTotalCount: fileSyncCount, // Only count actual file sync (upload/download)
    allFilesCount: allFilesCount,
    realModifyDeleteCount: realModifyDeleteCount,
  };
};

async function syncIndividualItem(
  key: string,
  deletionOp: boolean,
  val: FileOrFolderMixedState,
  vaultRandomID: string,
  client: RemoteClient,
  db: InternalDBs,
  vault: Vault,
  localDeleteFunc: (key: string) => Promise<void>,
  password: string
) {
  syncLog.debug(`start syncing "${key}" with plan ${JSON.stringify(val)}`);

  const remoteMissing = await dispatchOperationToActual(
    key,
    vaultRandomID,
    val,
    client,
    db,
    vault,
    localDeleteFunc,
    password
  );

  syncLog.debug(`finished ${key}`);

  // `remoteMissing`: the remote item vanished (404) and the stale snapshot
  // entry was dropped — the item must not be recorded as synced.
  return { deletionOp, remoteMissing };
}
