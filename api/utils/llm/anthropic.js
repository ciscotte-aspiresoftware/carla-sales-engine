// Anthropic (Claude) provider adapter.
//
// Normalized interface (see ./openai.js for the contract).
//
// Claude specifics (per the claude-api guidance):
//   • `system` is a TOP-LEVEL param, not a message — the router already
//     hands it to us separately.
//   • `max_tokens` is REQUIRED.
//   • `temperature` is REMOVED on Opus 4.7/4.8 (sending it 400s), so we never
//     forward it. The classify/email tasks don't need it.
//   • `thinking` is omitted (off) — matches the old non-thinking gpt-4o-mini
//     behavior and keeps JSON output clean.
//   • There is no native JSON-mode. When jsonMode is on we add a hard
//     instruction to the system prompt; the router also defensively extracts
//     the JSON substring from the reply.

const AnthropicMod = require('@anthropic-ai/sdk');
const Anthropic = AnthropicMod.default || AnthropicMod;

const JSON_SUFFIX = '\n\nOutput ONLY the raw JSON value. No prose, no explanation, no markdown code fences.';

let _client = null;
function getClient() {
    if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY missing — set it in the environment to use the Claude provider.');
    }
    if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return _client;
}

async function complete({ system, messages, model, jsonMode = false, maxTokens = 8192 }) {
    // Claude requires user/assistant only in `messages`; system is separate.
    const sys = jsonMode ? `${system || ''}${JSON_SUFFIX}` : (system || undefined);
    const msgs = messages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
    }));

    const resp = await getClient().messages.create({
        model,
        max_tokens: maxTokens,
        ...(sys ? { system: sys } : {}),
        messages: msgs,
        // No temperature (Opus 4.7/4.8 reject it); no thinking (off by default).
    });

    const text = (resp.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');

    return {
        text,
        usage: {
            inputTokens: resp.usage?.input_tokens || 0,
            outputTokens: resp.usage?.output_tokens || 0,
        },
    };
}

function hasKey() {
    return !!process.env.ANTHROPIC_API_KEY;
}

module.exports = { complete, hasKey };
