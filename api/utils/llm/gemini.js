// Google Gemini provider adapter.
//
// Normalized interface (see ./openai.js for the contract).
//
// Gemini specifics (@google/genai SDK):
//   • `systemInstruction` is a config field, not a message.
//   • `contents` uses roles 'user' | 'model' (NOT 'assistant') — we map.
//   • Native JSON mode via `responseMimeType: 'application/json'`.
//   • `temperature` + `maxOutputTokens` supported.
//   • usageMetadata: { promptTokenCount, candidatesTokenCount }.
//
// NOTE: the user has no Gemini key yet. Model IDs in the catalog
// (utils/settings.js PROVIDERS.gemini.models) are best-effort defaults —
// verify against the current Gemini model list when a key is added. Because
// model selection is free-text in the admin UI, a stale catalog entry is not
// load-bearing: the operator can type the correct ID.

const { GoogleGenAI } = require('@google/genai');

let _client = null;
function getClient() {
    if (!process.env.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY missing — set it in the environment to use the Gemini provider.');
    }
    if (!_client) _client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    return _client;
}

async function complete({ system, messages, model, jsonMode = false, temperature, maxTokens = 8192 }) {
    const contents = messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
    }));

    const config = { maxOutputTokens: maxTokens };
    if (system) config.systemInstruction = system;
    if (typeof temperature === 'number') config.temperature = temperature;
    if (jsonMode) config.responseMimeType = 'application/json';

    const resp = await getClient().models.generateContent({ model, contents, config });

    // resp.text is a convenience getter that concatenates text parts.
    const text = typeof resp.text === 'string' ? resp.text : (resp.text?.() || '');
    const um = resp.usageMetadata || {};
    return {
        text,
        usage: {
            inputTokens: um.promptTokenCount || 0,
            outputTokens: um.candidatesTokenCount || 0,
        },
    };
}

function hasKey() {
    return !!process.env.GEMINI_API_KEY;
}

module.exports = { complete, hasKey };
