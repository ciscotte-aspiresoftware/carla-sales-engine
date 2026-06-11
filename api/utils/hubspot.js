// HubSpot CRM client (Private App token).
//
// One-way push of Atlas companies + their contacts into HubSpot. Mirrors the
// house style of utils/apollo.js / utils/firecrawl.js: read the key from env
// at module load, plain axios calls, errors classified (401 auth / 403 scope /
// 429 rate-limit), and every call fed to recordUsage() for the Costs page.
//
// Auth: a HubSpot Private App access token in HUBSPOT_PRIVATE_APP_TOKEN. The
// app needs these scopes on the private app:
//   crm.objects.companies.read  crm.objects.companies.write
//   crm.objects.contacts.read   crm.objects.contacts.write
// (notes/engagements ride on the contacts/companies scopes).
//
// Demo mode (utils/mode.js): every network function short-circuits to a canned
// id and writes NOTHING to HubSpot - a push in demo mode is a no-op the UI can
// still exercise. Real writes only happen in real mode with a token present.

const axios = require('axios');
const { recordUsage, priceService } = require('./api-cost');
const { isDemo } = require('./mode');

const TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN || '';
const BASE = 'https://api.hubapi.com';

// Note→Company default association (HUBSPOT_DEFINED). Stable across portals.
const NOTE_TO_COMPANY_TYPE_ID = 190;

function hasToken() {
    return !!TOKEN;
}

// Build the axios config with auth + json headers. Throws loudly when the
// token is missing in real mode so the route returns a clear 4xx rather than
// a confusing 401 from HubSpot.
function authConfig(extra = {}) {
    if (!TOKEN) {
        const err = new Error('HUBSPOT_PRIVATE_APP_TOKEN is not set - cannot reach HubSpot.');
        err.code = 'NO_TOKEN';
        throw err;
    }
    return {
        baseURL: BASE,
        headers: {
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': 'application/json',
        },
        ...extra,
    };
}

// Normalize a HubSpot axios error into an Error carrying .status and a
// human-readable message. 401/403 are auth/scope problems (operator must fix
// the private app); 429 is a transient rate-limit the caller can choose to
// soften. Everything else is surfaced verbatim.
function hsError(operation, error) {
    const status = error.response?.status;
    const body = error.response?.data;
    const msg = body?.message || error.message || 'HubSpot request failed';
    const e = new Error(`HubSpot ${operation}: ${msg}`);
    e.status = status;
    e.hubspot = true;
    if (status === 401) e.reason = 'auth';        // bad/expired token
    else if (status === 403) e.reason = 'scope';  // missing scope
    else if (status === 429) e.reason = 'rate';   // rate limited
    return e;
}

// Fire-and-forget usage row so the Costs page shows HubSpot call volume.
// HubSpot is subscription-priced (no per-call charge) so usdCost is 0; the
// value here is the `units` count, not the dollar amount.
function track(operation, durationMs, metadata) {
    recordUsage({
        service: 'hubspot',
        operation,
        units: 1,
        usdCost: priceService('hubspot', 1),
        durationMs,
        metadata: metadata || {},
    });
}

// ─── Account ping (health) ───────────────────────────────────────────────
// GET /account-info/v3/details → portalId, timeZone, accountType, uiDomain.
async function accountPing() {
    if (isDemo()) return { demo: true, portalId: 'demo-portal' };
    const startedAt = Date.now();
    try {
        const { data } = await axios.get('/account-info/v3/details', authConfig());
        track('account_ping', Date.now() - startedAt, { portalId: data?.portalId });
        return data;
    } catch (error) {
        throw hsError('account ping', error);
    }
}

// ─── Company upsert (dedupe by domain) ────────────────────────────────────
// Search by exact domain first; PATCH when found (or when a knownId is passed
// from a prior sync), else POST. Returns { id, created }.
async function searchCompanyByDomain(domain) {
    if (!domain) return null;
    if (isDemo()) return null;
    const startedAt = Date.now();
    try {
        const { data } = await axios.post('/crm/v3/objects/companies/search', {
            filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'EQ', value: String(domain).toLowerCase() }] }],
            properties: ['domain', 'name'],
            limit: 1,
        }, authConfig());
        track('company_search', Date.now() - startedAt, { domain });
        return data?.results?.[0]?.id ? { id: String(data.results[0].id) } : null;
    } catch (error) {
        throw hsError('company search', error);
    }
}

async function upsertCompany({ domain, properties, knownId = null }) {
    if (isDemo()) return { id: `demo-company-${domain || 'x'}`, created: false, demo: true };
    let id = knownId;
    if (!id) {
        const found = await searchCompanyByDomain(domain);
        if (found) id = found.id;
    }
    const startedAt = Date.now();
    try {
        if (id) {
            const { data } = await axios.patch(`/crm/v3/objects/companies/${encodeURIComponent(id)}`, { properties }, authConfig());
            track('company_update', Date.now() - startedAt, { domain, id });
            return { id: String(data.id), created: false };
        }
        const { data } = await axios.post('/crm/v3/objects/companies', { properties }, authConfig());
        track('company_create', Date.now() - startedAt, { domain });
        return { id: String(data.id), created: true };
    } catch (error) {
        throw hsError('company upsert', error);
    }
}

// ─── Contact upsert (by email) ────────────────────────────────────────────
// HubSpot enforces email uniqueness, so the batch upsert endpoint with
// idProperty=email is the clean create-or-update: existing contact → updated,
// new email → created. Returns { id, created }.
async function upsertContactByEmail(properties) {
    const email = properties?.email;
    if (!email) {
        const err = new Error('contact upsert requires an email');
        err.reason = 'validation';
        throw err;
    }
    if (isDemo()) return { id: `demo-contact-${email}`, created: false, demo: true };
    const startedAt = Date.now();
    try {
        const { data } = await axios.post('/crm/v3/objects/contacts/batch/upsert', {
            inputs: [{ idProperty: 'email', id: email, properties }],
        }, authConfig());
        const result = data?.results?.[0];
        track('contact_upsert', Date.now() - startedAt, { email });
        if (!result?.id) throw new Error('upsert returned no contact id');
        // `new` is 'COMPLETE' for both; HubSpot doesn't flag created-vs-updated
        // here, so we report created:false (the field is informational only).
        return { id: String(result.id), created: false };
    } catch (error) {
        throw hsError('contact upsert', error);
    }
}

// ─── Association (contact → company, default label) ───────────────────────
// v4 default association needs no association-type id. Idempotent: re-PUTting
// an existing association is a no-op on HubSpot's side.
async function associateContactToCompany(contactId, companyId) {
    if (isDemo()) return true;
    const startedAt = Date.now();
    try {
        await axios.put(
            `/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/default/companies/${encodeURIComponent(companyId)}`,
            {},
            authConfig(),
        );
        track('associate', Date.now() - startedAt, { contactId, companyId });
        return true;
    } catch (error) {
        throw hsError('associate contact→company', error);
    }
}

// ─── Note (timeline engagement on the company) ────────────────────────────
// Notes require hs_timestamp + the association at creation time. html is the
// note body (HubSpot renders a safe subset of HTML in hs_note_body).
async function createNote({ companyId, html, timestampMs = null }) {
    if (isDemo()) return { id: `demo-note-${companyId}`, demo: true };
    const startedAt = Date.now();
    try {
        const { data } = await axios.post('/crm/v3/objects/notes', {
            properties: {
                hs_note_body: html,
                hs_timestamp: new Date(timestampMs || Date.now()).toISOString(),
            },
            associations: [{
                to: { id: String(companyId) },
                types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_COMPANY_TYPE_ID }],
            }],
        }, authConfig());
        track('note_create', Date.now() - startedAt, { companyId });
        return { id: String(data.id) };
    } catch (error) {
        throw hsError('note create', error);
    }
}

module.exports = {
    hasToken,
    accountPing,
    searchCompanyByDomain,
    upsertCompany,
    upsertContactByEmail,
    associateContactToCompany,
    createNote,
};
