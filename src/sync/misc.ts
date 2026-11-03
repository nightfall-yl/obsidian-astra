/**
 * Trimmed to the helpers actually used by the sync engine; the nanoid
 * dependency is replaced by a crypto-based randomId.
 */

import type { Vault } from "obsidian";
import { moment, normalizePath as obsidianNormalizePath } from "obsidian";

import { syncLog } from "./log";

const getCrypto = (): Crypto => {
  if (typeof window !== "undefined" && window.crypto) {
    return window.crypto;
  }
  return window.crypto;
};

/**
 * nanoid replacement (no new npm dependency).
 * Same alphabet and default length as nanoid.
 */
const NANOID_ALPHABET =
  "useandom-26T198340PX75pxJACKVERYMINDBUSHOLFWOLFGQZbfghjklqvwyzrict";

export const randomId = (size: number = 21): string => {
  const bytes = new Uint8Array(size);
  getCrypto().getRandomValues(bytes);
  let id = "";
  for (let i = 0; i < size; i++) {
    id += NANOID_ALPHABET.charAt((bytes[i] ?? 0) % 64);
  }
  return id;
};

/**
 * If any part of the file starts with '.' or '_' then it's a hidden file.
 */
export const isHiddenPath = (
  item: string,
  dot: boolean = true,
  underscore: boolean = true
) => {
  if (!(dot || underscore)) {
    throw Error("parameter error for isHiddenPath");
  }
  const k = obsidianNormalizePath(item);
  const k2 = k.split("/"); // TODO: only unix path now
  for (const singlePart of k2) {
    if (singlePart === "." || singlePart === ".." || singlePart === "") {
      continue;
    }
    if (dot && singlePart[0] === ".") {
      return true;
    }
    if (underscore && singlePart[0] === "_") {
      return true;
    }
  }
  return false;
};

/**
 * Normalizes a path
 */
export const dirname = (path: string) => {
  // Normalize the path to use forward slashes
  path = path.replace(/\\/g, "/");

  // Split the path into parts using forward slash as the separator
  const parts = path.split("/");

  // Remove the last part (file or directory name)
  parts.pop();

  // Join the remaining parts to get the dirname
  const dir = parts.join("/");

  // Handle the case where the path was empty or only contained a root slash
  if (dir === "" || dir === "/" || dir === ".") {
    return "/";
  }

  return dir;
};

/**
 * Util func for mkdir -p based on the "path" of original file or folder
 * "a/b/c/" => ["a", "a/b", "a/b/c"]
 * "a/b/c/d/e.txt" => ["a", "a/b", "a/b/c", "a/b/c/d"]
 */
export const getFolderLevels = (x: string, addEndingSlash: boolean = false) => {
  const res: string[] = [];

  if (x === "" || x === "/") {
    return res;
  }

  const y1 = x.split("/");
  for (let index = 0; index + 1 < y1.length; index++) {
    let k = y1.slice(0, index + 1).join("/");
    if (k === "" || k === "/") {
      continue;
    }
    if (addEndingSlash) {
      k = `${k}/`;
    }
    res.push(k);
  }
  return res;
};

export const mkdirpInVault = async (thePath: string, vault: Vault) => {
  const foldersToBuild = getFolderLevels(thePath);
  for (const folder of foldersToBuild) {
    const r = await vault.adapter.exists(folder);
    if (!r) {
      await vault.adapter.mkdir(folder);
    }
  }
};

/**
 * https://stackoverflow.com/questions/8609289
 */
export const bufferToArrayBuffer = (
  b: Uint8Array | ArrayBufferView
): ArrayBuffer => {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/* Fix TS2349 + noUncheckedIndexedAccess: string indexing yields
 * string | undefined, so use charAt (always a string) and a local callable
 * moment type (obsidian re-exports moment as a namespace type which is not
 * directly callable under strict TS, though it is the real moment function
 * at runtime). */
type MomentFn = (x?: number) => { format: (fmt?: string) => string };
const momentFn = moment as unknown as MomentFn;

/**
 * Encode a binary string to base64 without using the deprecated btoa().
 */
export const encodeBase64 = (str: string): string => {
  let result = "";
  for (let i = 0; i < str.length; i += 3) {
    const a = str.charCodeAt(i);
    const b = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
    const c = i + 2 < str.length ? str.charCodeAt(i + 2) : 0;
    result += BASE64_CHARS[a >> 2];
    result += BASE64_CHARS[((a & 3) << 4) | (b >> 4)];
    result += i + 1 < str.length ? BASE64_CHARS[((b & 15) << 2) | (c >> 6)] : "=";
    result += i + 2 < str.length ? BASE64_CHARS[c & 63] : "=";
  }
  return result;
};

/**
 * Decode a base64 string to a binary string without using the deprecated atob().
 */
export const decodeBase64 = (str: string): string => {
  let result = "";
  for (let i = 0; i < str.length; i += 4) {
    const a = BASE64_CHARS.indexOf(str.charAt(i));
    const b = BASE64_CHARS.indexOf(str.charAt(i + 1));
    const c = BASE64_CHARS.indexOf(str.charAt(i + 2));
    const d = BASE64_CHARS.indexOf(str.charAt(i + 3));
    result += String.fromCharCode((a << 2) | (b >> 4));
    if (str.charAt(i + 2) !== "=")
      result += String.fromCharCode(((b & 15) << 4) | (c >> 2));
    if (str.charAt(i + 3) !== "=")
      result += String.fromCharCode(((c & 3) << 6) | d);
  }
  return result;
};

/**
 * Replaces rfc4648's `base64url` codec (no new npm dependency).
 */
export const bytesToBase64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return encodeBase64(binary)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
};

export const base64urlToBytes = (text: string): Uint8Array => {
  let b = text.replace(/-/g, "+").replace(/_/g, "/");
  while (b.length % 4 !== 0) {
    b += "=";
  }
  const binary = decodeBase64(b);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

/**
 * https://stackoverflow.com/questions/18230217
 */
export const getRandomIntInclusive = (min: number, max: number) => {
  const randomBuffer = new Uint32Array(1);
  getCrypto().getRandomValues(randomBuffer);
  const randomNumber = (randomBuffer[0] ?? 0) / (0xffffffff + 1);
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(randomNumber * (max - min + 1)) + min;
};

/**
 * Random buffer
 */
export const getRandomArrayBuffer = (byteLength: number) => {
  const k = getCrypto().getRandomValues(new Uint8Array(byteLength));
  return bufferToArrayBuffer(k);
};

/**
 * https://stackoverflow.com/questions/958908
 */
export const reverseString = (x: string) => {
  return [...x].reverse().join("");
};

/**
 * Starting from 1
 */
export const atWhichLevel = (x: string) => {
  if (
    x === undefined ||
    x === "" ||
    x === "." ||
    x === ".." ||
    x.startsWith("/")
  ) {
    syncLog.debug(`do not know which level for ${x}`);
  }
  let y = x;
  if (x.endsWith("/")) {
    y = x.slice(0, -1);
  }
  return y.split("/").length;
};

export const unixTimeToStr = (x: number | undefined | null, fmt?: string) => {
  if (x === undefined || x === null || Number.isNaN(x)) {
    return undefined;
  }
  return fmt ? momentFn(x).format(fmt) : momentFn(x).format();
};

/**
 * If input is already a folder, returns its folder;
 * And if input is a file, returns its direname.
 */
export const getParentFolder = (a: string) => {
  const b = dirname(a);
  if (b === "." || b === "/") {
    // the root
    return "/";
  }
  if (b.endsWith("/")) {
    return b;
  }
  return `${b}/`;
};

/**
 * Local mirror of obsidian's `Stat` interface.
 * Keeps `ctime`/`mtime` as `number | undefined` in every environment,
 * so downstream code never has to depend on obsidian stubs being installed.
 */
export interface FileStat {
  type: "file" | "folder";
  ctime?: number;
  mtime?: number;
  size?: number;
}

/**
 * On Android the stat has bugs for folders. So we need a fixed version.
 */
export const statFix = async (
  vault: Vault,
  path: string
): Promise<FileStat | undefined> => {
  const s = await vault.adapter.stat(path);
  if (s == undefined) {
    return;
  }
  const ctime =
    s.ctime === null || Number.isNaN(s.ctime) ? undefined : s.ctime;
  const mtime =
    s.mtime === null || Number.isNaN(s.mtime) ? undefined : s.mtime;
  const size =
    s.type === "folder" &&
    (s.size === undefined || s.size === null || Number.isNaN(s.size))
      ? 0
      : s.size;
  return {
    type: s.type,
    ctime: ctime,
    mtime: mtime,
    size: size,
  };
};
