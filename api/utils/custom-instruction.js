// Custom instruction helper - when the rep fills the optional "Custom prompt"
// textarea in the Sales Agent Step 3 / sequences editor, the trimmed text gets
// injected as a REP OVERRIDE block near the BOTTOM of the GPT user message
// (recency bias makes the model follow the most recent instruction most
// reliably).
//
// Per product decision: rep overrides take precedence over every other rule
// in the prompt - we trust the sender. The framing is "the instruction MUST
// BE FOLLOWED", not "the instruction text must appear verbatim". The rep
// typically writes the instruction TO the model in meta form ("tell him X",
// "mention Y"); the model is responsible for translating that into the email
// body in the sender's voice, addressed to the recipient. So "tell him I'll
// be there Monday for bananas" becomes something like "I'll be there Monday
// for some bananas" in the email - the intent is honored, the meta wrapper
// is dropped. Even nonsensical content gets included (the rep has full
// context, the model doesn't); the model just needs to convey it rather than
// paste it verbatim.
//
// Empty / whitespace-only input -> returns '' so callers can splice without
// emitting a hollow "REP OVERRIDE:" heading.
//
// Max length is enforced here to protect token budgets - clients should also
// cap the textarea but never trust input.
//
// Ported from valsource/be-vms-checker/utils/custom-instruction.js - keep the
// two in sync if either gets edited.
const MAX_CUSTOM_INSTRUCTION_LENGTH = 500;

function buildCustomInstructionBlock(customInstruction) {
    if (typeof customInstruction !== 'string') return '';
    const trimmed = customInstruction.trim();
    if (!trimmed) return '';
    const capped = trimmed.length > MAX_CUSTOM_INSTRUCTION_LENGTH
        ? trimmed.slice(0, MAX_CUSTOM_INSTRUCTION_LENGTH)
        : trimmed;
    // Leading newline lets callers splice the result into a prompt array with
    // .join('\n') and naturally get a blank line above the REP OVERRIDE header.
    return `

============================================================
🔴 REP OVERRIDE - MANDATORY INSTRUCTION FROM THE SENDER 🔴
============================================================
The sender has explicitly written the instruction below and it MUST BE FOLLOWED. This is non-negotiable and overrides every other rule in this prompt where the two conflict. Do not soften the instruction, do not silently drop it because it feels off-tone or nonsensical - the rep knows best. If it conflicts with stylistic guidance above, the rep wins. All other rules (date handling, naming, formatting) still apply where they do not conflict.

How to follow it (important):
- The instruction is written by the sender TO YOU (the writer) about what they want conveyed to the recipient. Your job is to follow the instruction by reflecting it in the email body, NOT to paste the instruction text verbatim.
- If the instruction is in meta form ("tell him X", "mention Y", "remind him Z", "say I'll be Q"), drop the meta wrapper and write the content directly in the sender's voice, addressed to the recipient. Examples:
  • "tell him I'll be there Monday for bananas" → write something like "I'll be there Monday for some bananas" in the body.
  • "mention our long-term hold thesis" → weave that idea into the body in your own words.
  • "remind him we met at SaaStr" → "Good to reconnect after SaaStr" or similar.
- If the instruction is style/tone/length guidance ("shorter", "more casual", "lead with X"), apply it to the draft directly.
- Whatever the instruction asks for must be REFLECTED in the email body, even if the wording feels off, even if it's quirky. Reflect the intent; don't paste the meta phrasing.

Before returning the email, verify the instruction's content has been followed (intent reflected in the body, in the sender's voice). If not, rewrite until it has.

INSTRUCTION:
${capped}
============================================================`;
}

// Post-generation guard: detect when the rep's instruction text leaked into
// the generated body verbatim. The prompt-side fix in buildCustomInstructionBlock
// is the primary defense; this is belt-and-suspenders insurance for the cases
// where the model copy-pastes despite the instructions.
//
// Threshold: 100% coverage with a 6-word floor. The floor exists so short
// style instructions ("be more casual", "shorter", "lead with X") never fire -
// those words would otherwise show up naturally in any email body and generate
// noise. For longer instructions, we require every word to appear contiguously:
// anything less is the model successfully translating a meta instruction
// ("tell him I'll be there Monday for bananas") into recipient-voice content
// ("I'll be there Monday for bananas"), which is the intended behavior -
// partial overlap is expected and isn't a leak.
//
// Returns { fragment, indexInBody } on detection, null otherwise. Callers
// log a warning and surface a flag to the UI so the rep can re-run.
const LEAK_MIN_WORDS = 6;
const LEAK_COVERAGE_PCT = 1.0;
function detectInstructionLeak(body, instruction) {
    if (typeof body !== 'string' || typeof instruction !== 'string') return null;
    const normBody = body.toLowerCase().replace(/[^\w\s']/g, ' ').replace(/\s+/g, ' ');
    const instWords = instruction
        .toLowerCase()
        .replace(/[^\w\s']/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
    const window = Math.max(LEAK_MIN_WORDS, Math.ceil(LEAK_COVERAGE_PCT * instWords.length));
    if (instWords.length < window) return null;
    for (let i = 0; i + window <= instWords.length; i++) {
        const slice = instWords.slice(i, i + window).join(' ');
        const idx = normBody.indexOf(slice);
        if (idx !== -1) {
            return { fragment: slice, indexInBody: idx };
        }
    }
    return null;
}

module.exports = { buildCustomInstructionBlock, MAX_CUSTOM_INSTRUCTION_LENGTH, detectInstructionLeak };
