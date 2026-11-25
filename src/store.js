// Everything lives in this browser's localStorage. Use Settings → Backup to export/import.
const K = { settings: 'rt.settings', resume: 'rt.resume', apps: 'rt.apps' };

const read = (k, fallback) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
};
const write = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); }
  catch (e) { throw new Error(`Could not save (browser storage full?): ${e.message}`); }
};

const allApps = () => read(K.apps, {});

export const store = {
  getSettings() {
    return { keys: {}, defaultProvider: 'anthropic', defaultModel: '', ollamaUrl: 'http://localhost:11434', ...read(K.settings, {}) };
  },
  saveSettings(s) { write(K.settings, s); },

  getBaseResume() { return read(K.resume, { text: '', fileName: '', updatedAt: null }); },
  saveBaseResume(r) {
    const out = { ...r, updatedAt: new Date().toISOString() };
    write(K.resume, out);
    return out;
  },

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
      resumeMd: '', changes: '', resumeModel: '',
      coverMd: '', coverModel: '',
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
    return { app: 'resume-tailor', version: 1, exportedAt: new Date().toISOString(), resume: this.getBaseResume(), apps: allApps() };
  },
  importAll(data) {
    if (data?.app !== 'resume-tailor') throw new Error('Not a Resume Tailor backup file');
    if (data.resume?.text) write(K.resume, data.resume);
    const apps = { ...allApps(), ...(data.apps || {}) };
    write(K.apps, apps);
    return Object.keys(data.apps || {}).length;
  },
};
