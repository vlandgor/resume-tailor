// API-key vault: keys are encrypted in the browser before they're saved to your account.
// The database only ever sees { salt, iv, ct }; without your passphrase nobody (including Supabase) can read them.
//
// Passphrase -> PBKDF2-SHA256 (600k rounds, random salt) -> AES-256-GCM key.
// "Remember on this device" stores that AES key in IndexedDB as a non-extractable CryptoKey:
// the page can use it to decrypt, but it can't be read out or copied as bytes. Signing out forgets it.

const ITERATIONS = 600_000;
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function deriveKey(passphrase, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

export async function seal(key, salt, iterations, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { v: 1, iter: iterations, salt, iv: b64(iv), ct: b64(ct) };
}

async function open(key, vault) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, key, unb64(vault.ct));
  return JSON.parse(dec.decode(pt));
}

// New vault with a fresh salt. Returns { key, salt, iterations } for sealing.
export async function createVaultKey(passphrase) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  return { key: await deriveKey(passphrase, unb64(salt)), salt, iterations: ITERATIONS };
}

// Unlock an existing vault. Throws 'Wrong passphrase' if it doesn't decrypt.
export async function unlockVault(passphrase, vault) {
  const key = await deriveKey(passphrase, unb64(vault.salt), vault.iter || ITERATIONS);
  try { return { key, keys: await open(key, vault) }; }
  catch { throw new Error('Wrong passphrase'); }
}

export async function openWithKey(key, vault) {
  try { return await open(key, vault); } catch { return null; }
}

// ---------- remember on this device (IndexedDB) ----------
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('rt-vault', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function tx(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('keys', mode);
    const req = fn(t.objectStore('keys'));
    t.oncomplete = () => { db.close(); resolve(req?.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}
export const rememberKey = (userId, key) => tx('readwrite', s => s.put(key, userId)).catch(() => {});
export const recallKey = userId => tx('readonly', s => s.get(userId)).catch(() => null);
export const forgetKey = userId => tx('readwrite', s => s.delete(userId)).catch(() => {});
