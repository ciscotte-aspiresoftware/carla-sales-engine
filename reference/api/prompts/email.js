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

function buildEmailPrompt({ classification, lead, sender, template }) {
    // Keep the company snapshot tight - too much context dilutes the prompt.
    const cls = classification || {};
    const signalsList = (cls.signals || []).slice(0, 5).map(s => `  - ${s}`).join('\n') || '  (none extracted)';
    const fleetTypes = (cls.fleetVehicleTypes || []).join(', ') || 'unknown';
    const languages = (cls.languages || []).join(', ') || 'unknown';

    const leadFirstName = lead.firstName || 'there';
    const leadFullName = `${lead.firstName || ''} ${lead.lastName || ''}`.trim();
    const leadTitle = lead.title || 'leadership';

    const systemContent = template?.systemPrompt
        ? substitute(template.systemPrompt, sender, template)
        : LEGACY_BLUEBIRD_PROMPT;

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
- First name to use in greeting: ${leadFirstName}
- Title: ${leadTitle}

Write the outreach email now. Return JSON only.`,
        },
    ];
}

module.exports = { buildEmailPrompt };
