// Back-compat shim.
//
// The LLM layer is now multi-provider (OpenAI / Anthropic / Gemini), living in
// utils/llm/. Historical imports — `require('./openai')` and
// `require('../utils/openai')` — keep working unchanged: they get the same
// `chat()` entry point, which now routes to the per-task provider + model
// chosen in Admin → AI models (utils/settings.js).
//
// New code should `require('./llm')` directly.
module.exports = require('./llm');
