// Multi-step sequence email prompt builder.
//
// Single-email gen lives in prompts/email.js. This file is for the
// multi-touch sequence path: same recipient gets 3-5 emails over a couple
// of weeks, each playing a different role (intro, value, follow-up,
// breakup). The prompt has to tell GPT which step it's writing AND give
// it the prior steps so step 3 can reference step 1 without repeating it.
//
// Inputs:
//   sender         - persona (firstName, lastName, title, company, signoff, email)
//   template       - template record (systemPrompt, voice, language, linkedinGuidance)
//   company        - { name, domain, vertical, country, classification }
//   companyReport  - optional long-form markdown report from /report (richer
//                    than `classification` alone). Falls back to classification
//                    summary when no report exists.
//   lead           - recipient: firstName, lastName, title, email, linkedinUrl,
//                    liSummary, liPosts, phone
//   stepConfig     - this step's plan: { orderIdx, totalSteps, purpose,
//                                        daysAfterPrev, lengthHint, customGuidance? }
//   priorSteps     - array of { orderIdx, purpose, subject, body } for steps
//                    that already shipped (empty for step 0)
//   customInstruction - optional rep steering ("mention their recent expansion")

const PURPOSE_GUIDANCE = {
    intro: `INTRO (first email).
- Hook in the first line referencing something concrete from the company's report or website.
- One short sentence stating who you are (sender persona) and why you're reaching out.
- One soft CTA: a question, a 15-min ask, or "open to learning more?". No demo pitch.
- Don't say "I came across your company" - say WHAT you saw.`,

    value: `VALUE follow-up.
- Acknowledge nothing (no "circling back", no "following up"). Just lead with new value.
- ONE specific insight or angle you didn't say in the intro - something they'd get from a short call.
- Tie it back to a fact from the company report or their LinkedIn (if relevant).
- One soft re-ask. Shorter than the intro.`,

    social_proof: `SOCIAL PROOF email.
- Reference how a similar-sized / similar-vertical operator is using the sender's product.
- ONE concrete metric or outcome (no fluffy "scaled significantly").
- Keep it short. Position as "thought this might be relevant since you're in [vertical/country]."
- One soft ask: "want me to share the case study?"`,

    follow_up: `GENTLE FOLLOW-UP.
- Acknowledge they're busy. ONE line.
- Re-ask plainly. No new pitch, no new value - just a clear yes/no/timing question.
- VERY short. 40-70 words max.`,

    breakup: `BREAKUP email (last touch).
- Polite closeout. Acknowledge you've reached out a few times.
- Leave the door open: "if timing's not right, I'll follow up in a quarter / feel free to reach out."
- NO new pitch. NO question. End with the signoff.
- Very short. 30-50 words max.`,
};

// Length targets for sequence steps. `medium` is intentionally matched
// to the single-email Sales Agent prompt (90-130 words) so step 1 of any
// sequence reads at the same length as a one-off Sales Agent intro -
// reps can switch back and forth without the email size jumping.
const LENGTH_TARGETS = {
    long:   '130-160 words',
    medium: '90-130 words',
    short:  '50-80 words',
    brief:  '30-50 words',
};

// Reuse the same token substitution + universal rules as the single-email
// prompt so templates that work for one-offs work for sequence steps too.
function substitute(text, sender, template) {
    if (!text) return '';
    return text
        .replace(/\{\{voice\}\}/g, (template && template.voice) || 'Warm, professional, plain English.')
        .replace(/\{\{language\}\}/g, (template && template.language) || 'English')
        .replace(/\{\{sender\.firstName\}\}/g, sender.firstName || '')
        .replace(/\{\{sender\.title\}\}/g, sender.title || '')
        .replace(/\{\{sender\.company\}\}/g, sender.company || '');
}

const EMAIL_OUTPUT_CONTRACT = `Output strictly valid JSON: {"subject": string, "body": string}. No markdown fences, no commentary.`;

// LinkedIn rules: import from email.js so the single-email and sequence
// paths share the SAME LI-PRIMARY directive. Prior local copy was a stale
// fork that (a) used the old "use ONLY where they fit" defensive framing
// and (b) had a bug where `postsBlock = formatPostsForPrompt(posts)` was
// stringified as `[object Object]` because that helper returns an object
// `{postsText, hiringSignal}`, not a string.
const { LINKEDIN_UNIVERSAL_RULES } = require('./email');

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
            lines.push(`- RECENT PROMOTION SIGNAL: started "${rp.newRole}" at ${rp.company} ${rp.monthsAgo} months ago (was "${rp.priorRole}" before).`);
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

    const trimmed = typeof extraGuidance === 'string' ? extraGuidance.trim().slice(0, 1000) : '';
    const extraLine = trimmed ? `\n\nPortfolio-specific guidance: ${trimmed}` : '';

    return `\n\n===== RECIPIENT LINKEDIN PROFILE (primary personalization source) =====\n${lines.join('\n')}${postsBlock}${extraLine}\n\nHOW TO USE THIS DATA:\n${LINKEDIN_UNIVERSAL_RULES}\n=====`;
}

// Trim the company report so the prompt stays under model limits when the
// report is large (some are 3-4k words). 6000 chars is plenty for the model
// to grab the relevant pain points + signals without ballooning costs.
function clipReport(markdown, max = 6000) {
    if (!markdown) return '';
    if (markdown.length <= max) return markdown;
    return markdown.slice(0, max) + '\n\n[...report truncated for prompt length...]';
}

// Surfaces the website-scraped contacts on the company's classification
// so the model has SOMETHING addressable even when there's no named lead.
// Returns an empty string when nothing usable is present.
function buildScrapedContactsBlock(company) {
    const c = company?.classification?.scrapedContacts || company?.scrapedContacts || null;
    if (!c) return '';
    const lines = [];
    if (Array.isArray(c.emails) && c.emails.length > 0) {
        lines.push(`- Emails from the company website: ${c.emails.slice(0, 4).join(', ')}`);
    }
    if (Array.isArray(c.phones) && c.phones.length > 0) {
        lines.push(`- Phone numbers from the website: ${c.phones.slice(0, 3).join(', ')}`);
    }
    if (Array.isArray(c.linkedinCompanyUrls) && c.linkedinCompanyUrls.length > 0) {
        lines.push(`- Company LinkedIn URL: ${c.linkedinCompanyUrls[0]}`);
    }
    if (lines.length === 0) return '';
    return `\n\nScraped from the company website (use as the addressable surface when there is no named recipient):\n${lines.join('\n')}`;
}

function buildSequenceStepPrompt({ sender, template, company, companyReport, lead, stepConfig, priorSteps, customInstruction }) {
    const baseSystem = template?.systemPrompt
        ? substitute(template.systemPrompt, sender, template)
        : `You write short, specific outbound sales emails on behalf of ${sender.company}. Voice: warm, professional, plain English.`;

    const stepGuidance = PURPOSE_GUIDANCE[stepConfig.purpose] || PURPOSE_GUIDANCE.intro;
    const lengthTarget = LENGTH_TARGETS[stepConfig.lengthHint] || LENGTH_TARGETS.medium;
    const customStepGuidance = stepConfig.customGuidance
        ? `\n\nTemplate author's extra guidance for this step: ${stepConfig.customGuidance}`
        : '';

    // No-lead mode: the company hasn't had Sales Agent / Apollo run on it
    // yet, so we don't have a named decision-maker. Switch to a generic
    // greeting and tell the model to lean on the company report rather
    // than fabricating a recipient.
    const noLead = !lead || (!lead.firstName && !lead.lastName && !lead.email);
    const greetingRule = noLead
        ? `- This email has NO named recipient. Open with "Hello," (no name). Do NOT invent a recipient name, role, or pronoun.`
        : `- Don't start with "Hi {firstName}," more than once - use varied openers across the sequence.`;

    const systemMessage = `${baseSystem}

You are writing step ${stepConfig.orderIdx + 1} of ${stepConfig.totalSteps} in an outreach sequence to ${noLead ? 'a company (no named recipient identified)' : 'ONE recipient'}.

This step's role:
${stepGuidance}${customStepGuidance}

Length target for this step: ${lengthTarget}.

Universal rules:
- Never reference prior emails directly ("as I mentioned"). Behave like the prior emails happened but the recipient may not have read them.
- Don't repeat the exact hook from a prior step. Pick a different angle each step.
${greetingRule}
- Don't include any salutation block like "Dear" - start the body directly.
- Always sign off as "${sender.firstName}" alone (no "Best regards,", just "Best,").
- Plain English. No "synergy", "leverage", "circle back", "touch base", "deck", "ping".

${EMAIL_OUTPUT_CONTRACT}`;

    // User message: the data. Structured for legibility.
    const reportBlock = companyReport
        ? `\n\nCompany research report (AI-generated, treat as ground truth):\n${clipReport(companyReport)}`
        : (company?.classification?.summary
            ? `\n\nCompany classification summary: ${company.classification.summary}`
            : '');

    const priorBlock = priorSteps && priorSteps.length > 0
        ? `\n\nPrior steps in this sequence (FOR CONTEXT - do not repeat):\n${priorSteps.map((s) => `[Step ${s.orderIdx + 1} · ${s.purpose} · ${s.daysAfterPrev}d after prev]\nSubject: ${s.subject || '(none)'}\n${s.body || ''}`).join('\n\n---\n\n')}`
        : '';

    // LinkedIn signals only when we have a lead. No-lead path uses the
    // scraped-contacts block instead so the model has SOMETHING about the
    // company beyond the report.
    const liBlock = noLead ? '' : buildLinkedInBlock(lead.liSummary, lead.liPosts, template?.linkedinGuidance);
    const scrapedBlock = noLead ? buildScrapedContactsBlock(company) : '';

    // Same REP OVERRIDE block the single-email path uses - non-negotiable
    // framing, translation guidance for meta-form instructions ("tell him X"
    // → write content in sender's voice), 500-char defensive cap. Prior
    // local copy was a one-liner "(take SERIOUSLY)" that the model
    // routinely ignored.
    const { buildCustomInstructionBlock } = require('../utils/custom-instruction');
    const customInstrBlock = buildCustomInstructionBlock(customInstruction);

    const recipientLine = noLead
        ? `Recipient: (none identified - addressing the company directly).`
        : `Recipient: ${lead.firstName || ''} ${lead.lastName || ''}${lead.title ? `, ${lead.title}` : ''}${lead.email ? ` <${lead.email}>` : ''}.`;

    const userMessage = `Sender: ${sender.firstName} ${sender.lastName || ''}, ${sender.title} at ${sender.company}.
Sign off as: ${sender.signoff || sender.firstName}.

${recipientLine}

Company being prospected: ${company?.name || '(unknown)'}${company?.domain ? ` (${company.domain})` : ''}${company?.country ? ` · ${company.country}` : ''}${company?.vertical ? ` · ${company.vertical}` : ''}.${reportBlock}${liBlock}${scrapedBlock}${priorBlock}${customInstrBlock}

Write step ${stepConfig.orderIdx + 1} of ${stepConfig.totalSteps} now.`;

    return [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage },
    ];
}

module.exports = { buildSequenceStepPrompt, PURPOSE_GUIDANCE, LENGTH_TARGETS };