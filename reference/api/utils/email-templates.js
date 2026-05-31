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

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'email-templates.json');

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
];

function ensureFile() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(FILE)) {
        fs.writeFileSync(FILE, JSON.stringify(DEFAULT_TEMPLATES, null, 2));
    }
}

function readAll() {
    ensureFile();
    try {
        const raw = fs.readFileSync(FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : DEFAULT_TEMPLATES;
    } catch {
        return DEFAULT_TEMPLATES;
    }
}

function writeAll(templates) {
    ensureFile();
    fs.writeFileSync(FILE, JSON.stringify(templates, null, 2));
}

function getTemplate(id) {
    return readAll().find((t) => t.id === id) || null;
}

function listTemplates({ portfolioCompany } = {}) {
    let all = readAll();
    if (portfolioCompany) {
        const target = String(portfolioCompany).toLowerCase();
        all = all.filter((t) => (t.portfolioCompany || '').toLowerCase() === target);
    }
    // Trim the heavy systemPrompt for picker-style listings so the wire
    // payload stays small. Editors fetch the full record via getTemplate.
    return all.map((t) => ({
        id: t.id,
        name: t.name,
        portfolioCompany: t.portfolioCompany || '',
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
function suggestTemplate({ icpId, portfolioCompany }) {
    const all = readAll();
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
    return {
        id,
        name: String(data.name).trim(),
        portfolioCompany: String(data.portfolioCompany || '').trim(),
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
        exampleSubject: String(data.exampleSubject || '').trim(),
        exampleBody: String(data.exampleBody || '').trim(),
        existingId,
    };
}

function createTemplate(data) {
    const v = validate(data);
    const all = readAll();
    if (all.find((t) => t.id === v.id)) throw new Error(`template "${v.id}" already exists`);
    const now = Date.now();
    const tpl = { ...v, createdAt: now, updatedAt: now };
    delete tpl.existingId;
    all.push(tpl);
    writeAll(all);
    return tpl;
}

function updateTemplate(id, data) {
    const all = readAll();
    const idx = all.findIndex((t) => t.id === id);
    if (idx < 0) return null;
    const v = validate({ ...data, id }, { existingId: id });
    const merged = { ...all[idx], ...v, id, updatedAt: Date.now() };
    delete merged.existingId;
    all[idx] = merged;
    writeAll(all);
    return all[idx];
}

function deleteTemplate(id) {
    const all = readAll();
    const idx = all.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    all.splice(idx, 1);
    writeAll(all);
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
