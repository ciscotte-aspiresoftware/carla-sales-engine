// POST /api/hubspot/* - one-way push of Atlas companies + contacts into HubSpot.
//
// Reads from Atlas's own company store (companies.json / Supabase) and writes
// to HubSpot via utils/hubspot.js (Private App token). Idempotent: companies
// dedupe by domain, contacts by email, and each pushed record's HubSpot id +
// sync timestamp are written back onto the Atlas record so re-pushing UPDATES
// rather than duplicating.
//
// Field mapping (company → HubSpot company property), verified against the
// live portal - all custom props already exist:
//   name          ← classification.title
//   domain        ← company.domain                 (dedupe key)
//   phone         ← classification.phone
//   address       ← classification.address
//   city          ← company.city
//   icp_summary   ← "<Qualified|Not qualified> — <reason>"   (the verdict)
//   rating        ← classification.rating          (number)
//   reviews       ← classification.reviews         (number)
//   vertical      ← company.vertical
//   signalssummary← classification.signals[] joined
//   + a timeline Note with the markdown report + key quotes (only re-created
//     when the classification is newer than the last sync, so re-pushes don't
//     stack duplicate notes).
//
// Contact gate (per the operator's choice): push EVERY lead that has an email.
//   email ← lead.email   firstname/lastname/jobtitle/phone/hs_linkedin_url

const express = require('express');
const hubspot = require('../utils/hubspot');
const companiesStore = require('./companies');
const realtime = require('../utils/realtime');
const { trackActivity } = require('../middleware/activity');
const { isDemo, isPinned } = require('../utils/mode');

const router = express.Router();

// Optional inbound API-key gate on the push endpoints, mirroring /api/discover.
// When HUBSPOT_PUSH_API_KEY is unset the endpoints stay open (local-dev
// default); when set, callers must present `x-api-key` or `Authorization:
// Bearer`. Lets you expose the push to another service without sharing code.
function keyOk(req) {
    const required = process.env.HUBSPOT_PUSH_API_KEY || '';
    if (!required) return true;
    const headerKey = req.get('x-api-key') || '';
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    return headerKey === required || bearer === required;
}

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Minimal markdown → HubSpot-note HTML. hs_note_body renders a safe HTML
// subset, not markdown, so convert the few constructs the report uses
// (headings, bold, line breaks). Escapes first so the source text is safe.
function mdLite(md) {
    return esc(md)
        .replace(/^#{1,6}\s*(.*)$/gm, '<strong>$1</strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');
}

// Build the company-note HTML from the pinned classification.
function buildNoteHtml(company, cls) {
    const parts = [];
    parts.push(`<strong>Atlas classification — ${esc(cls.title || company.domain || '')}</strong>`);
    const verdict = cls.is_match === true ? '✅ Qualified' : cls.is_match === false ? '❌ Not qualified' : '⏳ Pending';
    parts.push(`Verdict: ${verdict}${cls.reason ? ` — ${esc(cls.reason)}` : ''}`);
    if (cls.rating != null) parts.push(`Google rating: ${esc(cls.rating)} (${esc(cls.reviews ?? 0)} reviews)`);
    const signals = Array.isArray(cls.signals) ? cls.signals.filter(Boolean) : [];
    if (signals.length) parts.push(`<strong>Signals</strong><ul>${signals.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`);
    const quotes = Array.isArray(cls.key_quotes) ? cls.key_quotes.filter(Boolean) : [];
    if (quotes.length) parts.push(`<strong>Key quotes</strong><ul>${quotes.map((q) => `<li><em>${esc(q)}</em></li>`).join('')}</ul>`);
    if (cls.report) parts.push(`<strong>Report</strong><br>${mdLite(cls.report)}`);
    parts.push(`<span style="color:#888">Synced from Atlas · ${esc(company.domain || '')}</span>`);
    return parts.join('<br>');
}

// Build the HubSpot company property bag from a company's pinned classification.
function companyProps(company) {
    const cls = company.classification || {};
    const verdict = cls.is_match === true ? 'Qualified' : cls.is_match === false ? 'Not qualified' : 'Pending';
    const icpSummary = cls.reason ? `${verdict} — ${cls.reason}` : verdict;
    const signals = Array.isArray(cls.signals) ? cls.signals.filter(Boolean) : [];
    const props = {
        name: cls.title || cls.name || company.domain || '',
        domain: (company.domain || '').toLowerCase(),
        icp_summary: icpSummary,
    };
    if (cls.phone) props.phone = cls.phone;
    if (cls.address) props.address = cls.address;
    // NB: company.city is the grid SEARCH-cell city (where we scanned), not
    // the company's actual HQ city - e.g. a Miami sweep surfaces a Brooklyn
    // business. The full street address (above) carries the real location, so
    // we deliberately do NOT map company.city → HubSpot `city` to avoid
    // writing a misleading value. HubSpot users can parse the address field.
    if (cls.rating != null) props.rating = String(cls.rating);
    if (cls.reviews != null) props.reviews = String(cls.reviews);
    if (company.vertical) props.vertical = company.vertical;
    if (signals.length) props.signalssummary = signals.map((s) => `• ${s}`).join('\n');
    return props;
}

// Push one already-loaded company record. Best-effort on contacts + note:
// a single contact or note failure is captured, never aborts the company.
async function pushCompany(company) {
    const domain = (company.domain || '').toLowerCase();
    if (!domain) {
        return { companyId: company.id, skipped: true, reason: 'no domain' };
    }

    const cls = company.classification || {};
    // Capture the prior sync time BEFORE we write back the company - it drives
    // the note-staleness check below.
    const lastSync = company.hubspotSyncedAt || 0;
    const errors = [];

    // 1. Company upsert (dedupe by domain or a stored hubspotId).
    const { id: hubspotCompanyId, created } = await hubspot.upsertCompany({
        domain,
        properties: companyProps(company),
        knownId: company.hubspotId || null,
    });
    // Demo mode is a pure no-op preview - don't persist the stub id back onto
    // the record (it would render a misleading "HubSpot" synced badge).
    if (!isDemo()) await companiesStore.setCompanyHubspot(company.id, { hubspotId: hubspotCompanyId, syncedAt: Date.now() });

    // 2. Contacts: every lead with an email (the operator-chosen gate).
    const leads = Array.isArray(company.leads) ? company.leads : [];
    const withEmail = leads.filter((l) => l && l.email);
    let pushedContacts = 0;
    const contactErrors = [];
    for (const lead of withEmail) {
        try {
            const cprops = { email: lead.email };
            if (lead.firstName) cprops.firstname = lead.firstName;
            if (lead.lastName) cprops.lastname = lead.lastName;
            if (lead.title) cprops.jobtitle = lead.title;
            if (lead.phone) cprops.phone = lead.phone;
            if (lead.linkedinUrl) cprops.hs_linkedin_url = lead.linkedinUrl;
            // Deliberately NOT setting hs_lead_status: it's an optional,
            // portal-customized dropdown (this portal uses "New", "Working",
            // etc. - the default "NEW" value is rejected). Leave it for the
            // operator's HubSpot workflows to set, so the push stays portable.
            const { id: contactId } = await hubspot.upsertContactByEmail(cprops);
            await hubspot.associateContactToCompany(contactId, hubspotCompanyId);
            if (!isDemo()) await companiesStore.setLeadHubspot(company.id, lead.apolloId || lead.email, { hubspotId: contactId, syncedAt: Date.now() });
            pushedContacts++;
        } catch (e) {
            contactErrors.push({ email: lead.email, error: e.message });
        }
    }

    // 3. Note: only (re)create when the classification is newer than the last
    // sync, so repeated pushes of an unchanged company don't stack notes.
    let noteCreated = false;
    const hasNoteContent = !!cls.report || (Array.isArray(cls.key_quotes) && cls.key_quotes.length > 0);
    const classifiedAt = cls.classifiedAt || 0;
    if (hasNoteContent && classifiedAt >= lastSync) {
        try {
            await hubspot.createNote({ companyId: hubspotCompanyId, html: buildNoteHtml(company, cls) });
            noteCreated = true;
        } catch (e) {
            errors.push(`note: ${e.message}`);
        }
    }

    return {
        companyId: company.id,
        hubspotId: hubspotCompanyId,
        created,
        contacts: {
            pushed: pushedContacts,
            withoutEmail: leads.length - withEmail.length,
            failed: contactErrors.length,
            errors: contactErrors,
        },
        note: { created: noteCreated },
        errors,
    };
}

async function loadCompany(id) {
    const data = await companiesStore.readAll();
    return (data.companies || []).find((c) => c.id === id) || null;
}

// ─── GET /api/hubspot/health ──────────────────────────────────────────────
// Token presence + a cheap account ping. Drives the Admin connection panel.
router.get('/health', async (_req, res) => {
    const connected = hubspot.hasToken();
    // mode + modePinnedByEnv are diagnostics: if a push "does nothing" with no
    // error, it's a demo no-op. modePinnedByEnv:true confirms BLUEBIRD_MODE is
    // being read by THIS running build (so you can tell a stale deploy from a
    // wrong env value).
    const out = { success: true, connected, demo: isDemo(), mode: isDemo() ? 'demo' : 'real', modePinnedByEnv: isPinned() };
    if (connected && !isDemo()) {
        try {
            const acct = await hubspot.accountPing();
            out.portal = { portalId: acct?.portalId, uiDomain: acct?.uiDomain, timeZone: acct?.timeZone };
        } catch (e) {
            out.connected = false;
            out.error = e.message;
        }
    }
    res.json(out);
});

// ─── POST /api/hubspot/push/:companyId ──────────────────────────────────────
router.post('/push/:companyId', trackActivity('hubspot_push'), async (req, res) => {
    if (!keyOk(req)) return res.status(401).json({ success: false, error: 'Invalid or missing API key' });
    const startedAt = Date.now();
    try {
        const company = await loadCompany(req.params.companyId);
        if (!company) return res.status(404).json({ success: false, error: 'Company not found' });
        console.log(`[HubSpot] ▶ push company ${company.id} (${company.domain || 'no-domain'})`);
        const result = await pushCompany(company);
        console.log(`[HubSpot] ✓ push ${company.id} in ${Date.now() - startedAt}ms`, result.skipped ? `skipped: ${result.reason}` : `hubspotId=${result.hubspotId} contacts=${result.contacts.pushed}`);
        if (result.skipped) return res.status(422).json({ success: false, error: `Skipped: ${result.reason}`, ...result });
        return res.json({ success: true, ...result });
    } catch (err) {
        console.error(`[HubSpot] ✗ push error after ${Date.now() - startedAt}ms:`, err.message);
        const status = err.code === 'NO_TOKEN' ? 400 : (err.status && err.status < 500 ? err.status : 500);
        return res.status(status).json({ success: false, error: err.message, reason: err.reason || null });
    }
});

// ─── POST /api/hubspot/push  { companyIds: [] } ─────────────────────────────
// Bulk push. Best-effort per company; one failure never aborts the batch.
// Emits a lightweight realtime progress event for larger runs.
router.post('/push', trackActivity('hubspot_push'), async (req, res) => {
    if (!keyOk(req)) return res.status(401).json({ success: false, error: 'Invalid or missing API key' });
    const ids = Array.isArray(req.body?.companyIds) ? req.body.companyIds.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ success: false, error: 'companyIds (non-empty array) is required' });

    const startedAt = Date.now();
    console.log(`[HubSpot] ▶ bulk push ${ids.length} companies`);
    const io = realtime.getIO();
    const emit = (payload) => { if (io && ids.length > 10) io.emit('hubspot_progress', payload); };

    const data = await companiesStore.readAll();
    const byId = new Map((data.companies || []).map((c) => [c.id, c]));

    const pushed = [];
    const skipped = [];
    const errors = [];
    let processed = 0;
    for (const id of ids) {
        const company = byId.get(id);
        if (!company) { errors.push({ id, error: 'not found' }); processed++; emit({ processed, total: ids.length, id, status: 'error' }); continue; }
        try {
            const result = await pushCompany(company);
            if (result.skipped) skipped.push({ id, reason: result.reason });
            else pushed.push({ id, hubspotId: result.hubspotId, contacts: result.contacts.pushed });
            emit({ processed: processed + 1, total: ids.length, id, status: result.skipped ? 'skipped' : 'pushed' });
        } catch (e) {
            errors.push({ id, error: e.message });
            emit({ processed: processed + 1, total: ids.length, id, status: 'error' });
        }
        processed++;
    }
    console.log(`[HubSpot] ✓ bulk push ${Date.now() - startedAt}ms | pushed=${pushed.length} skipped=${skipped.length} errors=${errors.length}`);
    return res.json({ success: true, pushed, skipped, errors, total: ids.length });
});

module.exports = router;
