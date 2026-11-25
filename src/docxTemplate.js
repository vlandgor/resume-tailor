// Style-preserving tailoring for a DOCX resume (e.g. exported from Google Docs).
//
// Every non-empty paragraph becomes one line:  §<id> | text
// The AI edits the text, deletes lines, or repeats an id to add a similar line.
// When the DOCX is rebuilt, each line keeps the formatting of the paragraph its id
// points to (paragraph style, spacing, bullets, colors, fonts), so the original look is kept.
//
// Markers inside the text: **bold**, *italic*, ⇥ tab, ↵ line break.
// Lines marked [link] contain hyperlinks and are always kept as they are.
import JSZip from 'jszip';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const LINE_RE = /^§(\d+)(?:\s*\[link\])?\s*\|\s?(.*)$/;

// ---------- base64 (templates are stored in localStorage) ----------
export function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- XML helpers ----------
const isW = (n, name) => n && n.namespaceURI === W && n.localName === name;
const kids = (el, name) => (el ? Array.from(el.childNodes).filter(n => isW(n, name)) : []);
const rPrOf = r => kids(r, 'rPr')[0] || null;
const isOn = (rPr, name) => {
  const e = kids(rPr, name)[0];
  if (!e) return false;
  const v = e.getAttributeNS(W, 'val');
  return !(v === '0' || v === 'false' || v === 'none');
};

function ownerP(node) {
  let n = node.parentNode;
  while (n && !isW(n, 'p')) n = n.parentNode;
  return n;
}
const runsOf = p => Array.from(p.getElementsByTagNameNS(W, 'r')).filter(r => ownerP(r) === p);

function runText(r) {
  let t = '';
  for (const c of r.childNodes) {
    if (isW(c, 't')) t += c.textContent;
    else if (isW(c, 'tab')) t += '⇥';
    else if (isW(c, 'br') || isW(c, 'cr')) t += '↵';
  }
  return t;
}

function paraInfo(p) {
  const textRuns = runsOf(p).filter(r => runText(r));
  const allBold = textRuns.length > 0 && textRuns.every(r => isOn(rPrOf(r), 'b'));
  const allItal = textRuns.length > 0 && textRuns.every(r => isOn(rPrOf(r), 'i'));
  let text = '';
  for (const r of textRuns) {
    let t = runText(r);
    const rp = rPrOf(r);
    if (!allBold && isOn(rp, 'b') && t.trim()) t = `**${t}**`;
    else if (!allItal && isOn(rp, 'i') && t.trim()) t = `*${t}*`;
    text += t;
  }
  text = text.replace(/\*\*\*\*/g, ''); // merge neighbouring bold runs
  const instr = Array.from(p.getElementsByTagNameNS(W, 'instrText')).map(e => e.textContent).join(' ');
  const hasLink = p.getElementsByTagNameNS(W, 'hyperlink').length > 0 || /HYPERLINK/.test(instr);
  return { text, hasLink };
}

async function loadDoc(buf) {
  const zip = await JSZip.loadAsync(buf);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('Not a valid DOCX file');
  const doc = new DOMParser().parseFromString(await file.async('string'), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Could not read the DOCX contents');
  return { zip, doc };
}

// ---------- parse ----------
export function linesToPlain(lines) {
  return lines.split('\n')
    .map(l => l.match(LINE_RE)?.[2])
    .filter(t => t != null)
    .map(t => t.replace(/\*\*?/g, '').replace(/⇥/g, '   ').replace(/↵/g, '\n'))
    .join('\n');
}

export async function parseTemplate(buf) {
  const { zip, doc } = await loadDoc(buf);
  const ps = Array.from(doc.getElementsByTagNameNS(W, 'p'));
  const lines = [];
  ps.forEach((p, i) => {
    const { text, hasLink } = paraInfo(p);
    if (text.trim()) lines.push(`§${i}${hasLink ? ' [link]' : ''} | ${text}`);
  });
  if (!lines.length) throw new Error('No text found in this DOCX');

  // Page size & margins (twips -> inches) from the last section
  const sect = Array.from(doc.getElementsByTagNameNS(W, 'sectPr')).pop();
  const pgSz = sect && kids(sect, 'pgSz')[0];
  const pgMar = sect && kids(sect, 'pgMar')[0];
  const tw = (el, attr, def) => (el && el.getAttributeNS(W, attr) ? +el.getAttributeNS(W, attr) / 1440 : def);
  const page = {
    width: tw(pgSz, 'w', 8.5), height: tw(pgSz, 'h', 11),
    top: tw(pgMar, 'top', 1), bottom: tw(pgMar, 'bottom', 1),
    left: tw(pgMar, 'left', 1), right: tw(pgMar, 'right', 1),
  };

  // Fonts used (so the preview can load them from Google Fonts)
  const fonts = new Set();
  const collect = d => Array.from(d.getElementsByTagNameNS(W, 'rFonts')).forEach(f => {
    const a = f.getAttributeNS(W, 'ascii');
    if (a) fonts.add(a);
  });
  collect(doc);
  const styles = zip.file('word/styles.xml');
  if (styles) collect(new DOMParser().parseFromString(await styles.async('string'), 'application/xml'));

  const linesText = lines.join('\n');
  return { lines: linesText, text: linesToPlain(linesText), page, fonts: [...fonts] };
}

// ---------- rebuild ----------
const RPR_ORDER = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs'];
function setOn(doc, rPr, name, on) {
  const existing = kids(rPr, name)[0];
  if (!on) { if (existing) rPr.removeChild(existing); return; }
  if (existing) { existing.removeAttributeNS(W, 'val'); return; }
  const el = doc.createElementNS(W, `w:${name}`);
  const idx = RPR_ORDER.indexOf(name);
  const before = Array.from(rPr.childNodes).find(c => {
    const j = RPR_ORDER.indexOf(c.localName);
    return j === -1 || j > idx;
  });
  rPr.insertBefore(el, before || null); // schema order matters to Word
}

function segments(text) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    const t = m[0];
    out.push(t.startsWith('**') ? { text: t.slice(2, -2), b: true } : { text: t.slice(1, -1), i: true });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

function makeRun(doc, rPr, text) {
  const r = doc.createElementNS(W, 'w:r');
  if (rPr) r.appendChild(rPr);
  text.split(/(⇥|↵)/).forEach(part => {
    if (!part) return;
    if (part === '⇥') r.appendChild(doc.createElementNS(W, 'w:tab'));
    else if (part === '↵') r.appendChild(doc.createElementNS(W, 'w:br'));
    else {
      const t = doc.createElementNS(W, 'w:t');
      t.setAttributeNS(XML_NS, 'xml:space', 'preserve');
      t.textContent = part;
      r.appendChild(t);
    }
  });
  return r;
}

// Replace p's content with `text`, borrowing run formatting from the pristine copy `src`.
function rewrite(doc, p, text, src) {
  const runs = runsOf(src).filter(r => runText(r).trim());
  const find = pred => runs.find(r => pred(rPrOf(r)));
  const base = find(rp => !isOn(rp, 'b') && !isOn(rp, 'i')) || runs[0];
  const bold = find(rp => isOn(rp, 'b'));
  const ital = find(rp => isOn(rp, 'i'));

  for (const c of Array.from(p.childNodes)) if (!isW(c, 'pPr')) p.removeChild(c);

  for (const seg of segments(text)) {
    const tmpl = seg.b ? (bold || base) : seg.i ? (ital || base) : base;
    let rPr = tmpl && rPrOf(tmpl) ? rPrOf(tmpl).cloneNode(true) : null;
    if (seg.b && !bold) { rPr = rPr || doc.createElementNS(W, 'w:rPr'); setOn(doc, rPr, 'b', true); }
    if (seg.i && !ital) { rPr = rPr || doc.createElementNS(W, 'w:rPr'); setOn(doc, rPr, 'i', true); }
    p.appendChild(makeRun(doc, rPr, seg.text));
  }
}

function removePara(p) {
  const parent = p.parentNode;
  const keepShell = kids(kids(p, 'pPr')[0], 'sectPr').length > 0 // holds section settings
    || (isW(parent, 'tc') && kids(parent, 'p').length === 1);    // a table cell needs one paragraph
  if (keepShell) { for (const c of Array.from(p.childNodes)) if (!isW(c, 'pPr')) p.removeChild(c); }
  else parent.removeChild(p);
}

export function parseLines(linesText) {
  const map = new Map();
  for (const line of String(linesText).split('\n')) {
    const m = line.trim().match(LINE_RE);
    if (!m) continue;
    const id = +m[1];
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(m[2]);
  }
  return map;
}

export async function buildDocx(templateB64, linesText) {
  const { zip, doc } = await loadDoc(fromB64(templateB64));
  const map = parseLines(linesText);
  const ps = Array.from(doc.getElementsByTagNameNS(W, 'p'));

  ps.forEach((p, i) => {
    const orig = paraInfo(p);
    if (!orig.text.trim()) return; // empty spacer paragraphs always stay
    const entries = map.get(i);
    if (!entries) { removePara(p); return; }

    const pristine = p.cloneNode(true);
    let anchor = p;
    entries.forEach((text, k) => {
      const unchanged = orig.hasLink || text.trim() === orig.text.trim();
      if (k === 0) {
        if (!unchanged) rewrite(doc, p, text, pristine);
        return;
      }
      const node = pristine.cloneNode(true);
      kids(kids(node, 'pPr')[0], 'sectPr').forEach(s => s.parentNode.removeChild(s)); // never duplicate section settings
      if (!unchanged) rewrite(doc, node, text, pristine);
      anchor.parentNode.insertBefore(node, anchor.nextSibling);
      anchor = node;
    });
  });

  zip.file('word/document.xml', new XMLSerializer().serializeToString(doc));
  return zip.generateAsync({ type: 'blob', mimeType: DOCX_MIME });
}

// Lines with hyperlinks are never changed in the DOCX; make the stored text match so the editor shows the truth.
export function protectLinks(newLines, refLines) {
  const linked = new Map();
  for (const l of String(refLines).split('\n')) {
    const m = l.match(/^§(\d+)\s*\[link\]/);
    if (m) linked.set(m[1], l);
  }
  return String(newLines).split('\n').map(l => {
    const id = l.match(/^§(\d+)/)?.[1];
    return id && linked.has(id) ? linked.get(id) : l;
  }).join('\n');
}
