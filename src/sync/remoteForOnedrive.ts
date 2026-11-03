/**
 * (src/remoteForOnedrive.ts).
 *
 * Adaptations for astral-trek (zero new npm dependencies):
 * - @microsoft/microsoft-graph-client's `AuthenticationProvider` interface and
 *   @microsoft/microsoft-graph-types (`DriveItem`, `UploadSession`, `User`)
 *   are replaced by the minimal local Graph types below;
 * - the OAuth redirect URI is `obsidian://astral-trek-onedrive` (this plugin's
 *   own protocol handler), so a custom Azure app registration with that
 *   redirect URI is required (clientID is configurable in settings).
 */

import type { Vault} from "obsidian";
import { requestUrl, type RequestUrlParam } from "obsidian";

import {
  COMMAND_CALLBACK_ONEDRIVE,
  DEFAULT_CONTENT_TYPE,
  OAUTH2_FORCE_EXPIRE_MILLISECONDS,
  type OnedriveConfig,
  type RemoteItem,
} from "./baseTypes";
import { decryptArrayBuffer, encryptArrayBuffer } from "./encrypt";
import {
  bufferToArrayBuffer,
  encodeBase64,
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

const SCOPES = ["User.Read", "Files.ReadWrite.AppFolder", "offline_access"];
const REDIRECT_URI = `obsidian://${COMMAND_CALLBACK_ONEDRIVE}`;
const ONEDRIVE_AUTH_TIMEOUT_MS = 30000;

// Minimal local replacements for @microsoft/microsoft-graph-types.
interface GraphParentReference {
  path?: string;
}
interface GraphDriveItem {
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

export const DEFAULT_ONEDRIVE_CONFIG: OnedriveConfig = {
  accessToken: "",
  // Author-owned PKCE app: this project's own Azure app registration (also
  // the redirect URI obsidian://astral-trek-onedrive, so this works out of the box.
  clientID: "ad95e28f-d89a-43db-8ce6-0e64ef1283aa",
  authority: "https://login.microsoftonline.com/consumers/",
  refreshToken: "",
  accessTokenExpiresInSeconds: 0,
  accessTokenExpiresAtTime: 0,
  deltaLink: "",
  username: "",
  credentialsShouldBeDeletedAtTime: 0,
};

////////////////////////////////////////////////////////////////////////////////
// Onedrive authorization using PKCE
////////////////////////////////////////////////////////////////////////////////

// Helper functions for PKCE
async function generateCodeVerifier(): Promise<string> {
  const arrayBuffer = new Uint8Array(32);
  // Bare global WebCrypto: available in the Obsidian renderer (Chromium) and
  // in Node 18+ (tests); no window/globalThis reference so popout-safe.
  const cryptoApi = crypto;
  if (!cryptoApi || !cryptoApi.getRandomValues) {
    throw new Error("Crypto API not available");
  }
  cryptoApi.getRandomValues(arrayBuffer);
  return encodeBase64(String.fromCharCode(...arrayBuffer))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const cryptoApi = crypto;
  if (!cryptoApi || !cryptoApi.subtle || !cryptoApi.subtle.digest) {
    throw new Error("Crypto subtle API not available");
  }
  const digest = await cryptoApi.subtle.digest("SHA-256", data);
  return encodeBase64(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export async function getAuthUrlAndVerifier(
  clientID: string,
  authority: string
) {
  const verifier = await generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);

  // Build OAuth2 authorization URL manually
  const baseAuthority = authority.replace(/\/$/, ""); // strip trailing slash
  const params = new URLSearchParams({
    client_id: clientID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    response_mode: "query",
  });
  const authCodeUrl = `${baseAuthority}/oauth2/v2.0/authorize?${params.toString()}`;

  return {
    authUrl: authCodeUrl,
    verifier: verifier,
  };
}

/**
 * Check doc from
 * https://docs.microsoft.com/en-us/azure/active-directory/develop/v2-oauth2-auth-code-flow
 * https://docs.microsoft.com/en-us/onedrive/developer/rest-api/getting-started/graph-oauth?view=odsp-graph-online#code-flow
 */
export interface AccessCodeResponseSuccessfulType {
  token_type: "Bearer" | "bearer";
  expires_in: number;
  ext_expires_in?: number;
  scope: string;
  access_token: string;
  refresh_token?: string;
  id_token?: string;
}
export interface AccessCodeResponseFailedType {
  error: string;
  error_description: string;
  error_codes?: number[];
  timestamp?: string;
  trace_id?: string;
  correlation_id?: string;
}

export const sendAuthReq = async (
  clientID: string,
  authority: string,
  authCode: string,
  verifier: string
): Promise<AccessCodeResponseSuccessfulType | AccessCodeResponseFailedType> => {
  try {
    // extract tenant from authority URL
    const authorityUrl = new URL(authority);
    const tenant = authorityUrl.pathname.replace(/^\//, "") || "common";

    const requestPromise = requestUrl({
      url: `${authority.replace(/\/$/, "")}/oauth2/v2.0/token`,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      // Do NOT throw on non-2xx: we must read the response body to surface the
      // real Azure error_description (AADSTSxxxxx) instead of a bare "400".
      throw: false,
      body: new URLSearchParams({
        tenant: tenant,
        client_id: clientID,
        scope: SCOPES.join(" "),
        code: authCode,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }).toString(),
    }).json as unknown;

    const timeoutPromise = new Promise<never>((_, reject) => {
      window.setTimeout(() => {
        reject(Error("请求超时（30秒）。请检查网络连接后重试。"));
      }, ONEDRIVE_AUTH_TIMEOUT_MS);
    });

    const rsp = (await Promise.race([
      requestPromise,
      timeoutPromise,
    ])) as AccessCodeResponseSuccessfulType | AccessCodeResponseFailedType;

    if ("error" in rsp && rsp.error !== undefined) {
      const rspFailed = rsp;
      syncLog.debug("OneDrive auth error:", rspFailed);
      const errorMsg = rspFailed.error_description || rspFailed.error || "未知错误";
      return {
        ...rspFailed,
        error_description: errorMsg,
      };
    } else {
      return rsp;
    }
  } catch (err: unknown) {
    syncLog.debug("OneDrive auth request failed:", err);
    const error = err as {
      response?: { data?: string | Record<string, unknown> };
      message?: string;
    };
    // 尝试解析响应体获取更详细的错误信息
    if (error.response && error.response.data) {
      const errorData: Record<string, unknown> =
        typeof error.response.data === "string"
          ? (JSON.parse(error.response.data) as Record<string, unknown>)
          : error.response.data;
      const desc =
        typeof errorData.error_description === "string"
          ? errorData.error_description
          : "";
      const errCode = typeof errorData.error === "string" ? errorData.error : "";
      throw Error(`Azure API 错误: ${desc || errCode || JSON.stringify(errorData)}`);
    }

    throw Error(`网络请求失败: ${error.message ?? String(err)}`);
  }
};

export const sendRefreshTokenReq = async (
  clientID: string,
  authority: string,
  refreshToken: string
): Promise<AccessCodeResponseSuccessfulType | AccessCodeResponseFailedType> => {
  // also use Obsidian request to bypass CORS issue.
  const body = new URLSearchParams({
    tenant: "consumers",
    client_id: clientID,
    scope: SCOPES.join(" "),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }).toString();

  const requestParams: RequestUrlParam = {
    url: `${authority.replace(/\/$/, "")}/oauth2/v2.0/token`,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    throw: false, // surface real Azure error body on non-2xx
    body: body,
  };

  const requestPromise = requestUrl(requestParams).json as unknown;
  const timeoutPromise = new Promise<never>((_, reject) => {
    window.setTimeout(() => {
      reject(Error("请求超时（30秒）。请检查网络连接后重试。"));
    }, ONEDRIVE_AUTH_TIMEOUT_MS);
  });
  const rsp = (await Promise.race([requestPromise, timeoutPromise])) as Record<
    string,
    unknown
  >;

  if (rsp.error !== undefined) {
    return rsp as unknown as AccessCodeResponseFailedType;
  } else {
    return rsp as unknown as AccessCodeResponseSuccessfulType;
  }
};

export const setConfigBySuccessfullAuthInplace = async (
  config: OnedriveConfig,
  authRes: AccessCodeResponseSuccessfulType,
  saveUpdatedConfigFunc?: () => Promise<void>
) => {
  config.accessToken = authRes.access_token;
  config.accessTokenExpiresAtTime =
    Date.now() + authRes.expires_in * 1000 - 5 * 60 * 1000;
  config.accessTokenExpiresInSeconds = authRes.expires_in;
  config.refreshToken = authRes.refresh_token ?? "";

  // manually set it expired after 80 days;
  config.credentialsShouldBeDeletedAtTime =
    Date.now() + OAUTH2_FORCE_EXPIRE_MILLISECONDS;

  if (saveUpdatedConfigFunc !== undefined) {
    await saveUpdatedConfigFunc();
  }
};

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

const fromDriveItemToRemoteItem = (
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
  };
};

// Shared helper for OneDrive Graph API JSON calls.
// Uses `throw: false` so a non-2xx response (e.g. HTTP 400) is returned instead
// of being swallowed by an opaque RequestUrlError, then surfaces the real Graph
// error code/message + HTTP status.
const oneDriveApiRequest = async (
  method: string,
  theUrl: string,
  headers: Record<string, string>,
  body?: string
): Promise<Record<string, unknown>> => {
  const resp = await requestUrl({
    url: theUrl,
    method,
    contentType: "application/json",
    throw: false,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  const rawJson: unknown = resp.json;
  const json = (rawJson ?? {}) as Record<string, unknown>;
  const o = json as {
    error?: unknown;
    error_description?: string;
  };

  // Graph errors nest the real cause inside error.innerError:
  //   { "error": { "code":"invalidRequest", "message":"Invalid request",
  //                "innerError": { "code":"...", "message":"..." } } }
  // Recursively walk innerError to surface the actual reason instead of the
  // generic outer message, so the root cause is visible to the user.
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
    // Try parsing error as a plain string fallback
    if (!detail && typeof o.error === "string") {
      detail = o.error;
    }
    if (o.error_description) {
      detail = detail
        ? `${detail} — ${o.error_description}`
        : o.error_description;
    }
    // Always append the RAW response body so any detail we failed to parse
    // (e.g. innerError under a different key, or non-JSON payload) is visible.
    const rawText: unknown = resp.text;
    const raw =
      typeof rawText === "string" ? rawText : JSON.stringify(json);
    const apiError = Error(
      `OneDrive API ${method} ${theUrl} 失败 (HTTP ${resp.status}): ${
        detail || "无解析详情"
      }\nRAW BODY: ${raw}`
    ) as Error & { status?: number; code?: string };
    // Attach machine-readable metadata so callers can distinguish "the item is
    // gone" (404/itemNotFound) from auth/throttling/server/network failures
    // without parsing the human-readable message.
    apiError.status = resp.status;
    const graphErr = json.error as Record<string, unknown> | undefined;
    if (graphErr !== undefined && typeof graphErr.code === "string") {
      apiError.code = graphErr.code;
    }
    throw apiError;
  }
  return json;
};

class MyAuthProvider {
  onedriveConfig: OnedriveConfig;
  saveUpdatedConfigFunc: () => Promise<void>;
  constructor(
    onedriveConfig: OnedriveConfig,
    saveUpdatedConfigFunc: () => Promise<void>
  ) {
    this.onedriveConfig = onedriveConfig;
    this.saveUpdatedConfigFunc = saveUpdatedConfigFunc;
  }
  getAccessToken = async () => {
    if (
      this.onedriveConfig.accessToken === "" ||
      this.onedriveConfig.refreshToken === ""
    ) {
      throw Error("The user has not manually auth yet.");
    }

    const currentTs = Date.now();
    if (this.onedriveConfig.accessTokenExpiresAtTime > currentTs) {
      return this.onedriveConfig.accessToken;
    } else {
      // use refreshToken to refresh
      const r = await sendRefreshTokenReq(
        this.onedriveConfig.clientID,
        this.onedriveConfig.authority,
        this.onedriveConfig.refreshToken
      );
      if ("error" in r) {
        const r2 = r;
        throw Error(
          `Error while refreshing accessToken: ${r2.error}, ${String(
            r2.error_codes
          )}: ${r2.error_description}`
        );
      }
      const r2 = r;
      this.onedriveConfig.accessToken = r2.access_token;
      this.onedriveConfig.refreshToken = r2.refresh_token ?? "";
      this.onedriveConfig.accessTokenExpiresInSeconds = r2.expires_in;
      this.onedriveConfig.accessTokenExpiresAtTime =
        currentTs + r2.expires_in * 1000 - 60 * 2 * 1000;
      await this.saveUpdatedConfigFunc();
      return this.onedriveConfig.accessToken;
    }
  };
}

export class WrappedOnedriveClient {
  onedriveConfig: OnedriveConfig;
  remoteBaseDir: string;
  vaultFolderExists: boolean;
  authGetter: MyAuthProvider;
  saveUpdatedConfigFunc: () => Promise<void>;
  constructor(
    onedriveConfig: OnedriveConfig,
    remoteBaseDir: string,
    saveUpdatedConfigFunc: () => Promise<void>
  ) {
    this.onedriveConfig = onedriveConfig;
    this.remoteBaseDir = remoteBaseDir;
    this.vaultFolderExists = false;
    this.saveUpdatedConfigFunc = saveUpdatedConfigFunc;
    this.authGetter = new MyAuthProvider(onedriveConfig, saveUpdatedConfigFunc);
  }

  init = async () => {
    // check token
    if (
      this.onedriveConfig.accessToken === "" ||
      this.onedriveConfig.refreshToken === ""
    ) {
      throw Error("The user has not manually auth yet.");
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
    await requestUrl({
      url: theUrl,
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${await this.authGetter.getAccessToken()}`,
      },
    });
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
  saveUpdatedConfigFunc: () => Promise<void>
) => {
  return new WrappedOnedriveClient(
    onedriveConfig,
    remoteBaseDir,
    saveUpdatedConfigFunc
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
      await client.saveUpdatedConfigFunc();
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

  for (const entry of entries) {
    // 已删项：从快照中移除（即使 fromDriveItemToRemoteItem 失败也不影响删除判断）
    if (entry.deleted) {
      const name = entry.item.name;
      const parentPath = entry.item.parentReference?.path;
      if (name !== undefined && parentPath !== undefined) {
        try {
          const deletedItem = fromDriveItemToRemoteItem(
            entry.item,
            client.remoteBaseDir
          );
          if (deletedItem.key !== "/") {
            delete snapshot[deletedItem.key];
          }
        } catch {
          // 元数据不完整：尝试按路径后缀在快照里反查
          for (const key of Object.keys(snapshot)) {
            if (key.endsWith(`/${name}`) || key === `/${name}`) {
              delete snapshot[key];
              break;
            }
          }
        }
      }
      continue;
    }

    try {
      const remoteItem = fromDriveItemToRemoteItem(
        entry.item,
        client.remoteBaseDir
      );
      if (remoteItem.key !== "/") {
        snapshot[remoteItem.key] = remoteItem;
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
  // deltaLink（小字符串）→ 仍走 settings.sync，saveUpdatedConfigFunc 会写 data.json
  if (deltaLinkChanged) {
    client.onedriveConfig.deltaLink = newDeltaLink;
    await client.saveUpdatedConfigFunc();
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
  const content = (
    await requestUrl({
      url: downloadUrl,
      headers: { "Cache-Control": "no-cache" },
    })
  ).arrayBuffer;
  return content;
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
