// LLM router — the single chokepoint every AI call in Atlas goes through.
//
// Keeps the historical `chat(messages, opts)` signature so call sites barely
// change, but now routes to a per-task provider+model chosen in Admin →
// AI models (utils/settings.js). Providers live in ./openai, ./anthropic,
// ./gemini and all expose the same normalized `complete()` contract.
//
//   chat(messages, {
//     task,            // 'classify' | 'email' | 'report' | 'icpAutomation'
//                      //   → resolves {provider, model} from settings.getAi()
//     provider, model, // explicit override (skips task resolution)
//     response_format, // { type: 'json_object' } → jsonMode
//     temperature,     // forwarded to providers that accept it (not Claude)
//     maxTokens,       // default 8192
//     operation,       // cost-ledger tag
//   }) -> string
//
// messages are OpenAI-style [{role:'system'|'user'|'assistant', content}].
// The router pulls system turns out and hands them to the adapter separately
// (Claude/Gemini want system as a top-level field).

const settings = require('../settings');
const { recordLLM } = require('../api-cost');

const ADAPTERS = {
    openai: require('./openai'),
    anthropic: require('./anthropic'),
    gemini: require('./gemini'),
};

const DEFAULT_MODEL = 'claude-opus-4-8';
const DEFAULT_PROVIDER = 'anthropic';

// Back-compat: infer a provider from a bare model id (for any stray caller
// still passing a raw `model` string instead of a `task`).
function inferProvider(model) {
    const m = String(model || '').toLowerCase();
    if (m.startsWith('claude')) return 'anthropic';
    if (m.startsWith('gemini')) return 'gemini';
    if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return 'openai';
    return DEFAULT_PROVIDER;
}

function resolveTarget(opts) {
    if (opts.provider && opts.model) return { provider: opts.provider, model: opts.model };
    if (opts.task) {
        const ai = settings.getAi();
        const t = ai && ai[opts.task];
        if (t && t.provider && t.model) return { provider: t.provider, model: t.model };
    }
    if (opts.model) return { provider: inferProvider(opts.model), model: opts.model };
    return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
}

// Defensive JSON extraction. OpenAI json_object + Gemini responseMimeType
// already return clean JSON; Claude (prompt-instructed) usually does too but
// can wrap in fences or add a stray sentence. Idempotent on clean JSON.
function extractJson(text) {
    let t = String(text || '').trim();
    const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fence) t = fence[1].trim();
    if (t.startsWith('{') || t.startsWith('[')) return t;
    const firstObj = t.indexOf('{');
    const firstArr = t.indexOf('[');
    let start = -1;
    if (firstObj === -1) start = firstArr;
    else if (firstArr === -1) start = firstObj;
    else start = Math.min(firstObj, firstArr);
    if (start >= 0) {
        const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
        if (end > start) return t.slice(start, end + 1);
    }
    return t;
}

/**
 * Send a chat completion through the resolved provider. Returns the text
 * content as a string (JSON-extracted when response_format requests JSON).
 * Throws on auth/credit failures so the route handler surfaces a clear error.
 */
async function chat(messages, opts = {}) {
    const { provider, model } = resolveTarget(opts);
    const adapter = ADAPTERS[provider];
    if (!adapter) throw new Error(`Unknown AI provider: ${provider}`);

    const systemParts = [];
    const convo = [];
    for (const m of messages || []) {
        if (m.role === 'system') systemParts.push(m.content);
        else convo.push(m);
    }
    const system = systemParts.join('\n\n');
    const jsonMode = !!opts.response_format;

    const startedAt = Date.now();
    const result = await adapter.complete({
        system,
        messages: convo,
        model,
        jsonMode,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens || 8192,
    });
    const durationMs = Date.now() - startedAt;

    // Fire-and-forget usage logging (never throws / blocks).
    recordLLM({
        provider,
        model,
        usage: result.usage,
        operation: opts.operation || opts.task || null,
        durationMs,
    });

    return jsonMode ? extractJson(result.text) : result.text;
}

module.exports = { chat, DEFAULT_MODEL, DEFAULT_PROVIDER };
