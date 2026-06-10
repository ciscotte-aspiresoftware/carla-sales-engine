// Email-generation prompt builder.
//
// Two-message structure given to GPT:
//   1. System message - voice, tone, structure, hard rules. Comes from
//      the template's `systemPrompt` field after token substitution.
//      Pre-templates this was hardcoded for Bluebird; now each portfolio
//      company supplies its own (Bluebird/Thermeon/NedFox).
//   2. User message - the data the LLM has to work with: sender persona,
//      prospect fields, recipient lead. Generated here regardless of
//      template since the shape doesn't vary per company.
//
// Token substitution supported in `template.systemPrompt`:
//   {{voice}}              → template.voice
//   {{sender.firstName}}   → sender.firstName
//   {{sender.title}}       → sender.title
//   {{sender.company}}     → sender.company
//   Anything else passes through unchanged.

function substitute(text, sender, template) {
    if (!text) return '';
    return text
        .replace(/\{\{voice\}\}/g, (template && template.voice) || 'Warm, professional, plain English.')
        .replace(/\{\{language\}\}/g, (template && template.language) || 'English')
        .replace(/\{\{sender\.firstName\}\}/g, sender.firstName || '')
        .replace(/\{\{sender\.title\}\}/g, sender.title || '')
        .replace(/\{\{sender\.company\}\}/g, sender.company || '');
}

// Legacy hardcoded prompt - kept as a fallback for callers that don't
// pass a template (some demo paths still do this). New code should
// always provide a template.
const LEGACY_BLUEBIRD_PROMPT = `You write short, specific outbound sales emails on behalf of Bluebird Auto Rental Software. Bluebird makes RentWorks, a fleet/reservation/counter management platform built specifically for independent car rental operators (not Hertz/Avis/Enterprise scale).

Voice:
- Warm but professional. Not bro-y, not over-formal.
- Specific to what the prospect's website actually shows. No generic "I came across your company" language.
- 90-120 words MAX in the body. Subject line under 60 characters.
- New outreach only - assume zero prior contact.

Structure:
1. One-line opener referencing something concrete from their site (a city, a fleet detail, the booking flow).
2. One sentence about what Bluebird/RentWorks does, framed against a likely pain point you can infer from the signals.
3. One soft ask - short call, demo, or "open to learning more?". No hard pitch.
4. Signoff with sender's first name only.

Hard rules:
- Never invent facts the page doesn't support. If fleet size is unknown, don't claim a number.
- Don't mention competitors by name (Hertz/Avis/etc.) unless the prospect's site already does.
- Don't use the words "synergy", "leverage", "circle back", or "touch base". Plain English only.
- Don't include any salutation header like "Dear" - start with "Hi {firstName}," exactly.
- Output strictly valid JSON: {"subject": string, "body": string}. No markdown fences, no commentary.`;

// Universal rules that always wrap the LinkedIn signals block - apply to
// every portfolio company / template, so they live here rather than in any
// individual template's systemPrompt. The templates page surfaces this same
// string as a read-only "Always applied" hint so editors can see what
// they're adding on top of. KEEP IN SYNC with the LINKEDIN_UNIVERSAL_RULES
// constant in web/src/pages/templates.tsx - if you edit one, edit both.
//
// Re-written 2026-06-08: the prior framing ("use ONLY where they fit") was
// too cautious - the model interpreted it as "skip LinkedIn unless you must"
// and generic emails were the default even when rich LI data was present.
// Modeled on valsource's pattern (be-vms-checker/utils/linkedin-helpers.js
// generatePersonalizedEmail): LI signals are PRIMARY personalization,
// referenced explicitly in the opener.
const LINKEDIN_UNIVERSAL_RULES = `When LinkedIn data is provided below, treat it as PRIMARY personalization. Your opener MUST reference ONE specific LinkedIn-derived detail from this person's profile or posts - prefer a fresh post (last 3 months), then current role, then a past tenure at a recognizable employer in the same vertical. Override any template-level instruction to "open from the website" when LI data is available. Rules: paraphrase, never paste post text verbatim; include the year for anything older than 12 months ("back in 2023") - never say "recently" or "last month" for stale signals; don't describe the recipient's own product back to them; one detail max - don't stuff multiple LI references into a single email; don't quote hiring posts or congratulatory reshares as if they were thought leadership.`;

// Parser invariant - the email-gen route does JSON.parse on the LLM output
// and reads `subject` + `body` off the result. If the template's systemPrompt
// fails to instruct this format (typo, accidental delete, new template
// missing it), the endpoint returns a 502 every time. So we append this
// contract to whatever the template provides - it can't be edited away.
// Same pattern as icps.js where the {is_match, reason} format is hardcoded
// outside the editable rule text. KEEP IN SYNC with EMAIL_OUTPUT_CONTRACT
// in web/src/pages/templates.tsx.
const EMAIL_OUTPUT_CONTRACT = `Output strictly valid JSON: {"subject": string, "body": string}. No markdown fences, no commentary.`;

// Builds the optional LinkedIn signals block from a scraped profile + posts.
// Empty string when nothing usable is available - caller splices it into the
// prompt and gets a no-op when the lead has no LI. Imported lazily so this
// module stays free of the apify-helper dependency for callers that don't
// need it.
//
// `extraGuidance` is the template-owned `linkedinGuidance` field (optional).
// When present it's appended as a "Portfolio-specific guidance:" line so it
// sits right next to the LI data - strongest possible prompt anchor.
function buildLinkedInBlock(liSummary, liPosts, extraGuidance) {
    const { formatPostsForPrompt } = require('../utils/linkedin');
    const lines = [];
    if (liSummary) {
        const s = liSummary;
        if (s.headline) lines.push(`- LinkedIn headline: "${s.headline.slice(0, 200)}"`);
        if (s.current) lines.push(`- Current role / company: ${s.current.slice(0, 200)}`);
        if (s.location) lines.push(`- Location (LinkedIn): ${s.location.slice(0, 120)}`);
        if (s.about) lines.push(`- About (LinkedIn bio, 1st 400 chars): ${s.about.slice(0, 400)}`);
        if (s.experience) lines.push(`- Recent experience:\n${s.experience}`);
        if (s.recentPromotion) {
            const rp = s.recentPromotion;
            lines.push(`- RECENT PROMOTION SIGNAL: started "${rp.newRole}" at ${rp.company} ${rp.monthsAgo} months ago (was "${rp.priorRole}" before). Consider a brief congrats / acknowledgment if natural.`);
        } else if (s.promotions) {
            lines.push(`- Promotion history (same-company tenure): ${s.promotions.slice(0, 200)}`);
        }
    }

    let postsBlock = '';
    if (Array.isArray(liPosts) && liPosts.length > 0) {
        const { postsText, hiringSignal } = formatPostsForPrompt(liPosts);
        if (hiringSignal) lines.push('- Hiring signal: yes (recent posts mention hiring/team growth)');
        if (postsText) postsBlock = `\n\nRECENT LINKEDIN POSTS (newest first; posts within the last 3 months are tagged "prefer this" - those are the strongest hooks):\n${postsText}`;
    }

    if (lines.length === 0 && !postsBlock) return '';

    // Template-owned extra guidance gets appended right next to the LI data
    // so it has maximum prompt anchor weight. Trimmed + length-capped so a
    // wandering template field can't blow up the prompt.
    const trimmed = typeof extraGuidance === 'string' ? extraGuidance.trim().slice(0, 1000) : '';
    const extraLine = trimmed ? `\n\nPortfolio-specific guidance: ${trimmed}` : '';

    // Block structure modeled on valsource's PRIMARY-personalization layout:
    // a labeled "RECIPIENT LINKEDIN PROFILE" section comes first (where the
    // model anchors its opener), THEN the rules ("how to use it"), THEN
    // posts. The all-caps labels + the explicit "USE THIS DATA" instruction
    // overcome any template-level structure rule that says "open from
    // their site" - LI takes priority when present.
    return `\n\n===== RECIPIENT LINKEDIN PROFILE (primary personalization source) =====\n${lines.join('\n')}${postsBlock}${extraLine}\n\nHOW TO USE THIS DATA:\n${LINKEDIN_UNIVERSAL_RULES}\n=====`;
}

function buildEmailPrompt({ classification, lead, sender, template, customInstruction }) {
    const { buildCustomInstructionBlock } = require('../utils/custom-instruction');
    // Keep the company snapshot tight - too much context dilutes the prompt.
    const cls = classification || {};
    const signalsList = (cls.signals || []).slice(0, 5).map(s => `  - ${s}`).join('\n') || '  (none extracted)';
    const fleetTypes = (cls.fleetVehicleTypes || []).join(', ') || 'unknown';
    const languages = (cls.languages || []).join(', ') || 'unknown';

    // No-contact path: when Apollo returned zero decision-makers, the
    // frontend fires this route with an empty Lead object. We don't want
    // to force "Hi there," (looks like a botched merge field). Instead we
    // signal the no-contact case explicitly and let the system prompt's
    // greeting rule pick a clean professional opener (typically "Hello,"
    // or omit the greeting line entirely depending on the template's voice).
    const isNoContact = !lead.firstName && !lead.lastName;
    const leadFirstName = lead.firstName || '';
    const leadFullName = `${lead.firstName || ''} ${lead.lastName || ''}`.trim();
    const leadTitle = lead.title || (isNoContact ? '(unknown - addressing the company directly)' : 'leadership');

    // LinkedIn signals - appended to the user message only when the lead
    // has a scraped profile and/or recent posts. Empty string otherwise so
    // the prompt stays identical to the pre-LI behavior for leads we
    // couldn't scrape. Per-template `linkedinGuidance` (optional) layers
    // portfolio-specific advice on top of the universal rules.
    const liBlock = buildLinkedInBlock(lead.liSummary, lead.liPosts, template?.linkedinGuidance);

    const rawSystem = template?.systemPrompt
        ? substitute(template.systemPrompt, sender, template)
        : LEGACY_BLUEBIRD_PROMPT;

    // Strip any pre-existing JSON-contract line from the resolved system
    // prompt so we don't end up with duplicates after appending the
    // canonical hardcoded copy. The seeded templates ship with this line
    // baked in (`email-templates.js`); newer / edited templates may or
    // may not. Either way the final prompt ends up with exactly one
    // contract line, in a known position, that the user can't break.
    const dedupedSystem = rawSystem.replace(
        /^[\s\-•*]*Output strictly valid JSON.*$\n?/gim,
        '',
    ).trimEnd();
    const systemContent = `${dedupedSystem}\n\n${EMAIL_OUTPUT_CONTRACT}`;

    return [
        {
            role: 'system',
            content: systemContent,
        },
        {
            role: 'user',
            content: `Sender:
- Name: ${sender.name}
- Title: ${sender.title} at ${sender.company}
- Intro paragraph (use as the "what we do" sentence in your own words, don't paste verbatim):
  ${sender.intro}
- Signoff first name: ${sender.signoff}

Prospect company:
- Name: ${cls.name || '(unknown)'}
- Domain: ${cls.domain || '(unknown)'}
- Location: ${[cls.city, cls.country].filter(Boolean).join(', ') || '(unknown)'}
- Tagline: ${cls.tagline || '(none)'}
- Fleet hint: ${cls.fleetSizeHint || 'unknown'}
- Fleet types: ${fleetTypes}
- Languages on site: ${languages}
- Online booking: ${cls.hasOnlineBooking ? 'yes' : 'no / unclear'}
- Existing booking platform hints: ${(cls.bookingPlatformHints || []).join(', ') || 'none mentioned'}
- Signals to potentially reference:
${signalsList}

Recipient lead:
- Name: ${leadFullName || '(unknown)'}
- First name to use in greeting: ${leadFirstName || '(none - no contact identified)'}
- Title: ${leadTitle}${isNoContact ? `

NO-CONTACT MODE: No specific decision-maker was identified for this company. Address the email to the business itself, not a named person. Open with "Hello," (no name) - DO NOT write "Hi there,", "Dear Sir/Madam,", "To whom it may concern,", or guess a name. Keep everything else about the email identical (specific opener referencing their site, the value sentence, the soft ask). The rep will forward this to whichever inbox they identify (info@, sales@, the owner if they find one later).` : ''}${liBlock}${buildCustomInstructionBlock(customInstruction)}

Write the outreach email now. Return JSON only.`,
        },
    ];
}

module.exports = { buildEmailPrompt, LINKEDIN_UNIVERSAL_RULES };
