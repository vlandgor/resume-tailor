# Resume Tailor

A personal tool that runs entirely in the browser. Keep one base resume, paste a job description, pick an AI model, and get a tailored resume (plus an optional cover letter). Edit the result, then download it as DOCX or PDF. Every application is saved in the sidebar.

There is no backend. The page is static and deployed to GitHub Pages by `.github/workflows/pages.yml` on every push to `main`. AI calls go straight from your browser to the provider you pick.

## One-time GitHub setup

Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
After that, every push to `main` builds and deploys. The link is shown under **Actions → latest run → deploy**, and is usually `https://<user>.github.io/resume-tailor/`.

## First use

1. **Settings & backup** → paste an API key for at least one provider:
   - Anthropic: https://console.anthropic.com → API keys
   - OpenAI: https://platform.openai.com/api-keys
   - Google Gemini: https://aistudio.google.com/apikey
   - OpenRouter (one key, many models): https://openrouter.ai/keys
   - Ollama (free, local models): see below
   Then choose a default model. The list comes live from the provider, and you can also type any model ID.
2. **Base resume** → upload your PDF/DOCX (or paste text) and check that the extracted text looks right.

## Daily use

- **+ New application** → paste the job description (the link is optional, kept for reference) → **Tailor resume**.
- **Resume** tab: edit the Markdown on the left and see the preview on the right. Edits save automatically. *What was changed* lists the AI's edits and the gaps it found.
- **Download .docx**, or **Save as PDF**, which opens the print dialog. Choose "Save as PDF" there. Allow pop-ups for the site.
- **Cover letter** tab: generate or rewrite one. **Job posting** tab: description, link and notes.

## Where data lives

Your resume, applications and API keys live in this browser's localStorage. They are never in the repo and never on GitHub.
- A different browser or computer starts empty. Use **Settings → Backup** to export and import (keys aren't included).
- Clearing site data for the page deletes everything, so export a backup now and then.
- localStorage is shared by every page on `<user>.github.io`, so any other Pages site you publish there could read it. Fine if they're all your own projects.

## Ollama (optional, local models)

Ollama has to allow requests from the Pages site. Start it with:
```bash
OLLAMA_ORIGINS="https://<user>.github.io" ollama serve
```
On Windows, set `OLLAMA_ORIGINS` as a user environment variable and restart Ollama. Chrome and Edge allow an https page to call `http://localhost`; Safari doesn't.

## Develop locally

```bash
npm install
npm run dev     # http://localhost:5173, rebuilds on save (refresh the page)
npm run build   # production build into dist/
```

- AI instructions (truthfulness rules, tone, length): `src/prompts.js`
- DOCX layout and PDF print styles: `src/files.js`
- UI: `src/app.js`, `src/styles.css`
