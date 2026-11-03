/**
 * (src/metadataOnRemote.ts). The fast-equals and rfc4648 dependencies are
 * replaced by a local deepEqual and local base64url helpers.
 */

import { base64urlToBytes, bytesToBase64url, reverseString } from "./misc";

const DEFAULT_README_FOR_METADATAONREMOTE =
  "Do NOT edit or delete the file manually. This file is for the plugin third-party-sync to store some necessary meta data on the remote services. Its content is slightly obfuscated.";

const DEFAULT_VERSION_FOR_METADATAONREMOTE = "20220220";

export const DEFAULT_FILE_NAME_FOR_METADATAONREMOTE =
  ".third-party-sync-metadata-on-remote.json";

export const DEFAULT_FILE_NAME_FOR_METADATAONREMOTE2 =
  ".third-party-sync-metadata-on-remote.bin";

// Backward compatibility with remotely-save metadata names.
export const LEGACY_FILE_NAME_FOR_METADATAONREMOTE =
  "_remotely-save-metadata-on-remote.json";

export const LEGACY_FILE_NAME_FOR_METADATAONREMOTE2 =
  "_remotely-save-metadata-on-remote.bin";

export const FILE_NAME_FOR_DATA_JSON = "data.json";

export const FILE_NAME_FOR_BOOKMARK_FILE = "/bookmarks.json";

export interface DeletionOnRemote {
  key: string;
  actionWhen: number;
}

export interface MetadataOnRemote {
  version?: string;
  generatedWhen?: number;
  deletions?: DeletionOnRemote[];
}

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) {
    return true;
  }
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) {
    return false;
  }
  if (aArr && bArr) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  for (const k of aKeys) {
    if (!deepEqual(aObj[k], bObj[k])) {
      return false;
    }
  }
  return true;
};

export const isEqualMetadataOnRemote = (
  a: MetadataOnRemote,
  b: MetadataOnRemote
) => {
  const m1 = a === undefined ? { deletions: [] } : a;
  const m2 = b === undefined ? { deletions: [] } : b;

  // we only need to compare deletions
  const d1 = m1.deletions === undefined ? [] : m1.deletions;
  const d2 = m2.deletions === undefined ? [] : m2.deletions;
  return deepEqual(d1, d2);
};

export const serializeMetadataOnRemote = (x: MetadataOnRemote) => {
  const y = x;

  if (y["version"] === undefined) {
    y["version"] = DEFAULT_VERSION_FOR_METADATAONREMOTE;
  }
  if (y["generatedWhen"] === undefined) {
    y["generatedWhen"] = Date.now();
  }
  if (y["deletions"] === undefined) {
    y["deletions"] = [];
  }

  const z = {
    readme: DEFAULT_README_FOR_METADATAONREMOTE,
    d: reverseString(
      bytesToBase64url(new TextEncoder().encode(JSON.stringify(x)))
    ),
  };

  return JSON.stringify(z, null, 2);
};

export const deserializeMetadataOnRemote = (x: string | ArrayBuffer) => {
  let y1 = "";
  if (typeof x === "string") {
    y1 = x;
  } else {
    y1 = new TextDecoder().decode(x);
  }

  let y2: Record<string, unknown>;
  try {
    y2 = JSON.parse(y1) as Record<string, unknown>;
  } catch {
    throw new Error(
      `invalid remote meta data file with first few chars: ${y1.slice(0, 5)}`
    );
  }

  if (!("readme" in y2 && "d" in y2)) {
    throw new Error(
      'invalid remote meta data file (no "readme" or "d" fields)!'
    );
  }

  let y3: string;
  try {
    y3 = new TextDecoder().decode(base64urlToBytes(reverseString(y2["d"] as string)));
  } catch {
    throw new Error('invalid remote meta data file (invalid "d" field)!');
  }

  let y4: MetadataOnRemote;
  try {
    y4 = JSON.parse(y3) as MetadataOnRemote;
  } catch {
    throw new Error(
      `invalid remote meta data file with "d" field with first few chars: ${y3.slice(
        0,
        5
      )}`
    );
  }
  return y4;
};
