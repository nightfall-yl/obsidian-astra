/**
 * The rfc4648 dependency is replaced by local base64url helpers.
 */

import { base64urlToBytes, bufferToArrayBuffer, bytesToBase64url } from "./misc";

const DEFAULT_ITER = 20000;

const getCrypto = (): Crypto => {
  // Bare global WebCrypto: available in the Obsidian renderer (Chromium) and
  // in Node 18+ (tests); no window/globalThis reference so popout-safe.
  return crypto;
};

const getKeyFromPassword = async (
  salt: Uint8Array,
  password: string,
  rounds: number = DEFAULT_ITER
) => {
  const crypto = getCrypto();
  if (
    !crypto.subtle ||
    !crypto.subtle.importKey ||
    !crypto.subtle.deriveBits
  ) {
    throw new Error("Crypto subtle API not available");
  }

  const k1 = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey", "deriveBits"]
  );

  const k2 = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: bufferToArrayBuffer(salt),
      iterations: rounds,
      hash: "SHA-256",
    },
    k1,
    256
  );

  return k2;
};

export const encryptArrayBuffer = async (
  arrBuf: ArrayBuffer,
  password: string,
  rounds: number = DEFAULT_ITER
) => {
  const crypto = getCrypto();
  if (!crypto.getRandomValues || !crypto.subtle || !crypto.subtle.encrypt) {
    throw new Error("Crypto API not available");
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));

  const derivedKey = await getKeyFromPassword(salt, password, rounds);
  // 12 bytes or 96 bits per GCM spec https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const keyCrypt = await crypto.subtle.importKey(
    "raw",
    derivedKey,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );

  const enc = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keyCrypt, arrBuf);

  const res = new Uint8Array([...salt, ...iv, ...new Uint8Array(enc)]);

  return bufferToArrayBuffer(res);
};

export const decryptArrayBuffer = async (
  arrBuf: ArrayBuffer,
  password: string,
  rounds: number = DEFAULT_ITER
) => {
  const salt = arrBuf.slice(0, 16); // first 16 bytes are salt
  const iv = arrBuf.slice(16, 28); // next 12 bytes are IV
  const cipherText = arrBuf.slice(28); // final bytes are ciphertext
  const key = await getKeyFromPassword(new Uint8Array(salt), password, rounds);

  const crypto = getCrypto();
  if (!crypto.subtle || !crypto.subtle.importKey || !crypto.subtle.decrypt) {
    throw new Error("Crypto API not available");
  }

  const keyCrypt = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );

  const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, keyCrypt, cipherText);

  return dec;
};

export const encryptStringToBase64url = async (
  text: string,
  password: string,
  rounds: number = DEFAULT_ITER
) => {
  const enc = await encryptArrayBuffer(
    bufferToArrayBuffer(new TextEncoder().encode(text)),
    password,
    rounds
  );
  return bytesToBase64url(new Uint8Array(enc));
};

export const decryptBase64urlToString = async (
  text: string,
  password: string,
  rounds: number = DEFAULT_ITER
) => {
  return new TextDecoder().decode(
    await decryptArrayBuffer(
      bufferToArrayBuffer(base64urlToBytes(text)),
      password,
      rounds
    )
  );
};

export const getSizeFromOrigToEnc = (x: number) => {
  if (x < 0 || Number.isNaN(x) || !Number.isInteger(x)) {
    throw Error(`getSizeFromOrigToEnc: x=${x} is not a valid size`);
  }
  // plaintext size + salt + GCM authN tag + IV
  return x + 16 + 16 + 12;
};
