// All Markdown we render (AI output, pasted text) goes through DOMPurify so it can't inject scripts.
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export const safeMd = md => DOMPurify.sanitize(marked.parse(md || ''));
