// Rendering DOCX in the browser (preview + PDF), and measuring page count for the 2-page limit.
import { renderAsync } from 'docx-preview';
import { marked } from 'marked';
import { safeMd } from './safe.js';

const PX_PER_IN = 96;
const SYSTEM_FONTS = /^(arial|calibri|cambria|times new roman|times|georgia|verdana|tahoma|helvetica|courier new|courier|segoe ui|garamond|trebuchet ms|symbol|wingdings|aptos|consolas|book antiqua|palatino linotype)$/i;
const requested = new Set();

function fontHref(family, full) {
  const fam = encodeURIComponent(family).replace(/%20/g, '+');
  return `https://fonts.googleapis.com/css2?family=${fam}${full ? ':ital,wght@0,400;0,700;1,400;1,700' : ''}&display=swap`;
}

// Google Docs fonts (Roboto, Lato, Montserrat…) usually aren't installed locally; pull them from Google Fonts.
export function fontLinks(fonts = []) {
  return fonts.filter(f => !SYSTEM_FONTS.test(f)).map(f => fontHref(f, true));
}
export function loadFonts(fonts = []) {
  for (const f of fonts) {
    if (SYSTEM_FONTS.test(f) || requested.has(f)) continue;
    requested.add(f);
    const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: fontHref(f, true) });
    link.onerror = () => { link.href = fontHref(f, false); link.onerror = null; }; // font without bold/italic variants
    document.head.appendChild(link);
  }
}

// docx-preview computes real tab widths (e.g. right-aligned dates) ~500 ms after rendering, from the
// unzoomed layout. Wait for that before zooming, measuring or copying the HTML for printing.
const settleTabs = () => new Promise(r => setTimeout(r, 700));

const OPTIONS = {
  inWrapper: true,
  breakPages: true,
  ignoreLastRenderedPageBreak: true,
  experimental: true,
  useBase64URL: true,
  renderHeaders: true,
  renderFooters: true,
};

// view: 'single' — one continuous sheet; 'pages' — split onto page-sized sheets like Word/Docs.
export async function renderDocx(blob, container, fonts, view = 'single') {
  loadFonts(fonts);
  container.innerHTML = '';
  await renderAsync(blob, container, container, OPTIONS);
  await settleTabs();
  container.classList.toggle('paged', view === 'pages');
  if (view === 'pages') paginate(container);
}

// Moves whole paragraphs/tables that cross the bottom margin onto a new sheet.
// Approximate (no widow/orphan control), but close to what Word/Docs will do.
function paginate(container) {
  for (const first of container.querySelectorAll('.docx-wrapper > section.docx')) {
    let sec = first;
    for (let guard = 0; guard < 50; guard++) {
      const art = sec.querySelector(':scope > article');
      if (!art) break;
      const cs = getComputedStyle(sec);
      const usable = parseFloat(cs.minHeight) - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      art.style.position = 'relative'; // makes offsetTop relative to the article
      const blocks = Array.from(art.children);
      let cut = blocks.findIndex(b => b.offsetTop + b.offsetHeight > usable + 1);
      if (cut === -1) break;
      if (cut === 0) cut = 1; // a single block taller than a page stays put
      if (cut >= blocks.length) break;
      const next = sec.cloneNode(false);
      const nextArt = art.cloneNode(false);
      next.appendChild(nextArt);
      blocks.slice(cut).forEach(b => nextArt.appendChild(b));
      sec.after(next);
      sec = next;
    }
  }
}

function offscreen(widthIn) {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;left:-20000px;top:0;visibility:hidden;width:${widthIn}in;`;
  document.body.appendChild(el);
  return el;
}

// Approximate page count: rendered content height / usable page height.
export async function measureDocxPages(blob, page, fonts) {
  loadFonts(fonts);
  const box = offscreen(page.width + 1);
  try {
    await renderAsync(blob, box, box, { ...OPTIONS, inWrapper: false, ignoreHeight: true, renderHeaders: false, renderFooters: false });
    await document.fonts.ready;
    await settleTabs();
    const usable = (page.height - page.top - page.bottom) * PX_PER_IN;
    let total = 0;
    box.querySelectorAll('section.docx').forEach(sec => {
      const cs = getComputedStyle(sec);
      const content = sec.scrollHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      total += Math.max(content, 1) / usable;
    });
    return Math.round(total * 100) / 100;
  } finally {
    box.remove();
  }
}

// Same metrics as PRINT_CSS in files.js, scoped to the measuring box.
const MEASURE_CSS = `
.mdm { font-family: Calibri, Carlito, "Segoe UI", Arial, sans-serif; font-size: 10.5pt; line-height: 1.35; }
.mdm h1 { font-size: 19pt; margin: 0; } .mdm h1 + p { margin: 2pt 0 6pt; }
.mdm h2 { font-size: 11.5pt; border-bottom: 1px solid #999; padding-bottom: 2pt; margin: 11pt 0 4pt; }
.mdm h3 { font-size: 11pt; margin: 8pt 0 0; } .mdm h3 + p { margin: 0 0 2pt; }
.mdm p { margin: 4pt 0 6pt; } .mdm ul { margin: 2pt 0 4pt; padding-left: 16pt; } .mdm li { margin: 1.5pt 0; }
.mdm::after { content: ''; display: table; clear: both; }`;

export async function measureMdPages(md) {
  const box = offscreen(7.3); // letter width minus 0.6in margins
  try {
    box.className = 'mdm';
    box.innerHTML = `<style>${MEASURE_CSS}</style>${safeMd(md || '')}`;
    box.style.display = 'flow-root';
    await document.fonts.ready;
    return Math.round((box.scrollHeight / ((11 - 1.2) * PX_PER_IN)) * 100) / 100;
  } finally {
    box.remove();
  }
}

// Opens the styled resume in a new window and starts the print dialog ("Save as PDF").
export async function printDocx(blob, title, page, fonts) {
  const w = window.open('', '_blank');
  if (!w) throw new Error('Pop-up blocked. Allow pop-ups for this site to save PDFs.');
  const box = offscreen(page.width + 1);
  try {
    await renderAsync(blob, box, box, { ...OPTIONS, renderHeaders: false, renderFooters: false });
    await document.fonts.ready;
    await settleTabs();
    const css = `
      @page { size: ${page.width}in ${page.height}in; margin: ${page.top}in ${page.right}in ${page.bottom}in ${page.left}in; }
      html, body { margin: 0; background: #fff; }
      .docx-wrapper { background: none !important; padding: 0 !important; display: block !important; }
      .docx-wrapper > section.docx { padding: 0 !important; margin: 0 !important; width: auto !important; min-height: 0 !important; box-shadow: none !important; }
      .docx-wrapper > section.docx + section.docx { break-before: page; }
      @media screen { body { background: #e9e9ec; } .docx-wrapper { max-width: ${page.width - page.left - page.right}in; margin: 24px auto !important; background: #fff !important; padding: ${page.top}in ${page.right}in !important; box-sizing: content-box; } }`;
    const links = fontLinks(fonts).map(h => `<link rel="stylesheet" href="${h}">`).join('');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/[<>&"]/g, '')}</title>${links}<style>${css}</style></head><body>${box.innerHTML}</body></html>`);
    w.document.close();
    const go = () => { w.focus(); w.print(); };
    Promise.race([w.document.fonts.ready, new Promise(r => setTimeout(r, 2500))]).then(() => setTimeout(go, 200));
  } finally {
    box.remove();
  }
}
