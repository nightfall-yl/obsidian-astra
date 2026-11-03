/**
 * - localforage is replaced by the local minimal IndexedDB KV store (src/sync/idb.ts)
 * - nanoid is replaced by crypto-based randomId
 * - the historical migration chain is dropped: astral-trek starts fresh at the
 *   current schema version, so only version set/verify remains.
 */

import type { TAbstractFile} from "obsidian";
import { requireApiVersion, TFile, TFolder } from "obsidian";

import { API_VER_STAT_FOLDER } from "./baseTypes";
import { createKvStore, type KvStore } from "./idb";
import { randomId, statFix } from "./misc";

export const DEFAULT_DB_VERSION_NUMBER: number = 20250430;
export const DEFAULT_TBL_VERSION = "schemaversion";
export const DEFAULT_TBL_FILE_HISTORY = "filefolderoperationhistory";
export const DEFAULT_TBL_SYNC_MAPPING = "syncmetadatahistory";
export const DEFAULT_TBL_VAULT_RANDOM_ID_MAPPING = "vaultrandomidmapping";
export const DEFAULT_TBL_PREV_SYNC_RECORDS = "prevsyncrecords";

export interface FileFolderHistoryRecord {
  key: string;
  ctime: number;
  mtime: number;
  size: number;
  actionWhen: number;
  actionType: "delete" | "rename" | "renameDestination";
  keyType: "folder" | "file";
  renameTo: string;
  vaultRandomID: string;
}

interface SyncMetaMappingRecord {
  localKey: string;
  remoteKey: string;
  localSize: number;
  remoteSize: number;
  localMtime: number;
  remoteMtime: number;
  remoteExtraKey: string;
  remoteType: "onedrive";
  keyType: "folder" | "file";
  vaultRandomID: string;
}

export interface PrevSyncRecord {
  key: string;
  mtime: number;
  size: number;
  keyType: "folder" | "file";
  vaultRandomID: string;
}

export interface InternalDBs {
  versionTbl: KvStore;
  fileHistoryTbl: KvStore;
  syncMappingTbl: KvStore;
  vaultRandomIDMappingTbl: KvStore;
  prevSyncRecordsTbl: KvStore;
}

export const prepareDBs = async (
  vaultBasePath: string,
  vaultRandomIDFromOldConfigFile: string
) => {
  const db: InternalDBs = {
    versionTbl: createKvStore(DEFAULT_TBL_VERSION),
    fileHistoryTbl: createKvStore(DEFAULT_TBL_FILE_HISTORY),
    syncMappingTbl: createKvStore(DEFAULT_TBL_SYNC_MAPPING),
    vaultRandomIDMappingTbl: createKvStore(DEFAULT_TBL_VAULT_RANDOM_ID_MAPPING),
    prevSyncRecordsTbl: createKvStore(DEFAULT_TBL_PREV_SYNC_RECORDS),
  };

  // try to get vaultRandomID firstly
  let vaultRandomID = "";
  const vaultRandomIDInDB: string | null =
    await db.vaultRandomIDMappingTbl.getItem<string>(`path2id\t${vaultBasePath}`);
  if (vaultRandomIDInDB === null) {
    if (vaultRandomIDFromOldConfigFile !== "") {
      // reuse the old config id
      vaultRandomID = vaultRandomIDFromOldConfigFile;
    } else {
      // no old config id, we create a random one
      vaultRandomID = randomId();
    }
    // save the id back
    await db.vaultRandomIDMappingTbl.setItem<string>(
      `path2id\t${vaultBasePath}`,
      vaultRandomID
    );
    await db.vaultRandomIDMappingTbl.setItem<string>(
      `id2path\t${vaultRandomID}`,
      vaultBasePath
    );
  } else {
    vaultRandomID = vaultRandomIDInDB;
  }

  if (vaultRandomID === "") {
    throw Error("no vaultRandomID found or generated");
  }

  const originalVersion: number | null = await db.versionTbl.getItem<number>(
    "version"
  );
  if (originalVersion === null) {
    await db.versionTbl.setItem<number>(
      "version",
      DEFAULT_DB_VERSION_NUMBER
    );
  } else if (originalVersion < DEFAULT_DB_VERSION_NUMBER) {
    throw Error(
      "You've installed a new version, but then downgrade to an old version. Stop working!"
    );
  } else if (originalVersion > DEFAULT_DB_VERSION_NUMBER) {
    throw Error(
      `unknown internal db version ${originalVersion} (expected ${DEFAULT_DB_VERSION_NUMBER})`
    );
  }

  return {
    db: db,
    vaultRandomID: vaultRandomID,
  };
};

export const clearAllPrevSyncRecordsByVault = async (
  db: InternalDBs,
  vaultRandomID: string
) => {
  const keys = (await db.prevSyncRecordsTbl.keys()).filter((x) =>
    x.startsWith(`${vaultRandomID}\t`)
  );
  const ps: Promise<unknown>[] = [];
  for (const key of keys) {
    ps.push(db.prevSyncRecordsTbl.removeItem(key));
  }
  await Promise.all(ps);
};

export const savePrevSyncRecordsByVault = async (
  db: InternalDBs,
  vaultRandomID: string,
  records: PrevSyncRecord[]
) => {
  // Clear old records first
  await clearAllPrevSyncRecordsByVault(db, vaultRandomID);
  // Save new records
  const ps: Promise<unknown>[] = [];
  for (const record of records) {
    ps.push(
      db.prevSyncRecordsTbl.setItem<PrevSyncRecord>(
        `${vaultRandomID}\t${record.key}`,
        record
      )
    );
  }
  await Promise.all(ps);
};

export const loadPrevSyncRecordsByVault = async (
  db: InternalDBs,
  vaultRandomID: string
) => {
  const records = [] as PrevSyncRecord[];
  await db.prevSyncRecordsTbl.iterate((value, key, _iterationNumber) => {
    if (key.startsWith(`${vaultRandomID}\t`)) {
      records.push(value as PrevSyncRecord);
    }
  });
  return records;
};

export { destroyDBs } from "./idb";

export const loadFileHistoryTableByVault = async (
  db: InternalDBs,
  vaultRandomID: string
) => {
  const records = [] as FileFolderHistoryRecord[];
  await db.fileHistoryTbl.iterate((value, key, _iterationNumber) => {
    if (key.startsWith(`${vaultRandomID}\t`)) {
      records.push(value as FileFolderHistoryRecord);
    }
  });
  records.sort((a, b) => a.actionWhen - b.actionWhen); // ascending
  return records;
};

export const clearDeleteRenameHistoryOfKeyAndVault = async (
  db: InternalDBs,
  key: string,
  vaultRandomID: string
) => {
  const fullKey = `${vaultRandomID}\t${key}`;
  const item: FileFolderHistoryRecord | null =
    await db.fileHistoryTbl.getItem<FileFolderHistoryRecord>(fullKey);
  if (
    item !== null &&
    (item.actionType === "delete" || item.actionType === "rename")
  ) {
    await db.fileHistoryTbl.removeItem(fullKey);
  }
};

export const insertDeleteRecordByVault = async (
  db: InternalDBs,
  fileOrFolder: TAbstractFile,
  vaultRandomID: string
) => {
  let k: FileFolderHistoryRecord;
  if (fileOrFolder instanceof TFile) {
    k = {
      key: fileOrFolder.path,
      ctime: fileOrFolder.stat.ctime,
      mtime: fileOrFolder.stat.mtime,
      size: fileOrFolder.stat.size,
      actionWhen: Date.now(),
      actionType: "delete",
      keyType: "file",
      renameTo: "",
      vaultRandomID: vaultRandomID,
    };
  } else if (fileOrFolder instanceof TFolder) {
    // key should endswith "/"
    const key = fileOrFolder.path.endsWith("/")
      ? fileOrFolder.path
      : `${fileOrFolder.path}/`;
    const ctime = 0; // they are deleted, so no way to get ctime, mtime
    const mtime = 0; // they are deleted, so no way to get ctime, mtime
    k = {
      key: key,
      ctime: ctime,
      mtime: mtime,
      size: 0,
      actionWhen: Date.now(),
      actionType: "delete",
      keyType: "folder",
      renameTo: "",
      vaultRandomID: vaultRandomID,
    };
  } else {
    return;
  }
  await db.fileHistoryTbl.setItem<FileFolderHistoryRecord>(
    `${vaultRandomID}\t${k.key}`,
    k
  );
};

/**
 * A file/folder is renamed from A to B
 * We insert two records:
 * A with actionType="rename"
 * B with actionType="renameDestination"
 */
export const insertRenameRecordByVault = async (
  db: InternalDBs,
  fileOrFolder: TAbstractFile,
  oldPath: string,
  vaultRandomID: string
) => {
  let k1: FileFolderHistoryRecord;
  let k2: FileFolderHistoryRecord;
  const actionWhen = Date.now();
  if (fileOrFolder instanceof TFile) {
    k1 = {
      key: oldPath,
      ctime: fileOrFolder.stat.ctime,
      mtime: fileOrFolder.stat.mtime,
      size: fileOrFolder.stat.size,
      actionWhen: actionWhen,
      actionType: "rename",
      keyType: "file",
      renameTo: fileOrFolder.path,
      vaultRandomID: vaultRandomID,
    };
    k2 = {
      key: fileOrFolder.path,
      ctime: fileOrFolder.stat.ctime,
      mtime: fileOrFolder.stat.mtime,
      size: fileOrFolder.stat.size,
      actionWhen: actionWhen,
      actionType: "renameDestination",
      keyType: "file",
      renameTo: "", // itself is the destination, so no need to set this field
      vaultRandomID: vaultRandomID,
    };
  } else if (fileOrFolder instanceof TFolder) {
    const key = oldPath.endsWith("/") ? oldPath : `${oldPath}/`;
    const renameTo = fileOrFolder.path.endsWith("/")
      ? fileOrFolder.path
      : `${fileOrFolder.path}/`;
    let ctime = 0;
    let mtime = 0;
    if (requireApiVersion(API_VER_STAT_FOLDER)) {
      // TAbstractFile does not contain these info
      // but from API_VER_STAT_FOLDER we can manually stat them by path.
      const s = await statFix(fileOrFolder.vault, fileOrFolder.path);
      ctime = s?.ctime ?? 0;
      mtime = s?.mtime ?? 0;
    }
    k1 = {
      key: key,
      ctime: ctime,
      mtime: mtime,
      size: 0,
      actionWhen: actionWhen,
      actionType: "rename",
      keyType: "folder",
      renameTo: renameTo,
      vaultRandomID: vaultRandomID,
    };
    k2 = {
      key: renameTo,
      ctime: ctime,
      mtime: mtime,
      size: 0,
      actionWhen: actionWhen,
      actionType: "renameDestination",
      keyType: "folder",
      renameTo: "", // itself is the destination, so no need to set this field
      vaultRandomID: vaultRandomID,
    };
  } else {
    return;
  }
  await Promise.all([
    db.fileHistoryTbl.setItem<FileFolderHistoryRecord>(
      `${vaultRandomID}\t${k1.key}`,
      k1
    ),
    db.fileHistoryTbl.setItem<FileFolderHistoryRecord>(
      `${vaultRandomID}\t${k2.key}`,
      k2
    ),
  ]);
};

export const upsertSyncMetaMappingDataByVault = async (
  serviceType: "onedrive",
  db: InternalDBs,
  localKey: string,
  localMTime: number,
  localSize: number,
  remoteKey: string,
  remoteMTime: number,
  remoteSize: number,
  remoteExtraKey: string,
  vaultRandomID: string
) => {
  const aggregratedInfo: SyncMetaMappingRecord = {
    localKey: localKey,
    localMtime: localMTime,
    localSize: localSize,
    remoteKey: remoteKey,
    remoteMtime: remoteMTime,
    remoteSize: remoteSize,
    remoteExtraKey: remoteExtraKey,
    remoteType: serviceType,
    keyType: localKey.endsWith("/") ? "folder" : "file",
    vaultRandomID: vaultRandomID,
  };
  await db.syncMappingTbl.setItem<SyncMetaMappingRecord>(
    `${vaultRandomID}\t${remoteKey}`,
    aggregratedInfo
  );
};

export const getSyncMetaMappingByRemoteKeyAndVault = async (
  serviceType: "onedrive",
  db: InternalDBs,
  remoteKey: string,
  remoteMTime: number,
  remoteExtraKey: string,
  vaultRandomID: string
) => {
  const potentialItem = await db.syncMappingTbl.getItem<SyncMetaMappingRecord>(
    `${vaultRandomID}\t${remoteKey}`
  );

  if (potentialItem === null) {
    // no result was found
    return undefined;
  }

  if (
    potentialItem.remoteKey === remoteKey &&
    potentialItem.remoteMtime === remoteMTime &&
    potentialItem.remoteExtraKey === remoteExtraKey &&
    potentialItem.remoteType === serviceType
  ) {
    // the result was found
    return potentialItem;
  } else {
    return undefined;
  }
};

export const clearAllSyncMetaMapping = async (db: InternalDBs) => {
  await db.syncMappingTbl.clear();
};
