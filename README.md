# Resume Tailor

A personal tool that runs in the browser, with accounts. Keep one base resume, paste a job description, pick an AI model, and get a tailored resume (plus an optional cover letter) **in your own design**, never longer than 2 pages. Download it as DOCX or PDF. Every application is saved in the sidebar.

The page is static and deployed to GitHub Pages by `.github/workflows/pages.yml` on every push to `main`. Accounts and data live in [Supabase](https://supabase.com) (Postgres + Auth). AI calls go straight from your browser to the provider you pick.

Live: https://vlandgor.github.io/resume-tailor/

## Accounts setup (one time)

1. **Create a Supabase project** at supabase.com (free tier is plenty).
2. **Create the tables**: *SQL Editor → New query*, paste [`supabase/schema.sql`](supabase/schema.sql), *Run*. It creates `user_state`, `applications` and `templates`, turns on row-level security (each user can only touch their own rows) and grants access to signed-in users only.
3. **Sign-in settings** (*Authentication*):
   - *URL Configuration*: **Site URL** = `https://vlandgor.github.io/resume-tailor/`. Under **Redirect URLs** add `https://vlandgor.github.io/resume-tailor/**` and `http://localhost:5173/**`. Google sign-in, email confirmation and password-reset links only return to these addresses.
   - *Sign In / Providers*: keep **Email** on with **Confirm email** on. "Allow new users to sign up" controls whether anyone can create an account (turn it off to make the app invite-only again; you can still add people under *Users → Add user*).
4. **Google sign-in** (optional):
   - In [Google Cloud Console](https://console.cloud.google.com/) create a project, set up the **OAuth consent screen** (External, app name, your email), then *APIs & Services → Credentials → Create credentials → OAuth client ID → Web application*.
   - **Authorized JavaScript origins**: `https://vlandgor.github.io`. **Authorized redirect URIs**: the callback URL shown in Supabase under *Sign In / Providers → Google* (looks like `https://<project-ref>.supabase.co/auth/v1/callback`).
   - Paste the Google **Client ID** and **Client secret** into that Supabase Google provider and enable it.
   - While the consent screen is in *Testing*, only the Google accounts listed as test users can sign in; *Publish app* to open it to anyone.
5. **Email for other people**: Supabase's built-in email sender only delivers to members of your Supabase team, and only a couple of messages per hour. Before letting others sign up with email (confirmation and password-reset mails), connect a mail provider under *Project Settings → Authentication → SMTP Settings* (e.g. Resend, Brevo). Google sign-in doesn't need email at all.
6. **Connect the site**: copy the **Project URL** and the **publishable key** (*Project Settings → API Keys*; on older projects, the `anon` key works too). In GitHub: *repo → Settings → Secrets and variables → Actions → Variables*, add `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. Re-run the Pages workflow (or push).
   For local dev, copy `.env.example` to `.env` and fill in the same two values.

Both values are public by design (they end up in the page). What protects the data is sign-in plus row-level security. Never put the **secret** / `service_role` key anywhere in this repo.

Forgotten password: *Forgot password?* on the sign-in screen emails a reset link (needs step 5 for anyone outside your Supabase team). You can also set a password in *Authentication → Users*.

## First use

1. **Sign in** with Google, or create an account with email + password. If this browser has data from before accounts, the app offers to **import it into your account** (it's removed from the browser once it's safely saved).
2. **Settings & account** → paste an API key for at least one provider (Anthropic, OpenAI, Gemini, OpenRouter, or a local Ollama), choose a **key passphrase**, and pick a default model.
3. **Base resume** → upload your resume **as DOCX** to keep your styling.
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

- **Your account (Supabase)**: settings, base resume, DOCX style templates and applications. Same data on every computer you sign in on. Each user sees only their own.
- **API keys** are encrypted in your browser (AES-256-GCM, key derived from your passphrase with PBKDF2-SHA256, 600k rounds) and only the encrypted blob is saved. Without the passphrase nobody can read them, including whoever runs the database. On a new device you enter the passphrase once; *Remember on this device* keeps the unlocked key in that browser (as a non-extractable key) until you sign out or press *Lock now*. Forgot the passphrase? *Reset keys* and paste them again.
- **This browser only**: the last model you picked and the preview mode.
- Changes save in the background; the sidebar shows *Saving… / All changes saved*. If you're offline it keeps retrying, and the browser warns you before closing with unsaved changes.
- **Settings → Backup** still exports everything (except keys) to a JSON file.

## Ollama (optional, local models)

```bash
OLLAMA_ORIGINS="https://vlandgor.github.io" ollama serve
```
On Windows, set `OLLAMA_ORIGINS` as a user environment variable and restart Ollama. Chrome and Edge allow an https page to call `http://localhost`; Safari doesn't.

## Develop locally

```bash
npm install
cp .env.example .env   # then fill in your Supabase URL + publishable key
npm run dev     # http://localhost:5173, rebuilds on save (refresh the page)
npm run build   # production build into dist/
```

- `src/prompts.js`: AI instructions (truthfulness, 2-page limit, line format)
- `src/docxTemplate.js`: DOCX → lines and lines → DOCX (style preservation)
- `src/preview.js`: DOCX preview, page estimate, print-to-PDF
- `src/files.js`: PDF/DOCX text extraction, built-in layout for plain-text mode
- `src/store.js`: data layer (loads your account into memory, saves changes in the background)
- `src/vault.js`: API-key encryption
- `src/supabase.js`, `supabase/schema.sql`: database client and schema
- `src/app.js`, `src/styles.css`: UI
