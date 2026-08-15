import { config } from '../db.js';

/* ===========================================================================
 * AI gateway (§20, blueprint §14).
 *
 * GOVERNING PRINCIPLE: AI is advisory. Nothing here writes a business record.
 * Every caller stores the suggestion in ai_runs and lets a human accept it.
 *
 * Providers, all free-tier capable:
 *   openrouter  — free model lane (default). Set AI_API_KEY.
 *   groq        — very fast, ~1k req/day. Set AI_API_KEY.
 *   ollama      — fully local, zero cost, zero data egress. AI_BASE_URL.
 *   rules       — no LLM at all; every feature falls back to statistics.
 *
 * If a provider is configured but fails, times out, or returns unparseable
 * JSON, the caller receives usedFallback:true and MUST use its statistical
 * path. A warehouse at 5 a.m. cannot wait on someone's rate limit.
 * ======================================================================== */

const ENDPOINTS: Record<string, string> = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  ollama: 'http://localhost:11434/v1/chat/completions',
};

export type LlmResult<T> = {
  ok: boolean;
  data: T | null;
  raw?: string;
  model: string;
  latencyMs: number;
  usedFallback: boolean;
  fallbackReason?: string;
};

export function aiEnabled() {
  return config.ai.provider !== 'rules' &&
    (config.ai.provider === 'ollama' || !!config.ai.apiKey);
}

/**
 * Ask the model for strict JSON. `shape` is a short description of the object
 * we want — kept in the prompt rather than a schema library because free
 * models honour a plain, short instruction far better than a JSON Schema.
 */
export async function askJson<T>(opts: {
  system: string;
  user: string;
  shape: string;
  images?: { mediaType: string; base64: string }[];
  maxTokens?: number;
}): Promise<LlmResult<T>> {
  const started = Date.now();
  const model = opts.images?.length ? config.ai.visionModel : config.ai.model;

  if (!aiEnabled()) {
    return { ok: false, data: null, model: 'rules', latencyMs: 0,
      usedFallback: true, fallbackReason: 'ai_disabled' };
  }

  const url = config.ai.baseUrl || ENDPOINTS[config.ai.provider];
  const content: any[] = [{ type: 'text', text: `${opts.user}\n\nReturn ONLY JSON of this shape, no prose, no markdown fence:\n${opts.shape}` }];
  for (const img of opts.images ?? []) {
    content.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.base64}` } });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(config.ai.apiKey ? { Authorization: `Bearer ${config.ai.apiKey}` } : {}),
        ...(config.ai.provider === 'openrouter'
          ? { 'HTTP-Referer': 'https://chotug.local', 'X-Title': 'ChotuG ERP Purchase' }
          : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: opts.maxTokens ?? 700,
        messages: [
          { role: 'system', content: `${opts.system}\nRespond with valid JSON only.` },
          { role: 'user', content: opts.images?.length ? content : content[0].text },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, data: null, model, latencyMs: Date.now() - started,
        usedFallback: true, fallbackReason: `http_${res.status}:${text.slice(0, 160)}` };
    }

    const json: any = await res.json();
    const raw: string = json?.choices?.[0]?.message?.content ?? '';
    const parsed = extractJson<T>(raw);
    if (!parsed) {
      return { ok: false, data: null, raw, model, latencyMs: Date.now() - started,
        usedFallback: true, fallbackReason: 'unparseable_json' };
    }
    return { ok: true, data: parsed, raw, model, latencyMs: Date.now() - started, usedFallback: false };
  } catch (e: any) {
    return { ok: false, data: null, model, latencyMs: Date.now() - started,
      usedFallback: true, fallbackReason: e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Free models still wrap JSON in prose or fences. Dig it out. */
function extractJson<T>(raw: string): T | null {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.search(/[{[]/);
  if (start === -1) return null;
  const opener = candidate[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(candidate.slice(start, i + 1)) as T; } catch { return null; }
      }
    }
  }
  return null;
}
