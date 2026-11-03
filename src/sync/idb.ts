/**
 * Minimal IndexedDB key-value store that replaces upstream's `localforage`
 * which used localforage for src/localdb.ts — NOT sql.js, so no WASM needed).
 *
 * Upstream created one localforage instance per logical table
 * (localforage.createInstance({ name, storeName })). We keep a single
 * IndexedDB database with a single object store and prefix keys by table
 * name, which preserves the same per-table key namespaces with ~80 lines
 * and zero npm dependencies.
 *
 * DB version history:
 *   1 — original, single "kv" object store (no keyPath, no indexes).
 *       Stores all sync tables via key prefix (schemaversion, filefolderoperationhistory, etc.).
 *   2 — adds dedicated "remoteSnapshot" object store with keyPath="key".
 *       Used by the OneDrive remote snapshot to move ~367KB of delta resume
 *       data out of data.json. Existing "kv" store untouched.
 *
 * Migration note (26.3.3-preview): the IndexedDB database was renamed from
 * "astral-trek-sync-db" to "astra-sync-db" so that all brand identifiers on
 * the storage side converge to "astra". `runMigrationIfNeeded()` below runs
 * exactly once on first `getDB()`: if the old DB exists, its sole object
 * store ("kv") is read in full, written to the new DB, and then the old DB
 * is deleted. Failure is silent — the new empty DB is used as fallback.
 */

const DB_NAME = "astra-sync-db";
const OLD_DB_NAME = "astral-trek-sync-db";
const KV_STORE_NAME = "kv";
export const REMOTE_SNAPSHOT_STORE = "remoteSnapshot";
const DB_VERSION = 2;

let dbPromise: Promise<IDBDatabase> | null = null;
let migrationPromise: Promise<void> | null = null;

/** 检测旧库是否存在 → 复制全部 kv store 数据到新库 → 删除旧库。
 *  幂等：迁移完成后旧库已删除，下次调用立即跳过。
 *  失败静默：任何异常被吞掉，降级为直接使用新空库。
 *  事务顺序：开旧库 → 全量读 kv store → 关旧库 → 开新库（onupgradeneeded 建 store） → readwrite tx 逐条 put → 等 complete → 删旧库。 */
const runMigrationIfNeeded = (): Promise<void> => {
  if (migrationPromise !== null) {
    return migrationPromise; // 已在跑或已完成
  }
  migrationPromise = (async () => {
    try {
      // 1. 尝试打开旧库；不存在则 IndexedDB 触发 error → .catch → null
      const oldDb: IDBDatabase | null = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(OLD_DB_NAME, 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("open oldDB failed"));
      }).catch(() => null);

      if (!oldDb) return; // 旧库不存在，跳过

      // 2. 读旧库 kv store 全量
      const oldTx = oldDb.transaction(KV_STORE_NAME, "readonly");
      const oldStore = oldTx.objectStore(KV_STORE_NAME);
      const allKeys = await requestToPromise<IDBValidKey[]>(oldStore.getAllKeys());
      const records: Array<[IDBValidKey, unknown]> = [];
      for (const key of allKeys) {
        const value = await requestToPromise<unknown>(oldStore.get(key));
        records.push([key, value]);
      }
      oldDb.close();

      if (records.length === 0) {
        // 旧库空的，直接删
        await dropDB(OLD_DB_NAME);
        return;
      }

      // 3. 打开新库（onupgradeneeded 会建 kv + remoteSnapshot store，与当前版本一致）
      const newDb: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(KV_STORE_NAME)) {
            db.createObjectStore(KV_STORE_NAME);
          }
          if (!db.objectStoreNames.contains(REMOTE_SNAPSHOT_STORE)) {
            db.createObjectStore(REMOTE_SNAPSHOT_STORE, { keyPath: "key" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("open newDB failed"));
      });

      // 4. 写入新库：readwrite tx，逐条 put 到 kv store
      const writeTx = newDb.transaction(KV_STORE_NAME, "readwrite");
      const writeStore = writeTx.objectStore(KV_STORE_NAME);
      for (const [key, value] of records) {
        writeStore.put(value, key);
      }
      await new Promise<void>((resolve, reject) => {
        writeTx.oncomplete = () => resolve();
        writeTx.onerror = () => reject(writeTx.error ?? new Error("write tx failed"));
      });
      newDb.close();

      // 5. 删旧库（resolve 分支齐全，永远不会 reject）
      await dropDB(OLD_DB_NAME);

      // 重置 dbPromise，确保后续 getDB() 打开的是已含数据的新库
      dbPromise = null;
    } catch {
      // 迁移失败不阻塞正常运行
    }
  })();
  return migrationPromise;
};

/** 删除指定 IndexedDB 库（resolve 分支齐全，永不 reject）。 */
const dropDB = (name: string): Promise<void> =>
  new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });

const getDB = async (): Promise<IDBDatabase> => {
  // 先跑一次性迁移（绝大多数用户迁移Promise已 resolve 或旧库不存在 → 立即返回）
  await runMigrationIfNeeded();

  if (dbPromise === null) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(KV_STORE_NAME)) {
          db.createObjectStore(KV_STORE_NAME);
        }
        if (!db.objectStoreNames.contains(REMOTE_SNAPSHOT_STORE)) {
          db.createObjectStore(REMOTE_SNAPSHOT_STORE, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error ?? new Error("indexedDB open failed"));
      };
    });
  }
  return dbPromise;
};

const requestToPromise = <T>(req: IDBRequest<T>): Promise<T> => {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error("indexedDB request failed"));
    };
  });
};

export interface KvStore {
  getItem<T>(key: string): Promise<T | null>;
  setItem<T>(key: string, value: T): Promise<T>;
  removeItem(key: string): Promise<void>;
  keys(): Promise<string[]>;
  iterate(
    iterator: (value: unknown, key: string, iterationNumber: number) => void
  ): Promise<void>;
  clear(): Promise<void>;
}

class IdbKvStore implements KvStore {
  private readonly prefix: string;

  constructor(storeName: string) {
    this.prefix = `${storeName}\u0000`;
  }

  private fullKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  private stripPrefix(fullKey: string): string {
    return fullKey.substring(this.prefix.length);
  }

  getItem = async <T>(key: string): Promise<T | null> => {
    const db = await getDB();
    const tx = db.transaction(KV_STORE_NAME, "readonly");
    const res = await requestToPromise<unknown>(
      tx.objectStore(KV_STORE_NAME).get(this.fullKey(key))
    );
    return (res ?? null) as T | null;
  };

  setItem = async <T>(key: string, value: T): Promise<T> => {
    const db = await getDB();
    const tx = db.transaction(KV_STORE_NAME, "readwrite");
    await requestToPromise(
      tx.objectStore(KV_STORE_NAME).put(value as unknown, this.fullKey(key))
    );
    return value;
  };

  removeItem = async (key: string): Promise<void> => {
    const db = await getDB();
    const tx = db.transaction(KV_STORE_NAME, "readwrite");
    await requestToPromise(
      tx.objectStore(KV_STORE_NAME).delete(this.fullKey(key))
    );
  };

  keys = async (): Promise<string[]> => {
    const db = await getDB();
    const tx = db.transaction(KV_STORE_NAME, "readonly");
    const allKeys = await requestToPromise(
      tx.objectStore(KV_STORE_NAME).getAllKeys()
    );
    const res: string[] = [];
    for (const k of allKeys) {
      if (typeof k === "string" && k.startsWith(this.prefix)) {
        res.push(this.stripPrefix(k));
      }
    }
    return res;
  };

  iterate = async (
    iterator: (value: unknown, key: string, iterationNumber: number) => void
  ): Promise<void> => {
    const db = await getDB();
    const tx = db.transaction(KV_STORE_NAME, "readonly");
    const allKeys = await requestToPromise(
      tx.objectStore(KV_STORE_NAME).getAllKeys()
    );
    let iterationNumber = 0;
    for (const k of allKeys) {
      if (typeof k !== "string" || !k.startsWith(this.prefix)) {
        continue;
      }
      const value = await requestToPromise<unknown>(
        db.transaction(KV_STORE_NAME, "readonly").objectStore(KV_STORE_NAME).get(k)
      );
      iterator(value, this.stripPrefix(k), iterationNumber);
      iterationNumber += 1;
    }
  };

  clear = async (): Promise<void> => {
    const db = await getDB();
    const tx = db.transaction(KV_STORE_NAME, "readwrite");
    const allKeys = await requestToPromise(
      tx.objectStore(KV_STORE_NAME).getAllKeys()
    );
    const writeTx = db.transaction(KV_STORE_NAME, "readwrite");
    const store = writeTx.objectStore(KV_STORE_NAME);
    for (const k of allKeys) {
      if (typeof k === "string" && k.startsWith(this.prefix)) {
        store.delete(k);
      }
    }
    await new Promise<void>((resolve, reject) => {
      writeTx.oncomplete = () => {
        resolve();
      };
      writeTx.onerror = () => {
        reject(writeTx.error ?? new Error("indexedDB clear failed"));
      };
    });
  };
}

export const createKvStore = (storeName: string): KvStore => {
  return new IdbKvStore(storeName);
};

/**
 * Direct access to the "remoteSnapshot" object store (DB version 2+).
 * This store has keyPath="key" (the RemoteItem.path-equivalent property).
 * Used by the OneDrive delta API to persist the remote file listing snapshot
 * out of data.json.
 *
 * All methods are safe: any IndexedDB error resolves to empty/default values
 * and a warn-level log, never throws. The caller (listFromRemote) then falls
 * through to a full enumeration — which is the correct fallback.
 */
export async function remoteSnapshotLoadAll<T extends { key: string }>(): Promise<Record<string, T>> {
  try {
    const db = await getDB();
    if (!db.objectStoreNames.contains(REMOTE_SNAPSHOT_STORE)) {
      return {};
    }
    const tx = db.transaction(REMOTE_SNAPSHOT_STORE, "readonly");
    const items = (await requestToPromise(tx.objectStore(REMOTE_SNAPSHOT_STORE).getAll())) as T[];
    const result: Record<string, T> = {};
    for (const item of items) {
      result[item.key] = item;
    }
    return result;
  } catch (err) {
    console.warn("[remoteSnapshot] loadAll failed, treating as empty:", err instanceof Error ? err.message : String(err));
    return {};
  }
}

export async function remoteSnapshotSaveAll<T extends { key: string }>(
  snapshot: Record<string, T>
): Promise<void> {
  try {
    const db = await getDB();
    if (!db.objectStoreNames.contains(REMOTE_SNAPSHOT_STORE)) {
      return;
    }
    const tx = db.transaction(REMOTE_SNAPSHOT_STORE, "readwrite");
    const store = tx.objectStore(REMOTE_SNAPSHOT_STORE);
    // Clear existing then bulk put — simpler than diffing, and snapshots are
    // entirely rebuilt on every listFromRemote call anyway.
    await requestToPromise(store.clear());
    for (const item of Object.values(snapshot)) {
      store.put(item);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("remoteSnapshot save tx failed"));
    });
  } catch (err) {
    console.warn("[remoteSnapshot] saveAll failed:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Delete one snapshot entry by key without loading/rewriting the whole store.
 * Used for self-healing when the remote item is confirmed gone (HTTP 404) or
 * right after a successful remote deletion.
 */
export async function remoteSnapshotRemove(key: string): Promise<void> {
  try {
    const db = await getDB();
    if (!db.objectStoreNames.contains(REMOTE_SNAPSHOT_STORE)) {
      return;
    }
    const tx = db.transaction(REMOTE_SNAPSHOT_STORE, "readwrite");
    const txDone = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("remoteSnapshot remove tx failed"));
    });
    await requestToPromise(tx.objectStore(REMOTE_SNAPSHOT_STORE).delete(key));
    await txDone;
  } catch (err) {
    console.warn("[remoteSnapshot] remove failed:", err instanceof Error ? err.message : String(err));
  }
}

export async function remoteSnapshotClear(): Promise<void> {
  try {
    const db = await getDB();
    if (!db.objectStoreNames.contains(REMOTE_SNAPSHOT_STORE)) {
      return;
    }
    const tx = db.transaction(REMOTE_SNAPSHOT_STORE, "readwrite");
    await requestToPromise(tx.objectStore(REMOTE_SNAPSHOT_STORE).clear());
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("remoteSnapshot clear tx failed"));
    });
  } catch (err) {
    console.warn("[remoteSnapshot] clear failed:", err instanceof Error ? err.message : String(err));
  }
}

/** Drop the whole sync database (used by "wipe local sync data").
 *  Also drops the legacy "astral-trek-sync-db" if it still exists,
 *  so a user pressing "wipe" while an old DB is lingering gets a clean slate. */
export const destroyDBs = async (): Promise<void> => {
  if (dbPromise !== null) {
    try {
      const db = await dbPromise;
      db.close();
    } catch {
      // ignore
    }
    dbPromise = null;
  }
  await dropDB(DB_NAME);
  await dropDB(OLD_DB_NAME);
};
