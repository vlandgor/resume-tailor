// Resume Tailor — browser-only app (hash routing, localStorage, direct AI calls)
import { marked } from 'marked';
import { store } from './store.js';
import { listModels, complete, providerList } from './providers.js';
import * as prompts from './prompts.js';
import { extractResumeText, downloadDocx, printPdf, downloadBlob, fileBase } from './files.js';
import { parseTemplate, buildDocx, toB64, fromB64, linesToPlain, protectLinks } from './docxTemplate.js';
import { renderDocx, measureDocxPages, measureMdPages, printDocx } from './preview.js';

const $ = s => document.querySelector(s);
const main = $('#main');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUSES = ['draft', 'applied', 'interview', 'offer', 'rejected'];
const MAX_PAGES = 2;
// The browser estimate runs ~15% short of real Word/Docs layout, so enforce with a safety margin.
const PAGE_LIMIT = 1.85;
const state = { providers: [], settings: null, models: {} };

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), isErr ? 8000 : 3000);
}
const setSaveStatus = text => { const el = $('#saveStatus'); if (el) el.textContent = text; };
const pagesBadge = p => (p ? `<span class="pages ${p > PAGE_LIMIT ? 'bad' : 'ok'}" title="Estimated from the on-screen layout. Over ${PAGE_LIMIT} risks spilling onto page 3 in Word/Docs.">≈ ${p.toFixed(1)} pages${p > PAGE_LIMIT ? ' — too long' : ''}</span>` : '');

// ---------- documents ----------
async function resumeBlob(a) {
  const tpl = store.getTemplate(a.templateId);
  if (!tpl) throw new Error('The style template for this application is missing. Re-upload your DOCX and re-tailor.');
  return buildDocx(tpl, a.lines);
}

async function measure(a) {
  if (a.mode === 'docx') return measureDocxPages(await resumeBlob(a), a.page, a.fonts);
  return measureMdPages(a.resumeMd);
}

const resumeAsText = a => (a.mode === 'docx' ? linesToPlain(a.lines) : a.resumeMd);

// ---------- AI actions ----------
async function tailor(id, { provider, model, instructions = '' }, onStep = () => {}) {
  const a = store.getApp(id);
  const base = store.getBaseResume();
  if (!base.text.trim()) throw new Error('Add your base resume first (sidebar → Base resume).');
  if (!a.jobText.trim()) throw new Error('This application has no job description.');
  const docx = base.mode === 'docx' && store.getTemplate(base.templateId);

  const raw = await complete({
    provider, model, settings: store.getSettings(),
    system: docx ? prompts.TAILOR_DOCX_SYSTEM : prompts.TAILOR_SYSTEM,
    user: prompts.tailorUser({ baseResume: docx ? base.lines : base.text, jobText: a.jobText, instructions, basePages: base.pages }),
  });

  let fields;
  if (docx) {
    const out = prompts.parseTailorLines(raw);
    if (!out.lines) throw new Error('The model did not return the resume in the expected format. Try again or pick a stronger model.');
    fields = { mode: 'docx', lines: protectLinks(out.lines, base.lines), resumeMd: '', templateId: base.templateId, page: base.page, fonts: base.fonts, changes: out.changes, company: out.company, title: out.title };
  } else {
    const out = prompts.parseTailor(raw);
    if (!out.resumeMd) throw new Error('The model returned an empty response. Try again or pick another model.');
    fields = { mode: 'text', resumeMd: out.resumeMd, lines: '', changes: out.changes, company: out.company, title: out.title };
  }

  const fresh = store.getApp(id); // re-read in case title/company were edited meanwhile
  store.saveApp({
    ...fresh, ...fields,
    resumeModel: `${provider}/${model}`,
    company: fresh.company || fields.company, title: fresh.title || fields.title,
  });
  return enforceLength(id, { provider, model }, onStep);
}

// The 2-page hard rule: measure the rendered result; if it's too long, ask the model to cut (up to 2 rounds).
async function enforceLength(id, { provider, model }, onStep = () => {}) {
  for (let round = 0; ; round++) {
    const a = store.getApp(id);
    onStep('Checking length…');
    const pages = await measure(a);
    store.patchApp(id, { pages });
    if (pages <= PAGE_LIMIT) return store.getApp(id);
    if (round === 2) {
      toast(`Still about ${pages.toFixed(1)} pages after shortening twice. Trim it by hand or use "Fit to 2 pages" again.`, true);
      return store.getApp(id);
    }
    onStep(`${pages.toFixed(1)} pages — shortening…`);
    const raw = await complete({
      provider, model, settings: store.getSettings(),
      system: a.mode === 'docx' ? prompts.TAILOR_DOCX_SYSTEM : prompts.TAILOR_SYSTEM,
      user: prompts.shortenUser({ resume: a.mode === 'docx' ? a.lines : a.resumeMd, jobText: a.jobText, pages: pages.toFixed(1) }),
    });
    const out = a.mode === 'docx' ? prompts.parseTailorLines(raw) : prompts.parseTailor(raw);
    const text = a.mode === 'docx' ? protectLinks(out.lines, a.lines) : out.resumeMd;
    if (!text) throw new Error('The model returned an unusable response while shortening.');
    store.patchApp(id, {
      ...(a.mode === 'docx' ? { lines: text } : { resumeMd: text }),
      changes: `${a.changes}${out.changes ? `\n\n**Shortened to fit 2 pages:**\n\n${out.changes}` : ''}`,
    });
  }
}

async function writeCover(id, { provider, model, instructions = '' }) {
  const a = store.getApp(id);
  const resume = resumeAsText(a) || store.getBaseResume().text;
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
    btn.innerHTML = `<span class="spinner"></span>${esc(label || 'Working…')}`;
  } else {
    btn.disabled = false;
    btn.innerHTML = btn.dataset.label;
  }
}
const stepper = btn => text => { btn.innerHTML = `<span class="spinner"></span>${esc(text)}`; };

// Preview view mode: one continuous sheet, or split into pages. Remembered across visits.
const getView = () => localStorage.getItem('rt.view') || 'single';
const previewCol = id => `<div class="preview-col">
  <div class="seg" id="viewSeg"><button data-view="single">Single page</button><button data-view="pages">Split pages</button></div>
  <div id="${id}" class="docx-box"></div></div>`;
function initViewToggle(onChange) {
  const seg = $('#viewSeg');
  const sync = () => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.view === getView()));
  sync();
  seg.onclick = e => {
    const v = e.target.dataset?.view;
    if (!v || v === getView()) return;
    localStorage.setItem('rt.view', v);
    sync();
    onChange();
  };
}

// Fit the 8.5in docx-preview page into its column.
function fitPreview(box) {
  const page = box.querySelector('section.docx');
  const wrap = box.querySelector('.docx-wrapper');
  if (!page || !wrap) return;
  wrap.style.zoom = Math.min(1, (box.clientWidth - 4) / (page.offsetWidth + 40));
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
      await tailor(a.id, { ...m, instructions: $('#n-instr').value.trim() }, stepper(btn));
      if ($('#n-cover').checked) {
        stepper(btn)('Writing cover letter…');
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
  if (tab === 'cover') return renderCoverTab(a, patch);
  return renderResumeTab(a, patch);
}

// Shared "nothing generated yet" panel
function genPanel(title, hint, placeholder, label, onGo) {
  $('#tabBody').innerHTML = `<div class="gen-panel">
    <h3 style="margin-top:0">${title}</h3>
    <p class="muted">${hint}</p>
    ${pickerHTML('g')}
    <label>Extra instructions <span class="muted">(optional)</span></label>
    <input id="g-instr" placeholder="${placeholder}">
    <div style="margin-top:16px"><button id="g-go" class="primary">${label}</button></div>
  </div>`;
  const getModel = initPicker('g');
  $('#g-go').onclick = e => onGo(e.currentTarget, getModel, $('#g-instr').value.trim());
}

async function runAction(btn, getModel, label, fn) {
  let m;
  try { m = getModel(); } catch (err) { return toast(err.message, true); }
  busy(btn, true, label);
  try { await fn(m); route(); } catch (err) { toast(err.message, true); busy(btn, false); }
}

function renderResumeTab(a, patch) {
  const hasResume = a.mode === 'docx' ? !!a.lines : !!a.resumeMd;
  const go = (btn, getModel, instructions) =>
    runAction(btn, getModel, 'Tailoring…', m => tailor(a.id, { ...m, instructions }, stepper(btn)));

  if (!hasResume) {
    return genPanel('Tailor the resume', 'Uses your base resume and this job posting.', 'e.g. keep it to one page', 'Tailor resume', go);
  }

  const isDocx = a.mode === 'docx';
  $('#tabBody').innerHTML = `
    <div class="toolbar">
      ${pickerHTML('g')}
      <input id="g-instr" class="instr" placeholder="Instructions for re-tailoring (optional)">
      <button id="g-go">Re-tailor</button>
      <span class="spacer"></span>
      <span id="pagesSlot">${pagesBadge(a.pages)}</span>
      <button id="g-fit" ${a.pages > PAGE_LIMIT ? '' : 'hidden'}>Fit to 2 pages</button>
      <span id="saveStatus"></span>
      <button id="dl-docx">Download .docx</button>
      <button id="dl-pdf" class="primary">Save as PDF</button>
    </div>
    ${a.changes ? `<details class="changes"><summary>What was changed</summary>${marked.parse(a.changes)}</details>` : ''}
    <p class="muted" style="margin:0 0 10px;font-size:12px">${a.resumeModel ? `Generated with ${esc(a.resumeModel)} · ` : ''}${isDocx
      ? 'Your own DOCX styling is kept. Edit text after "|" on the left; delete a line to remove it, or duplicate a line to add one with the same formatting. Edits save automatically.'
      : 'Edit on the left, preview on the right — edits save automatically.'}</p>
    <div class="editor ${isDocx ? 'docx-mode' : ''}">
      <textarea id="d-md" spellcheck="true"></textarea>
      ${isDocx ? previewCol('d-preview') : '<div id="d-preview" class="paper"></div>'}
    </div>`;
  const getModel = initPicker('g');
  const ta = $('#d-md'), pv = $('#d-preview');
  ta.value = isDocx ? a.lines : a.resumeMd;

  let renderSeq = 0;
  const render = async () => {
    const cur = store.getApp(a.id);
    if (!isDocx) { pv.innerHTML = marked.parse(cur.resumeMd); return; }
    const seq = ++renderSeq;
    try {
      const blob = await resumeBlob(cur);
      if (seq !== renderSeq) return;
      await renderDocx(blob, pv, cur.fonts, getView());
      if (seq !== renderSeq) return;
      fitPreview(pv);
    } catch (e) { pv.innerHTML = `<p class="danger" style="padding:16px">${esc(e.message)}</p>`; }
  };
  const remeasure = async () => {
    try {
      const pages = await measure(store.getApp(a.id));
      patch({ pages });
      $('#pagesSlot').innerHTML = pagesBadge(pages);
      $('#g-fit').hidden = pages <= PAGE_LIMIT;
    } catch { /* preview shows the error */ }
  };
  render();
  if (isDocx) initViewToggle(render);
  window.onresize = () => fitPreview(pv);

  let t;
  ta.oninput = () => {
    if (!isDocx) pv.innerHTML = marked.parse(ta.value);
    setSaveStatus('Editing…');
    clearTimeout(t);
    t = setTimeout(async () => {
      try {
        patch(isDocx ? { lines: ta.value } : { resumeMd: ta.value });
        setSaveStatus('Saved');
        if (isDocx) await render();
        remeasure();
      } catch (e) { setSaveStatus('Save failed'); toast(e.message, true); }
    }, isDocx ? 700 : 500);
  };

  $('#dl-docx').onclick = async () => {
    try {
      const cur = store.getApp(a.id);
      if (isDocx) downloadBlob(await resumeBlob(cur), `${fileBase(cur, 'resume')}.docx`);
      else await downloadDocx(cur, 'resume');
    } catch (e) { toast(e.message, true); }
  };
  $('#dl-pdf').onclick = async () => {
    try {
      const cur = store.getApp(a.id);
      if (isDocx) await printDocx(await resumeBlob(cur), fileBase(cur, 'resume'), cur.page, cur.fonts);
      else printPdf(cur, 'resume');
    } catch (e) { toast(e.message, true); }
  };
  $('#g-go').onclick = e => {
    if (!confirm('This replaces the current version, including your manual edits. Continue?')) return;
    go(e.currentTarget, getModel, $('#g-instr').value.trim());
  };
  $('#g-fit').onclick = e => {
    const btn = e.currentTarget;
    runAction(btn, getModel, 'Shortening…', m => enforceLength(a.id, m, stepper(btn)));
  };
}

function renderCoverTab(a, patch) {
  const go = (btn, getModel, instructions) =>
    runAction(btn, getModel, 'Writing…', m => writeCover(a.id, { ...m, instructions }));

  if (!a.coverMd) {
    return genPanel('Write a cover letter', 'Uses the tailored resume (or your base resume) and this job posting.',
      'e.g. mention I can relocate, mention a referral from …', 'Write cover letter', go);
  }

  $('#tabBody').innerHTML = `
    <div class="toolbar">
      ${pickerHTML('g')}
      <input id="g-instr" class="instr" placeholder="Instructions for rewriting (optional)">
      <button id="g-go">Rewrite</button>
      <span class="spacer"></span>
      <span id="saveStatus"></span>
      <button id="dl-docx">Download .docx</button>
      <button id="dl-pdf" class="primary">Save as PDF</button>
    </div>
    ${a.coverModel ? `<p class="muted" style="margin:0 0 10px;font-size:12px">Generated with ${esc(a.coverModel)} · edits save automatically.</p>` : ''}
    <div class="editor">
      <textarea id="d-md" spellcheck="true"></textarea>
      <div id="d-preview" class="paper"></div>
    </div>`;
  const getModel = initPicker('g');
  const ta = $('#d-md'), pv = $('#d-preview');
  ta.value = a.coverMd;
  pv.innerHTML = marked.parse(a.coverMd);
  let t;
  ta.oninput = () => {
    pv.innerHTML = marked.parse(ta.value);
    setSaveStatus('Editing…');
    clearTimeout(t);
    t = setTimeout(() => {
      try { patch({ coverMd: ta.value }); setSaveStatus('Saved'); } catch (e) { toast(e.message, true); }
    }, 500);
  };
  $('#dl-docx').onclick = async () => { try { await downloadDocx(store.getApp(a.id), 'cover'); } catch (e) { toast(e.message, true); } };
  $('#dl-pdf').onclick = () => { try { printPdf(store.getApp(a.id), 'cover'); } catch (e) { toast(e.message, true); } };
  $('#g-go').onclick = e => {
    if (!confirm('This replaces the current letter, including your manual edits. Continue?')) return;
    go(e.currentTarget, getModel, $('#g-instr').value.trim());
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
  const isDocx = r.mode === 'docx' && store.getTemplate(r.templateId);
  main.innerHTML = `<div style="max-width:1200px">
    <h1>Base resume</h1>
    <p class="muted">Every tailored version starts from this.
      <b>To keep your own design</b> (colors, fonts, links, spacing), upload it as <b>DOCX</b> — from Google Docs:
      <i>File → Download → Microsoft Word (.docx)</i>. PDF, TXT or pasted text also work, but then the built-in layout is used.</p>
    <div class="row" style="margin:14px 0">
      <input type="file" id="b-file" accept=".docx,.pdf,.txt,.md" style="flex:0 1 auto">
      <span style="flex:1"></span>
      <span id="b-pages">${pagesBadge(r.pages)}</span>
      <span class="muted" style="font-size:12px">${r.updatedAt ? `${esc(r.fileName || 'Edited')} · ${isDocx ? 'style template' : 'plain text'} · updated ${new Date(r.updatedAt).toLocaleString()}` : 'Not set yet'}</span>
    </div>
    ${isDocx ? `
      <div class="editor docx-mode">
        <div>
          <p class="muted" style="margin-top:0">What the AI sees: one line per paragraph. Edit the text after "| " and it saves automatically.
            The § number links each line to its formatting, so keep it. Delete a line to drop it, or duplicate a line to add one with the same style.
            Lines marked [link] contain hyperlinks; change those in Google Docs and re-upload.</p>
          <textarea id="b-lines" class="big" spellcheck="true">${esc(r.lines)}</textarea>
          <div class="row" style="margin-top:8px"><button id="b-reset">Reset to original</button><span id="saveStatus" class="muted"></span></div>
        </div>
        ${previewCol('b-preview')}
      </div>` : `
      <textarea id="b-text" class="big" placeholder="Paste your resume here…">${esc(r.text)}</textarea>
      <div class="row" style="margin-top:12px"><button id="b-save" class="primary">Save</button><span id="saveStatus"></span></div>`}
  </div>`;

  if (isDocx) {
    const pv = $('#b-preview'), ta = $('#b-lines');
    const tpl = store.getTemplate(r.templateId);
    let seq = 0;
    const renderBase = async () => {
      const mine = ++seq;
      try {
        const blob = await buildDocx(tpl, store.getBaseResume().lines);
        if (mine !== seq) return;
        await renderDocx(blob, pv, r.fonts, getView());
        fitPreview(pv);
      } catch (e) { pv.textContent = e.message; }
    };
    // Save edited lines: hyperlink lines always keep their original text (the DOCX keeps them unchanged anyway).
    const saveLines = async lines => {
      const original = (await parseTemplate(fromB64(tpl))).lines;
      const fixed = protectLinks(lines, original);
      const blob = await buildDocx(tpl, fixed);
      const pages = await measureDocxPages(blob, r.page, r.fonts);
      store.saveBaseResume({ ...store.getBaseResume(), lines: fixed, text: linesToPlain(fixed), pages });
      $('#b-pages').innerHTML = pagesBadge(pages);
      return fixed;
    };
    renderBase();
    initViewToggle(renderBase);
    window.onresize = () => fitPreview(pv);

    let t = null;
    const flush = async () => {
      clearTimeout(t);
      t = null;
      try {
        const fixed = await saveLines(ta.value);
        if (fixed !== ta.value && document.activeElement !== ta) ta.value = fixed; // show protected link lines as they really are
        setSaveStatus('Saved');
        renderBase();
      } catch (e) { setSaveStatus('Save failed'); toast(e.message, true); }
    };
    ta.oninput = () => {
      setSaveStatus('Editing…');
      clearTimeout(t);
      t = setTimeout(flush, 700);
    };
    ta.onblur = () => {
      if (t) return flush();
      const saved = store.getBaseResume().lines; // already saved while typing: just show the protected version
      if (saved !== ta.value) ta.value = saved;
    };
    $('#b-reset').onclick = async () => {
      if (!confirm('Discard your edits and restore the text from the uploaded DOCX?')) return;
      const original = (await parseTemplate(fromB64(tpl))).lines;
      ta.value = await saveLines(original);
      setSaveStatus('Restored');
      renderBase();
    };
  } else {
    $('#b-save').onclick = () => {
      const text = $('#b-text').value;
      store.saveBaseResume({ ...store.getBaseResume(), mode: 'text', text, lines: '', templateId: '' });
      measureMdPages(text).then(pages => store.saveBaseResume({ ...store.getBaseResume(), pages }));
      setSaveStatus('Saved');
      toast('Base resume saved');
    };
  }

  $('#b-file').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      if (f.name.toLowerCase().endsWith('.docx')) {
        const buf = await f.arrayBuffer();
        const tpl = await parseTemplate(buf);
        const b64 = toB64(buf);
        if (b64.length > 2_000_000) throw new Error('This DOCX is large (big images?). Remove images or compress them and try again.');
        const templateId = await store.saveTemplate(b64);
        const pages = await measureDocxPages(new Blob([buf]), tpl.page, tpl.fonts);
        store.saveBaseResume({ mode: 'docx', fileName: f.name, templateId, text: tpl.text, lines: tpl.lines, page: tpl.page, fonts: tpl.fonts, pages });
        toast(pages > PAGE_LIMIT ? `Imported. Note: your base resume is about ${pages.toFixed(1)} pages; tailored versions will be cut to 2.` : 'Imported — tailored resumes will keep this styling');
      } else {
        const text = await extractResumeText(f);
        const pages = await measureMdPages(text);
        store.saveBaseResume({ mode: 'text', fileName: f.name, text, lines: '', templateId: '', page: null, fonts: [], pages });
        toast('Imported as plain text (upload a DOCX to keep your own styling)');
      }
      viewResume();
    } catch (err) { toast(err.message, true); }
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
    <p class="muted">Your resume, style template and applications live only in this browser. Export a backup now and then, and use Import to move
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
  window.onresize = null;
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
