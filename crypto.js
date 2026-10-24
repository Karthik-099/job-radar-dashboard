// Job Radar crypto: PBKDF2-SHA256 (600k) -> AES-256-GCM via WebCrypto. Keys are non-extractable and
// live in memory only. Shared by the dashboard and the Node test (tests/js/crypto.test.mjs).
"use strict";
(function (root) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const b64e = (u8) => {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };

  async function deriveKey(passphrase, salt, iterations) {
    const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  // v1: plain JSON. v2: gzipped JSON (much smaller download), inflated with the browser's DecompressionStream.
  async function decryptBlob(blob, passphrase) {
    if (!blob || (blob.v !== 1 && blob.v !== 2)) throw new Error("Unsupported data format");
    const key = await deriveKey(passphrase, b64d(blob.salt), blob.iters);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(blob.iv) }, key, b64d(blob.ct));
    if (blob.v === 1) return JSON.parse(dec.decode(pt));
    const stream = new Blob([pt]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  }

  async function encryptWithKey(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj))));
    return { iv: b64e(iv), ct: b64e(ct) };
  }

  async function decryptWithKey(key, box) {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(box.iv) }, key, b64d(box.ct));
    return JSON.parse(dec.decode(pt));
  }

  root.JRCrypto = { deriveKey, decryptBlob, encryptWithKey, decryptWithKey, b64d, b64e };
})(typeof window !== "undefined" ? window : globalThis);
