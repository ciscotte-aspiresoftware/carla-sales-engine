// POST /api/apollo/webhook - receives waterfall enrichment results from Apollo.
// Apollo's waterfall phone enrichment is async: the client initiates a request,
// Apollo enriches the phone in the background, and POSTs the result here.
// We extract the phone and update the lead record.

const express = require('express');
const { upsertLeadInCompany } = require('./companies');
const { consumePendingEnrichment } = require('../utils/apollo');

const router = express.Router();

// Pull the first usable number out of a phone_numbers array.
function pickFromPhoneArray(arr) {
    if (!Array.isArray(arr)) return null;
    for (const p of arr) {
        if (typeof p === 'string' && p.trim()) return p.trim();
        const n = p?.sanitized_number || p?.raw_number || p?.number;
        if (n) return String(n);
    }
    return null;
}

// Extract the primary phone from Apollo's webhook payload. Apollo's actual
// shape nests phone_numbers inside people[] (verified against the docs:
// { status, people: [ { phone_numbers: [ { sanitized_number, raw_number } ] } ] }),
// but the native vs waterfall formats differ and aren't fully documented, so we
// check every known location and fall back to a recursive scan for ANY
// phone_numbers array. This makes the extractor robust to whichever shape
// Apollo actually sends, instead of silently returning null and hanging.
function extractWaterfallPhone(payload) {
    if (!payload || typeof payload !== 'object') return null;

    // 1. people[] array (the documented shape) — first person with a number wins.
    if (Array.isArray(payload.people)) {
        for (const person of payload.people) {
            const n = pickFromPhoneArray(person?.phone_numbers);
            if (n) return n;
        }
    }
    // 2. single person object.
    const fromPerson = pickFromPhoneArray(payload.person?.phone_numbers);
    if (fromPerson) return fromPerson;
    // 3. top-level phone_numbers (older assumption).
    const fromTop = pickFromPhoneArray(payload.phone_numbers);
    if (fromTop) return fromTop;
    // 4. contact subobject.
    const fromContact = pickFromPhoneArray(payload.contact?.phone_numbers);
    if (fromContact) return fromContact;

    // 5. Last resort: recursively scan for any phone_numbers array anywhere in
    // the payload (covers waterfall vendor-nested shapes we haven't seen).
    let found = null;
    const seen = new Set();
    (function scan(node, depth) {
        if (found || !node || typeof node !== 'object' || depth > 6 || seen.has(node)) return;
        seen.add(node);
        if (Array.isArray(node.phone_numbers)) {
            const n = pickFromPhoneArray(node.phone_numbers);
            if (n) { found = n; return; }
        }
        for (const v of Array.isArray(node) ? node : Object.values(node)) {
            if (v && typeof v === 'object') scan(v, depth + 1);
        }
    })(payload, 0);
    return found;
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
