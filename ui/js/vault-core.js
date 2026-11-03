/* Student Vault - encrypted local storage core.
 * No secrets are stored in plaintext. The PIN-derived key wraps a random
 * AES-256-GCM master key; all vault data and files are encrypted with it.
 */
(function () {
  'use strict';

  const DB_NAME = 'studentvault';
  const DB_VERSION = 1;
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const PBKDF2_ITERATIONS = 210000;
  const AUTH_KEY = 'sv.auth.v2';
  const PUBLIC_KEY = 'sv.public.v2';
  const PASSKEY_KEY = 'sv.passkey.v2';
  const MAX_FILE_BYTES = 25 * 1024 * 1024;

  function b64encode(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let out = '';
    const chunk = 0x8000;
    for (let i = 0; i < view.length; i += chunk) {
      out += String.fromCharCode.apply(null, view.subarray(i, i + chunk));
    }
    return btoa(out);
  }

  function b64decode(value) {
    const raw = atob(String(value || ''));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function randomBytes(length) {
    return crypto.getRandomValues(new Uint8Array(length));
  }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }

  async function importAesKey(raw) {
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function deriveKek(pin, saltB64) {
    const base = await crypto.subtle.importKey('raw', textEncoder.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: b64decode(saltB64), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      base,
      256
    );
    return importAesKey(new Uint8Array(bits));
  }

  async function deriveRecoveryKey(code, saltB64) {
    const normalized = normalizeRecoveryCode(code);
    const base = await crypto.subtle.importKey('raw', textEncoder.encode(normalized), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: b64decode(saltB64), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      base,
      256
    );
    return importAesKey(new Uint8Array(bits));
  }

  function pack(iv, ciphertext) {
    const out = new Uint8Array(iv.length + ciphertext.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ciphertext), iv.length);
    return out;
  }

  function unpack(packed) {
    const bytes = packed instanceof Uint8Array ? packed : new Uint8Array(packed);
    if (bytes.length < 13) throw new Error('Invalid encrypted payload');
    return { iv: bytes.slice(0, 12), data: bytes.slice(12) };
  }

  async function encryptBytes(key, bytes) {
    const iv = randomBytes(12);
    const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, source);
    return pack(iv, ciphertext);
  }

  async function decryptBytes(key, packed) {
    const { iv, data } = unpack(packed);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new Uint8Array(plain);
  }

  async function encryptJSON(key, value) {
    return encryptBytes(key, textEncoder.encode(JSON.stringify(value)));
  }

  async function decryptJSON(key, packed) {
    const bytes = await decryptBytes(key, packed);
    return JSON.parse(textDecoder.decode(bytes));
  }

  function newMasterRaw() {
    return randomBytes(32);
  }

  async function wrapMasterRaw(masterRaw, kek) {
    return b64encode(await encryptBytes(kek, masterRaw));
  }

  async function unwrapMasterRaw(wrappedB64, kek) {
    return decryptBytes(kek, b64decode(wrappedB64));
  }

  /* ---------- IndexedDB ---------- */
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('This device does not support local encrypted storage.'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Storage could not be opened.'));
    });
    return dbPromise;
  }

  async function dbGet(store, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbPut(store, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbDelete(store, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbGetAll(store) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbClear(store) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function putFileRecord(id, packed) {
    // Keep only the opaque encrypted blob. Document metadata lives inside the
    // encrypted state record, so file names never appear in plaintext storage.
    return dbPut('files', { id: id, data: packed });
  }

  async function getFileRecord(id) {
    return dbGet('files', id);
  }

  async function deleteFileRecord(id) {
    return dbDelete('files', id);
  }

  async function getAllFileRecords() {
    return dbGetAll('files');
  }

  /* ---------- auth metadata ---------- */
  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  const getAuth = () => readJSON(AUTH_KEY, null);
  const setAuth = (value) => writeJSON(AUTH_KEY, value);
  const getPublic = () => readJSON(PUBLIC_KEY, null);
  const setPublic = (value) => writeJSON(PUBLIC_KEY, value);
  const getPasskey = () => readJSON(PASSKEY_KEY, null);
  const setPasskey = (value) => writeJSON(PASSKEY_KEY, value);
  const clearPasskey = () => localStorage.removeItem(PASSKEY_KEY);

  function clearAuth() {
    [AUTH_KEY, PUBLIC_KEY, PASSKEY_KEY, 'sv.fail.v2', 'sv-pin', 'sv-passkey', 'sv-token', 'sv-theme'].forEach((key) => {
      try { localStorage.removeItem(key); } catch (_) { /* ignore */ }
    });
  }

  /* ---------- recovery code ---------- */
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function randomRecoveryCode() {
    const bytes = randomBytes(20);
    let chars = '';
    for (let i = 0; i < 20; i++) chars += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return chars.match(/.{1,5}/g).join('-');
  }

  function normalizeRecoveryCode(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /* ---------- validation + formatting ---------- */
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function fmtBytes(n) {
    const num = Number(n) || 0;
    if (num < 1024) return num + ' B';
    if (num < 1024 * 1024) return (num / 1024).toFixed(num < 10 * 1024 ? 1 : 0) + ' KB';
    if (num < 1024 * 1024 * 1024) return (num / 1048576).toFixed(1) + ' MB';
    return (num / 1073741824).toFixed(2) + ' GB';
  }

  function todayISO() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function prettyDate(iso, options) {
    if (!iso) return 'No date';
    const d = new Date(iso + (String(iso).length === 10 ? 'T12:00:00' : ''));
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-IN', options || { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'SV';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  function isValidEmail(email) {
    return !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function safeHttpUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      return (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : '';
    } catch (_) {
      return '';
    }
  }

  const FILE_TYPES = {
    'application/pdf': { type: 'pdf', ext: ['pdf'] },
    'image/png': { type: 'img', ext: ['png'] },
    'image/jpeg': { type: 'img', ext: ['jpg', 'jpeg'] },
    'image/webp': { type: 'img', ext: ['webp'] },
    'image/gif': { type: 'img', ext: ['gif'] },
    'text/plain': { type: 'text', ext: ['txt'] }
  };

  function validateFile(file) {
    if (!file) return { ok: false, error: 'Choose a file first.' };
    if (!file.size) return { ok: false, error: 'This file is empty.' };
    if (file.size > MAX_FILE_BYTES) return { ok: false, error: 'Files must be 25 MB or smaller.' };
    const ext = (String(file.name).split('.').pop() || '').toLowerCase();
    let entry = FILE_TYPES[file.type];
    if (!entry) {
      entry = Object.values(FILE_TYPES).find((item) => item.ext.includes(ext));
    }
    if (!entry) return { ok: false, error: 'Use PDF, PNG, JPG, WEBP, GIF, or TXT files.' };
    return { ok: true, type: entry.type, ext };
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name || 'download';
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  window.VaultCore = {
    PBKDF2_ITERATIONS,
    MAX_FILE_BYTES,
    b64encode,
    b64decode,
    randomBytes,
    uid,
    importAesKey,
    deriveKek,
    deriveRecoveryKey,
    encryptBytes,
    decryptBytes,
    encryptJSON,
    decryptJSON,
    newMasterRaw,
    wrapMasterRaw,
    unwrapMasterRaw,
    openDB,
    dbGet,
    dbPut,
    dbDelete,
    dbGetAll,
    dbClear,
    putFileRecord,
    getFileRecord,
    deleteFileRecord,
    getAllFileRecords,
    getAuth,
    setAuth,
    getPublic,
    setPublic,
    getPasskey,
    setPasskey,
    clearPasskey,
    clearAuth,
    randomRecoveryCode,
    normalizeRecoveryCode,
    escapeHtml,
    fmtBytes,
    todayISO,
    prettyDate,
    initials,
    isValidEmail,
    safeHttpUrl,
    validateFile,
    downloadBlob
  };
})();
