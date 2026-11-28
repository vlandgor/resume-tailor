// Resume Tailor — static app (hash routing, Supabase accounts + storage, direct AI calls from the browser)
import { safeMd } from './safe.js';
import { store } from './store.js';
import { sb, configured } from './supabase.js';
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
const state = { providers: [], settings: null, models: {}, user: null };

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
      `<option value="${x.id}">${esc(x.label)}${x.hasKey ? '' : x.locked ? ' — locked' : ' — no key'}</option>`).join('')}</select>
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
  const nMsg = (a.messages || []).length;
  const TABS = { resume: 'Resume', cover: 'Cover letter', messages: `Messages${nMsg ? ` (${nMsg})` : ''}`, job: 'Job posting' };
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
  if (tab === 'messages') return renderMessagesTab(a, patch);
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
    ${a.changes ? `<details class="changes"><summary>What was changed</summary>${safeMd(a.changes)}</details>` : ''}
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
    if (!isDocx) { pv.innerHTML = safeMd(cur.resumeMd); return; }
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
    if (!isDocx) pv.innerHTML = safeMd(ta.value);
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
  pv.innerHTML = safeMd(a.coverMd);
  let t;
  ta.oninput = () => {
    pv.innerHTML = safeMd(ta.value);
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

// ---------- recruiter messages: paste in, AI drafts, you send it yourself ----------
async function draftReply(id, { provider, model, instructions = '' }) {
  const a = store.getApp(id);
  const thread = a.messages || [];
  if (!thread.some(m => m.dir === 'in')) throw new Error('Paste a message from the recruiter first.');
  const raw = await complete({
    provider, model, settings: store.getSettings(),
    system: prompts.REPLY_SYSTEM,
    user: prompts.replyUser({
      resume: resumeAsText(a) || store.getBaseResume().text,
      jobText: a.jobText, company: a.company, title: a.title, notes: a.notes, thread, instructions,
    }),
  });
  const out = prompts.parseReply(raw);
  return store.patchApp(id, { replyDraft: out.reply, replyNotes: out.notes, replyModel: `${provider}/${model}` });
}

function renderMessagesTab(a, patch) {
  const thread = a.messages || [];
  const fmt = d => new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  $('#tabBody').innerHTML = `<div class="msgs">
    <div class="thread">
      ${thread.length ? thread.map(m => `
        <div class="msg ${m.dir}">
          <div class="msg-head"><b>${m.dir === 'in' ? 'Recruiter' : 'You'}</b><span>${esc(fmt(m.date))}</span>
            <button class="icon-btn" data-del="${m.id}" title="Delete message" aria-label="Delete message">✕</button></div>
          <div class="msg-body">${esc(m.text)}</div>
        </div>`).join('') : `<p class="muted">No messages yet. When a recruiter writes to you about this job, paste their email below.
        The app never connects to your email: you copy messages in and copy replies out.</p>`}
    </div>

    <div class="gen-panel">
      <label style="margin-top:0">Paste the recruiter's message</label>
      <textarea id="m-in" rows="6" placeholder="Paste the email text here (the part they wrote, not the whole quoted history)."></textarea>
      <div class="row" style="margin-top:8px;gap:12px">
        <button id="m-add">Add to conversation</button>
        <label class="chk"><input type="checkbox" id="m-add-draft" checked> and draft a reply</label>
      </div>
    </div>

    <div class="gen-panel">
      <h3 style="margin-top:0">Your reply</h3>
      <div class="toolbar">
        ${pickerHTML('g')}
        <input id="m-instr" class="instr" placeholder="What to say, e.g. available Tue/Wed afternoons; ask about the salary range">
        <button id="m-draft" class="primary">${a.replyDraft ? 'Redraft' : 'Draft reply'}</button>
      </div>
      ${a.replyNotes ? `<div class="banner">${safeMd(a.replyNotes)}</div>` : ''}
      <textarea id="m-reply" rows="12" placeholder="The drafted reply appears here. Edit it freely; it saves automatically.">${esc(a.replyDraft || '')}</textarea>
      <div class="row" style="margin-top:8px;gap:8px">
        <button id="m-copy" class="primary">Copy reply</button>
        <button id="m-sent">Mark as sent</button>
        <span class="muted" style="font-size:12px">${a.replyModel ? `Drafted with ${esc(a.replyModel)}. ` : ''}Fill any [placeholders] before sending.</span>
        <span id="saveStatus" class="muted"></span>
      </div>
    </div>
  </div>`;
  const getModel = initPicker('g');
  const reply = $('#m-reply');

  const runDraft = async btn => {
    let m;
    try { m = getModel(); } catch (err) { return toast(err.message, true); }
    busy(btn, true, 'Drafting…');
    try { await draftReply(a.id, { ...m, instructions: $('#m-instr').value.trim() }); route(); }
    catch (err) { toast(err.message, true); busy(btn, false); }
  };

  $('#m-add').onclick = async e => {
    const text = $('#m-in').value.trim();
    if (!text) return toast('Paste the message first', true);
    const msg = { id: crypto.randomUUID(), dir: 'in', text, date: new Date().toISOString() };
    patch({ messages: [...(store.getApp(a.id).messages || []), msg] });
    if ($('#m-add-draft').checked) { $('#m-in').value = ''; return runDraft(e.currentTarget); }
    route();
  };
  $('#m-draft').onclick = e => {
    if (reply.value.trim() && !confirm('Replace the current draft?')) return;
    runDraft(e.currentTarget);
  };

  let t;
  reply.oninput = () => {
    setSaveStatus('Editing…');
    clearTimeout(t);
    t = setTimeout(() => { patch({ replyDraft: reply.value }); setSaveStatus('Saved'); }, 400);
  };
  $('#m-copy').onclick = async () => {
    if (/\[[^\]]+\]/.test(reply.value) && !confirm('The reply still has [placeholders]. Copy anyway?')) return;
    try { await navigator.clipboard.writeText(reply.value); toast('Copied. Paste it into your email and send.'); }
    catch { reply.select(); toast('Press Ctrl+C to copy', true); }
  };
  $('#m-sent').onclick = () => {
    const text = reply.value.trim();
    if (!text) return toast('Nothing to mark as sent', true);
    const msg = { id: crypto.randomUUID(), dir: 'out', text, date: new Date().toISOString() };
    patch({ messages: [...(store.getApp(a.id).messages || []), msg], replyDraft: '', replyNotes: '' });
    route();
  };
  document.querySelectorAll('[data-del]').forEach(b => (b.onclick = () => {
    if (!confirm('Delete this message?')) return;
    patch({ messages: (store.getApp(a.id).messages || []).filter(m => m.id !== b.dataset.del) });
    route();
  }));
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
  const vault = store.vaultStatus();
  const legacy = store.legacyLocal().keys; // plain-text keys saved in this browser before accounts
  const useLegacy = vault === 'none' && Object.keys(legacy).length > 0;
  const keyed = state.providers.filter(p => p.needsKey);
  const mask = k => (k ? `••••${k.slice(-4)}` : '');
  const keyRows = keyed.map(p => `<div class="key-row">
      <span>${esc(p.label)}</span>
      <input type="password" id="k-${p.id}" placeholder="${s.keys[p.id] ? `Saved (${mask(s.keys[p.id])}) — type to replace` : 'Paste API key'}" autocomplete="off">
      ${s.keys[p.id] ? `<label class="chk"><input type="checkbox" id="c-${p.id}"> remove</label>` : '<span></span>'}
    </div>`).join('');
  const remember = id => `<label class="chk"><input type="checkbox" id="${id}" checked> Remember on this device</label>`;

  main.innerHTML = `<div class="narrow">
    <h1>Settings</h1>

    <h3>API keys</h3>
    <p class="muted">Your keys are encrypted <b>in this browser</b> with your passphrase before they're saved to your account.
      The database only holds the encrypted version, so nobody can read your keys without the passphrase, not even the server.
      Keys are sent only to the provider you pick. If you forget the passphrase, reset it and paste your keys again.</p>
    ${vault === 'locked' ? `
      <div class="banner">
        <b>Your keys are locked.</b> Enter your passphrase to use them on this device.
        <div class="row" style="margin-top:8px">
          <input type="password" id="v-unlock" placeholder="Passphrase" autocomplete="off">
          <button id="v-unlock-go" class="primary">Unlock</button>
        </div>
        <div class="row" style="margin-top:8px;justify-content:space-between">${remember('v-remember')}
          <button id="v-reset" class="link danger">Forgot passphrase? Reset keys</button></div>
      </div>` : `
      ${useLegacy ? `<div class="banner">Found ${Object.keys(legacy).length} API key(s) saved in this browser before accounts.
        They're filled in below: set a passphrase and press <b>Save settings</b> to move them into your account, encrypted.</div>` : ''}
      ${keyRows}
      ${vault === 'none' ? `
        <div class="grid2">
          <div><label>Passphrase <span class="muted">(at least 8 characters)</span></label><input type="password" id="v-pass" autocomplete="new-password"></div>
          <div><label>Repeat passphrase</label><input type="password" id="v-pass2" autocomplete="new-password"></div>
        </div>
        <p class="muted" style="margin:6px 0 16px;font-size:12px">Different from your sign-in password. ${remember('v-remember')}</p>`
      : `<p class="muted" style="font-size:12px">Unlocked on this device. <button id="v-lock" class="link">Lock now</button></p>`}`}
    <div class="key-row"><span>Ollama URL</span><input id="s-ollama" value="${esc(s.ollamaUrl)}"><span></span></div>

    <h3 style="margin-top:28px">Default model</h3>
    <p class="muted">Used until you pick something else (the last model you used is remembered too).</p>
    ${pickerHTML('s')}
    <div style="margin-top:24px"><button id="s-save" class="primary">Save settings</button></div>

    <h3 style="margin-top:40px">Account</h3>
    <p class="muted">Signed in as <b>${esc(state.user.email)}</b>. Your resume, templates and applications are saved to your account
      and only you can see them.</p>
    <div class="row">
      <input type="password" id="a-pass" placeholder="New sign-in password (at least 8 characters)" autocomplete="new-password">
      <button id="a-save">Change password</button>
    </div>

    <h3 style="margin-top:40px">Backup</h3>
    <p class="muted">Download everything as a file, or import a backup into this account. API keys are not included.</p>
    <div class="row">
      <button id="x-export">Export backup (.json)</button>
      <label class="btn" style="margin:0">Import backup<input type="file" id="x-import" accept=".json" hidden></label>
    </div>
  </div>`;
  initPicker('s');
  $('#s-prov').value = s.defaultProvider;
  $('#s-model').value = s.defaultModel;
  if (useLegacy) for (const [id, v] of Object.entries(legacy)) { const el = $(`#k-${id}`); if (el) el.value = v; }

  const afterKeysChange = () => { state.models = {}; loadMeta(); viewSettings(); };
  if (vault === 'locked') {
    const go = async () => {
      const btn = $('#v-unlock-go');
      busy(btn, true, 'Unlocking…');
      try {
        await store.unlock($('#v-unlock').value, $('#v-remember').checked);
        toast('Keys unlocked');
        afterKeysChange();
      } catch (e) { busy(btn, false); toast(e.message, true); }
    };
    $('#v-unlock-go').onclick = go;
    $('#v-unlock').onkeydown = e => { if (e.key === 'Enter') go(); };
    $('#v-reset').onclick = async () => {
      if (!confirm('Delete your saved API keys? You\'ll need to paste them again and choose a new passphrase.')) return;
      await store.resetVault();
      afterKeysChange();
    };
  }
  if (vault === 'unlocked') {
    $('#v-lock').onclick = async () => { await store.lock(); toast('Keys locked on this device'); afterKeysChange(); };
  }

  $('#s-save').onclick = async e => {
    const btn = e.currentTarget;
    const next = { ...s, keys: { ...s.keys } };
    if (vault !== 'locked') {
      keyed.forEach(p => {
        const v = $(`#k-${p.id}`).value.trim();
        if (v) next.keys[p.id] = v;
        if ($(`#c-${p.id}`)?.checked) delete next.keys[p.id];
      });
    }
    next.ollamaUrl = $('#s-ollama').value.trim();
    next.defaultProvider = $('#s-prov').value;
    next.defaultModel = $('#s-model').value.trim();
    const keysChanged = JSON.stringify(next.keys) !== JSON.stringify(s.keys);
    try {
      if (keysChanged && vault === 'none') {
        const pass = $('#v-pass').value;
        if (pass !== $('#v-pass2').value) throw new Error('The two passphrases don\'t match.');
        busy(btn, true, 'Encrypting…');
        await store.setupVault(pass, $('#v-remember').checked);
      }
      store.saveSettings(next);
      if (keysChanged) {
        await store.syncNow();
        store.clearLegacyKeys(); // the plain-text copy in this browser is no longer needed
      }
      localStorage.removeItem('rt.lastModel');
      toast('Settings saved');
      afterKeysChange();
    } catch (err) { busy(btn, false); toast(err.message, true); }
  };

  $('#a-save').onclick = async e => {
    const password = $('#a-pass').value;
    if (password.length < 8) return toast('Use at least 8 characters', true);
    const btn = e.currentTarget;
    busy(btn, true, 'Saving…');
    const { error } = await sb.auth.updateUser({ password });
    busy(btn, false);
    if (error) return toast(error.message, true);
    $('#a-pass').value = '';
    toast('Password changed');
  };

  $('#x-export').onclick = () => {
    const blob = new Blob([JSON.stringify(store.exportAll(), null, 2)], { type: 'application/json' });
    downloadBlob(blob, `resume-tailor-backup-${new Date().toISOString().slice(0, 10)}.json`);
  };
  $('#x-import').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const n = await store.importAll(JSON.parse(await f.text()));
      renderList();
      toast(`Imported ${n} application${n === 1 ? '' : 's'}`);
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- one-time import of data saved in this browser before accounts ----------
const migrateFlag = () => `rt.migrateDismissed.${state.user.id}`;
function migrationBanner() {
  if (localStorage.getItem(migrateFlag()) || !store.isAccountEmpty()) return;
  const legacy = store.legacyLocal();
  if (!legacy.hasData) return;
  main.insertAdjacentHTML('afterbegin', `<div class="banner" id="migrate">
    <b>Found data saved in this browser from before accounts</b>
    (${legacy.backup.resume?.text ? 'base resume, ' : ''}${legacy.nApps} application${legacy.nApps === 1 ? '' : 's'}).
    Import it into your account?
    <div class="row" style="margin-top:8px"><button id="mg-go" class="primary">Import into my account</button>
      <button id="mg-no">Not now</button></div>
  </div>`);
  $('#mg-no').onclick = () => { localStorage.setItem(migrateFlag(), '1'); $('#migrate').remove(); };
  $('#mg-go').onclick = async e => {
    busy(e.currentTarget, true, 'Importing…');
    try {
      const n = await store.importAll(legacy.backup);
      await store.syncNow();
      store.clearLegacyData(); // only after it's safely in the account
      localStorage.setItem(migrateFlag(), '1');
      state.settings = store.getSettings();
      toast(`Imported ${n} application${n === 1 ? '' : 's'} into your account`);
      if (Object.keys(legacy.keys).length) location.hash = '#/settings'; // finish moving the API keys there
      else route();
    } catch (err) { busy(e.currentTarget, false); toast(err.message, true); }
  };
}

// ---------- router ----------
function route() {
  window.onresize = null;
  const [, view, id, tab] = location.hash.split('/');
  renderList();
  if (view === 'app' && id) viewApp(id, tab);
  else if (view === 'resume') viewResume();
  else if (view === 'settings') viewSettings();
  else viewNew();
  migrationBanner();
}

function loadMeta() {
  state.settings = store.getSettings();
  state.providers = providerList(state.settings);
}

// ---------- sign-in & startup ----------
const authView = document.createElement('div');
authView.id = 'authView';
document.body.append(authView);

function showAuth(html) {
  document.body.classList.add('signed-out');
  authView.innerHTML = `<div class="auth-card"><div class="auth-brand">Resume Tailor</div>${html}</div>`;
}

// Where Supabase sends people back after Google sign-in, email confirmation or a password-reset link.
const appUrl = () => `${location.origin}${location.pathname}`;
const GOOGLE_ICON = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

// mode: 'signin' | 'signup' | 'reset'
function showLogin(mode = 'signin', notice = '') {
  const T = {
    signin: { intro: 'Sign in to your account.', btn: 'Sign in', busy: 'Signing in…' },
    signup: { intro: 'Create an account. Your data is private to you.', btn: 'Create account', busy: 'Creating…' },
    reset: { intro: 'Enter your email and we\'ll send you a link to set a new password.', btn: 'Send reset link', busy: 'Sending…' },
  }[mode];
  showAuth(`
    ${notice ? `<div class="banner" style="margin-top:0">${esc(notice)}</div>` : ''}
    <p class="muted" style="margin-top:0">${T.intro}</p>
    ${mode !== 'reset' ? `
      <button id="g-google" class="google">${GOOGLE_ICON} Continue with Google</button>
      <div class="or"><span>or with email</span></div>` : ''}
    <form id="loginForm">
      <label${mode !== 'reset' ? ' style="margin-top:0"' : ''}>Email</label><input id="l-email" type="email" autocomplete="username" required>
      ${mode === 'reset' ? '' : `<label>Password${mode === 'signup' ? ' <span class="muted">(at least 8 characters)</span>' : ''}</label>
        <input id="l-pass" type="password" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" required ${mode === 'signup' ? 'minlength="8"' : ''}>`}
      <button class="primary block" style="width:100%;margin-top:18px">${T.btn}</button>
    </form>
    <div class="auth-links">
      ${mode === 'signin' ? '<button class="link" data-mode="signup">Create an account</button><button class="link" data-mode="reset">Forgot password?</button>'
        : '<button class="link" data-mode="signin">Back to sign in</button>'}
    </div>`);
  authView.querySelectorAll('[data-mode]').forEach(b => (b.onclick = () => showLogin(b.dataset.mode)));
  $('#l-email').focus();

  if ($('#g-google')) {
    $('#g-google').onclick = async e => {
      busy(e.currentTarget, true, 'Opening Google…');
      const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: appUrl() } });
      if (error) { busy(e.currentTarget, false); toast(error.message, true); } // on success the page navigates to Google
    };
  }

  $('#loginForm').onsubmit = async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    const email = $('#l-email').value.trim();
    busy(btn, true, T.busy);
    if (mode === 'reset') {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: `${appUrl()}?recovery=1` });
      if (error) { busy(btn, false); return toast(error.message, true); }
      return showLogin('signin', 'If that email has an account, a reset link is on its way. Open it in this browser.');
    }
    const password = $('#l-pass').value;
    if (mode === 'signup') {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: appUrl() } });
      if (error) { busy(btn, false); return toast(error.message, true); }
      if (data.session) return start(data.user); // email confirmation is off
      return showLogin('signin', 'Check your email and click the confirmation link, then sign in here.');
    }
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) { busy(btn, false); return toast(error.message, true); }
    start(data.user);
  };
}

// After clicking a password-reset link: the user is signed in and sets a new password.
function showNewPassword(user) {
  showAuth(`<form id="pwForm">
    <p class="muted" style="margin-top:0">Choose a new password for <b>${esc(user.email)}</b>.</p>
    <label>New password <span class="muted">(at least 8 characters)</span></label>
    <input id="pw-new" type="password" autocomplete="new-password" minlength="8" required>
    <button class="primary block" style="width:100%;margin-top:18px">Save password</button>
  </form>`);
  $('#pw-new').focus();
  $('#pwForm').onsubmit = async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    busy(btn, true, 'Saving…');
    const { error } = await sb.auth.updateUser({ password: $('#pw-new').value });
    if (error) { busy(btn, false); return toast(error.message, true); }
    toast('Password changed');
    start(user);
  };
}

function initSyncStatus() {
  const el = $('#sync');
  let shownError = false;
  store.onSync((status, err) => {
    el.className = `sync ${status}`;
    el.textContent = { saving: 'Saving…', saved: 'All changes saved', error: 'Not saved — retrying…' }[status];
    el.title = err?.message || '';
    if (status === 'error' && !shownError) { shownError = true; toast(`Couldn't save to your account: ${err.message}`, true); }
    if (status === 'saved') shownError = false;
  });
  window.addEventListener('beforeunload', e => { if (store.hasPendingWrites()) e.preventDefault(); });
}

async function start(user) {
  document.body.classList.remove('signed-out');
  authView.innerHTML = '';
  state.user = user;
  main.innerHTML = '<p class="muted">Loading your data…</p>';
  try { await store.init(user.id); }
  catch (e) {
    main.innerHTML = `<div class="narrow"><h1>Couldn't load your data</h1><p class="danger">${esc(e.message)}</p>
      <button onclick="location.reload()">Try again</button></div>`;
    return;
  }
  $('#account').innerHTML = `<span title="${esc(user.email)}">${esc(user.email)}</span><button id="signOut" class="link">Sign out</button>`;
  $('#signOut').onclick = async () => { await store.signOut(); location.reload(); };
  initSyncStatus();
  loadMeta();
  window.addEventListener('hashchange', route);
  if (!location.hash) location.hash = store.getBaseResume().text ? '#/new' : '#/resume';
  else route();
}

async function boot() {
  if (!configured) {
    return showAuth(`<p>This build isn't connected to a database yet.</p>
      <p class="muted">Set <code>SUPABASE_URL</code> and <code>SUPABASE_PUBLISHABLE_KEY</code> (see README → Accounts setup) and rebuild.</p>`);
  }
  sb.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT' && state.user) location.reload(); });

  // Coming back from Google / an email link: supabase-js exchanges ?code=… for a session during getSession().
  const params = new URL(location.href).searchParams;
  const { data: { session } } = await sb.auth.getSession();
  if (location.search) history.replaceState(null, '', location.pathname + location.hash); // tidy the URL
  const urlError = params.get('error_description');

  if (session && params.has('recovery')) return showNewPassword(session.user);
  if (session) return start(session.user);
  if (urlError) return showLogin('signin', urlError);
  // e.g. email confirmed in a different browser than the one used to sign up: the address is confirmed, just sign in.
  if (params.has('code')) return showLogin('signin', 'Your email is confirmed. Sign in to continue.');
  showLogin();
}
boot();
