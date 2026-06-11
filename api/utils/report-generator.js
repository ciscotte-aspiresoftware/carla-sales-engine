// Per-ICP markdown company report.
//
// When an ICP has reportEnabled, the sweep (and the on-demand backfill
// button) calls this to produce a human-readable markdown brief about the
// company, on top of the binary is_match/reason verdict:
//   - MATCH    → a full report following the ICP's own reportTemplate
//                (the operator's markdown - sections named whatever they
//                 want). Falls back to DEFAULT_REPORT_TEMPLATE if blank.
//   - NO MATCH → a short "why this was rejected" markdown so the sales
//                team can see the reasoning at a glance.
//
// Uses the Admin-configured reportModel (default gpt-4o) - stronger than
// the binary classifier (mini) because reports are read by humans. Output
// is raw markdown text, NOT json - so no response_format here.

const { chat } = require('./openai');
const { getAi } = require('./settings');
const { DEFAULT_REPORT_TEMPLATE } = require('./icps');

// Cap the page content fed to the report model. Reports want more context
// than the binary classifier (12k) since they summarise the whole site,
// but we still bound it to keep token cost predictable - especially on
// crawl-mode markdown that can run to hundreds of KB.
const REPORT_MARKDOWN_CAP = 16000;

async function generateCompanyReport({ markdown, pageTitle, icp, isMatch, reason }) {
    if (!markdown || !icp) return null;
    const content = markdown.length > REPORT_MARKDOWN_CAP ? markdown.slice(0, REPORT_MARKDOWN_CAP) : markdown;

    let system;
    if (isMatch) {
        const template = (icp.reportTemplate || '').trim() || DEFAULT_REPORT_TEMPLATE;
        system = [
            'You are a sales research analyst. Write a concise markdown brief about the business below for the sales team that will pursue it.',
            '',
            'Follow EXACTLY this markdown template - keep the operator\'s section headings verbatim, fill each with what the page supports. If the page does not cover a section, write "Not stated on the website" rather than inventing anything.',
            '',
            'TEMPLATE:',
            template,
            '',
            'Rules:',
            '- Output markdown only. No preamble, no closing remarks, no code fences.',
            '- Never invent facts the page does not support.',
            '- Keep it tight and skimmable - this is a sales brief, not an essay.',
        ].join('\n');
    } else {
        system = [
            `You are a sales research analyst. This company was screened as NOT a fit for the ICP "${icp.name}".`,
            'Under a single "## Why this was rejected" heading, give 2-4 short markdown bullet points explaining why it does not fit, grounded in what the page shows and the ICP criteria.',
            'Output markdown only. No preamble. Do not invent facts.',
        ].join('\n');
    }

    const user = [
        `Page title: ${pageTitle || '(none)'}`,
        '',
        `Classifier verdict: ${isMatch ? 'MATCH' : 'NOT A MATCH'}${reason ? ` - ${reason}` : ''}`,
        '',
        'Page content:',
        content,
    ].join('\n');

    try {
        const raw = await chat(
            [{ role: 'system', content: system }, { role: 'user', content: user }],
            { task: 'report', temperature: 0.3 },
        );
        const text = (raw || '').trim();
        return text || null;
    } catch (err) {
        console.warn(`[Report] generation failed for ${icp.id}: ${err.message}`);
        return null;
    }
}

module.exports = { generateCompanyReport };
