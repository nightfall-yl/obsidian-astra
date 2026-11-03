/**
 * Unit tests for the vendored encrypt/metadataOnRemote modules
 * Exercises the dependency replacements: rfc4648 → base64url helpers,
 * fast-equals → local deepEqual.
 */

import { describe, expect, it } from "vitest";

import {
  decryptBase64urlToString,
  encryptStringToBase64url,
  getSizeFromOrigToEnc,
} from "./encrypt";
import { base64urlToBytes, bytesToBase64url } from "./misc";
import {
  deserializeMetadataOnRemote,
  isEqualMetadataOnRemote,
  serializeMetadataOnRemote,
} from "./metadataOnRemote";

describe("base64url helpers", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      bytes[i] = i;
    }
    const encoded = bytesToBase64url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    const decoded = base64urlToBytes(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it("round-trips empty input", () => {
    expect(bytesToBase64url(new Uint8Array(0))).toBe("");
    expect(Array.from(base64urlToBytes(""))).toEqual([]);
  });

  it("round-trips single bytes (padding stripping works)", () => {
    for (let b = 0; b < 256; b += 17) {
      const decoded = base64urlToBytes(bytesToBase64url(new Uint8Array([b])));
      expect(Array.from(decoded)).toEqual([b]);
    }
  });
});

describe("encryptStringToBase64url / decryptBase64urlToString", () => {
  it("round-trips a UTF-8 string", async () => {
    const text = "你好，astral-trek！emoji 🚀 ascii";
    const enc = await encryptStringToBase64url(text, "hunter2");
    expect(enc).not.toMatch(/[+/=]/);
    const dec = await decryptBase64urlToString(enc, "hunter2");
    expect(dec).toBe(text);
  });

  it("produces different ciphertexts per call (random salt/iv)", async () => {
    const a = await encryptStringToBase64url("same text", "pw");
    const b = await encryptStringToBase64url("same text", "pw");
    expect(a).not.toBe(b);
  });

  it("fails to decrypt with a wrong password", async () => {
    const enc = await encryptStringToBase64url("secret", "right-password");
    await expect(
      decryptBase64urlToString(enc, "wrong-password")
    ).rejects.toThrow();
  });
});

describe("getSizeFromOrigToEnc", () => {
  it("adds salt + GCM tag + IV overhead", () => {
    expect(getSizeFromOrigToEnc(0)).toBe(44);
    expect(getSizeFromOrigToEnc(100)).toBe(144);
  });

  it("rejects invalid sizes", () => {
    expect(() => getSizeFromOrigToEnc(-1)).toThrow();
    expect(() => getSizeFromOrigToEnc(1.5)).toThrow();
    expect(() => getSizeFromOrigToEnc(Number.NaN)).toThrow();
  });
});

describe("metadataOnRemote serialize / deserialize", () => {
  it("round-trips deletions", () => {
    const meta = {
      deletions: [
        { key: "note.md", actionWhen: 1700000000000 },
        { key: "folder/", actionWhen: 1700000001000 },
      ],
    };
    const serialized = serializeMetadataOnRemote(meta);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect(parsed.readme).toBeTruthy();
    expect(typeof parsed.d).toBe("string");
    const restored = deserializeMetadataOnRemote(serialized);
    expect(restored.deletions).toEqual(meta.deletions);
    expect(restored.version).toBeTruthy();
  });

  it("rejects corrupted payloads", () => {
    expect(() => deserializeMetadataOnRemote("not-json")).toThrow();
    expect(() =>
      deserializeMetadataOnRemote(JSON.stringify({ foo: 1 }))
    ).toThrow();
  });
});

describe("isEqualMetadataOnRemote", () => {
  it("compares only deletions, order-sensitively", () => {
    const a = { deletions: [{ key: "a.md", actionWhen: 1 }] };
    const b = { deletions: [{ key: "a.md", actionWhen: 1 }] };
    expect(isEqualMetadataOnRemote(a, b)).toBe(true);

    const c = { deletions: [{ key: "b.md", actionWhen: 1 }] };
    expect(isEqualMetadataOnRemote(a, c)).toBe(false);

    const emptyA = { deletions: [] };
    const undefinedB = { deletions: undefined };
    expect(isEqualMetadataOnRemote(emptyA, undefinedB)).toBe(true);
  });
});
