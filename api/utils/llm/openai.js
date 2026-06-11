// OpenAI provider adapter.
//
// Normalized interface shared by every provider in this folder:
//   complete({ system, messages, model, jsonMode, temperature, maxTokens })
//     -> { text, usage: { inputTokens, outputTokens } }
//
// `system` is the combined system prompt (the router extracts role:'system'
// out of the message list); `messages` is the user/assistant turns only.
// OpenAI wants system back IN the messages array as a system-role message,
// so we re-prepend it here.

const OpenAI = require('openai');

let _client = null;
function getClient() {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY missing — set it in the environment to use the OpenAI provider.');
    }
    if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return _client;
}

async function complete({ system, messages, model, jsonMode = false, temperature, maxTokens = 8192 }) {
    const fullMessages = [];
    if (system) fullMessages.push({ role: 'system', content: system });
    for (const m of messages) fullMessages.push({ role: m.role, content: m.content });

    const params = { model, messages: fullMessages, max_tokens: maxTokens };
    if (typeof temperature === 'number') params.temperature = temperature;
    if (jsonMode) params.response_format = { type: 'json_object' };

    const completion = await getClient().chat.completions.create(params);
    const text = completion.choices?.[0]?.message?.content || '';
    return {
        text,
        usage: {
            inputTokens: completion.usage?.prompt_tokens || 0,
            outputTokens: completion.usage?.completion_tokens || 0,
        },
    };
}

function hasKey() {
    return !!process.env.OPENAI_API_KEY;
}

module.exports = { complete, hasKey };
