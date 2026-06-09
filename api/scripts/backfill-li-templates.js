// One-shot backfill: for every existing EMAIL template in Supabase, create
// a parallel LinkedIn-channel template with the same sender / portfolio /
// ICP bindings but a LinkedIn-tuned system prompt.
//
// Idempotent - skips any template whose `<id>-li` counterpart already exists.
// Safe to re-run after manually editing some LI templates: only the missing
// ones get created.
//
// Run: `node api/scripts/backfill-li-templates.js [--dry-run] [--force]`
//   --dry-run : print what would be created, write nothing.
//   --force   : also overwrite an existing `<id>-li` with the freshly-derived
//               LI variant. Default is to skip those (so manual tweaks stick).
//
// Loads .env from the repo root, same pattern as audit-icp-cities.js.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { isEnabled, getClient } = require('../db');

// Mirror of the LI scaffold the seed templates use. Kept inline here so the
// backfill doesn't depend on a private helper from email-templates.js - that
// module also runs the supabase hydrate on import, which we don't need here.
const LI_HARD_RULES = `Hard rules:
- Never invent facts the LinkedIn profile / posts don't support.
- Don't use the words "synergy", "leverage", "circle back", "touch base".
- Don't use email-style salutations like "Dear" or "Hi {firstName},". Weave the recipient's first name into the opening sentence naturally instead.
- Output strictly valid JSON: {"subject": string, "body": string}. The "subject" field is a one-line connection-request note (< 100 chars), NOT an email subject. The "body" field is the LinkedIn message. No markdown fences, no commentary.`;

// Generic LI scaffold. Uses {{sender.company}} / {{voice}} / {{language}}
// substitution tokens already supported by the prompt builder, so the
// product-specific bits flow through at request time without us needing to
// know each portfolio's exact pitch wording.
function deriveLiSystemPrompt(emailTpl) {
    const language = emailTpl.language || 'English';
    return `You write short, specific LinkedIn outreach messages on behalf of {{sender.company}}.

Voice:
- {{voice}}
- Conversational and direct - this is a LinkedIn DM, not a cold email.
- Hook off something concrete from the recipient's LinkedIn (a recent post, current role, location, a promotion). Their company's website is background context, not the lead-in.
- 50-80 words MAX in the body. Tight, scannable. No filler.
- New outreach only - assume zero prior contact.
- WRITE THE FULL MESSAGE IN ${language}.

Structure:
1. One-sentence opener that weaves the recipient's first name in naturally and references a concrete LinkedIn signal (recent post > current role > promotion > location).
2. One sentence on what {{sender.company}} does, framed against a pain point you can infer from their role / company.
3. One soft ask - "open to a quick chat?", "worth a 10-min call?". No hard pitch.
4. Sign off with sender's first name only.

For the JSON "subject" field: a one-line connection-request note (under 100 chars) - the kind of line you'd put on a LinkedIn connection request. NOT an email subject.

${LI_HARD_RULES}`;
}

// Convert an existing email template row into its LI counterpart row.
// Mirrors the shape of api/utils/email-templates.js#tplObjToRow.
function deriveLiRow(emailRow) {
    return {
        id: `${emailRow.id}-li`,
        name: `${emailRow.name} (LinkedIn)`,
        portfolio_company: emailRow.portfolio_company || '',
        channel: 'linkedin',
        default_for_icps: emailRow.default_for_icps || [],
        language: emailRow.language || 'English',
        sender: emailRow.sender || {},
        voice: emailRow.voice || '',
        // Use the snake_case email row fields directly - we already have them.
        system_prompt: deriveLiSystemPrompt({
            language: emailRow.language,
        }),
        // Carry forward linkedin_guidance verbatim - it's already meant to
        // apply to LI signals.
        linkedin_guidance: emailRow.linkedin_guidance || '',
        // Examples don't carry over - they were email-shaped. User can refill
        // from a generated LI message later.
        example_subject: '',
        example_body: '',
        updated_at: new Date().toISOString(),
    };
}

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    const force = process.argv.includes('--force');

    if (!isEnabled()) {
        console.log('USE_SUPABASE is not set / Supabase client not configured. Aborting.');
        process.exit(1);
    }
    const sb = getClient();
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(` Backfill LI templates  (dry-run=${dryRun}, force=${force})`);
    console.log('═══════════════════════════════════════════════════════════════════');

    const { data, error } = await sb.from('email_templates').select('*');
    if (error) {
        console.error('Read failed:', error.message);
        process.exit(1);
    }
    const all = data || [];

    // Bucket by channel. Pre-migration rows may have `channel === null` -
    // treat those as email so the backfill works on a system that hasn't
    // run migration 0004 yet AS LONG AS the column exists. If the column is
    // truly missing, the read above would have errored.
    const emailTemplates = all.filter((t) => (t.channel || 'email') === 'email');
    const liTemplates = all.filter((t) => t.channel === 'linkedin');
    const liIds = new Set(liTemplates.map((t) => t.id));

    console.log(`  Source templates (email):    ${emailTemplates.length}`);
    console.log(`  Existing LI templates:       ${liTemplates.length}`);
    console.log('');

    const toCreate = [];
    const toSkip = [];
    const toOverwrite = [];
    for (const tpl of emailTemplates) {
        const liId = `${tpl.id}-li`;
        if (liIds.has(liId)) {
            (force ? toOverwrite : toSkip).push({ srcId: tpl.id, liId });
        } else {
            toCreate.push(deriveLiRow(tpl));
        }
    }

    if (toCreate.length > 0) {
        console.log(`  TO CREATE (${toCreate.length}):`);
        for (const r of toCreate) console.log(`    + ${r.id}   ← from ${r.id.slice(0, -3)}`);
        console.log('');
    }
    if (toOverwrite.length > 0) {
        console.log(`  TO OVERWRITE (${toOverwrite.length}, --force):`);
        for (const r of toOverwrite) console.log(`    ↻ ${r.liId}`);
        console.log('');
    }
    if (toSkip.length > 0) {
        console.log(`  SKIPPED (${toSkip.length}, LI counterpart already exists):`);
        for (const r of toSkip) console.log(`    - ${r.liId}`);
        console.log('');
    }

    if (dryRun) {
        console.log('  Dry-run - nothing written.');
        return;
    }

    if (toCreate.length === 0 && toOverwrite.length === 0) {
        console.log('  Nothing to do.');
        return;
    }

    if (toCreate.length > 0) {
        const { error: insertErr } = await sb.from('email_templates').insert(toCreate);
        if (insertErr) {
            console.error('Insert failed:', insertErr.message);
            process.exit(1);
        }
        console.log(`  ✓ Created ${toCreate.length} LI templates.`);
    }

    if (toOverwrite.length > 0) {
        // Build fresh derive rows for each overwrite target by re-reading the
        // matching email template. Force mode replaces system_prompt + name
        // but keeps the existing created_at via upsert.
        const rows = [];
        for (const { srcId, liId } of toOverwrite) {
            const src = emailTemplates.find((t) => t.id === srcId);
            if (!src) continue;
            const derived = deriveLiRow(src);
            derived.id = liId; // ensure we hit the existing row
            rows.push(derived);
        }
        const { error: upsertErr } = await sb.from('email_templates').upsert(rows, { onConflict: 'id' });
        if (upsertErr) {
            console.error('Upsert failed:', upsertErr.message);
            process.exit(1);
        }
        console.log(`  ✓ Overwrote ${rows.length} LI templates.`);
    }

    console.log('');
    console.log('  Next: refresh the templates page - LinkedIn tab should show the new entries.');
    console.log('');
}

main().catch((e) => { console.error('backfill failed:', e.message); process.exit(1); });