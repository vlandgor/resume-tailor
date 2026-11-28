// Data lives in your Supabase account (see supabase/schema.sql), one set per user.
//
// On sign-in everything is loaded into memory once (it's small), so reads stay synchronous.
// Writes update memory immediately and are sent to the database in the background (debounced,
// in order, retried on failure). Use store.onSync() to show the save state.
//
// Base resume has two modes:
//   mode 'docx' – uploaded DOCX used as a style template (templateId + numbered `lines`)
//   mode 'text' – plain text / Markdown (PDF, TXT, pasted), output uses the built-in layout
// DOCX templates are stored once per content hash; each application remembers which one it used,
// so old applications still render correctly after you replace the base resume.
//
// API keys are never stored in plain text: they're encrypted in the browser (vault.js) and only
// the ciphertext is saved. Until you unlock with your passphrase, settings.keys is empty.
import { sb } from './supabase.js';
import { createVaultKey, unlockVault, openWithKey, seal, rememberKey, recallKey, forgetKey } from './vault.js';

const mem = {
  uid: null, settings: {}, resume: {}, apps: {}, templates: new Map(),
  vault: null,      // encrypted blob as stored in the database (or null = no vault yet)
  vaultKey: null,   // AES key while unlocked
  keys: {},         // decrypted API keys while unlocked
};

// ---------- background write queue ----------
const queue = new Map(); // key -> async fn; a newer write for the same key replaces the older one
let timer = null, flushing = false, pendingState = {};
let syncCb = () => {};

function enqueue(key, fn, delay = 600) {
  queue.delete(key); // re-insert at the end so ordering follows the latest change
  queue.set(key, fn);
  syncCb('saving');
  clearTimeout(timer);
  timer = setTimeout(flush, delay);
}

async function flush() {
  if (flushing) return;
  flushing = true;
  while (queue.size) {
    const [key, fn] = queue.entries().next().value;
    queue.delete(key);
    try {
      await fn();
    } catch (e) {
      if (!queue.has(key)) queue.set(key, fn); // retry unless a newer write replaced it
      flushing = false;
      syncCb('error', e);
      clearTimeout(timer);
      timer = setTimeout(flush, 5000);
      return;
    }
  }
  flushing = false;
  syncCb('saved');
}

const must = ({ error }) => { if (error) throw new Error(error.message); };

// user_state is one row; patches are merged so settings/resume/vault changes go out together.
function saveState(patch) {
  Object.assign(pendingState, patch);
  enqueue('state', async () => {
    const p = pendingState;
    pendingState = {};
    try {
      must(await sb.from('user_state').upsert({ user_id: mem.uid, ...p, updated_at: new Date().toISOString() }));
    } catch (e) {
      pendingState = { ...p, ...pendingState };
      throw e;
    }
  });
}

const saveAppRemote = app => enqueue(`app:${app.id}`, async () => must(await sb.from('applications').upsert({
  id: app.id, user_id: mem.uid, data: app, created_at: app.createdAt, updated_at: app.updatedAt,
})));

async function hashId(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf).slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- data from before accounts (this browser's localStorage) ----------
const LEGACY = { settings: 'rt.settings', resume: 'rt.resume', apps: 'rt.apps', tpl: 'rt.tpl.' };
const readLocal = (k, fallback) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
};

export const store = {
  // ---------- session ----------
  async init(uid) {
    mem.uid = uid;
    const [st, apps, tpls] = await Promise.all([
      sb.from('user_state').select('settings, resume, key_vault').maybeSingle(),
      sb.from('applications').select('data'),
      sb.from('templates').select('id, b64'),
    ]);
    for (const r of [st, apps, tpls]) must(r);
    mem.settings = st.data?.settings || {};
    mem.resume = st.data?.resume || {};
    mem.vault = st.data?.key_vault || null;
    mem.apps = Object.fromEntries(apps.data.map(r => [r.data.id, r.data]));
    mem.templates = new Map(tpls.data.map(t => [t.id, t.b64]));
    // Auto-unlock if this device remembers the key
    if (mem.vault) {
      const key = await recallKey(uid);
      const keys = key && await openWithKey(key, mem.vault);
      if (keys) { mem.vaultKey = key; mem.keys = keys; }
    }
  },
  onSync(cb) { syncCb = cb; },
  hasPendingWrites() { return queue.size > 0 || flushing; },
  // Push everything now; throws if something couldn't be saved.
  async syncNow() {
    clearTimeout(timer);
    while (flushing) await new Promise(r => setTimeout(r, 100));
    await flush();
    if (queue.size) throw new Error('Could not save to your account. Check your connection and try again.');
  },
  async signOut() {
    await flush();
    await forgetKey(mem.uid);
    await sb.auth.signOut();
  },

  // ---------- settings ----------
  getSettings() {
    return { defaultProvider: 'anthropic', defaultModel: '', ollamaUrl: 'http://localhost:11434', ...mem.settings, keys: { ...mem.keys }, keysLocked: this.vaultStatus() === 'locked' };
  },
  // Saves settings; if keys changed, re-encrypts the vault (must be unlocked or set up first).
  saveSettings(s) {
    const { keys = {}, keysLocked, ...rest } = s;
    mem.settings = rest;
    saveState({ settings: rest });
    if (JSON.stringify(keys) !== JSON.stringify(mem.keys)) {
      if (!mem.vaultKey) throw new Error('Set up or unlock your key vault before saving API keys.');
      mem.keys = { ...keys };
      this._sealKeys();
    }
  },

  // ---------- key vault ----------
  vaultStatus() { return mem.vaultKey ? 'unlocked' : mem.vault ? 'locked' : 'none'; },
  async setupVault(passphrase, remember) {
    if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
    const { key, salt, iterations } = await createVaultKey(passphrase);
    mem.vaultKey = key;
    mem.vaultMeta = { salt, iterations };
    if (remember) await rememberKey(mem.uid, key); else await forgetKey(mem.uid);
    this._sealKeys();
  },
  async unlock(passphrase, remember) {
    const { key, keys } = await unlockVault(passphrase, mem.vault);
    mem.vaultKey = key;
    mem.vaultMeta = { salt: mem.vault.salt, iterations: mem.vault.iter };
    mem.keys = keys;
    if (remember) await rememberKey(mem.uid, key); else await forgetKey(mem.uid);
  },
  async lock() {
    mem.vaultKey = null;
    mem.keys = {};
    await forgetKey(mem.uid);
  },
  // Forgot the passphrase: drop the vault (keys are gone; paste them again).
  async resetVault() {
    queue.delete('vault');
    mem.vault = null; mem.vaultKey = null; mem.vaultMeta = null; mem.keys = {};
    await forgetKey(mem.uid);
    saveState({ key_vault: null });
  },
  _sealKeys() {
    const { vaultKey, keys } = mem;
    const meta = mem.vaultMeta || { salt: mem.vault.salt, iterations: mem.vault.iter };
    enqueue('vault', async () => {
      mem.vault = await seal(vaultKey, meta.salt, meta.iterations, keys);
      must(await sb.from('user_state').upsert({ user_id: mem.uid, key_vault: mem.vault, updated_at: new Date().toISOString() }));
    }, 0);
  },

  // ---------- base resume & templates ----------
  getBaseResume() {
    return { mode: 'text', text: '', lines: '', templateId: '', fileName: '', page: null, fonts: [], pages: null, updatedAt: null, ...mem.resume };
  },
  saveBaseResume(r) {
    const out = { ...r, updatedAt: new Date().toISOString() };
    mem.resume = out;
    saveState({ resume: out });
    return out;
  },

  async saveTemplate(b64) {
    const id = await hashId(b64);
    if (!mem.templates.has(id)) {
      mem.templates.set(id, b64);
      enqueue(`tpl:${id}`, async () => must(await sb.from('templates').upsert({ user_id: mem.uid, id, b64 }, { ignoreDuplicates: true })), 0);
    }
    return id;
  },
  getTemplate(id) { return (id && mem.templates.get(id)) || null; },

  // ---------- applications ----------
  listApps() {
    return Object.values(mem.apps).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  getApp(id) { return mem.apps[id] || null; },
  createApp(fields) {
    const now = new Date().toISOString();
    const app = {
      id: crypto.randomUUID(),
      company: '', title: '', status: 'draft',
      jobUrl: '', jobText: '', notes: '',
      mode: 'text', resumeMd: '', lines: '', templateId: '', page: null, fonts: [], pages: null,
      changes: '', resumeModel: '',
      coverMd: '', coverModel: '',
      messages: [], replyDraft: '', replyNotes: '', replyModel: '',
      createdAt: now, updatedAt: now,
      ...fields,
    };
    mem.apps[app.id] = app;
    saveAppRemote(app);
    return app;
  },
  saveApp(app) {
    app.updatedAt = new Date().toISOString();
    mem.apps[app.id] = app;
    saveAppRemote(app);
    return app;
  },
  patchApp(id, fields) {
    const a = this.getApp(id);
    if (!a) throw new Error('Application not found');
    return this.saveApp({ ...a, ...fields });
  },
  deleteApp(id) {
    delete mem.apps[id];
    enqueue(`app:${id}`, async () => must(await sb.from('applications').delete().eq('id', id)), 0);
  },

  // ---------- backup (file) ----------
  // Backup excludes API keys on purpose.
  exportAll() {
    return {
      app: 'resume-tailor', version: 2, exportedAt: new Date().toISOString(),
      resume: this.getBaseResume(), apps: mem.apps, templates: Object.fromEntries(mem.templates),
    };
  },
  async importAll(data) {
    if (data?.app !== 'resume-tailor') throw new Error('Not a Resume Tailor backup file');
    for (const b64 of Object.values(data.templates || {})) await this.saveTemplate(b64); // ids are content hashes
    if (data.resume?.text) this.saveBaseResume(data.resume);
    if (data.settings) {
      const { keys, ...rest } = data.settings; // never import keys in plain text
      mem.settings = { ...rest, ...mem.settings };
      saveState({ settings: mem.settings });
    }
    const apps = Object.values(data.apps || {});
    for (const a of apps) mem.apps[a.id] = a;
    if (apps.length) {
      enqueue('import', async () => must(await sb.from('applications').upsert(apps.map(a => ({
        id: a.id, user_id: mem.uid, data: a, created_at: a.createdAt, updated_at: a.updatedAt,
      })))), 0);
    }
    return apps.length;
  },

  // ---------- data saved in this browser before accounts existed ----------
  legacyLocal() {
    const resume = readLocal(LEGACY.resume, null);
    const apps = readLocal(LEGACY.apps, {});
    const settings = readLocal(LEGACY.settings, null);
    const templates = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith(LEGACY.tpl)) templates[k.slice(LEGACY.tpl.length)] = localStorage.getItem(k);
    }
    const nApps = Object.keys(apps).length;
    const hasData = !!resume?.text || nApps > 0;
    const keys = Object.fromEntries(Object.entries(settings?.keys || {}).filter(([, v]) => v));
    return { hasData, nApps, keys, backup: { app: 'resume-tailor', resume, apps, templates, settings } };
  },
  isAccountEmpty() { return !mem.resume?.text && !Object.keys(mem.apps).length; },
  clearLegacyData() {
    // Keep rt.settings until its plain-text keys have been moved into the vault (see clearLegacyKeys).
    const drop = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k === LEGACY.resume || k === LEGACY.apps || k.startsWith(LEGACY.tpl)) drop.push(k);
    }
    drop.forEach(k => localStorage.removeItem(k));
  },
  clearLegacyKeys() { localStorage.removeItem(LEGACY.settings); },
};
