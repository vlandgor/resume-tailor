// Everything lives in this browser's localStorage. Use Settings → Backup to export/import.
//
// Base resume has two modes:
//   mode 'docx' – uploaded DOCX used as a style template (templateId + numbered `lines`)
//   mode 'text' – plain text / Markdown (PDF, TXT, pasted), output uses the built-in layout
// DOCX templates are stored once under rt.tpl.<id>; each application remembers which one it used,
// so old applications still render correctly after you replace the base resume.
const K = { settings: 'rt.settings', resume: 'rt.resume', apps: 'rt.apps', tpl: 'rt.tpl.' };

const read = (k, fallback) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
};
const write = (k, v) => {
  try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); }
  catch (e) { throw new Error(`Could not save (browser storage full?): ${e.message}`); }
};

const allApps = () => read(K.apps, {});

async function hashId(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf).slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export const store = {
  getSettings() {
    return { keys: {}, defaultProvider: 'anthropic', defaultModel: '', ollamaUrl: 'http://localhost:11434', ...read(K.settings, {}) };
  },
  saveSettings(s) { write(K.settings, s); },

  getBaseResume() {
    return { mode: 'text', text: '', lines: '', templateId: '', fileName: '', page: null, fonts: [], pages: null, updatedAt: null, ...read(K.resume, {}) };
  },
  saveBaseResume(r) {
    const out = { ...r, updatedAt: new Date().toISOString() };
    write(K.resume, out);
    return out;
  },

  async saveTemplate(b64) {
    const id = await hashId(b64);
    if (!localStorage.getItem(K.tpl + id)) write(K.tpl + id, b64);
    return id;
  },
  getTemplate(id) { return id ? localStorage.getItem(K.tpl + id) : null; },

  listApps() {
    return Object.values(allApps()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  getApp(id) { return allApps()[id] || null; },
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
    const apps = allApps();
    apps[app.id] = app;
    write(K.apps, apps);
    return app;
  },
  saveApp(app) {
    app.updatedAt = new Date().toISOString();
    const apps = allApps();
    apps[app.id] = app;
    write(K.apps, apps);
    return app;
  },
  patchApp(id, fields) {
    const a = this.getApp(id);
    if (!a) throw new Error('Application not found');
    return this.saveApp({ ...a, ...fields });
  },
  deleteApp(id) {
    const apps = allApps();
    delete apps[id];
    write(K.apps, apps);
  },

  // Backup excludes API keys on purpose.
  exportAll() {
    const templates = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith(K.tpl)) templates[k.slice(K.tpl.length)] = localStorage.getItem(k);
    }
    return { app: 'resume-tailor', version: 2, exportedAt: new Date().toISOString(), resume: this.getBaseResume(), apps: allApps(), templates };
  },
  importAll(data) {
    if (data?.app !== 'resume-tailor') throw new Error('Not a Resume Tailor backup file');
    for (const [id, b64] of Object.entries(data.templates || {})) write(K.tpl + id, b64);
    if (data.resume?.text) write(K.resume, data.resume);
    write(K.apps, { ...allApps(), ...(data.apps || {}) });
    return Object.keys(data.apps || {}).length;
  },
};
