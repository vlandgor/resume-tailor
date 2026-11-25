# Resume Tailor

A personal tool that runs entirely in the browser. Keep one base resume, paste a job description, pick an AI model, and get a tailored resume (plus an optional cover letter) **in your own design**, never longer than 2 pages. Download it as DOCX or PDF. Every application is saved in the sidebar.

There is no backend. The page is static and deployed to GitHub Pages by `.github/workflows/pages.yml` on every push to `main`. AI calls go straight from your browser to the provider you pick.

Live: https://vlandgor.github.io/resume-tailor/

## First use

1. **Settings & backup** → paste an API key for at least one provider (Anthropic, OpenAI, Gemini, OpenRouter, or a local Ollama) and pick a default model.
2. **Base resume** → upload your resume **as DOCX** to keep your styling.
   From Google Docs: *File → Download → Microsoft Word (.docx)*.
   PDF/TXT/pasted text also work, but then a built-in plain layout is used.

## How your styling is kept

The DOCX is used as a template. Each non-empty paragraph becomes one line the AI sees:

```
§11 | **Lead Developer — Gata Games (FLOWR)**⇥*2021 – Present*
§12 | Built procedural audio-visual systems in Unity 6…
```

The AI edits text, deletes lines, or repeats a `§id` to add a line (e.g. one more bullet). When the DOCX is rebuilt, every line gets the formatting of the paragraph its id points to: fonts, colors, sizes, spacing, bullets, tab stops. So the result looks like your original.

- `**bold**` / `*italic*` map to the bold/italic formatting used in that paragraph; `⇥` is a tab, `↵` a line break.
- Lines marked `[link]` contain hyperlinks and are never changed.
- Empty spacer paragraphs are always kept.
- Limits: content can't move between sections, and mixed inline formatting beyond bold/italic (e.g. one colored word mid-sentence) falls back to the paragraph's main style when the AI rewrites that line.

You can edit the lines yourself in the left pane; the preview on the right updates.

## The 2-page rule

- The prompt makes it a hard limit.
- After tailoring, the app renders the result and estimates its page count. If it's over the limit, it automatically sends it back to the model to shorten (up to 2 rounds). **Fit to 2 pages** does the same on demand.
- The browser estimate runs a bit short of real Word/Docs layout, so anything above ~1.85 estimated pages counts as too long. Do a quick check of the final PDF.

## Daily use

- **+ New application** → paste the job description → **Tailor resume** (optionally tick *Also write a cover letter*).
- **Download .docx** keeps your design; Word shows your Google Fonts only if they're installed (fonts aren't embedded in DOCX).
- **Save as PDF** opens the print dialog with your styling and the Google Fonts loaded. Choose "Save as PDF". Allow pop-ups for the site.
- **Cover letter** uses a simple built-in layout for now.

## Where data lives

Your resume, style template, applications and API keys live in this browser's localStorage. They are never in the repo.
- A different browser or computer starts empty. Use **Settings → Backup** to export and import (keys aren't included).
- Clearing site data deletes everything, so export a backup now and then.
- localStorage is shared by every page on `vlandgor.github.io`, so keep that in mind if you publish other Pages sites.

## Ollama (optional, local models)

```bash
OLLAMA_ORIGINS="https://vlandgor.github.io" ollama serve
```
On Windows, set `OLLAMA_ORIGINS` as a user environment variable and restart Ollama. Chrome and Edge allow an https page to call `http://localhost`; Safari doesn't.

## Develop locally

```bash
npm install
npm run dev     # http://localhost:5173, rebuilds on save (refresh the page)
npm run build   # production build into dist/
```

- `src/prompts.js`: AI instructions (truthfulness, 2-page limit, line format)
- `src/docxTemplate.js`: DOCX → lines and lines → DOCX (style preservation)
- `src/preview.js`: DOCX preview, page estimate, print-to-PDF
- `src/files.js`: PDF/DOCX text extraction, built-in layout for plain-text mode
- `src/app.js`, `src/styles.css`: UI
