// POST /api/apollo/webhook - receives waterfall enrichment results from Apollo.
// Apollo's waterfall phone enrichment is async: the client initiates a request,
// Apollo enriches the phone in the background, and POSTs the result here.
// We extract the phone and update the lead record.

const express = require('express');
const companiesStore = require('./companies');
const { consumePendingEnrichment } = require('../utils/apollo');

const router = express.Router();

// Extract the primary phone from Apollo's waterfall response.
function extractWaterfallPhone(payload) {
    if (!payload) return null;
    // Apollo sends phone_numbers array with {sanitized_number, raw_number, ...}
    const phoneNumbers = Array.isArray(payload.phone_numbers) ? payload.phone_numbers : [];
    if (phoneNumbers.length === 0) return null;
    const first = phoneNumbers[0];
    return first?.sanitized_number || first?.raw_number || null;
}

// POST /api/apollo/webhook
// Payload (from Apollo docs):
// {
//   request_id: "...",
//   person: {...},
//   phone_numbers: [{sanitized_number, raw_number, ...}, ...],
//   status: "success" | "not_found",
//   ... (metadata)
// }
router.post('/webhook', async (req, res) => {
    const payload = req.body;
    const requestId = payload?.request_id;

    if (!requestId) {
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

    const { apolloId, companyId, leadKey } = pending;
    const phone = extractWaterfallPhone(payload);

    try {
        // Update the lead with the phone (and phoneCheckedAt timestamp).
        const patch = { phoneCheckedAt: Date.now() };
        if (phone) patch.phone = phone;

        // Import upsertLeadInCompany at the top if needed, or use a helper here.
        // For now, access the store directly via companiesStore.
        const allData = await companiesStore.readAll();
        const companies = allData.companies || [];
        const company = companies.find(c => c.id === companyId);

        if (!company) {
            console.warn(`[Apollo] webhook: company ${companyId} not found`);
            return res.status(404).json({ success: false, error: 'Company not found' });
        }

        // Find and update the lead.
        const leadIndex = (company.leads || []).findIndex(l => l.apolloId === apolloId || l.email === leadKey);
        if (leadIndex === -1) {
            console.warn(`[Apollo] webhook: lead not found in company ${companyId}`);
            return res.status(404).json({ success: false, error: 'Lead not found' });
        }

        company.leads[leadIndex] = { ...company.leads[leadIndex], ...patch };
        await companiesStore.writeAll({ companies });

        console.log(`[Apollo] ✓ webhook processed for ${apolloId}: phone=${phone || '(none)'}`);
        return res.json({ success: true, phone });
    } catch (error) {
        console.error('[Apollo] webhook processing error:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
