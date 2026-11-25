// File in: resume text extraction (PDF/DOCX/TXT). File out: DOCX download and print-to-PDF.
import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';
import { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle } from 'docx';
import { marked } from 'marked';
import { linesToPlain } from './docxTemplate.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;

// ---------- extraction ----------
async function pdfText(buffer) {
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    pages.push(content.items.map(it => (it.str || '') + (it.hasEOL ? '\n' : '')).join(''));
  }
  return pages.join('\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function extractResumeText(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const buffer = await file.arrayBuffer();
  if (ext === 'pdf') return pdfText(buffer);
  if (ext === 'docx') return (await mammoth.extractRawText({ arrayBuffer: buffer })).value.trim();
  if (['txt', 'md', 'markdown'].includes(ext)) return new TextDecoder().decode(buffer).trim();
  throw new Error('Unsupported file type. Use PDF, DOCX, TXT or MD.');
}

// ---------- Markdown -> DOCX ----------
function clean(text) {
  return text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/<(https?:[^>]+|[^>\s]+@[^>\s]+)>/g, '$1')
    .replace(/\\([\\`*_{}\[\]()#+\-.!|&])/g, '$1')
    .replace(/&amp;/g, '&');
}

function runs(text, base = {}) {
  text = clean(text);
  const out = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(new TextRun({ text: text.slice(last, m.index), ...base }));
    const t = m[0];
    if (t.startsWith('**')) out.push(new TextRun({ text: t.slice(2, -2), ...base, bold: true }));
    else out.push(new TextRun({ text: t.slice(1, -1), ...base, italics: true }));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), ...base }));
  return out;
}

function multiline(text, base) {
  const kids = [];
  text.split('\n').forEach((line, i) => {
    if (i > 0) kids.push(new TextRun({ text: '', break: 1 }));
    kids.push(...runs(line, base));
  });
  return kids;
}

function mdToDocx(md) {
  const children = [];
  let prev = null;
  for (const t of marked.lexer(md || '')) {
    if (t.type === 'space') continue;
    if (t.type === 'heading') {
      if (t.depth === 1) {
        children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 }, children: runs(t.text, { bold: true, size: 36 }) }));
      } else if (t.depth === 2) {
        children.push(new Paragraph({
          spacing: { before: 220, after: 80 }, keepNext: true,
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 1 } },
          children: runs(t.text.toUpperCase(), { bold: true, size: 23 }),
        }));
      } else {
        children.push(new Paragraph({ spacing: { before: 140 }, keepNext: true, children: runs(t.text, { bold: true, size: 22 }) }));
      }
    } else if (['paragraph', 'text', 'blockquote', 'code'].includes(t.type)) {
      const center = prev?.type === 'heading' && prev.depth === 1;
      children.push(new Paragraph({
        alignment: center ? AlignmentType.CENTER : AlignmentType.LEFT,
        spacing: { after: center ? 60 : 100 },
        children: multiline(t.text, center ? { color: '444444' } : {}),
      }));
    } else if (t.type === 'list') {
      for (const item of t.items) {
        children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 30 }, children: runs(item.text.replace(/\s*\n\s*/g, ' ')) }));
      }
    }
    prev = t;
  }
  return new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 21 } } } },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 864, bottom: 864, left: 936, right: 936 } } },
      children,
    }],
  });
}

export function fileBase(app, kind) {
  const name = (app.mode === 'docx'
    ? linesToPlain(app.lines || '').split('\n').find(l => l.trim())
    : app.resumeMd.match(/^#\s+(.+)$/m)?.[1]) || 'Resume';
  const part = kind === 'cover' ? 'Cover Letter' : 'Resume';
  return [name.trim(), part, app.company].filter(Boolean).join(' - ').replace(/[\\/:*?"<>|]+/g, '').slice(0, 120);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadDocx(app, kind) {
  const md = kind === 'cover' ? app.coverMd : app.resumeMd;
  downloadBlob(await Packer.toBlob(mdToDocx(md)), `${fileBase(app, kind)}.docx`);
}

// ---------- print to PDF ----------
export const PRINT_CSS = `
@page { size: letter; margin: 0.6in; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Calibri, Carlito, "Segoe UI", Arial, sans-serif; font-size: 10.5pt; line-height: 1.35; color: #111; }
h1 { text-align: center; font-size: 19pt; margin: 0; }
h1 + p { text-align: center; margin: 2pt 0 6pt; color: #444; }
h2 { font-size: 11.5pt; text-transform: uppercase; letter-spacing: .04em; border-bottom: 1px solid #999; padding-bottom: 2pt; margin: 11pt 0 4pt; }
h3 { font-size: 11pt; margin: 8pt 0 0; }
h3 + p { margin: 0 0 2pt; color: #444; }
p { margin: 4pt 0 6pt; }
ul { margin: 2pt 0 4pt; padding-left: 16pt; }
li { margin: 1.5pt 0; }
a { color: inherit; text-decoration: none; }
h2, h3 { break-after: avoid; } li { break-inside: avoid; }
@media screen {
  body { background: #e9e9ec; }
  .page { background: #fff; width: 8.5in; min-height: 11in; margin: 24px auto; padding: 0.6in; box-shadow: 0 2px 12px rgba(0,0,0,.15); }
}`;

export function printPdf(app, kind) {
  const md = kind === 'cover' ? app.coverMd : app.resumeMd;
  const title = fileBase(app, kind).replace(/[<>&"]/g, '');
  const w = window.open('', '_blank');
  if (!w) throw new Error('Pop-up blocked. Allow pop-ups for this site to save PDFs.');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${PRINT_CSS}</style></head>
<body><div class="page">${marked.parse(md || '')}</div></body></html>`);
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 400);
}
