// Calls each AI provider's HTTP API directly from the browser (all four support CORS).
// Model lists are fetched live, so new models appear automatically.

export const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', needsKey: true },
  openai: { label: 'OpenAI', needsKey: true },
  gemini: { label: 'Google Gemini', needsKey: true },
  openrouter: { label: 'OpenRouter (any model)', needsKey: true },
  ollama: { label: 'Ollama (local)', needsKey: false },
};

const ANTHROPIC_HEADERS = key => ({
  'x-api-key': key,
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true', // required for browser calls; the key is your own
});

function getKey(provider, settings) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown provider: ${provider}`);
  if (!p.needsKey) return null;
  const key = settings.keys?.[provider];
  if (!key && settings.keysLocked) throw new Error('Your API keys are locked. Unlock them in Settings.');
  if (!key) throw new Error(`No API key for ${p.label}. Add it in Settings.`);
  return key;
}

async function http(url, opts = {}) {
  let r;
  try { r = await fetch(url, opts); }
  catch (e) {
    throw new Error(url.includes('localhost')
      ? 'Could not reach Ollama. Is it running, with OLLAMA_ORIGINS set? (see README)'
      : `Network error: ${e.message}`);
  }
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) {
    const msg = data?.error?.message || data?.error || data?.message || text;
    throw new Error(`${r.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`.slice(0, 600));
  }
  return data;
}

export async function listModels(provider, settings) {
  const key = getKey(provider, settings);
  switch (provider) {
    case 'anthropic': {
      const d = await http('https://api.anthropic.com/v1/models?limit=100', { headers: ANTHROPIC_HEADERS(key) });
      return d.data.map(m => m.id);
    }
    case 'openai': {
      const d = await http('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
      return d.data.map(m => m.id)
        .filter(id => /^(gpt|o\d|chatgpt)/.test(id) && !/(audio|realtime|transcribe|tts|image|search)/.test(id))
        .sort().reverse();
    }
    case 'gemini': {
      const d = await http('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
        headers: { 'x-goog-api-key': key },
      });
      return d.models
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => m.name.replace(/^models\//, ''));
    }
    case 'openrouter': {
      const d = await http('https://openrouter.ai/api/v1/models', { headers: { Authorization: `Bearer ${key}` } });
      return d.data.map(m => m.id).sort();
    }
    case 'ollama': {
      const d = await http(`${settings.ollamaUrl || 'http://localhost:11434'}/api/tags`);
      return d.models.map(m => m.name);
    }
  }
}

export async function complete({ provider, model, system, user, settings }) {
  if (!model) throw new Error('No model selected');
  const key = getKey(provider, settings);
  switch (provider) {
    case 'anthropic': {
      const d = await http('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { ...ANTHROPIC_HEADERS(key), 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 8000, system, messages: [{ role: 'user', content: user }] }),
      });
      return d.content.filter(b => b.type === 'text').map(b => b.text).join('');
    }
    case 'openai':
    case 'openrouter': {
      const base = provider === 'openai' ? 'https://api.openai.com/v1' : 'https://openrouter.ai/api/v1';
      const d = await http(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      });
      return d.choices?.[0]?.message?.content || '';
    }
    case 'gemini': {
      const d = await http(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
        }),
      });
      return (d.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    }
    case 'ollama': {
      const d = await http(`${settings.ollamaUrl || 'http://localhost:11434'}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model, stream: false, options: { num_ctx: 16384 },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      });
      return d.message?.content || '';
    }
  }
}

export function providerList(settings) {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id, label: p.label, needsKey: p.needsKey, hasKey: !p.needsKey || !!settings.keys?.[id], locked: p.needsKey && !!settings.keysLocked,
  }));
}
