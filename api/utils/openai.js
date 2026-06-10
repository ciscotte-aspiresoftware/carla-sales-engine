// Shared OpenAI client. The classifier and the email generator both call
// the same model via this wrapper so we have one place to swap models or
// adjust defaults. Also the chokepoint for usage tracking (api-cost.js) -
// every chat completion lands a row in api_usage with token counts +
// computed USD spend, which drives the Costs page.

const OpenAI = require('openai');
const { recordOpenAI } = require('./api-cost');

// Default model - cheap-ish but smart enough for short generation.
const DEFAULT_MODEL = process.env.BLUEBIRD_OPENAI_MODEL || 'gpt-4o-mini';

// Lazy client init. Constructing OpenAI() at module load throws when
// OPENAI_API_KEY isn't set, which would break `require('./utils/openai')`
// for any code path (including smoke tests and the /health endpoint that
// just wants to report whether the key is present).
let _client = null;
function getClient() {
    if (!_client) {
        if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
        _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return _client;
}

/**
 * Send a chat completion. Returns the message content as a string.
 * Throws on auth/credit failures so the route handler can surface a clear
 * error to the user instead of silently degrading.
 *
 * `operation` is an optional tag stored on the usage row so the Costs page
 * can break spend down by Atlas operation (e.g. 'classify', 'email_gen',
 * 'li_message', 'icp_generate', 'icp_improve', 'report'). Untagged calls
 * still log; they just show up as "(unknown)" in the breakdown.
 */
async function chat(messages, { model = DEFAULT_MODEL, temperature = 0.4, response_format, operation = null } = {}) {
    const params = { model, messages, temperature };
    if (response_format) params.response_format = response_format;
    const startedAt = Date.now();
    const completion = await getClient().chat.completions.create(params);
    const durationMs = Date.now() - startedAt;

    // Fire-and-forget usage logging. recordOpenAI never throws; if the
    // ledger insert fails we proceed anyway - the user still gets their
    // response, we just lose one row of cost tracking.
    recordOpenAI({ model, usage: completion.usage, operation, durationMs });

    return completion.choices?.[0]?.message?.content || '';
}

module.exports = { chat, getClient, DEFAULT_MODEL };