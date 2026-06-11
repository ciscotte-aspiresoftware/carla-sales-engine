// POST /api/apollo/webhook - receives waterfall enrichment results from Apollo.
// Apollo's waterfall phone enrichment is async: the client initiates a request,
// Apollo enriches the phone in the background, and POSTs the result here.
// We extract the phone and update the lead record.

const express = require('express');
const { upsertLeadInCompany } = require('./companies');
const { consumePendingEnrichment } = require('../utils/apollo');

const router = express.Router();

// Rank an Apollo phone entry's type so we prefer the person's CELL/mobile over
// a work/HQ/business line. Lower score = more preferred. Apollo's type_cd values
// include "mobile", "work_hq", "work", "home", "other", "direct"/"direct_dial".
function phoneTypeRank(entry) {
    const t = String(entry?.type_cd || entry?.type || '').toLowerCase();
    if (t.includes('mobile') || t.includes('cell')) return 0;          // the cell — what we want
    if (t.includes('direct')) return 1;                                // direct dial to the person
    if (t === '' || t === 'other' || t == null) return 2;              // unknown — could be a cell
    if (t.includes('home')) return 3;
    return 4;                                                          // work_hq / work / business line
}

function numberOf(entry) {
    if (typeof entry === 'string') return entry.trim() || null;
    return entry?.sanitized_number || entry?.raw_number || entry?.number || null;
}

// Collect every phone entry from a phone_numbers array (skips empties).
function collectFromArray(arr, out) {
    if (!Array.isArray(arr)) return;
    for (const p of arr) {
        if (numberOf(p)) out.push(p);
    }
}

// Extract the best phone from Apollo's webhook payload, preferring the person's
// mobile/cell. Apollo's actual shape nests phone_numbers inside people[]
// (verified against the docs: { status, people: [ { phone_numbers: [...] } ] }),
// but native vs waterfall formats differ and aren't fully documented, so we
// gather candidates from every known location plus a recursive fallback, then
// rank by type so the cell wins over a business/HQ line.
function extractWaterfallPhone(payload) {
    if (!payload || typeof payload !== 'object') return null;

    const candidates = [];
    if (Array.isArray(payload.people)) {
        for (const person of payload.people) collectFromArray(person?.phone_numbers, candidates);
    }
    collectFromArray(payload.person?.phone_numbers, candidates);
    collectFromArray(payload.phone_numbers, candidates);
    collectFromArray(payload.contact?.phone_numbers, candidates);

    // Recursive fallback: gather any phone_numbers array anywhere in the payload
    // (covers undocumented waterfall vendor-nested shapes).
    if (candidates.length === 0) {
        const seen = new Set();
        (function scan(node, depth) {
            if (!node || typeof node !== 'object' || depth > 6 || seen.has(node)) return;
            seen.add(node);
            if (Array.isArray(node.phone_numbers)) collectFromArray(node.phone_numbers, candidates);
            for (const v of Array.isArray(node) ? node : Object.values(node)) {
                if (v && typeof v === 'object') scan(v, depth + 1);
            }
        })(payload, 0);
    }

    if (candidates.length === 0) return null;
    // Prefer the cell. Stable sort keeps Apollo's own ordering within a tier.
    candidates.sort((a, b) => phoneTypeRank(a) - phoneTypeRank(b));
    return numberOf(candidates[0]);
}

// POST /api/apollo/webhook
// Apollo's actual phone-enrichment webhook payload (verified against docs):
// {
//   status: "success",
//   request_id: "...",                       // waterfall format; top-level
//   people: [ { id, status, phone_numbers: [ { sanitized_number, raw_number, status_cd } ] } ],
//   ...metadata (credits_consumed, vendor details, target_fields)
// }
router.post('/webhook', async (req, res) => {
    const payload = req.body;
    // Log the raw payload (truncated) so we can see Apollo's actual waterfall
    // shape in production — the native vs waterfall formats differ and the docs
    // are inconsistent. Remove or downgrade once the shape is confirmed stable.
    const rawForLog = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(payload);
    console.log(`[Apollo] webhook payload (${rawForLog.length}b): ${rawForLog.slice(0, 1500)}`);
    // Extract request_id from the RAW body first (precision-safe), symmetric with
    // how enrichPersonWithWaterfall registers it. Apollo's request_ids are 64-bit
    // integers > Number.MAX_SAFE_INTEGER; if Apollo ever POSTs request_id as a JSON
    // number, express.json's JSON.parse truncates it and the parsed value can never
    // match the registered string key. The raw regex avoids that entirely. Falls
    // back to the parsed value only if the raw buffer is unavailable.
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
    const ridMatch = /"request_id"\s*:\s*"?(-?\d+)"?/.exec(rawBody);
    const requestId = ridMatch ? ridMatch[1] : (payload?.request_id != null ? String(payload.request_id) : '');

    if (!requestId || requestId === 'undefined') {
        console.warn('[Apollo] webhook received without request_id');
        return res.status(400).json({ success: false, error: 'request_id required' });
    }

    // Look up which lead this request_id corresponds to.
    const pending = consumePendingEnrichment(requestId);
    if (!pending) {
        // Request not found (expired, never registered, or duplicate). Not an error—
        // just means we discarded it or this is a late/duplicate webhook fire.
        console.warn(`[Apollo] webhook request_id ${requestId} not in pending map`);
        return res.status(200).json({ success: true, message: 'request not in pending map' });
    }

    const { apolloId, companyId } = pending;
    const phone = extractWaterfallPhone(payload);

    try {
        // Update the lead with the phone (and phoneCheckedAt timestamp).
        const patch = { phoneCheckedAt: Date.now() };
        if (phone) patch.phone = phone;

        // Use the existing upsertLeadInCompany which handles both JSON and Supabase.
        const updated = await upsertLeadInCompany(companyId, apolloId, patch);
        if (!updated) {
            console.warn(`[Apollo] webhook: lead ${apolloId} not found in company ${companyId}`);
            return res.status(404).json({ success: false, error: 'Lead not found' });
        }

        console.log(`[Apollo] ✓ webhook processed for ${apolloId}: phone=${phone || '(none)'}`);
        return res.json({ success: true, phone });
    } catch (error) {
        console.error('[Apollo] webhook processing error:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
