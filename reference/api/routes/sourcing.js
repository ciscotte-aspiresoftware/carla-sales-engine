// /api/sourcing/* - fresh-lead pipeline for Bluebird.
//
// Endpoints:
//   GET  /api/sourcing/cities          - prefilled city dropdown options
//   POST /api/sourcing/search          - Scrapingdog Search API (5 credits)
//   POST /api/sourcing/details         - Scrapingdog Places API (5 credits)
//   POST /api/sourcing/promote         - push a result into companies.json
//   GET  /api/sourcing/scans           - recent scan history (no credits)

const express = require('express');
const { searchMaps, getPlaceDetails } = require('../utils/scrapingdog');
const { CITIES, getCity } = require('../utils/cities');
const { extractDomain, isChain, isTargetType } = require('../utils/chains');
const sources = require('../utils/sources-store');
const { upsertCompany } = require('./companies');
const mode = require('../utils/mode');
const { sourcingSearchStub, placeDetailsStub } = require('../utils/demo-stubs');

const router = express.Router();

// ─── GET /cities ─────────────────────────────────────────────────────────
// Static dropdown options. Frontend caches this once on mount.
router.get('/cities', (req, res) => {
    res.json({ success: true, cities: CITIES });
});

// ─── POST /search ────────────────────────────────────────────────────────
// Body: { cityKey?, point?: { lat, lng, label? }, query?, page? }
// Two input modes - exactly one required:
//   - cityKey: pick from prefilled CITIES (US/UK/Canada)
//   - point:   free-form lat/lng from a globe click; we synthesize the ll
//              string and default country='us' since Scrapingdog needs one.
//              The optional `label` is used for scan-history display.
router.post('/search', async (req, res) => {
    const { cityKey, point, query, page } = req.body || {};
    const effectiveQuery = (query && String(query).trim()) || 'car rental';
    const effectivePage = Number.isInteger(page) ? page : 0;

    // Resolve to a uniform "scan target" object regardless of input mode.
    let target;
    if (cityKey) {
        const city = getCity(cityKey);
        if (!city) return res.status(400).json({ success: false, error: `Unknown cityKey: ${cityKey}` });
        target = {
            label: city.label,
            country: city.country,
            ll: city.ll,
            language: city.language,
            domain: city.domain,
        };
    } else if (point && Number.isFinite(point.lat) && Number.isFinite(point.lng)) {
        // Free-form globe click. Synthesize the ll at zoom 12 (city-level).
        // Country/domain default to US - Scrapingdog accepts cross-region
        // searches and the lat/lng dominates the result location anyway.
        const lat = Number(point.lat).toFixed(4);
        const lng = Number(point.lng).toFixed(4);
        target = {
            label: point.label || `${lat}, ${lng}`,
            country: 'US',
            ll: `@${lat},${lng},12z`,
            language: 'en',
            domain: 'google.com',
        };
    } else {
        return res.status(400).json({ success: false, error: 'Either cityKey or point {lat, lng} is required' });
    }

    if (mode.isDemo()) {
        const stub = sourcingSearchStub(target, effectiveQuery);
        const scan = await sources.appendScan({
            city: target.label,
            country: target.country,
            ll: target.ll,
            query: effectiveQuery,
            page: effectivePage,
            results: stub.results,
            totalRaw: stub.counts.totalRaw,
            chainsFiltered: 0,
            nonTargetFiltered: 0,
        });
        console.log(`[Sourcing /search] demo stub returned for ${target.label} (no Scrapingdog credits spent)`);
        return res.json({
            success: true,
            scanId: scan.id,
            results: stub.results,
            counts: stub.counts,
            target: { label: target.label, country: target.country, ll: target.ll },
            demo: true,
        });
    }

    try {
        const { results: rawResults } = await searchMaps({
            query: effectiveQuery,
            ll: target.ll,
            country: target.country,
            language: target.language,
            domain: target.domain,
            page: effectivePage,
        });

        // Normalize each row to the shape the frontend expects + flag
        // why a row was dropped (chain vs wrong type) so the user can see
        // "filtered 7 chains, 3 non-rentals" in the UI.
        let chainsFiltered = 0;
        let nonTargetFiltered = 0;
        const kept = [];
        for (const r of rawResults) {
            const types = Array.isArray(r.types) ? r.types : (r.type ? [r.type] : []);
            const domain = extractDomain(r.website);
            if (domain && isChain(domain)) { chainsFiltered++; continue; }
            // For results without a website we can't check the chain blocklist,
            // but we can still apply the type filter to keep noise out.
            if (!isTargetType(types)) { nonTargetFiltered++; continue; }
            kept.push({
                title: r.title || '',
                placeId: r.place_id || '',
                dataId: r.data_id || '',
                website: r.website || '',
                domain,
                phone: r.phone || '',
                address: r.address || '',
                rating: r.rating ?? null,
                reviews: r.reviews ?? null,
                primaryType: r.type || '',
                allTypes: types,
                description: r.description || '',
                hours: r.open_state || r.hours || '',
                gps: r.gps_coordinates || null,
                thumbnail: r.thumbnail || '',
            });
        }

        const scan = await sources.appendScan({
            city: target.label,
            country: target.country,
            ll: target.ll,
            query: effectiveQuery,
            page: effectivePage,
            results: kept,
            totalRaw: rawResults.length,
            chainsFiltered,
            nonTargetFiltered,
        });

        return res.json({
            success: true,
            scanId: scan.id,
            results: kept,
            counts: {
                totalRaw: rawResults.length,
                keptCount: kept.length,
                chainsFiltered,
                nonTargetFiltered,
            },
            target: { label: target.label, country: target.country, ll: target.ll },
        });
    } catch (err) {
        console.error('[Sourcing /search]', err.response?.data || err.message);
        return res.status(500).json({ success: false, error: err.message || 'Search failed' });
    }
});

// ─── POST /details ───────────────────────────────────────────────────────
// Body: { dataId }
// Calls Scrapingdog /google_maps/places for one place. First checks the
// sources.json cache so re-clicks on the same row don't re-spend credits.
router.post('/details', async (req, res) => {
    const { dataId } = req.body || {};
    if (!dataId) return res.status(400).json({ success: false, error: 'dataId required' });

    try {
        const cached = await sources.getPlaceDetails(dataId);
        if (cached?.data) {
            console.log(`[Sourcing /details] cache hit for ${dataId}`);
            return res.json({ success: true, details: cached.data, cached: true, fetchedAt: cached.fetchedAt });
        }

        if (mode.isDemo()) {
            const details = placeDetailsStub();
            console.log(`[Sourcing /details] demo stub returned for ${dataId} (no Scrapingdog credits spent)`);
            return res.json({ success: true, details, cached: false, demo: true });
        }

        const { place } = await getPlaceDetails(dataId);
        if (!place) return res.status(404).json({ success: false, error: 'Place not found in Scrapingdog' });

        // Trim to fields actually useful for car rental sales - Places API
        // returns lots of restaurant-tuned extensions that would just be
        // empty arrays for rentals. Keep raw under `_raw` for the curious.
        const trimmed = {
            title: place.title || '',
            rating: place.rating ?? null,
            reviews: place.reviews ?? null,
            ratingSummary: Array.isArray(place.rating_summary) ? place.rating_summary : [],
            phone: place.phone || '',
            address: place.adderss || place.address || '', // typo in Scrapingdog response
            types: Array.isArray(place.type) ? place.type : (place.type ? [place.type] : []),
            serviceOptions: place.service_options || {},
            extensions: Array.isArray(place.extensions) ? place.extensions : [],
            unsupportedExtensions: Array.isArray(place.unsupported_extensions) ? place.unsupported_extensions : [],
            gps: place.gps_coordinates || null,
            _raw: place,
        };

        await sources.setPlaceDetails(dataId, trimmed);
        return res.json({ success: true, details: trimmed, cached: false });
    } catch (err) {
        console.error('[Sourcing /details]', err.response?.data || err.message);
        return res.status(500).json({ success: false, error: err.message || 'Details failed' });
    }
});

// ─── POST /promote ───────────────────────────────────────────────────────
// Body: { result: <Search-API-row>, scanId? }
// Promotes a sourcing row into companies.json so the Sales Agent flow can
// pick it up. Idempotent - re-promoting the same domain just updates the
// existing record. Returns the companyId so the frontend can navigate.
router.post('/promote', async (req, res) => {
    const { result, scanId } = req.body || {};
    if (!result || (!result.website && !result.title)) {
        return res.status(400).json({ success: false, error: 'result with website or title required' });
    }

    const url = result.website && /^https?:\/\//i.test(result.website)
        ? result.website
        : (result.website ? `https://${result.website}` : '');
    const domain = result.domain || extractDomain(url);

    try {
        // We're seeding a "pre-classification" record so the Sales Agent's
        // history view shows it immediately. Once the user actually runs
        // Analyze on this URL, the classifier will overwrite the
        // `classification` field with real data.
        const company = await upsertCompany({
            url,
            domain,
            classification: {
                isCarRental: true, // we already filtered to car rentals
                isIndependent: true, // chains were dropped
                confidence: 'low', // we haven't actually classified the site yet
                name: result.title || '',
                tagline: result.description || '',
                country: '',
                city: '',
                languages: [],
                fleetSizeHint: 'unknown',
                fleetVehicleTypes: [],
                hasOnlineBooking: false,
                bookingPlatformHints: [],
                phone: result.phone || '',
                email: '',
                domain,
                signals: [
                    result.address ? `Address: ${result.address}` : null,
                    (result.rating != null && result.reviews != null) ? `Google rating: ${result.rating} (${result.reviews} reviews)` : null,
                    result.primaryType ? `Listed as: ${result.primaryType}` : null,
                ].filter(Boolean),
                reasoning: 'Seeded from Google Maps sourcing - re-run Analyze on the URL to classify properly.',
            },
            scrapedAt: 0, // 0 means "never classified" - the Analyze button on Sales Agent flips this
            source: {
                type: 'scrapingdog-maps',
                scanId: scanId || null,
                dataId: result.dataId || null,
                placeId: result.placeId || null,
                promotedAt: Date.now(),
            },
        });

        return res.json({ success: true, companyId: company.id, url, alreadyExisted: company.scrapedAt > 0 });
    } catch (err) {
        console.error('[Sourcing /promote]', err.message);
        return res.status(500).json({ success: false, error: err.message || 'Promote failed' });
    }
});

// ─── GET /scans ──────────────────────────────────────────────────────────
// Recent scan history for the "Recent scans" footer on the page.
router.get('/scans', async (req, res) => {
    try {
        const scans = await sources.listScans({ limit: 10 });
        res.json({ success: true, scans });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── GET /scans/:id ──────────────────────────────────────────────────────
// Open a past scan - returns the stored results without spending credits.
router.get('/scans/:id', async (req, res) => {
    try {
        const scan = await sources.getScan(req.params.id);
        if (!scan) return res.status(404).json({ success: false, error: 'Scan not found' });
        res.json({ success: true, scan });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
