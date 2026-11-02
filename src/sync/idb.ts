/**
 * Minimal IndexedDB key-value store that replaces upstream's `localforage`
 * dependency (vendored from nightfall-yl/obsidian-third-party-sync@6240bcc,
 * which used localforage for src/localdb.ts — NOT sql.js, so no WASM needed).
 *
 * Upstream created one localforage instance per logical table
 * (localforage.createInstance({ name, storeName })). We keep a single
 * IndexedDB database with a single object store and prefix keys by table
 * name, which preserves the same per-table key namespaces with ~80 lines
 * and zero npm dependencies.
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
const STORE_NAME = "kv";

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
      const oldTx = oldDb.transaction(STORE_NAME, "readonly");
      const oldStore = oldTx.objectStore(STORE_NAME);
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

      // 3. 打开新库（onupgradeneeded 会建 kv store，与旧库 schema 一致）
      const newDb: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("open newDB failed"));
      });

      // 4. 写入新库：readwrite tx，逐条 put
      const writeTx = newDb.transaction(STORE_NAME, "readwrite");
      const writeStore = writeTx.objectStore(STORE_NAME);
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
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
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
    const tx = db.transaction(STORE_NAME, "readonly");
    const res = await requestToPromise<unknown>(
      tx.objectStore(STORE_NAME).get(this.fullKey(key))
    );
    return (res ?? null) as T | null;
  };

  setItem = async <T>(key: string, value: T): Promise<T> => {
    const db = await getDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    await requestToPromise(
      tx.objectStore(STORE_NAME).put(value as unknown, this.fullKey(key))
    );
    return value;
  };

  removeItem = async (key: string): Promise<void> => {
    const db = await getDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    await requestToPromise(
      tx.objectStore(STORE_NAME).delete(this.fullKey(key))
    );
  };

  keys = async (): Promise<string[]> => {
    const db = await getDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const allKeys = await requestToPromise(
      tx.objectStore(STORE_NAME).getAllKeys()
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
    const tx = db.transaction(STORE_NAME, "readonly");
    const allKeys = await requestToPromise(
      tx.objectStore(STORE_NAME).getAllKeys()
    );
    let iterationNumber = 0;
    for (const k of allKeys) {
      if (typeof k !== "string" || !k.startsWith(this.prefix)) {
        continue;
      }
      const value = await requestToPromise<unknown>(
        db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(k)
      );
      iterator(value, this.stripPrefix(k), iterationNumber);
      iterationNumber += 1;
    }
  };

  clear = async (): Promise<void> => {
    const db = await getDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const allKeys = await requestToPromise(
      tx.objectStore(STORE_NAME).getAllKeys()
    );
    const writeTx = db.transaction(STORE_NAME, "readwrite");
    const store = writeTx.objectStore(STORE_NAME);
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
