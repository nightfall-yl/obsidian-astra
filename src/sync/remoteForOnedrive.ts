/**
 * (src/remoteForOnedrive.ts).
 *
 * Adaptations for astra (zero new npm dependencies):
 * - @microsoft/microsoft-graph-client's `AuthenticationProvider` interface and
 *   @microsoft/microsoft-graph-types (`DriveItem`, `UploadSession`, `User`)
 *   are replaced by the minimal local Graph types below;
 * - OAuth 鉴权改用 Device Code Flow（RFC 8628），跨平台零配置，不依赖
 *   obsidian:// URL scheme。Token 持久化走 Obsidian SecretStorage。
 *
 * 上游同步引擎移植自 remotely-save（Apache 2.0），保留同步算法与 Graph API 封装。
 */

import type { Vault } from "obsidian";
import {
  requestUrl,
  type RequestUrlParam,
  type RequestUrlResponse,
} from "obsidian";

import {
  DEFAULT_CONTENT_TYPE,
  type OnedriveConfig,
  type RemoteItem,
} from "./baseTypes";
import { decryptArrayBuffer, encryptArrayBuffer } from "./encrypt";
import {
  bufferToArrayBuffer,
  getRandomArrayBuffer,
  getRandomIntInclusive,
  mkdirpInVault,
} from "./misc";
import { syncLog } from "./log";
import {
  remoteSnapshotClear,
  remoteSnapshotLoadAll,
  remoteSnapshotRemove,
  remoteSnapshotSaveAll
} from "./idb";
import { DeviceCodeFlowClient } from "./onedrive/auth/deviceCodeFlow";
import type { OAuthEndpoints } from "./onedrive/auth/deviceCodeFlow";
import type { TokenStorage } from "./onedrive/auth/tokenStorage";

// Device Code Flow scope —— 个人账号走 AppFolder 隔离模式
const ONEDRIVE_SCOPES = [
  "User.Read",
  "Files.ReadWrite.AppFolder",
  "offline_access",
];

// Microsoft Identity 端点（个人账号 = /consumers）
function buildOAuthEndpoints(authority: string): OAuthEndpoints {
  const base = authority.replace(/\/$/, "");
  return {
    deviceCode: `${base}/oauth2/v2.0/devicecode`,
    token: `${base}/oauth2/v2.0/token`,
  };
}

// Minimal local replacements for @microsoft/microsoft-graph-types.
interface GraphParentReference {
  path?: string;
}
interface GraphDriveItem {
  id?: string;
  parentReference?: GraphParentReference;
  name?: string;
  fileSystemInfo?: { lastModifiedDateTime?: string };
  folder?: unknown;
  file?: unknown;
  deleted?: unknown;
  size?: number;
  cTag?: string;
  eTag?: string;
}
interface GraphUploadSession {
  uploadUrl?: string;
}
interface GraphUser {
  displayName?: string;
}

const DEFAULT_CLIENT_ID = "ad95e28f-d89a-43db-8ce6-0e64ef1283aa";

export const DEFAULT_ONEDRIVE_CONFIG: OnedriveConfig = {
  accessToken: "",
  clientID: DEFAULT_CLIENT_ID,
  authority: "https://login.microsoftonline.com/consumers/",
  refreshToken: "",
  accessTokenExpiresInSeconds: 0,
  accessTokenExpiresAtTime: 0,
  deltaLink: "",
  username: "",
  credentialsShouldBeDeletedAtTime: 0,
};

////////////////////////////////////////////////////////////////////////////////
// Device Code Flow 鉴权客户端 + AuthProvider 工厂
////////////////////////////////////////////////////////////////////////////////

/** 构造 DeviceCodeFlowClient（给 sync-manager 用） */
export function buildDeviceCodeFlowClient(cfg: OnedriveConfig): DeviceCodeFlowClient {
	return new DeviceCodeFlowClient({
		clientId: cfg.clientID,
		endpoints: buildOAuthEndpoints(cfg.authority),
		scopes: ONEDRIVE_SCOPES,
	});
}

/**
 * AuthProvider：每次 Graph API 调用前由 WrappedOnedriveClient.getAccessToken() 触发。
 *
 * - access token 过期前 2 分钟自动 refresh
 * - refresh 串行化（单飞锁），避免并发请求互相 invalidate refresh token
 * - Token 持久化完全走 TokenStorage（SecretStorage），data.json 只保留 deltaLink 等非敏感字段
 */
class MyAuthProvider {
	private refreshPromise: Promise<void> | null = null;
	/** 暴露给 WrappedOnedriveClient.init() 做鉴权检查 */
	readonly tokenStorage: TokenStorage;

	constructor(
		tokenStorage: TokenStorage,
		private readonly flowClient: DeviceCodeFlowClient
	) {
		this.tokenStorage = tokenStorage;
	}

	getAccessToken = async (): Promise<string> => {
		if (!this.tokenStorage.hasTokens()) {
			throw new Error("尚未完成 OneDrive 鉴权，请在设置页点击「授权 OneDrive」。");
		}

		if (!this.tokenStorage.isAccessTokenExpired(120_000)) {
			const at = this.tokenStorage.getAccessToken();
			if (!at) throw new Error("Token 存储异常，请重新授权。");
			return at;
		}

		// 过期了 → 单飞锁下 refresh
		if (!this.refreshPromise) {
			this.refreshPromise = this.doRefresh().finally(() => {
				this.refreshPromise = null;
			});
		}
		await this.refreshPromise;

		const at = this.tokenStorage.getAccessToken();
		if (!at) throw new Error("Token 存储异常，请重新授权。");
		return at;
	};

	private async doRefresh(): Promise<void> {
		const rt = this.tokenStorage.getRefreshToken();
		if (!rt) {
			throw new Error("没有 refresh token，请在设置页重新授权。");
		}
		const resp = await this.flowClient.refreshToken(rt);
		this.tokenStorage.setTokens(
			resp.access_token,
			resp.refresh_token ?? rt,
			resp.expires_in
		);
	}
}

////////////////////////////////////////////////////////////////////////////////
// Other usual common methods
////////////////////////////////////////////////////////////////////////////////

const getOnedrivePath = (fileOrFolderPath: string, remoteBaseDir: string) => {
  // https://docs.microsoft.com/en-us/onedrive/developer/rest-api/concepts/special-folders-appfolder?view=odsp-graph-online
  const prefix = `/drive/special/approot:/${remoteBaseDir}`;
  if (fileOrFolderPath.startsWith(prefix)) {
    // already transformed, return as is
    return fileOrFolderPath;
  }

  let key = fileOrFolderPath;
  if (fileOrFolderPath === "/" || fileOrFolderPath === "") {
    // special
    return prefix;
  }
  if (key.endsWith("/")) {
    key = key.slice(0, key.length - 1);
  }

  key = `${prefix}/${key}`;
  return key;
};

const constructFromDriveItemToRemoteItemError = (x: GraphDriveItem) => {
  return `parentPath="${x.parentReference?.path}", selfName="${x.name}"`;
};

/**
 * Generic parser for OneDrive parent paths.
 * OneDrive returns paths like:
 *   /drive/root:/Apps/AnyAppName/VaultName/subfolder
 *   /drive/root:/应用/任意本地化名称/VaultName/subfolder
 *   /Livefolders/Apps/AnyAppName/VaultName/subfolder
 *   /drive/items/<id>!<id>:/VaultName/subfolder  (URI encoded)
 *
 * We extract the path AFTER remoteBaseDir (the vault folder name)
 * regardless of what App Folder name / localization scheme is used.
 * This avoids hard-coding plugin name strings and ensures compatibility with
 * any AAD app display name.
 */
const extractKeyByRemoteBaseDir = (
  fullPathOrParentPath: string,
  remoteBaseDir: string,
  fileName: string,
  parentRefIsIdBased: boolean
): string | null => {
  // For /drive/items/ID:PATH style (ID-based parent reference),
  // fullPathOrParentPath = parent's colon-subpath, e.g. "/VaultName/sub"
  // or "/VaultName" itself. We need to re-append fileName at the end.
  if (parentRefIsIdBased) {
    const key = fullPathOrParentPath;
    if (key === `/${remoteBaseDir}`) {
      return fileName;
    }
    const prefix = `/${remoteBaseDir}/`;
    if (key.startsWith(prefix)) {
      return `${key.substring(prefix.length)}/${fileName}`;
    }
    return null;
  }

  // For named-path formats (/drive/root:/ or /Livefolders/...):
  // fullPathOrParentPath = parentPath/name, fully assembled
  // remoteBaseDir itself may appear at ANY path segment after the drive prefix
  const idx = fullPathOrParentPath.indexOf(`/${remoteBaseDir}/`);
  if (idx >= 0) {
    return fullPathOrParentPath.substring(idx + 1 + remoteBaseDir.length + 1);
  }
  // remoteBaseDir is the immediate parent (no subfolder)
  const trailing = fullPathOrParentPath.lastIndexOf(`/${remoteBaseDir}`);
  if (
    trailing >= 0 &&
    trailing + remoteBaseDir.length + 1 ===
      fullPathOrParentPath.indexOf(`/${fileName}`, trailing)
  ) {
    // e.g. ".../AppFolder/VaultName/fileName"
    return fullPathOrParentPath.substring(
      trailing + 1 + remoteBaseDir.length + 1
    );
  }
  // Fallback for when fileName sits exactly after remoteBaseDir:
  // fullPathOrParentPath ends with /<remoteBaseDir>/<fileName>
  const suffix = `/${remoteBaseDir}/${fileName}`;
  if (fullPathOrParentPath.endsWith(suffix)) {
    return fileName;
  }
  return null;
};

export const fromDriveItemToRemoteItem = (
  x: GraphDriveItem,
  remoteBaseDir: string
): RemoteItem => {
  if (
    x === undefined ||
    x.parentReference === undefined ||
    x.parentReference.path === undefined ||
    x.name === undefined
  ) {
    throw Error(`invalid drive item shape`);
  }

  let key = "";

  // another possibile prefix
  const THIRD_COMMON_PREFIX_RAW = `/drive/items/`;

  const fullPathOriginal = `${x.parentReference.path}/${x.name}`;

  // The delta listing may surface the vault ROOT folder itself as one of the
  // items (its parent is the app folder, which does NOT contain remoteBaseDir).
  // Map it to the "/" root key so listFromRemote filters it out instead of
  // treating it as an unrecognized item.
  // Use path-segment-aware check instead of plain includes(), otherwise an
  // app folder name like "Obsidian Vault Sync" falsely matches "/Obsidian Vault"
  // substring and breaks the vault-root detection.
  const parentPath = x.parentReference.path;
  const hasRemoteBaseDirAsSegment =
    parentPath.endsWith(`/${remoteBaseDir}`) ||
    parentPath.includes(`/${remoteBaseDir}/`);
  const isVaultRootItem =
    x.name === remoteBaseDir && !hasRemoteBaseDirAsSegment;
  if (isVaultRootItem) {
    return {
      key: "/",
      lastModified: Date.parse(x.fileSystemInfo?.lastModifiedDateTime ?? ""),
      size: 0,
      remoteType: "onedrive",
      etag: x.cTag || "",
      id: x.id,
    };
  }

  // Try generic parsing FIRST — this works for ANY app name / any localization
  // without hard-coding "Remotely Sync" / "Third-party Sync" / etc.
  // Format 1: /drive/root:/<LocalizedAppsFolder>/<AnyAppName>/<remoteBaseDir>/...
  // Format 2: /Livefolders/<LocalizedAppsFolder>/<AnyAppName>/<remoteBaseDir>/...
  let keyCandidate = extractKeyByRemoteBaseDir(
    fullPathOriginal,
    remoteBaseDir,
    x.name,
    false
  );
  if (keyCandidate !== null) {
    key = keyCandidate;
  } else if (x.parentReference.path.startsWith(THIRD_COMMON_PREFIX_RAW)) {
    // it's something like
    // /drive/items/<some_id>!<another_id>:/${remoteBaseDir}/<subfolder>
    // with uri encoded!
    const parPath = decodeURIComponent(x.parentReference.path);
    const colonSubpath = parPath.substring(parPath.indexOf(":") + 1);
    keyCandidate = extractKeyByRemoteBaseDir(
      colonSubpath,
      remoteBaseDir,
      x.name,
      true
    );
    if (keyCandidate === null) {
      throw Error(
        `we meet file/folder and do not know how to deal with it:\n${constructFromDriveItemToRemoteItemError(
          x
        )}`
      );
    }
    key = keyCandidate;
  } else {
    throw Error(
      `we meet file/folder and do not know how to deal with it:\n${constructFromDriveItemToRemoteItemError(
        x
      )}`
    );
  }

  const isFolder = "folder" in x;
  if (isFolder) {
    key = `${key}/`;
  }
  return {
    key: key,
    lastModified: Date.parse(x.fileSystemInfo?.lastModifiedDateTime ?? ""),
    size: isFolder ? 0 : (x.size ?? 0),
    remoteType: "onedrive",
    etag: x.cTag || "", // do NOT use x.eTag because it changes if meta changes
    // Persisted so a delta delete can be matched by id: deletion entries often
    // omit name/parentReference, which used to leave a ghost snapshot entry.
    id: x.id,
  };
};

/**
 * Snapshot lookups built in ONE pass over the snapshot, so processing a delta
 * delete is O(1) instead of an O(n) scan per deleted entry.
 * - byId: driveItem id → snapshot key(s). A key list (not a single key) covers
 *   snapshots that hold the same item twice, e.g. a plaintext key left over
 *   from before encryption was enabled plus the current encrypted key.
 * - byName: basename → key(s), fallback when the delete entry has no usable id.
 */
export interface SnapshotIndex {
  byId: Map<string, string[]>;
  byName: Map<string, string[]>;
}

const baseNameOfSnapshotKey = (key: string): string => {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
};

const registerSnapshotKey = (
  index: SnapshotIndex,
  key: string,
  item: RemoteItem
) => {
  if (item.id !== undefined && item.id !== "") {
    const keys = index.byId.get(item.id);
    if (keys === undefined) {
      index.byId.set(item.id, [key]);
    } else if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  const name = baseNameOfSnapshotKey(key);
  const nameKeys = index.byName.get(name);
  if (nameKeys === undefined) {
    index.byName.set(name, [key]);
  } else if (!nameKeys.includes(key)) {
    nameKeys.push(key);
  }
};

export const buildSnapshotIndex = (
  snapshot: Record<string, RemoteItem>
): SnapshotIndex => {
  const byId = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  const index: SnapshotIndex = { byId, byName };
  for (const key of Object.keys(snapshot)) {
    const item = snapshot[key];
    if (item === undefined) {
      continue;
    }
    registerSnapshotKey(index, key, item);
  }
  return index;
};

/**
 * True when the snapshot was persisted before `RemoteItem.id` existed.
 * Such entries cannot be matched by id, so listFromRemote rebuilds the
 * snapshot once via full enumeration.
 */
export const hasLegacySnapshotEntries = (
  snapshot: Record<string, RemoteItem>
): boolean => {
  for (const key of Object.keys(snapshot)) {
    if (snapshot[key]?.id === undefined) {
      return true;
    }
  }
  return false;
};

export interface DeletedRemoteItemLike {
  id?: string;
  name?: string;
  parentReference?: { path?: string };
}

/**
 * Remove the snapshot entry (or entries) a delta deletion refers to.
 * Strategy: id first (survives missing name/parentReference), then the legacy
 * name/path fallback. Returns how many keys were removed.
 */
export const removeSnapshotEntriesForDeletedItem = (
  snapshot: Record<string, RemoteItem>,
  index: SnapshotIndex,
  item: DeletedRemoteItemLike,
  remoteBaseDir: string
): number => {
  // 1) id — the only field a delta deletion is guaranteed to carry.
  if (item.id !== undefined && item.id !== "") {
    const keys = index.byId.get(item.id);
    if (keys !== undefined && keys.length > 0) {
      let removed = 0;
      for (const key of keys) {
        // Only drop entries that still describe this id: the index may hold a
        // stale mapping if the path was deleted and recreated under a new id.
        if (snapshot[key]?.id === item.id) {
          delete snapshot[key];
          removed += 1;
        }
      }
      if (removed > 0) {
        return removed;
      }
    }
  }

  // 2) fallback — exact path-derived key, then basename lookup (one-pass index,
  // no per-item scan of the whole snapshot).
  let removed = 0;
  try {
    const deletedItem = fromDriveItemToRemoteItem(
      item,
      remoteBaseDir
    );
    if (
      deletedItem.key !== "/" &&
      snapshot[deletedItem.key] !== undefined
    ) {
      delete snapshot[deletedItem.key];
      removed += 1;
    }
  } catch {
    // incomplete metadata (e.g. no name/parentReference): basename below
  }
  if (removed > 0) {
    return removed;
  }

  const name = item.name;
  if (name === undefined) {
    return 0;
  }
  const keys = index.byName.get(name);
  if (keys === undefined) {
    return 0;
  }
  for (const key of keys) {
    if (snapshot[key] !== undefined) {
      delete snapshot[key];
      removed += 1;
    }
  }
  return removed;
};

/** 2xx is a usable response. */
export const isHttpSuccessStatus = (status: number): boolean => {
  return status >= 200 && status < 300;
};

/** 404 or 410 means the addressed remote item no longer exists. */
export const isHttpNotFoundStatus = (status: number): boolean => {
  return status === 404 || status === 410;
};

/** HTTP statuses that are transient server-side failures — safe to retry. */
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
export const isTransientHttpStatus = (status: number): boolean =>
  TRANSIENT_STATUSES.has(status);

/** 指数退避 sleep：1s → 2s → 4s → …（测试时注入 0 可跳过等待） */
const sleepMs = (ms: number): Promise<void> =>
  new Promise<void>((res) => setTimeout(res, ms));

/**
 * Turn a raw API error (as thrown by buildRemoteApiError) into a short,
 * user-friendly string suitable for a Notice. Internal codes like
 * `UnknownError` / `itemNotFound` are mapped to Chinese explanations;
 * transient failures suggest retrying; auth failures suggest re-login.
 * The raw body stays available under `err.cause` for debugging but never
 * surfaces to the user.
 */
export const humanizeApiError = (err: unknown): string => {
  if (err === null || err === undefined) {
    return "";
  }
  if (typeof err === "string") {
    return err;
  }
  if (!(err instanceof Error)) {
    return "";
  }
  const e = err as Error & { status?: number; code?: string };
  const status = e.status;
  const code = e.code;

  if (status !== undefined) {
    switch (status) {
      case 401:
        return "OneDrive 授权已失效，请重新授权";
      case 403:
        return "OneDrive 拒绝访问（权限不足或租户策略限制）";
      case 404:
      case 410:
        return "OneDrive 上找不到这个文件";
      case 429:
        return "OneDrive 请求过于频繁（限流），请稍后再试";
      case 502:
      case 503:
      case 504:
        return "OneDrive 服务暂时不可用，请稍后重试";
    }
  }

  if (code !== undefined) {
    switch (code) {
      case "UnknownError":
      case "generalException":
        return "OneDrive 服务暂时异常，请稍后重试";
      case "itemNotFound":
        return "OneDrive 上找不到这个文件";
      case "accessDenied":
        return "OneDrive 拒绝访问（权限不足）";
      case "invalidInput":
        return "请求参数有误";
    }
  }

  // Fallback: the clean message from buildRemoteApiError (no RAW BODY).
  return e.message;
};

/**
 * A DELETE that answers 2xx or 404 has reached its goal: 404 means the item is
 * already gone, which is exactly the state the caller wanted.
 */
export const isDeleteResponseDone = (status: number): boolean => {
  return isHttpSuccessStatus(status) || isHttpNotFoundStatus(status);
};

/**
 * Safely parse a response body. Never throws: `RequestUrlResponse.json` may be a
 * lazy getter that raises `SyntaxError` on non-JSON bodies (HTML error pages,
 * empty 404), so error paths must parse `resp.text` themselves.
 * Returns undefined when the body is empty, invalid JSON, or not an object.
 */
export const parseJsonBodySafe = (
  rawText: unknown
): Record<string, unknown> | undefined => {
  if (typeof rawText !== "string" || rawText === "") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(rawText);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Build the shared Onedrive error shape: human-readable message plus the
 * machine-readable `status` / `code` fields that `isRemoteItemNotFoundError`
 * relies on. The raw body is stored on `cause` (accessible via `err.cause.rawBody`)
 * but intentionally NOT concatenated into the message — end-users see a short
 * summary, while debugging still has the full payload available.
 */
export const buildRemoteApiError = (
  method: string,
  theUrl: string,
  status: number,
  rawText: unknown,
  detail: string = ""
): Error & { status?: number; code?: string; cause?: unknown } => {
  const parsed = parseJsonBodySafe(rawText);
  const raw =
    typeof rawText === "string" ? rawText : JSON.stringify(rawText ?? {});
  const apiError = Error(
    `OneDrive API ${method} ${theUrl} 失败 (HTTP ${status}): ${detail || "无解析详情"}`
  ) as Error & { status?: number; code?: string; cause?: unknown };
  apiError.status = status;
  apiError.cause = { rawBody: raw };
  const graphErr = parsed?.error as Record<string, unknown> | undefined;
  if (graphErr !== undefined && typeof graphErr.code === "string") {
    apiError.code = graphErr.code;
  }
  return apiError;
};

/** Human-readable fallback for a non-2xx response that carries no error body. */
export const httpStatusText = (status: number): string => {
  switch (status) {
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 409:
      return "Conflict";
    case 410:
      return "Gone";
    case 429:
      return "Too Many Requests";
    case 500:
      return "Internal Server Error";
    case 502:
      return "Bad Gateway";
    case 503:
      return "Service Unavailable";
    case 504:
      return "Gateway Timeout";
    default:
      return `HTTP ${status}`;
  }
};

/**
 * True when a non-2xx response must be treated as an API failure even if the
 * body has no Graph error fields (empty body, HTML error page, proxy 502 …).
 * Mirrors the upstream 26.2.8 guard: such responses used to fall through and
 * return `{}`, which callers could silently interpret as "no data".
 */
export const isBareErrorStatus = (status: number): boolean => {
  return status >= 400;
};

// Uses `throw: false` so a non-2xx response (e.g. HTTP 400) is returned instead
// of being swallowed by an opaque RequestUrlError, then surfaces the real Graph
// error code/message + HTTP status.
// `requester` is injectable for unit tests; production always uses requestUrl.
// Transient server failures (429/502/503/504) are retried up to 3 times with
// exponential backoff (1s → 2s → 4s); permanent failures throw immediately.
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
export const oneDriveApiRequest = async (
  method: string,
  theUrl: string,
  headers: Record<string, string>,
  body?: string,
  requester: (
    param: RequestUrlParam
  ) => Promise<RequestUrlResponse> = requestUrl,
  sleepFn: (ms: number) => Promise<void> = sleepMs
): Promise<Record<string, unknown>> => {
  let resp: RequestUrlResponse | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = RETRY_BASE_MS * 2 ** (attempt - 1);
      syncLog.info(
        `oneDriveApiRequest retry ${attempt}/${MAX_RETRIES} after HTTP ${resp?.status}, backoff=${backoff}ms: ${method} ${theUrl}`
      );
      await sleepFn(backoff);
    }

    resp = await requester({
      url: theUrl,
      method,
      contentType: "application/json",
      throw: false,
      headers,
      ...(body !== undefined ? { body } : {}),
    });

    if (resp.status < 400) {
      break; // success path handled by finalizeApiError
    }
    // Permanent failure — throw immediately, do not retry.
    if (!isTransientHttpStatus(resp.status)) {
      return finalizeApiError(method, theUrl, resp.status, resp.text);
    }
    // Transient failure — loop back (unless this was the last attempt).
  }

  // Loop exited naturally: either success (<400) or exhausted retries on transient.
  if (resp === null) {
    // Shouldn't happen but keeps TS happy
    throw new Error("oneDriveApiRequest: no response");
  }
  return finalizeApiError(method, theUrl, resp.status, resp.text);
};

/** Shared error finalization: parse Graph error body, build clean Error. */
const finalizeApiError = (
  method: string,
  theUrl: string,
  status: number,
  rawText: unknown
): Record<string, unknown> => {
  if (status < 400) {
    return parseJsonBodySafe(rawText) ?? {};
  }
  // Non-2xx: build human-readable error with no RAW BODY in message.
  const parsed = parseJsonBodySafe(rawText);
  const o = (parsed ?? {}) as {
    error?: unknown;
    error_description?: string;
  };

  const collectErrorDetail = (node: unknown, depth: number): string => {
    if (node === undefined || node === null || typeof node !== "object") {
      return "";
    }
    const obj = node as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof obj.code === "string") {
      parts.push(obj.code);
    }
    if (typeof obj.message === "string") {
      parts.push(obj.message);
    }
    let inner = "";
    if (depth < 5 && obj.innerError && typeof obj.innerError === "object") {
      inner = collectErrorDetail(obj.innerError, depth + 1);
    }
    const joined = parts.filter(Boolean).join(" ");
    return [joined, inner].filter(Boolean).join(" → ");
  };

  if (o.error !== undefined || o.error_description !== undefined) {
    let detail = collectErrorDetail(o.error, 0);
    if (!detail && typeof o.error === "string") {
      detail = o.error;
    }
    if (o.error_description) {
      detail = detail
        ? `${detail} — ${o.error_description}`
        : o.error_description;
    }
    throw buildRemoteApiError(method, theUrl, status, rawText, detail);
  }

  if (isBareErrorStatus(status)) {
    throw buildRemoteApiError(
      method,
      theUrl,
      status,
      rawText,
      httpStatusText(status)
    );
  }
  return parsed ?? {};
};

export class WrappedOnedriveClient {
  onedriveConfig: OnedriveConfig;
  remoteBaseDir: string;
  vaultFolderExists: boolean;
  authGetter: MyAuthProvider;
  /** 非敏感字段（deltaLink 等）持久化回调；token 不再走这里 */
  saveSettingsCb?: () => Promise<void>;
  constructor(
    onedriveConfig: OnedriveConfig,
    remoteBaseDir: string,
    tokenStorage: TokenStorage,
    flowClient: DeviceCodeFlowClient,
    saveSettingsCb?: () => Promise<void>
  ) {
    this.onedriveConfig = onedriveConfig;
    this.remoteBaseDir = remoteBaseDir;
    this.vaultFolderExists = false;
    this.authGetter = new MyAuthProvider(tokenStorage, flowClient);
    this.saveSettingsCb = saveSettingsCb;
  }

  init = async () => {
    // check token (SecretStorage via TokenStorage)
    if (!this.authGetter.tokenStorage.hasTokens()) {
      throw Error("尚未完成 OneDrive 鉴权，请在设置页点击「授权 OneDrive」。");
    }

    // Ensure the vault folder exists under approot.
    // Use PATCH with path-based addressing + conflictBehavior, which is the
    // approach proven to work by upstream remotely-save on personal accounts:
    //   PATCH /drive/special/approot:/<vaultName>
    //   { "folder": {}, "@microsoft.graph.conflictBehavior": "replace" }
    // This is idempotent (creates a fresh folder or is a no-op if it exists),
    // and avoids the `POST /drive/special/approot/children` form, which can
    // return a generic 400 invalidRequest (empty innerError) on personal
    // Microsoft accounts.
    if (!this.vaultFolderExists) {
      await this.patchJson(
        `/drive/special/approot:/${this.remoteBaseDir}`,
        {
          folder: {},
          "@microsoft.graph.conflictBehavior": "replace",
        }
      );
      this.vaultFolderExists = true;
    }
  };

  buildUrl = (pathFragOrig: string) => {
    const API_PREFIX = "https://graph.microsoft.com/v1.0";
    let theUrl = "";
    if (
      pathFragOrig.startsWith("http://") ||
      pathFragOrig.startsWith("https://")
    ) {
      theUrl = pathFragOrig;
    } else {
      const pathFrag = encodeURI(pathFragOrig);
      theUrl = `${API_PREFIX}${pathFrag}`;
    }
    return theUrl;
  };

  getJson = async (pathFragOrig: string) => {
    const theUrl = this.buildUrl(pathFragOrig);
    syncLog.debug(`getJson, theUrl=${theUrl}`);
    const accessToken = await this.authGetter.getAccessToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Cache-Control": "no-cache",
    };

    return oneDriveApiRequest("GET", theUrl, headers);
  };

  postJson = async (pathFragOrig: string, payload: Record<string, unknown>) => {
    const theUrl = this.buildUrl(pathFragOrig);
    syncLog.debug(`postJson, theUrl=${theUrl}`);
    const accessToken = await this.authGetter.getAccessToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
    };

    return oneDriveApiRequest("POST", theUrl, headers, JSON.stringify(payload));
  };

  patchJson = async (pathFragOrig: string, payload: Record<string, unknown>) => {
    const theUrl = this.buildUrl(pathFragOrig);
    syncLog.debug(`patchJson, theUrl=${theUrl}`);
    const accessToken = await this.authGetter.getAccessToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
    };

    return oneDriveApiRequest("PATCH", theUrl, headers, JSON.stringify(payload));
  };

  deleteJson = async (pathFragOrig: string) => {
    const theUrl = this.buildUrl(pathFragOrig);
    syncLog.debug(`deleteJson, theUrl=${theUrl}`);
    // `throw: false`: a 404 (item already gone) must be reported as success,
    // not as an opaque `Request failed, status 404`.
    const resp = await requestUrl({
      url: theUrl,
      method: "DELETE",
      throw: false,
      headers: {
        Authorization: `Bearer ${await this.authGetter.getAccessToken()}`,
      },
    });
    if (isDeleteResponseDone(resp.status)) {
      if (isHttpNotFoundStatus(resp.status)) {
        syncLog.debug(
          `deleteJson: remote item already absent (HTTP 404), nothing to do: ${theUrl}`
        );
      }
      return;
    }
    throw buildRemoteApiError(
      "DELETE",
      theUrl,
      resp.status,
      resp.text
    );
  };

  putArrayBuffer = async (pathFragOrig: string, payload: ArrayBuffer) => {
    const theUrl = this.buildUrl(pathFragOrig);
    syncLog.debug(`putArrayBuffer, theUrl=${theUrl}`);
    const accessToken = await this.authGetter.getAccessToken();
    // capture the real HTTP result instead of relying on requestUrl throwing,
    // so a failing PUT is visible in the console rather than silently swallowed.
    const resp = await requestUrl({
      url: theUrl,
      method: "PUT",
      body: payload,
      contentType: DEFAULT_CONTENT_TYPE,
      throw: false,
      headers: {
        "Content-Type": DEFAULT_CONTENT_TYPE,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (resp.status >= 200 && resp.status < 300) {
      return;
    }
    const rawText: unknown = resp.text;
    const rawJson: unknown = resp.json;
    const raw =
      typeof rawText === "string" ? rawText : JSON.stringify(rawJson ?? {});
    throw Error(`OneDrive 文件上传失败 (HTTP ${resp.status}): ${raw}`);
  };

  /**
   * A specialized function to upload large files by parts
   * @param pathFragOrig
   * @param payload
   * @param rangeStart
   * @param rangeEnd the end, exclusive
   * @param size
   */
  putUint8ArrayByRange = async (
    pathFragOrig: string,
    payload: Uint8Array,
    rangeStart: number,
    rangeEnd: number,
    size: number
  ) => {
    const theUrl = this.buildUrl(pathFragOrig);
    syncLog.debug(
      `putUint8ArrayByRange, theUrl=${theUrl}, range=${rangeStart}-${
        rangeEnd - 1
      }, len=${rangeEnd - rangeStart}, size=${size}`
    );
    // NO AUTH HEADER here!
    const res = await requestUrl({
      url: theUrl,
      method: "PUT",
      body: bufferToArrayBuffer(payload.subarray(rangeStart, rangeEnd)),
      contentType: DEFAULT_CONTENT_TYPE,
      headers: {
        // no "Content-Length" allowed here
        "Content-Range": `bytes ${rangeStart}-${rangeEnd - 1}/${size}`,
        /* "Cache-Control": "no-cache", not allowed here!!! */
      },
    });
    const resJson: unknown = res.json;
    return resJson as GraphDriveItem | GraphUploadSession;
  };
}

export const getOnedriveClient = (
  onedriveConfig: OnedriveConfig,
  remoteBaseDir: string,
  tokenStorage: TokenStorage,
  flowClient: DeviceCodeFlowClient,
  saveSettingsCb?: () => Promise<void>
) => {
  return new WrappedOnedriveClient(
    onedriveConfig,
    remoteBaseDir,
    tokenStorage,
    flowClient,
    saveSettingsCb
  );
};

/**
 * Use OneDrive delta API to list all files and folders.
 * https://learn.microsoft.com/en-us/onedrive/developer/rest-api/api/driveitem_delta
 *
 * 两种模式：
 *   1. 全量枚举（首次 / deltaLink 已过期）：打起始端点 /delta?$top=200，分页拉全量，
 *      存快照和 deltaLink，返回完整 Contents
 *   2. Delta 续传（deltaLink + 快照都存在）：直接用存的 deltaLink URL，拿到增量变化
 *      后合并到本地快照（新增/修改 upsert，删除移除），返回合并后的完整 Contents。
 *      任何网络错误或 410 Gone 都会回退到全量枚举（同时清空 deltaLink + 快照）
 */
export const listFromRemote = async (
  client: WrappedOnedriveClient,
  prefix?: string
) => {
  if (prefix !== undefined) {
    throw Error("prefix not supported (yet)");
  }
  await client.init();

  const NEXT_LINK_KEY = "@odata.nextLink";
  const DELTA_LINK_KEY = "@odata.deltaLink";

  // 从 IndexedDB 读远端快照（如果库尚未创建或读失败，返回 {} 降级为全量枚举）
  let idbSnapshot = await remoteSnapshotLoadAll<RemoteItem>();

  // 旧快照（条目缺 driveItem.id）无法按 id 匹配删除项：清空一次并强制全量
  // 枚举重建，让 id 落库。deltaLink 保留，重建后仍走增量续传；因为全量枚举
  // 写入的条目都带 id，后续不会再触发（只在“存在缺 id 条目”时为真）。
  if (hasLegacySnapshotEntries(idbSnapshot)) {
    syncLog.debug(
      `remote snapshot has entries without driveItem id, rebuild once via full enumeration`
    );
    await remoteSnapshotClear();
    idbSnapshot = {};
  }

  const tryDeltaResume =
    !!client.onedriveConfig.deltaLink &&
    Object.keys(idbSnapshot).length > 0;

  let items: GraphDriveItem[] = [];
  let newDeltaLink = "";
  let usedFullEnumeration = false;

  const fetchAllPages = async (startUrl: string) => {
    const collected: GraphDriveItem[] = [];
    let res = await client.getJson(startUrl);
    collected.push(...((res.value ?? []) as GraphDriveItem[]));
    while (NEXT_LINK_KEY in res) {
      res = await client.getJson(res[NEXT_LINK_KEY] as string);
      collected.push(...((res.value ?? []) as GraphDriveItem[]));
    }
    if (DELTA_LINK_KEY in res) {
      newDeltaLink = res[DELTA_LINK_KEY] as string;
    }
    return collected;
  };

  if (tryDeltaResume) {
    try {
      items = await fetchAllPages(client.onedriveConfig.deltaLink);
    } catch (err) {
      // deltaLink 过期或远端不可用 → 回退全量枚举
      syncLog.warn(
        `deltaLink 续传失败，回退全量枚举：${err instanceof Error ? err.message : String(err)}`
      );
      client.onedriveConfig.deltaLink = "";
      await remoteSnapshotClear();
      // Keep the in-memory base in sync with the store we just cleared; otherwise
      // the full enumeration below would merge into a stale, already-discarded
      // snapshot and resurrect entries the remote no longer has.
      idbSnapshot = {};
      await client.saveSettingsCb?.();
      usedFullEnumeration = true;
    }
  } else {
    usedFullEnumeration = true;
  }

  if (usedFullEnumeration) {
    const startUrl = `/drive/special/approot:/${client.remoteBaseDir}:/delta?$top=200`;
    items = await fetchAllPages(startUrl);
  }

  // ── 构建变更集（区分普通项和已删项） ──
  type DeltaEntry = { item: GraphDriveItem; deleted: boolean };
  const entries: DeltaEntry[] = items.map((item) => ({
    item,
    deleted: (item as Record<string, unknown>).deleted !== undefined,
  }));

  // ── 合并到快照（从 IDB 读入，浅拷贝避免回写污染原始引用） ──
  // 全量枚举结果是远端当前状态的唯一事实来源，必须从空快照重建：
  // 若沿用旧快照做基底，远端已删除但 delta 未报告的键会永远残留（幽灵条目）。
  let snapshot: Record<string, RemoteItem> = usedFullEnumeration
    ? {}
    : { ...idbSnapshot };

  // id→key 反向索引：只遍历快照一次（O(n)），之后每个删除项 O(1) 命中，
  // 避免“每个删除项都全表扫一遍”的 O(n*m)。
  const snapshotIndex = buildSnapshotIndex(snapshot);

  for (const entry of entries) {
    // 已删项：优先按 driveItem.id 移除（delta 删除项常常不带 name/parentReference，
    // 以前这种条目会被整条跳过，留下幽灵键），id 不可用再回退 name/path。
    if (entry.deleted) {
      removeSnapshotEntriesForDeletedItem(
        snapshot,
        snapshotIndex,
        entry.item,
        client.remoteBaseDir
      );
      continue;
    }

    try {
      const remoteItem = fromDriveItemToRemoteItem(
        entry.item,
        client.remoteBaseDir
      );
      if (remoteItem.key !== "/") {
        snapshot[remoteItem.key] = remoteItem;
        // 同一批 delta 里“新增后又被删除”的条目也能被后续删除项命中。
        registerSnapshotKey(snapshotIndex, remoteItem.key, remoteItem);
      }
    } catch (err) {
      syncLog.warn(
        `skip unrecognized onedrive item while listing remote: ${JSON.stringify(
          {
            name: entry.item?.name,
            parentPath: entry.item?.parentReference?.path,
          }
        )}`,
        err
      );
    }
  }

  // ── 脏检查：只有 snapshot 或 deltaLink 真正变化时才持久化 ──
  const snapshotChanged =
    Object.keys(idbSnapshot).length !== Object.keys(snapshot).length ||
    Object.keys(snapshot).some(
      (key) =>
        JSON.stringify(idbSnapshot[key]) !== JSON.stringify(snapshot[key])
    );
  const deltaLinkChanged =
    !!newDeltaLink && newDeltaLink !== client.onedriveConfig.deltaLink;

  // 快照 → IndexedDB（data.json 不再承载这份 ~367KB 的数据）
  if (snapshotChanged) {
    await remoteSnapshotSaveAll(snapshot);
  }
  // deltaLink（小字符串）→ 仍走 settings.sync，saveSettingsCb 会写 data.json
  if (deltaLinkChanged) {
    client.onedriveConfig.deltaLink = newDeltaLink;
    await client.saveSettingsCb?.();
  }

  // ── 返回完整 Contents ──
  return {
    Contents: Object.values(snapshot),
  };
};

export const getRemoteMeta = async (
  client: WrappedOnedriveClient,
  fileOrFolderPath: string
) => {
  await client.init();
  const remotePath = getOnedrivePath(fileOrFolderPath, client.remoteBaseDir);
  const rsp = await client.getJson(
    `${remotePath}?$select=cTag,eTag,fileSystemInfo,folder,file,name,parentReference,size`
  );
  const driveItem = rsp as GraphDriveItem;
  const res = fromDriveItemToRemoteItem(driveItem, client.remoteBaseDir);
  return res;
};

export const uploadToRemote = async (
  client: WrappedOnedriveClient,
  fileOrFolderPath: string,
  vault: Vault,
  isRecursively: boolean = false,
  password: string = "",
  remoteEncryptedKey: string = "",
  foldersCreatedBefore: Set<string> | undefined = undefined,
  uploadRaw: boolean = false,
  rawContent: string | ArrayBuffer = ""
) => {
  await client.init();

  let uploadFile = fileOrFolderPath;
  if (password !== "") {
    uploadFile = remoteEncryptedKey;
  }
  uploadFile = getOnedrivePath(uploadFile, client.remoteBaseDir);
  syncLog.debug(`uploadFile=${uploadFile}`);

  const isFolder = fileOrFolderPath.endsWith("/");

  if (isFolder && isRecursively) {
    throw Error("upload function doesn't implement recursive function yet!");
  } else if (isFolder && !isRecursively) {
    if (uploadRaw) {
      throw Error(`you specify uploadRaw, but you also provide a folder key!`);
    }
    // folder
    if (password === "") {
      // if not encrypted, mkdir a remote folder
      if (foldersCreatedBefore?.has(uploadFile)) {
        // created, pass
      } else {
        // https://stackoverflow.com/questions/56479865/creating-nested-folders-in-one-go-onedrive-api
        // use PATCH to create folder recursively!!!
        await client.patchJson(uploadFile, {
          folder: {},
          "@microsoft.graph.conflictBehavior": "replace",
        });
      }
      const res = await getRemoteMeta(client, uploadFile);
      return res;
    } else {
      // if encrypted,
      // upload a fake, random-size file
      // with the encrypted file name
      const byteLengthRandom = getRandomIntInclusive(
        1,
        65536 /* max allowed */
      );
      const arrBufRandom = await encryptArrayBuffer(
        getRandomArrayBuffer(byteLengthRandom),
        password
      );

      // an encrypted folder is always small, we just use put here
      await client.putArrayBuffer(
        `${uploadFile}:/content?${new URLSearchParams({
          "@microsoft.graph.conflictBehavior": "replace",
        })}`,
        arrBufRandom
      );
      const res = await getRemoteMeta(client, uploadFile);
      return res;
    }
  } else {
    // file
    // we ignore isRecursively parameter here
    let localContent: ArrayBuffer;
    if (uploadRaw) {
      if (typeof rawContent === "string") {
        localContent = bufferToArrayBuffer(new TextEncoder().encode(rawContent));
      } else {
        localContent = rawContent;
      }
    } else {
      localContent = await vault.adapter.readBinary(fileOrFolderPath);
    }
    let remoteContent = localContent;
    if (password !== "") {
      remoteContent = await encryptArrayBuffer(localContent, password);
    }

    // no need to create parent folders firstly, cool!

    // hard code range size
    const MIN_UNIT = 327680; // bytes in msft doc, about 0.32768 MB
    const RANGE_SIZE = MIN_UNIT * 20; // about 6.5536 MB
    const DIRECT_UPLOAD_MAX_SIZE = 1000 * 1000 * 4; // 4 Megabyte

    if (remoteContent.byteLength < DIRECT_UPLOAD_MAX_SIZE) {
      // directly using put!
      await client.putArrayBuffer(
        `${uploadFile}:/content?${new URLSearchParams({
          "@microsoft.graph.conflictBehavior": "replace",
        })}`,
        remoteContent
      );
    } else {
      // upload large files!
      // ref: https://docs.microsoft.com/en-us/onedrive/developer/rest-api/api/driveitem_createuploadsession?view=odsp-graph-online

      // 1. create uploadSession
      // uploadFile already starts with /drive/special/approot:/${remoteBaseDir}
      const s = (await client.postJson(`${uploadFile}:/createUploadSession`, {
        item: {
          "@microsoft.graph.conflictBehavior": "replace",
        },
      })) as unknown as GraphUploadSession;
      const uploadUrl = s.uploadUrl;
      if (uploadUrl === undefined) {
        throw Error("createUploadSession did not return an uploadUrl");
      }
      syncLog.debug("uploadSession = ");
      syncLog.debug(s);

      // 2. upload by ranges
      // convert to uint8
      const uint8 = new Uint8Array(remoteContent);

      // upload the ranges one by one
      let rangeStart = 0;
      while (rangeStart < uint8.byteLength) {
        await client.putUint8ArrayByRange(
          uploadUrl,
          uint8,
          rangeStart,
          Math.min(rangeStart + RANGE_SIZE, uint8.byteLength),
          uint8.byteLength
        );
        rangeStart += RANGE_SIZE;
      }
    }

    const res = await getRemoteMeta(client, uploadFile);
    return res;
  }
};

const downloadFromRemoteRaw = async (
  client: WrappedOnedriveClient,
  fileOrFolderPath: string
): Promise<ArrayBuffer> => {
  await client.init();
  const key = getOnedrivePath(fileOrFolderPath, client.remoteBaseDir);
  const rsp = await client.getJson(`${key}?$select=@microsoft.graph.downloadUrl`);
  const downloadUrl = rsp["@microsoft.graph.downloadUrl"] as string;
  // `throw: false`: requestUrl would otherwise throw `Request failed, status
  // 404`, an error without `status`/`code`, which the sync engine cannot tell
  // apart from auth/throttling failures. Report it in the same shape as
  // oneDriveApiRequest so a gone item (404/itemNotFound) is recognised.
  const resp = await requestUrl({
    url: downloadUrl,
    headers: { "Cache-Control": "no-cache" },
    throw: false,
  });
  if (!isHttpSuccessStatus(resp.status)) {
    // Use the approot path (not the signed download URL) in the message so the
    // notice/log stays readable and no temporary token leaks into it.
    throw buildRemoteApiError("GET", downloadUrl, resp.status, resp.text);
  }
  return resp.arrayBuffer;
};

export const downloadFromRemote = async (
  client: WrappedOnedriveClient,
  fileOrFolderPath: string,
  vault: Vault,
  mtime: number,
  password: string = "",
  remoteEncryptedKey: string = "",
  skipSaving: boolean = false
) => {
  await client.init();

  const isFolder = fileOrFolderPath.endsWith("/");

  if (!skipSaving) {
    await mkdirpInVault(fileOrFolderPath, vault);
  }

  if (isFolder) {
    // mkdirp locally is enough
    // do nothing here
    return new ArrayBuffer(0);
  } else {
    let downloadFile = fileOrFolderPath;
    if (password !== "") {
      downloadFile = remoteEncryptedKey;
    }
    downloadFile = getOnedrivePath(downloadFile, client.remoteBaseDir);
    const remoteContent = await downloadFromRemoteRaw(client, downloadFile);
    let localContent = remoteContent;
    if (password !== "") {
      localContent = await decryptArrayBuffer(remoteContent, password);
    }
    if (!skipSaving) {
      await vault.adapter.writeBinary(fileOrFolderPath, localContent, {
        mtime: mtime,
      });
    }
    return localContent;
  }
};

export const deleteFromRemote = async (
  client: WrappedOnedriveClient,
  fileOrFolderPath: string,
  password: string = "",
  remoteEncryptedKey: string = ""
) => {
  if (fileOrFolderPath === "/") {
    return;
  }
  let remoteFileName = fileOrFolderPath;
  if (password !== "") {
    remoteFileName = remoteEncryptedKey;
  }
  remoteFileName = getOnedrivePath(remoteFileName, client.remoteBaseDir);

  await client.init();
  await client.deleteJson(remoteFileName);
};

/**
 * Drop one entry from the persisted OneDrive remote snapshot.
 * `key` is the relative vault key emitted by `listFromRemote` (same shape the
 * sync engine uses), so no path translation is needed. Deletion is per-key —
 * the whole store is never reloaded or rewritten.
 */
export const removeFromRemoteSnapshot = async (key: string): Promise<void> => {
  await remoteSnapshotRemove(key);
};

export const checkConnectivity = async (
  client: WrappedOnedriveClient,
  callbackFunc?: (err?: unknown) => void
) => {
  try {
    const k = await getUserDisplayName(client);
    return k !== "<unknown display name>";
  } catch (err) {
    syncLog.debug(err);
    if (callbackFunc !== undefined) {
      callbackFunc(err);
    }
    return false;
  }
};

export const getUserDisplayName = async (client: WrappedOnedriveClient) => {
  await client.init();
  const res = await client.getJson("/me?$select=displayName");
  return ((res as GraphUser).displayName ?? "") || "<unknown display name>";
};

/**
 *
 * https://docs.microsoft.com/en-us/azure/active-directory/develop/v2-protocols-oidc#send-a-sign-out-request
 * https://docs.microsoft.com/en-us/graph/api/user-revokesigninsessions
 * https://docs.microsoft.com/en-us/graph/api/user-invalidateallrefreshtokens
 */
export const getRevokeAddr = async () => {
  return "https://account.live.com/consent/Manage";
};
