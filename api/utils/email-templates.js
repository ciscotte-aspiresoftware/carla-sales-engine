// Email templates - per-portfolio-company senders + system prompts that
// drive outbound email generation. Replaces the old hardcoded Bluebird-
// only `senders.js` + `prompts/email.js` pair with a data-driven model
// so each portfolio company (Bluebird, Thermeon, NedFox, etc.) has its
// own voice, sender persona, and tone - and so the rep can save new
// templates from the UI without a code change.
//
// Templates are scoped by portfolio company + bound to specific ICPs.
// When email generation runs for a given ICP, we look up the template
// where defaultForIcps contains that ICP id. No vertical fallback -
// the ICP IS the binding mechanism, and the vertical is derivable from
// the ICP if anyone needs it. Keeping templates ICP-bound means each
// ICP gets exactly its own outreach voice.
//
// Shape of a template (one record):
//   {
//     id:                 'bluebird-fazal',          // url-safe slug
//     name:               'Fazal Khaishgi',
//     portfolioCompany:   'Bluebird Auto Rental Systems',
//     defaultForIcps:     ['bluebird'],              // which ICPs use this template
//     language:           'en',                       // primary language of the output
//     sender: {
//       firstName: 'Fazal', lastName: 'Khaishgi',
//       title: 'Group Managing Director',
//       company: 'Bluebird Auto Rental Software',
//       email: 'fazal@bluebird-arc.com',
//       signoff: 'Fazal',
//     },
//     // The system message fed to GPT. May reference template tokens
//     // (see token-substitution in routes/email.js): {{sender.firstName}}
//     // {{sender.title}} {{sender.company}} {{voice}}.
//     systemPrompt: 'You write short outbound...',
//     // Voice/tone descriptor - pulled into the system prompt via the
//     // {{voice}} token if used.
//     voice: 'Warm, professional, plain English. No bro-speak.',
//     // Optional reference output the editor can show as an example.
//     exampleSubject: '...', exampleBody: '...',
//     createdAt, updatedAt
//   }
//
// File: api/data/email-templates.json, auto-bootstrapped with the
// DEFAULT_TEMPLATES below on first read.

const fs = require('fs');
const path = require('path');
const { isEnabled, getClient } = require('../db');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'email-templates.json');

// ─── Supabase layer (email_templates) - boot-cache + write-through ──────────
function tplRowToObj(r) {
    return {
        id: r.id, name: r.name, portfolioCompany: r.portfolio_company || '',
        // 'email' | 'linkedin'. Templates created before migration 0004 land
        // here as 'email' (the column DEFAULT). New LI templates carry
        // 'linkedin' so the LI route picks them up while /api/email keeps
        // its email-only behaviour.
        channel: r.channel || 'email',
        defaultForIcps: r.default_for_icps || [], language: r.language || 'English',
        sender: r.sender || {}, voice: r.voice || '', systemPrompt: r.system_prompt || '',
        linkedinGuidance: r.linkedin_guidance || '', exampleSubject: r.example_subject || '',
        exampleBody: r.example_body || '',
        createdAt: r.created_at ? new Date(r.created_at).getTime() : undefined,
        updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : undefined,
    };
}
function tplObjToRow(t) {
    return {
        id: t.id, name: t.name, portfolio_company: t.portfolioCompany || '',
        channel: t.channel || 'email',
        default_for_icps: t.defaultForIcps || [], language: t.language || 'English',
        sender: t.sender || {}, voice: t.voice || '', system_prompt: t.systemPrompt || '',
        linkedin_guidance: t.linkedinGuidance || '', example_subject: t.exampleSubject || '',
        example_body: t.exampleBody || '', updated_at: new Date().toISOString(),
    };
}
let tplCache = null;
async function hydrateFromSupabase() {
    try {
        const { data, error } = await getClient().from('email_templates').select('*');
        if (error || !data) return;
        tplCache = data.map(tplRowToObj);
    } catch (e) {
        console.warn('[templates] supabase hydrate failed (using JSON seed):', e.message);
    }
}

// ─── Defaults ─────────────────────────────────────────────────────────
//
// Only Fazal Khaishgi seeded - the canonical Bluebird sender. New
// templates are added by the user via the /templates page UI, which
// supports picking the portfolio company + ICP(s) from dropdowns
// populated by the live ICP registry. Keeping the seed list to one entry
// makes the demo state predictable; the system supports any number of
// templates added through the UI thereafter.
//
// The `systemPrompt` is the rules block fed to GPT. The data block
// (prospect + lead + sender) is composed at request time in
// routes/email.js - templates don't have to spell that part out.

const SHARED_HARD_RULES = `Hard rules:
- Never invent facts the page doesn't support.
- Don't use the words "synergy", "leverage", "circle back", "touch base".
- Don't include any salutation header like "Dear" - start with "Hi {firstName}," exactly.
- Output strictly valid JSON: {"subject": string, "body": string}. No markdown fences, no commentary.`;

// Fazal-as-sender across every current ICP. The sender persona is the
// same; what changes per template is (a) which product to pitch in the
// prompt body, and (b) which language to write the output in. Instruction
// language stays English everywhere - GPT reads English fluently and
// emits in whatever {{language}} we instruct it to.
const FAZAL_SENDER = {
    firstName: 'Fazal',
    lastName: 'Khaishgi',
    title: 'Group Managing Director',
    company: 'Valsoft Corporation',
    email: 'fazal@valsoft.com',
    signoff: 'Fazal',
};

// Reusable structure block - common across every template. Substitutes
// the product pitch + language at request time.
function makeSystemPrompt({ productPitch, language }) {
    return `You write short, specific outbound sales emails on behalf of ${productPitch.company}. ${productPitch.what}

Voice:
- {{voice}}
- Specific to what the prospect's website actually shows. No generic "I came across your company" language.
- 90-130 words MAX in the body. Subject line under 60 characters.
- New outreach only - assume zero prior contact.
- WRITE THE FULL EMAIL IN ${language}. Subject, greeting, body, and signoff must all be in ${language}.

Structure:
1. One-line opener referencing something concrete from their site (a city, a product detail, the booking/checkout flow).
2. One sentence about what ${productPitch.product} does, framed against a likely pain point you can infer from the signals.
3. One soft ask - short call, demo, or "open to learning more?". No hard pitch.
4. Signoff with sender's first name only.

${SHARED_HARD_RULES}`;
}

// LI-tuned variant of SHARED_HARD_RULES. Two real deltas from the email version:
//   1. No "Hi {firstName}," opener - LinkedIn DMs read more naturally with
//      the name woven inline ("Hey Marco, saw your post on...") than with
//      an email-style salutation header.
//   2. The output contract still emits {subject, body} so the LI frontend's
//      copy-subject / copy-body buttons keep working without changes -
//      `subject` is repurposed as a one-line connection-request note
//      (< 100 chars), not an email subject. If/when the LI page drops the
//      subject UI we'll add a LI_OUTPUT_CONTRACT here.
const LI_HARD_RULES = `Hard rules:
- Never invent facts the LinkedIn profile / posts don't support.
- Don't use the words "synergy", "leverage", "circle back", "touch base".
- Don't use email-style salutations like "Dear" or "Hi {firstName},". Weave the recipient's first name into the opening sentence naturally instead.
- Output strictly valid JSON: {"subject": string, "body": string}. The "subject" field is a one-line connection-request note (< 100 chars), NOT an email subject. The "body" field is the LinkedIn message. No markdown fences, no commentary.`;

// LI-message systemPrompt - parallel structure to makeSystemPrompt but
// shorter (LinkedIn DMs land best at 50-80 words), conversational, and
// hooks off the recipient's LinkedIn signals rather than their company
// website. The classification block (company info) still gets fed via the
// user message; that stays useful as background context.
function makeLiSystemPrompt({ productPitch, language }) {
    return `You write short, specific LinkedIn outreach messages on behalf of ${productPitch.company}. ${productPitch.what}

Voice:
- {{voice}}
- Conversational and direct - this is a LinkedIn DM, not a cold email.
- Hook off something concrete from the recipient's LinkedIn (a recent post, current role, location, a promotion). Their company's website is background context, not the lead-in.
- 50-80 words MAX in the body. Tight, scannable. No filler.
- New outreach only - assume zero prior contact.
- WRITE THE FULL MESSAGE IN ${language}.

Structure:
1. One-sentence opener that weaves the recipient's first name in naturally and references a concrete LinkedIn signal (recent post > current role > promotion > location).
2. One sentence on what ${productPitch.product} does, framed against a pain point you can infer from their role / company.
3. One soft ask - "open to a quick chat?", "worth a 10-min call?". No hard pitch.
4. Sign off with sender's first name only.

For the JSON "subject" field: a one-line connection-request note (under 100 chars) - the kind of line you'd put on a LinkedIn connection request. NOT an email subject. Examples: "Quick note about ${productPitch.product}" or "Saw your post on X - wanted to share something". For the JSON "body" field: the LinkedIn message proper.

${LI_HARD_RULES}`;
}

const DEFAULT_TEMPLATES = [
    // ─── Bluebird (English) ───────────────────────────────────────────
    {
        id: 'fazal-bluebird',
        name: 'Fazal - Bluebird',
        portfolioCompany: 'Bluebird Auto Rental Systems',
        defaultForIcps: ['bluebird'],
        language: 'English',
        sender: FAZAL_SENDER,
        voice: 'Warm but professional. Not bro-y, not over-formal. Plain English.',
        systemPrompt: makeSystemPrompt({
            language: 'English',
            productPitch: {
                company: 'Bluebird Auto Rental Software',
                product: 'Bluebird / RentWorks',
                what: 'Bluebird makes RentWorks, a fleet/reservation/counter management platform built specifically for independent car rental operators (not Hertz/Avis/Enterprise scale).',
            },
        }),
    },

    // ─── Thermeon (English) ───────────────────────────────────────────
    {
        id: 'fazal-thermeon',
        name: 'Fazal - Thermeon',
        portfolioCompany: 'Thermeon',
        defaultForIcps: ['thermeon'],
        language: 'English',
        sender: FAZAL_SENDER,
        voice: 'Direct, operations-savvy. Mid-market peer tone. UK English.',
        systemPrompt: makeSystemPrompt({
            language: 'English',
            productPitch: {
                company: 'Thermeon',
                product: 'CARS+',
                what: 'Thermeon makes CARS+, the vehicle-hire platform used by 2,000+ car rental operators across 50 countries. Sweet spot is mid-market rental businesses (10–500 vehicles), multi-branch operations, and corporate/business-travel customers.',
            },
        }),
    },

    // ─── NedFox - Garden Centres (Dutch) ──────────────────────────────
    {
        id: 'fazal-nedfox-garden',
        name: 'Fazal - NedFox Garden Centres',
        portfolioCompany: 'NedFox',
        defaultForIcps: ['nedfox-garden'],
        language: 'Dutch',
        sender: FAZAL_SENDER,
        voice: 'Warm en direct. Korte zinnen. Vakjargon van de tuincentrum-/groenbranche is welkom (tuincentrum, kassasysteem, plantenbarcode).',
        systemPrompt: makeSystemPrompt({
            language: 'Dutch',
            productPitch: {
                company: 'NedFox B.V.',
                product: 'RetailVista',
                what: 'NedFox makes RetailVista, a retail-ERP + POS suite built specifically for independent garden centres. Over 400 garden centres across the Netherlands, Belgium, and the UK already run on RetailVista - it covers POS, inventory, plant labels, webshop integration, and loyalty in one platform.',
            },
        }),
    },

    // ─── NedFox - Thrift Stores (Dutch) ───────────────────────────────
    {
        id: 'fazal-nedfox-thrift',
        name: 'Fazal - NedFox Kringloopwinkels',
        portfolioCompany: 'NedFox',
        defaultForIcps: ['nedfox-thrift'],
        language: 'Dutch',
        sender: FAZAL_SENDER,
        voice: 'Praktisch en warm. Erken dat veel kringloopwinkels stichtingen zijn met vrijwilligers - focus op tijd-/efficiency-winst, niet op winstmaximalisatie.',
        systemPrompt: makeSystemPrompt({
            language: 'Dutch',
            productPitch: {
                company: 'NedFox B.V.',
                product: 'RetailVista',
                what: 'NedFox makes RetailVista, a POS + inventory platform that also serves kringloopwinkels / thrift stores. Designed for the unique challenges of second-hand retail: unique (non-barcoded) items, donation tracking, mixed volunteer + paid staff workflows.',
            },
        }),
    },

    // ─── NedFox - Camping & Outdoor (Dutch) ───────────────────────────
    {
        id: 'fazal-nedfox-camping',
        name: 'Fazal - NedFox Camping & Outdoor',
        portfolioCompany: 'NedFox',
        defaultForIcps: ['nedfox-camping'],
        language: 'Dutch',
        sender: FAZAL_SENDER,
        voice: 'Praktisch en sport-/outdoor-savvy. Begrijp de seizoenspieken (lente/zomer) en de mix van high-ticket items (tenten, slaapzakken).',
        systemPrompt: makeSystemPrompt({
            language: 'Dutch',
            productPitch: {
                company: 'NedFox B.V.',
                product: 'RetailVista',
                what: 'NedFox makes RetailVista, the retail-ERP + POS suite used by independent specialty retailers including camping and outdoor stores. Handles seasonal stock peaks, high-ticket items, multi-channel sales (webshop + in-store).',
            },
        }),
    },

    // ─── NedFox - Personal Care (Dutch) ───────────────────────────────
    {
        id: 'fazal-nedfox-personal-care',
        name: 'Fazal - NedFox Personal Care',
        portfolioCompany: 'NedFox',
        defaultForIcps: ['nedfox-personal-care'],
        language: 'Dutch',
        sender: FAZAL_SENDER,
        voice: 'Warm, persoonlijk. Drogisterijen en parfumeries zijn vaak familiebedrijven met een sterke lokale band - eer dat in de toon.',
        systemPrompt: makeSystemPrompt({
            language: 'Dutch',
            productPitch: {
                company: 'NedFox B.V.',
                product: 'RetailVista',
                what: 'NedFox makes RetailVista, the retail-ERP + POS suite used by independent personal-care retailers (drogisterijen, parfumeries, beauty shops). Strong on SKU-heavy inventory, mix of branded + private label, and loyalty programs.',
            },
        }),
    },

    // ─── NedFox - Bathroom Stores (Dutch) ─────────────────────────────
    {
        id: 'fazal-nedfox-bathroom',
        name: 'Fazal - NedFox Bathroom Stores',
        portfolioCompany: 'NedFox',
        defaultForIcps: ['nedfox-bathroom'],
        language: 'Dutch',
        sender: FAZAL_SENDER,
        voice: 'Vakkundig, B2B retail. Erken de showroom-cyclus, projectverkoop, en lange salescycli typisch voor badkamer- en sanitairzaken.',
        systemPrompt: makeSystemPrompt({
            language: 'Dutch',
            productPitch: {
                company: 'NedFox B.V.',
                product: 'RetailVista',
                what: 'NedFox makes RetailVista, the retail-ERP + POS suite used by independent bathroom showrooms, sanitair specialists, and tile retailers. Built for showroom-driven sales, complex configurable products, and integration with installer workflows.',
            },
        }),
    },

    // ═════════════════════════════════════════════════════════════════════
    //  LinkedIn channel templates
    // ─────────────────────────────────────────────────────────────────────
    //  Parallel set of the email templates above, one per (portfolioCompany ×
    //  ICP) pairing. Same sender, voice, language, and ICP binding - the only
    //  delta is `channel: 'linkedin'` + an LI-tuned systemPrompt (shorter,
    //  conversational, hooks off LinkedIn signals rather than the company
    //  website). IDs suffix `-li` so they don't collide with the email twins.
    //
    //  Routes/li-message.js asks suggestTemplate({channel:'linkedin'}) and
    //  falls back to the email template if no LI counterpart exists, so adding
    //  / removing entries here is safe at any time.
    // ═════════════════════════════════════════════════════════════════════

    // ─── Bluebird LI (English) ────────────────────────────────────────
    {
        id: 'fazal-bluebird-li',
        name: 'Fazal - Bluebird (LinkedIn)',
        portfolioCompany: 'Bluebird Auto Rental Systems',
        channel: 'linkedin',
        defaultForIcps: ['bluebird'],
        language: 'English',
        sender: FAZAL_SENDER,
        voice: 'Warm but professional. Not bro-y, not over-formal. Plain English.',
        systemPrompt: makeLiSystemPrompt({
            language: 'English',
            productPitch: {
                company: 'Bluebird Auto Rental Software',
                product: 'Bluebird / RentWorks',
                what: 'Bluebird makes RentWorks, a fleet/reservation/counter management platform built specifically for independent car rental operators (not Hertz/Avis/Enterprise scale).',
            },
        }),
    },

    // ─── Thermeon LI (English) ────────────────────────────────────────
    {
        id: 'fazal-thermeon-li',
        name: 'Fazal - Thermeon (LinkedIn)',
        portfolioCompany: 'Thermeon',
        channel: 'linkedin',
        defaultForIcps: ['thermeon'],
        language: 'English',
        sender: FAZAL_SENDER,
        voice: 'Direct, operations-savvy. Mid-market peer tone. UK English.',
        systemPrompt: makeLiSystemPrompt({
            language: 'English',
            productPitch: {
                company: 'Thermeon',
                product: 'CARS+',
                what: 'Thermeon makes CARS+, the vehicle-hire platform used by 2,000+ car rental operators across 50 countries. Sweet spot is mid-market rental businesses (10–500 vehicles), multi-branch operations, and corporate/business-travel customers.',
            },
        }),
    },

    // ─── NedFox - Garden Centres LI (Dutch) ───────────────────────────
    {
        id: 'fazal-nedfox-garden-li',
        name: 'Fazal - NedFox Garden Centres (LinkedIn)',
        portfolioCompany: 'NedFox',
        channel: 'linkedin',
        defaultForIcps: ['nedfox-garden'],
        language: 'Dutch',
        sender: FAZAL_SENDER,
        voice: 'Warm en direct. Korte zinnen. Vakjargon van de tuincentrum-/groenbranche is welkom (tuincentrum, kassasysteem, plantenbarcode).',
        systemPrompt: makeLiSystemPrompt({
            language: 'Dutch',
            productPitch: {
                company: 'NedFox B.V.',
                product: 'RetailVista',
                what: 'NedFox makes RetailVista, a retail-ERP + POS suite built specifically for independent garden centres. Over 400 garden centres across the Netherlands, Belgium, and the UK already run on RetailVista - it covers POS, inventory, plant labels, webshop integration, and loyalty in one platform.',
            },
        }),
    },

    // ─── NedFox - Thrift Stores LI (Dutch) ────────────────────────────
    {
        id: 'fazal-nedfox-thrift-li',
        name: 'Fazal - NedFox Kringloopwinkels (LinkedIn)',
        portfolioCompany: 'NedFox',
        channel: 'linkedin',
        defaultForIcps: ['nedfox-thrift'],
        language: 'Dutch',
        sender: FAZAL_SENDER,
        voice: 'Praktisch en warm. Erken dat veel kringloopwinkels stichtingen zijn met vrijwilligers - focus op tijd-/efficiency-winst, niet op winstmaximalisatie.',
        systemPrompt: makeLiSystemPrompt({
            language: 'Dutch',
            productPitch: {
                company: 'NedFox B.V.',
                product: 'RetailVista',
                what: 'NedFox makes RetailVista, a POS + inventory platform that also serves kringloopwinkels / thrift stores. Designed for the unique challenges of second-hand retail: unique (non-barcoded) items, donation tracking, mixed volunteer + paid staff workflows.',
            },
        }),
    },

    // ─── NedFox - Camping & Outdoor LI (Dutch) ────────────────────────
    {
        id: 'fazal-nedfox-camping-li',
        name: 'Fazal - NedFox Camping & Outdoor (LinkedIn)',
        portfolioCompany: 'NedFox',
        channel: 'linkedin',
        defaultForIcps: ['nedfox-camping'],
        language: 'Dutch',
        sender: FAZAL_SENDER,
        voice: 'Praktisch en sport-/outdoor-savvy. Begrijp de seizoenspieken (lente/zomer) en de mix van high-ticket items (tenten, slaapzakken).',
        systemPrompt: makeLiSystemPrompt({
            language: 'Dutch',
            productPitch: {
                company: 'NedFox B.V.',
                product: 'RetailVista',
                what: 'NedFox makes RetailVista, the retail-ERP + POS suite used by independent specialty retailers including camping and outdoor stores. Handles seasonal stock peaks, high-ticket items, multi-channel sales (webshop + in-store).',
            },
        }),
    },

    // ─── NedFox - Personal Care LI (Dutch) ────────────────────────────
    {
        id: 'fazal-nedfox-personal-care-li',
        name: 'Fazal - NedFox Personal Care (LinkedIn)',
        portfolioCompany: 'NedFox',
        channel: 'linkedin',
        defaultForIcps: ['nedfox-personal-care'],
        language: 'Dutch',
        sender: FAZAL_SENDER,
        voice: 'Warm, persoonlijk. Drogisterijen en parfumeries zijn vaak familiebedrijven met een sterke lokale band - eer dat in de toon.',
        systemPrompt: makeLiSystemPrompt({
            language: 'Dutch',
            productPitch: {
                company: 'NedFox B.V.',
                product: 'RetailVista',
                what: 'NedFox makes RetailVista, the retail-ERP + POS suite used by independent personal-care retailers (drogisterijen, parfumeries, beauty shops). Strong on SKU-heavy inventory, mix of branded + private label, and loyalty programs.',
            },
        }),
    },

    // ─── NedFox - Bathroom Stores LI (Dutch) ──────────────────────────
    {
        id: 'fazal-nedfox-bathroom-li',
        name: 'Fazal - NedFox Bathroom Stores (LinkedIn)',
        portfolioCompany: 'NedFox',
        channel: 'linkedin',
        defaultForIcps: ['nedfox-bathroom'],
        language: 'Dutch',
        sender: FAZAL_SENDER,
        voice: 'Vakkundig, B2B retail. Erken de showroom-cyclus, projectverkoop, en lange salescycli typisch voor badkamer- en sanitairzaken.',
        systemPrompt: makeLiSystemPrompt({
            language: 'Dutch',
            productPitch: {
                company: 'NedFox B.V.',
                product: 'RetailVista',
                what: 'NedFox makes RetailVista, the retail-ERP + POS suite used by independent bathroom showrooms, sanitair specialists, and tile retailers. Built for showroom-driven sales, complex configurable products, and integration with installer workflows.',
            },
        }),
    },
];

function ensureFile() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(FILE)) {
        fs.writeFileSync(FILE, JSON.stringify(DEFAULT_TEMPLATES, null, 2));
    }
}

function readJsonSync() {
    ensureFile();
    try {
        const raw = fs.readFileSync(FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : DEFAULT_TEMPLATES;
    } catch {
        return DEFAULT_TEMPLATES;
    }
}

// Cache-backed read (sync getters), seeded from JSON then hydrated from
// Supabase.
function readAll() {
    if (tplCache) return tplCache;
    tplCache = readJsonSync();
    return tplCache;
}

function writeAll(templates) {
    tplCache = templates;
    ensureFile();
    fs.writeFileSync(FILE, JSON.stringify(templates, null, 2));
}

if (isEnabled()) hydrateFromSupabase();

function getTemplate(id) {
    return readAll().find((t) => t.id === id) || null;
}

function listTemplates({ portfolioCompany, channel } = {}) {
    let all = readAll();
    if (portfolioCompany) {
        const target = String(portfolioCompany).toLowerCase();
        all = all.filter((t) => (t.portfolioCompany || '').toLowerCase() === target);
    }
    // Channel filter. When omitted, returns every template (lets the
    // templates page show counts across both channels before switching).
    // When provided, narrows to that channel only - what the /templates
    // toggle and /api/li-message lookup both want.
    if (channel) {
        const target = String(channel).toLowerCase();
        all = all.filter((t) => (t.channel || 'email').toLowerCase() === target);
    }
    // Trim the heavy systemPrompt for picker-style listings so the wire
    // payload stays small. Editors fetch the full record via getTemplate.
    return all.map((t) => ({
        id: t.id,
        name: t.name,
        portfolioCompany: t.portfolioCompany || '',
        channel: t.channel || 'email',
        defaultForIcps: t.defaultForIcps || [],
        language: t.language || 'en',
        sender: t.sender,
    }));
}

// Pick the template for a given ICP. Each ICP should have exactly one
// template bound to it via defaultForIcps; if none binds, we fall back
// to any template under the same portfolio company; final fallback is
// the first template in the catalog (the seeded Fazal default).
//
// Lookup order:
//   1. defaultForIcps explicit match (the canonical path)
//   2. portfolioCompany match (covers ICPs the user hasn't bound a
//      template to yet - gives them their company's default voice)
//   3. first template in the catalog (Fazal)
//
// `channel` ('email' | 'linkedin') narrows each lookup step to templates
// matching that channel - so an LI message generation picks an LI template
// even when an email template exists for the same ICP. The cross-channel
// fallback (any template at all, even from the other channel) is intentional:
// during rollout, ICPs may have an email template but no LI counterpart yet
// - falling back to the email template is better than failing the request.
// The frontend can detect this via the returned template's `channel` field
// and surface a "no LI template yet" hint to nudge the user toward creating one.
function suggestTemplate({ icpId, portfolioCompany, channel } = {}) {
    const all = readAll();
    const wantChannel = channel ? String(channel).toLowerCase() : null;
    const matchesChannel = (t) => !wantChannel || (t.channel || 'email').toLowerCase() === wantChannel;

    // Pass 1 - channel-respecting lookup using the canonical priority chain.
    if (wantChannel) {
        if (icpId) {
            const direct = all.find((t) => matchesChannel(t)
                && Array.isArray(t.defaultForIcps) && t.defaultForIcps.includes(icpId));
            if (direct) return direct;
        }
        if (portfolioCompany) {
            const pc = String(portfolioCompany).toLowerCase();
            const match = all.find((t) => matchesChannel(t) && (t.portfolioCompany || '').toLowerCase() === pc);
            if (match) return match;
        }
        const firstInChannel = all.find(matchesChannel);
        if (firstInChannel) return firstInChannel;
    }

    // Pass 2 - cross-channel fallback (or no channel filter requested at all).
    // Same priority chain, no channel constraint - keeps rollout safe when an
    // ICP has an email template but no LI variant yet.
    if (icpId) {
        const direct = all.find((t) => Array.isArray(t.defaultForIcps) && t.defaultForIcps.includes(icpId));
        if (direct) return direct;
    }
    if (portfolioCompany) {
        const pc = String(portfolioCompany).toLowerCase();
        const match = all.find((t) => (t.portfolioCompany || '').toLowerCase() === pc);
        if (match) return match;
    }
    return all[0] || null;
}

function validate(data, { existingId = null } = {}) {
    if (!data) throw new Error('payload required');
    const id = String(data.id || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!id) throw new Error('id required (lowercase letters, digits, hyphens)');
    if (!data.name || !String(data.name).trim()) throw new Error('name required');
    if (!data.systemPrompt || !String(data.systemPrompt).trim()) throw new Error('systemPrompt required');
    if (!data.sender || !data.sender.firstName || !data.sender.signoff) {
        throw new Error('sender.firstName and sender.signoff are required');
    }
    // Channel - 'email' (default for legacy + new) or 'linkedin'. Constraint
    // is loose so a future channel (e.g. 'whatsapp', 'sms') doesn't need a
    // schema migration; column DEFAULT in migration 0004 handles rows that
    // arrive without one set.
    const channelRaw = String(data.channel || 'email').trim().toLowerCase();
    const channel = channelRaw === 'linkedin' ? 'linkedin' : 'email';
    return {
        id,
        name: String(data.name).trim(),
        portfolioCompany: String(data.portfolioCompany || '').trim(),
        channel,
        defaultForIcps: Array.isArray(data.defaultForIcps)
            ? data.defaultForIcps.map((s) => String(s).trim()).filter(Boolean)
            : [],
        language: String(data.language || 'en').trim() || 'en',
        sender: {
            firstName: String(data.sender.firstName).trim(),
            lastName: String(data.sender.lastName || '').trim(),
            title: String(data.sender.title || '').trim(),
            company: String(data.sender.company || '').trim(),
            email: String(data.sender.email || '').trim(),
            signoff: String(data.sender.signoff).trim(),
        },
        voice: String(data.voice || '').trim(),
        systemPrompt: String(data.systemPrompt).trim(),
        // Optional portfolio-specific LinkedIn guidance. Appended to the LI
        // signals block by buildLinkedInBlock at prompt time. Cap at 2000
        // chars to keep templates sensible; prompt builder also trims to
        // 1000 chars before injection.
        linkedinGuidance: String(data.linkedinGuidance || '').trim().slice(0, 2000),
        exampleSubject: String(data.exampleSubject || '').trim(),
        exampleBody: String(data.exampleBody || '').trim(),
        existingId,
    };
}

async function createTemplate(data) {
    const v = validate(data);
    const all = readAll();
    if (all.find((t) => t.id === v.id)) throw new Error(`template "${v.id}" already exists`);
    const now = Date.now();
    const tpl = { ...v, createdAt: now, updatedAt: now };
    delete tpl.existingId;
    if (isEnabled()) {
        const { error } = await getClient().from('email_templates').insert(tplObjToRow(tpl));
        if (error) throw new Error(`createTemplate: ${error.message}`);
        tplCache = [...all, tpl];
    } else {
        all.push(tpl);
        writeAll(all);
    }
    return tpl;
}

async function updateTemplate(id, data) {
    const all = readAll();
    const idx = all.findIndex((t) => t.id === id);
    if (idx < 0) return null;
    const v = validate({ ...data, id }, { existingId: id });
    const merged = { ...all[idx], ...v, id, updatedAt: Date.now() };
    delete merged.existingId;
    if (isEnabled()) {
        const { error } = await getClient().from('email_templates').update(tplObjToRow(merged)).eq('id', id);
        if (error) throw new Error(`updateTemplate: ${error.message}`);
        const next = [...all]; next[idx] = merged; tplCache = next;
    } else {
        all[idx] = merged;
        writeAll(all);
    }
    return merged;
}

async function deleteTemplate(id) {
    const all = readAll();
    const idx = all.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    if (isEnabled()) {
        const { error } = await getClient().from('email_templates').delete().eq('id', id);
        if (error) throw new Error(`deleteTemplate: ${error.message}`);
        tplCache = all.filter((t) => t.id !== id);
    } else {
        all.splice(idx, 1);
        writeAll(all);
    }
    return true;
}

module.exports = {
    getTemplate,
    listTemplates,
    suggestTemplate,
    createTemplate,
    updateTemplate,
    deleteTemplate,
};
