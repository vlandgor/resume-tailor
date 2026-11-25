// Resume Tailor — browser-only app (hash routing, localStorage, direct AI calls)
import { marked } from 'marked';
import { store } from './store.js';
import { listModels, complete, providerList } from './providers.js';
import * as prompts from './prompts.js';
import { extractResumeText, downloadDocx, printPdf, downloadBlob } from './files.js';

const $ = s => document.querySelector(s);
const main = $('#main');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUSES = ['draft', 'applied', 'interview', 'offer', 'rejected'];
const state = { providers: [], settings: null, models: {} };

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), isErr ? 7000 : 2500);
}
const setSaveStatus = text => { const el = $('#saveStatus'); if (el) el.textContent = text; };

// ---------- AI actions ----------
async function tailor(id, { provider, model, instructions = '' }) {
  const a = store.getApp(id);
  const base = store.getBaseResume().text;
  if (!base.trim()) throw new Error('Add your base resume first (sidebar → Base resume).');
  if (!a.jobText.trim()) throw new Error('This application has no job description.');
  const raw = await complete({
    provider, model, settings: store.getSettings(),
    system: prompts.TAILOR_SYSTEM,
    user: prompts.tailorUser({ baseResume: base, jobText: a.jobText, instructions }),
  });
  const out = prompts.parseTailor(raw);
  if (!out.resumeMd) throw new Error('The model returned an empty response. Try again or pick another model.');
  const fresh = store.getApp(id); // re-read in case title/company were edited meanwhile
  return store.saveApp({
    ...fresh,
    resumeMd: out.resumeMd, changes: out.changes, resumeModel: `${provider}/${model}`,
    company: fresh.company || out.company, title: fresh.title || out.title,
  });
}

async function writeCover(id, { provider, model, instructions = '' }) {
  const a = store.getApp(id);
  const resume = a.resumeMd || store.getBaseResume().text;
  if (!resume.trim()) throw new Error('Add your base resume first.');
  const raw = await complete({
    provider, model, settings: store.getSettings(),
    system: prompts.COVER_SYSTEM,
    user: prompts.coverUser({ resume, jobText: a.jobText, company: a.company, title: a.title, instructions }),
  });
  return store.patchApp(id, { coverMd: prompts.parseCover(raw), coverModel: `${provider}/${model}` });
}

// ---------- sidebar ----------
function renderList() {
  const q = $('#search').value.toLowerCase();
  const cur = location.hash.split('/')[2];
  const items = store.listApps().filter(a => `${a.title} ${a.company}`.toLowerCase().includes(q));
  $('#appList').innerHTML = items.map(a => `
    <a href="#/app/${a.id}" class="item ${a.id === cur ? 'active' : ''}">
      <div class="t">${esc(a.title || 'Untitled position')}</div>
      <div class="s"><span class="co">${esc(a.company || '—')}</span>
        <span class="status st-${a.status}">${a.status}</span></div>
    </a>`).join('') || `<div class="empty">${q ? 'No matches' : 'No applications yet'}</div>`;
  document.querySelectorAll('[data-nav]').forEach(el =>
    el.classList.toggle('active', location.hash === `#/${el.dataset.nav}`));
}
$('#search').oninput = renderList;

// ---------- model picker ----------
function pickerHTML(p) {
  return `<div class="picker">
    <select id="${p}-prov" title="AI provider">${state.providers.map(x =>
      `<option value="${x.id}">${esc(x.label)}${x.hasKey ? '' : ' — no key'}</option>`).join('')}</select>
    <input id="${p}-model" list="${p}-models" placeholder="Model (pick or type)" title="Model ID">
    <datalist id="${p}-models"></datalist>
  </div>`;
}
function initPicker(p) {
  const prov = $(`#${p}-prov`), model = $(`#${p}-model`), dl = $(`#${p}-models`);
  let last = null;
  try { last = JSON.parse(localStorage.getItem('rt.lastModel')); } catch { /* ignore */ }
  prov.value = last?.provider || state.settings.defaultProvider || 'anthropic';
  model.value = last?.model || state.settings.defaultModel || '';
  const load = async () => {
    const id = prov.value;
    dl.innerHTML = '';
    try {
      if (!state.models[id]) state.models[id] = await listModels(id, state.settings);
      if (prov.value === id) dl.innerHTML = state.models[id].map(m => `<option value="${esc(m)}">`).join('');
      model.placeholder = 'Model (pick or type)';
    } catch (e) {
      model.placeholder = 'Type model ID (list unavailable)';
      console.warn(e.message);
    }
  };
  prov.onchange = () => { model.value = ''; load(); };
  // A datalist only shows matches for the current text, so clear on focus to show the full list
  model.onfocus = () => { model.dataset.prev = model.value; model.value = ''; };
  model.onblur = () => { if (!model.value) model.value = model.dataset.prev || ''; };
  load();
  return () => {
    const v = { provider: prov.value, model: model.value.trim() };
    if (!v.model) throw new Error('Choose a model first');
    localStorage.setItem('rt.lastModel', JSON.stringify(v));
    return v;
  };
}

function busy(btn, on, label) {
  if (on) {
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${label || 'Working…'}`;
  } else {
    btn.disabled = false;
    btn.innerHTML = btn.dataset.label;
  }
}

// ---------- views ----------
function viewNew() {
  const base = store.getBaseResume();
  main.innerHTML = `<div class="narrow">
    <h1>New application</h1>
    <p class="muted">Paste the job description, pick a model, and tailor.</p>
    ${base.text ? '' : '<div class="banner">You haven\'t added a base resume yet. <a href="#/resume">Add it first →</a></div>'}
    <label>Job description</label>
    <textarea id="n-text" rows="14" placeholder="Paste the full job description here."></textarea>
    <label>Job post link <span class="muted">(optional, for your reference)</span></label>
    <input id="n-url" type="url" placeholder="https://…">
    <div class="grid2">
      <div><label>Position <span class="muted">(optional — AI fills it in)</span></label><input id="n-title"></div>
      <div><label>Company <span class="muted">(optional)</span></label><input id="n-company"></div>
    </div>
    <label>Extra instructions <span class="muted">(optional)</span></label>
    <input id="n-instr" placeholder="e.g. emphasize multiplayer/networking work, keep it to one page">
    <label>Model</label>
    ${pickerHTML('n')}
    <div class="row" style="margin-top:20px; gap:16px">
      <button id="n-go" class="primary">Tailor resume</button>
      <label class="chk"><input type="checkbox" id="n-cover"> Also write a cover letter</label>
    </div>
  </div>`;
  const getModel = initPicker('n');

  $('#n-go').onclick = async e => {
    const btn = e.currentTarget;
    let m;
    try { m = getModel(); } catch (err) { return toast(err.message, true); }
    const jobText = $('#n-text').value.trim();
    if (!jobText) return toast('Add the job description first', true);

    busy(btn, true, 'Tailoring… (usually 20–90 s)');
    const a = store.createApp({
      jobUrl: $('#n-url').value.trim(), jobText,
      title: $('#n-title').value.trim(), company: $('#n-company').value.trim(),
    });
    try {
      await tailor(a.id, { ...m, instructions: $('#n-instr').value.trim() });
      if ($('#n-cover').checked) {
        btn.innerHTML = '<span class="spinner"></span>Writing cover letter…';
        await writeCover(a.id, m);
      }
    } catch (err) {
      toast(err.message, true); // the draft is kept so nothing pasted is lost
    }
    location.hash = `#/app/${a.id}`;
  };
}

function viewApp(id, tab = 'resume') {
  const a = store.getApp(id);
  if (!a) { location.hash = '#/new'; return; }
  const TABS = { resume: 'Resume', cover: 'Cover letter', job: 'Job posting' };
  main.innerHTML = `
    <header class="app-head">
      <div class="fields">
        <input id="f-title" class="h-title" value="${esc(a.title)}" placeholder="Position title">
        <input id="f-company" class="h-company" value="${esc(a.company)}" placeholder="Company">
      </div>
      <div class="head-actions">
        <select id="f-status">${STATUSES.map(s => `<option ${s === a.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <button id="delBtn" class="danger">Delete</button>
      </div>
    </header>
    <nav class="tabs">${Object.entries(TABS).map(([k, v]) =>
      `<a href="#/app/${id}/${k}" class="${k === tab ? 'active' : ''}">${v}</a>`).join('')}</nav>
    <section id="tabBody"></section>`;

  const patch = fields => store.patchApp(id, fields);
  const patchAndList = fields => { patch(fields); renderList(); };
  $('#f-title').onchange = e => patchAndList({ title: e.target.value });
  $('#f-company').onchange = e => patchAndList({ company: e.target.value });
  $('#f-status').onchange = e => patchAndList({ status: e.target.value });
  $('#delBtn').onclick = () => {
    if (!confirm(`Delete "${a.title || 'this application'}"? This can't be undone.`)) return;
    store.deleteApp(id);
    location.hash = '#/new';
  };

  if (tab === 'job') return renderJobTab(a, patch);
  renderDocTab(a, tab === 'cover' ? 'cover' : 'resume', patch);
}

function renderDocTab(a, kind, patch) {
  const isCover = kind === 'cover';
  const md = isCover ? a.coverMd : a.resumeMd;
  const usedModel = isCover ? a.coverModel : a.resumeModel;
  const run = isCover ? writeCover : tailor;
  const body = $('#tabBody');

  async function generate(btn, getModel, instructions) {
    let m;
    try { m = getModel(); } catch (err) { return toast(err.message, true); }
    busy(btn, true, isCover ? 'Writing…' : 'Tailoring…');
    try {
      await run(a.id, { ...m, instructions: instructions.trim() });
      route();
    } catch (err) { toast(err.message, true); busy(btn, false); }
  }

  if (!md) {
    body.innerHTML = `<div class="gen-panel">
      <h3 style="margin-top:0">${isCover ? 'Write a cover letter' : 'Tailor the resume'}</h3>
      <p class="muted">${isCover
        ? 'Uses the tailored resume (or your base resume) and this job posting.'
        : 'Uses your base resume and this job posting.'}</p>
      ${pickerHTML('g')}
      <label>Extra instructions <span class="muted">(optional)</span></label>
      <input id="g-instr" placeholder="${isCover ? 'e.g. mention I can relocate, mention a referral from …' : 'e.g. keep it to one page'}">
      <div style="margin-top:16px"><button id="g-go" class="primary">${isCover ? 'Write cover letter' : 'Tailor resume'}</button></div>
    </div>`;
    const getModel = initPicker('g');
    $('#g-go').onclick = e => generate(e.currentTarget, getModel, $('#g-instr').value);
    return;
  }

  body.innerHTML = `
    <div class="toolbar">
      ${pickerHTML('g')}
      <input id="g-instr" class="instr" placeholder="Instructions for regenerating (optional)">
      <button id="g-go">${isCover ? 'Rewrite' : 'Re-tailor'}</button>
      <span class="spacer"></span>
      <span id="saveStatus"></span>
      <button id="dl-docx">Download .docx</button>
      <button id="dl-pdf" class="primary">Save as PDF</button>
    </div>
    ${!isCover && a.changes ? `<details class="changes"><summary>What was changed</summary>${marked.parse(a.changes)}</details>` : ''}
    ${usedModel ? `<p class="muted" style="margin:0 0 10px;font-size:12px">Generated with ${esc(usedModel)} · edit on the left, preview on the right — edits save automatically.</p>` : ''}
    <div class="editor">
      <textarea id="d-md" spellcheck="true"></textarea>
      <div id="d-preview" class="paper"></div>
    </div>`;
  const getModel = initPicker('g');

  const ta = $('#d-md'), pv = $('#d-preview');
  ta.value = md;
  const render = () => (pv.innerHTML = marked.parse(ta.value));
  render();
  let t;
  ta.oninput = () => {
    render();
    setSaveStatus('Editing…');
    clearTimeout(t);
    t = setTimeout(() => {
      try { patch(isCover ? { coverMd: ta.value } : { resumeMd: ta.value }); setSaveStatus('Saved'); }
      catch (e) { setSaveStatus('Save failed'); toast(e.message, true); }
    }, 500);
  };

  $('#dl-docx').onclick = async () => {
    try { await downloadDocx(store.getApp(a.id), kind); } catch (e) { toast(e.message, true); }
  };
  $('#dl-pdf').onclick = () => {
    try { printPdf(store.getApp(a.id), kind); } catch (e) { toast(e.message, true); }
  };
  $('#g-go').onclick = e => {
    if (!confirm('This replaces the current version, including your manual edits. Continue?')) return;
    generate(e.currentTarget, getModel, $('#g-instr').value);
  };
}

function renderJobTab(a, patch) {
  $('#tabBody').innerHTML = `<div class="narrow">
    <label style="margin-top:0">Job post link</label>
    <div class="row"><input id="j-url" type="url" value="${esc(a.jobUrl)}" placeholder="https://…">
      ${a.jobUrl ? `<a class="btn" href="${esc(a.jobUrl)}" target="_blank" rel="noopener">Open ↗</a>` : ''}</div>
    <label>Job description <span class="muted">(used for re-tailoring)</span></label>
    <textarea id="j-text" rows="22">${esc(a.jobText)}</textarea>
    <label>Notes</label>
    <textarea id="j-notes" rows="5" placeholder="Recruiter name, salary range, interview dates…">${esc(a.notes)}</textarea>
    <p class="muted" id="saveStatus"></p>
  </div>`;
  for (const [key, sel] of [['jobUrl', '#j-url'], ['jobText', '#j-text'], ['notes', '#j-notes']]) {
    const el = $(sel);
    let t;
    el.oninput = () => {
      setSaveStatus('Editing…');
      clearTimeout(t);
      t = setTimeout(() => { patch({ [key]: el.value }); setSaveStatus('Saved'); }, 400);
    };
  }
}

function viewResume() {
  const r = store.getBaseResume();
  main.innerHTML = `<div class="narrow" style="max-width:980px">
    <h1>Base resume</h1>
    <p class="muted">Your original resume — every tailored version starts from this. Upload a PDF, DOCX, TXT or Markdown file, or paste and edit the text directly.
    Text pulled from a PDF can come out a bit jumbled; the AI cleans it up when tailoring, but a quick look helps.</p>
    <div class="row" style="margin:14px 0">
      <input type="file" id="b-file" accept=".pdf,.docx,.txt,.md" style="flex:0 1 auto">
      <span style="flex:1"></span>
      <span class="muted" style="font-size:12px">${r.updatedAt ? `${esc(r.fileName || 'Edited')} · updated ${new Date(r.updatedAt).toLocaleString()}` : 'Not set yet'}</span>
    </div>
    <textarea id="b-text" class="big" placeholder="Paste your resume here…">${esc(r.text)}</textarea>
    <div class="row" style="margin-top:12px"><button id="b-save" class="primary">Save</button><span id="saveStatus"></span></div>
  </div>`;
  $('#b-file').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const text = await extractResumeText(f);
      store.saveBaseResume({ text, fileName: f.name });
      $('#b-text').value = text;
      toast('Resume imported and saved');
    } catch (err) { toast(err.message, true); }
  };
  $('#b-save').onclick = () => {
    const cur = store.getBaseResume();
    store.saveBaseResume({ ...cur, text: $('#b-text').value });
    setSaveStatus('Saved');
    toast('Base resume saved');
  };
}

function viewSettings() {
  const s = store.getSettings();
  const keyed = state.providers.filter(p => p.needsKey);
  const mask = k => (k ? `••••${k.slice(-4)}` : '');
  main.innerHTML = `<div class="narrow">
    <h1>Settings</h1>
    <p class="muted">API keys are stored only in this browser (localStorage) and are sent only to the provider you pick.
    Nothing is stored on GitHub.</p>
    <h3>API keys</h3>
    ${keyed.map(p => `<div class="key-row">
      <span>${esc(p.label)}</span>
      <input type="password" id="k-${p.id}" placeholder="${s.keys[p.id] ? `Saved (${mask(s.keys[p.id])}) — type to replace` : 'Paste API key'}" autocomplete="off">
      ${s.keys[p.id] ? `<label class="chk"><input type="checkbox" id="c-${p.id}"> remove</label>` : '<span></span>'}
    </div>`).join('')}
    <div class="key-row"><span>Ollama URL</span><input id="s-ollama" value="${esc(s.ollamaUrl)}"><span></span></div>
    <h3 style="margin-top:28px">Default model</h3>
    <p class="muted">Used until you pick something else (the last model you used is remembered too).</p>
    ${pickerHTML('s')}
    <div style="margin-top:24px"><button id="s-save" class="primary">Save settings</button></div>

    <h3 style="margin-top:40px">Backup</h3>
    <p class="muted">Your resume and applications live only in this browser. Export a backup now and then, and use Import to move
    them to another computer or browser. API keys are not included.</p>
    <div class="row">
      <button id="x-export">Export backup (.json)</button>
      <label class="btn" style="margin:0">Import backup<input type="file" id="x-import" accept=".json" hidden></label>
    </div>
  </div>`;
  initPicker('s');
  $('#s-prov').value = s.defaultProvider;
  $('#s-model').value = s.defaultModel;

  $('#s-save').onclick = () => {
    const next = { ...s, keys: { ...s.keys } };
    keyed.forEach(p => {
      const v = $(`#k-${p.id}`).value.trim();
      if (v) next.keys[p.id] = v;
      if ($(`#c-${p.id}`)?.checked) delete next.keys[p.id];
    });
    next.ollamaUrl = $('#s-ollama').value.trim();
    next.defaultProvider = $('#s-prov').value;
    next.defaultModel = $('#s-model').value.trim();
    store.saveSettings(next);
    localStorage.removeItem('rt.lastModel');
    state.models = {};
    loadMeta();
    toast('Settings saved');
    viewSettings();
  };

  $('#x-export').onclick = () => {
    const blob = new Blob([JSON.stringify(store.exportAll(), null, 2)], { type: 'application/json' });
    downloadBlob(blob, `resume-tailor-backup-${new Date().toISOString().slice(0, 10)}.json`);
  };
  $('#x-import').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const n = store.importAll(JSON.parse(await f.text()));
      renderList();
      toast(`Imported ${n} application${n === 1 ? '' : 's'}`);
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- router ----------
function route() {
  const [, view, id, tab] = location.hash.split('/');
  renderList();
  if (view === 'app' && id) return viewApp(id, tab);
  if (view === 'resume') return viewResume();
  if (view === 'settings') return viewSettings();
  return viewNew();
}

function loadMeta() {
  state.settings = store.getSettings();
  state.providers = providerList(state.settings);
}

window.addEventListener('hashchange', route);
loadMeta();
if (!location.hash) location.hash = store.getBaseResume().text ? '#/new' : '#/resume';
else route();
