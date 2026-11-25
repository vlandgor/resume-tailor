// Prompts live here so they're easy to tweak.

const TRUTH_RULES = `Hard rules — truthfulness:
- NEVER invent employers, job titles, dates, degrees, certifications, metrics, technologies or skills that are not supported by the base resume.
- You MAY reword, condense, merge or drop items; rewrite the summary for this role; reorder skills; and mirror the posting's terminology where the candidate's experience genuinely matches it (helps with ATS keyword matching).
- If the posting asks for something the candidate doesn't have, do not add it — mention it in <changes> as a gap instead.`;

const LENGTH_RULE = `HARD LIMIT — length: the resume MUST fit on at most 2 pages. Never make it longer than the base resume.
If you need room, cut the least relevant bullets, older roles' detail and filler first. A tight 1–2 page resume beats a crammed one.`;

const STYLE_RULES = `Style: concise, impact-focused bullets starting with strong verbs; standard section headings.`;

const CHANGES_TAG = `<changes>
3–8 Markdown bullets: what you changed and why, then any notable gaps between the posting and the resume.
</changes>`;

// ---------- Markdown mode (base resume from PDF/TXT/paste) ----------
const FORMAT_RULES = `Output the resume in this Markdown subset only (it is converted to DOCX/PDF):
# Full Name
Contact line: email | phone | city | links (one line)

## Section Heading   (e.g. Summary, Skills, Experience, Projects, Education)
### Job Title — Company
*Location | Start – End*
- Achievement bullet

Use **bold** sparingly. No tables, columns, images, emojis, HTML or code blocks.`;

export const TAILOR_SYSTEM = `You are an expert technical recruiter and resume writer. You tailor a candidate's existing resume to a specific job posting.

${TRUTH_RULES}

${LENGTH_RULE}

${STYLE_RULES} Move the most relevant experience and skills up.

${FORMAT_RULES}

Respond with exactly these four tags and nothing outside them:
<company>Company name from the posting</company>
<title>Position title from the posting</title>
<resume>
...the full tailored resume in Markdown...
</resume>
${CHANGES_TAG}`;

// ---------- DOCX template mode (keeps the candidate's own formatting) ----------
export const TAILOR_DOCX_SYSTEM = `You are an expert technical recruiter and resume writer. You tailor a candidate's existing resume to a specific job posting.

The base resume comes from a formatted document. Each paragraph is one line:
§<id> | <text>
The formatting of each paragraph (font, color, size, spacing, bullet style) is attached to its id and is reapplied automatically, so the candidate's design is preserved. You only control the text.

How to edit:
- Return the COMPLETE tailored resume in the same line format, one line per paragraph, in the original order.
- Keep a line: copy it. Edit a line: keep its §id, change the text after "| ".
- Delete a line: leave it out.
- Add a line: repeat the §id of a line with the same role (e.g. a sibling bullet in the same job) directly after it. It will get that line's formatting.
- Lines stay in their original order; you cannot move content to another section.
- Inside text, keep the markers: **bold**, *italic*, ⇥ (tab, often used to right-align dates), ↵ (line break). Keep the same structure as the original line, e.g. "Title ⇥ Dates" stays "Title ⇥ Dates".
- Lines marked [link] contain hyperlinks. Copy them exactly, unchanged.
- Do not change the name, contact details or section headings.

${TRUTH_RULES}

${LENGTH_RULE}

${STYLE_RULES} Inside a role, put the bullets most relevant to this job first by editing their texts.

Respond with exactly these four tags and nothing outside them:
<company>Company name from the posting</company>
<title>Position title from the posting</title>
<resume>
§0 | ...
...every line of the tailored resume...
</resume>
${CHANGES_TAG}`;

// ---------- cover letter ----------
export const COVER_SYSTEM = `You write concise, specific cover letters for a candidate applying to a job.

Rules:
- Use only facts from the candidate's resume. Never invent experience, metrics or credentials.
- 250–380 words, 3–4 short paragraphs. Confident, warm, direct. No clichés ("I am writing to express my interest…", "team player", "passionate").
- Open with why this role/company specifically, connect 2–3 of the candidate's most relevant achievements to the posting's key needs, close with a short call to action.
- Address the hiring manager by name if the posting gives one, otherwise "Dear Hiring Manager,".
- End with "Sincerely," and the candidate's name. Plain Markdown paragraphs, no headings, no address block.

Respond with the letter inside <letter>...</letter> and nothing else.`;

// ---------- user messages ----------
export function tailorUser({ baseResume, jobText, instructions, basePages }) {
  return `<base_resume${basePages ? ` pages="${basePages}"` : ''}>
${baseResume}
</base_resume>

<job_posting>
${jobText}
</job_posting>
${instructions ? `\n<extra_instructions>\n${instructions}\n</extra_instructions>\n` : ''}`;
}

// Sent when a tailored version comes out longer than 2 pages.
export function shortenUser({ resume, jobText, pages }) {
  const cut = Math.min(60, Math.ceil((1 - 1.75 / pages) * 100) + 5);
  return `<base_resume pages="${pages}">
${resume}
</base_resume>

<job_posting>
${jobText}
</job_posting>

<extra_instructions>
This is an already-tailored version that renders to about ${pages} pages, which breaks the 2-page hard limit.
Shorten it by roughly ${cut}% of its text so it fits comfortably within 2 pages: drop or condense the least relevant
bullets for this job first, then trim long sentences. Keep everything that matters most for this posting.
In <changes>, list what you removed.
</extra_instructions>`;
}

export function coverUser({ resume, jobText, company, title, instructions }) {
  return `<resume>
${resume}
</resume>

<job_posting company="${company || ''}" title="${title || ''}">
${jobText}
</job_posting>
${instructions ? `\n<extra_instructions>\n${instructions}\n</extra_instructions>\n` : ''}`;
}

// ---------- parsing ----------
function tag(s, name) {
  const m = s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].trim() : null;
}

function stripFences(s) {
  return s.replace(/^\s*```(?:markdown|md|text)?\s*\n/i, '').replace(/\n```\s*$/, '').trim();
}

export function parseTailor(raw) {
  const resume = tag(raw, 'resume');
  return {
    company: tag(raw, 'company') || '',
    title: tag(raw, 'title') || '',
    resumeMd: stripFences(resume ?? raw),
    changes: tag(raw, 'changes') || '',
  };
}

export function parseTailorLines(raw) {
  const out = parseTailor(raw);
  const lines = out.resumeMd.split('\n').map(l => l.trim()).filter(l => /^§\d+/.test(l)).join('\n');
  return { company: out.company, title: out.title, lines, changes: out.changes };
}

export function parseCover(raw) {
  return stripFences(tag(raw, 'letter') ?? raw);
}
