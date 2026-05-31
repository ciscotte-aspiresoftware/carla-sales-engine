// Per-cell sweep pipeline. Given an ICP + a single grid cell, this:
//   1. Marks cell `scanning`
//   2. Calls Scrapingdog Search at the cell's lat/lng with the ICP's
//      first searchTerm
//   3. Filters out chains + non-target types via the existing chains.js
//      blocklist/allowlist
//   4. Dedupes against the existing companies.json (skip already-classified
//      domains - saves Firecrawl + GPT credits)
//   5. For each new survivor: Firecrawl scrape → GPT classify (using
//      ICP.classifyPrompt) → upsertCompany with classification + source tag
//   6. Updates the cell with placesFound, leadsQualified, state=
//      `complete | empty` based on what came back
//
// Errors during scrape/classify on individual places don't kill the cell -
// they get logged and skipped, and the rest of the place list continues.
// A hard error (Scrapingdog 5xx, all Firecrawl keys exhausted, OpenAI
// auth fail) bails the whole cell back to `pending` so the next cron tick
// retries fresh.

const { searchMaps } = require('./scrapingdog');
const { extractDomain, isChain, isTargetType } = require('./chains');
const { scrapeUrl } = require('./firecrawl');
const { chat } = require('./openai');
const grid = require('./grid-store');
const { upsertCompany, attachLeads, setClassificationForIcp, isDemoRecord } = require('../routes/companies');
const { pushEvent } = require('./activity-log');
const scrapeCache = require('./scrape-cache');
const searchLog = require('./search-log');
const { listIcps, getIcp } = require('./icps');
const mode = require('./mode');
const fs = require('fs');
const path = require('path');

// Read companies.json once per sweep so we can dedupe by domain. The file
// is tiny (~few KB until much later) so reading it per cell is fine.
//
// Real mode skips demo-seeded records when building the dedupe set so a
// genuine sweep at a city we have demo data for (e.g. Cambridge with 161
// fixture rentals) doesn't dedup against the fixtures and find zero
// fresh survivors. The fixtures stay on disk (so demo mode can still
// see them) — they just don't influence real-mode dedup.
async function loadKnownDomains() {
    const FILE = path.resolve(__dirname, '..', 'data', 'companies.json');
    if (!fs.existsSync(FILE)) return new Set();
    try {
        const raw = await fs.promises.readFile(FILE, 'utf8');
        const data = JSON.parse(raw);
        const eligible = mode.isReal()
            ? (data.companies || []).filter(c => !isDemoRecord(c))
            : (data.companies || []);
        return new Set(eligible
            .map(c => (c.domain || '').toLowerCase())
            .filter(Boolean));
    } catch {
        return new Set();
    }
}

// GPT classify wrapper - uses the ICP's classifyPrompt, returns a parsed
// {is_match: bool, reason: string}. On parse failure or any error,
// returns { is_match: false, reason: <error> } so the caller can move on
// without blowing up the whole sweep.
async function classify(markdown, pageTitle, classifyPrompt) {
    if (!markdown) return { is_match: false, reason: 'no markdown returned from scraper' };
    const trimmed = markdown.length > 12000 ? markdown.slice(0, 12000) : markdown; // cap context

    const messages = [
        { role: 'system', content: classifyPrompt },
        { role: 'user', content: `Page title: ${pageTitle || '(none)'}\n\nPage content:\n${trimmed}` },
    ];
    try {
        const raw = await chat(messages, {
            temperature: 0.2,
            response_format: { type: 'json_object' },
        });
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch { return { is_match: false, reason: `classifier returned non-JSON: ${raw.slice(0, 100)}` }; }
        return {
            is_match: !!parsed.is_match,
            reason: parsed.reason || (parsed.is_match ? 'matched' : 'rejected'),
        };
    } catch (err) {
        return { is_match: false, reason: `classify error: ${err.message}` };
    }
}

// Auto-fanout classifier. After a sweep upserts a company under one ICP,
// every other ICP in the same vertical should also classify it - that's
// the whole point of vertical-keyed pooling. This helper runs each
// sibling ICP's prompt against the company's cached markdown and writes
// the verdict under classifications[siblingIcpId]. No Scrapingdog, no
// Firecrawl, just GPT.
//
// Idempotent: skips siblings that have already classified this domain
// (e.g. from a previous reclassify pass). Safe to call with every domain
// the sweep touched without worrying about duplicate work or extra cost.
//
// Each fanout verdict pushes a `company_qualified` / `company_rejected`
// event with `viaFanout: true` so the activity log can render it
// distinctly from the primary sweep's events. Errors per sibling are
// caught and logged - one bad ICP doesn't kill the fanout for others.
async function fanoutClassify(domain, vertical, primaryIcpId, parentCity) {
    if (!vertical || !domain) return { fannedOut: 0 };
    const cached = await scrapeCache.get(domain);
    if (!cached || !cached.markdown) return { fannedOut: 0 };

    // Find siblings - every ICP in the same vertical other than the one
    // that just classified this company. listIcps returns the trimmed
    // form, so re-fetch each via getIcp to access classifyPrompt.
    const v = String(vertical).toLowerCase();
    const siblingMetas = listIcps().filter(
        (i) => i.id !== primaryIcpId && (i.vertical || '').toLowerCase() === v,
    );
    if (siblingMetas.length === 0) return { fannedOut: 0 };

    let fannedOut = 0;
    for (const meta of siblingMetas) {
        const sibling = getIcp(meta.id);
        if (!sibling || !sibling.classifyPrompt) continue;
        try {
            const verdict = await classify(cached.markdown, cached.pageTitle, sibling.classifyPrompt);
            await setClassificationForIcp(domain, sibling.id, verdict);
            fannedOut++;
            pushEvent({
                type: verdict.is_match ? 'company_qualified' : 'company_rejected',
                icpId: sibling.id,
                cellId: 'fanout',
                parentCity: parentCity || null,
                domain,
                title: cached.pageTitle || domain,
                reason: verdict.reason,
                viaFanout: true,
                message: `${domain} - ${verdict.is_match ? 'qualified' : 'rejected'} (auto-fanout from ${primaryIcpId})`,
            });
        } catch (err) {
            console.warn(`[Fanout] ${domain} for ${sibling.id}: ${err.message}`);
        }
    }
    return { fannedOut };
}

// Run fanout for an array of domains in sequence - protects OpenAI rate
// limits and keeps log output ordered. Called at the end of a sweep cell
// so the cell's primary classifications complete first (immediate user
// feedback), then siblings catch up in the background. The cron is single-
// threaded so this won't slow the next cell unless fanout takes longer
// than the next cell's wall time, which is unlikely (fanout is GPT-only,
// the next cell pays Scrapingdog + Firecrawl too).
async function fanoutForDomains(domains, vertical, primaryIcpId, parentCity) {
    let total = 0;
    for (const d of domains) {
        const { fannedOut } = await fanoutClassify(d, vertical, primaryIcpId, parentCity);
        total += fannedOut;
    }
    return total;
}

async function sweepCell(icp, cell) {
    if (!icp) throw new Error('sweepCell: ICP required');
    if (!cell) throw new Error('sweepCell: cell required');

    // Demo mode: synthesize plausible-looking companies + leads without
    // touching any external API. Useful for UI demos, smoke tests, and
    // letting the operator preview the cell lifecycle (red → green) on
    // the Coverage globe. Flipped from /admin → utils/mode.js.
    if (mode.isDemo()) {
        console.log(`[Sweep DEMO] ▶ ${cell.parentCity}/${cell.id.slice(0, 8)} (${cell.lat}, ${cell.lng}) - ICP=${icp.id}`);
        await grid.updateCell(cell.id, { state: 'scanning', lastScannedAt: Date.now() });
        pushEvent({
            type: 'cell_start',
            icpId: icp.id,
            cellId: cell.id,
            parentCity: cell.parentCity || null,
            message: `Sweeping ${cell.parentCity || 'cell'} (${cell.lat.toFixed(3)}, ${cell.lng.toFixed(3)})`,
        });
        return runDemoSweep(icp, cell);
    }

    // Real mode: the live pipeline. Scrapingdog → chain/type filter →
    // domain dedup against companies.json → per-survivor Firecrawl scrape
    // (cached) → GPT classify → upsertCompany → auto-fanout to sibling
    // ICPs that share this vertical. Credits actually get spent here.
    console.log(`[Sweep] ▶ ${cell.parentCity}/${cell.id.slice(0, 8)} (${cell.lat}, ${cell.lng}) - ICP=${icp.id}`);
    await grid.updateCell(cell.id, { state: 'scanning', lastScannedAt: Date.now() });
    pushEvent({
        type: 'cell_start',
        icpId: icp.id,
        cellId: cell.id,
        parentCity: cell.parentCity || null,
        message: `Sweeping ${cell.parentCity || 'cell'} (${cell.lat.toFixed(3)}, ${cell.lng.toFixed(3)})`,
    });

    let placesFound = 0;
    let leadsQualified = 0;
    let chainsFiltered = 0;
    let nonTargetFiltered = 0;
    let alreadyKnown = 0;
    const touchedDomains = [];

    try {
        // Step 1: Scrapingdog Search (5 credits per term per cell).
        //
        // Term-level dedup via search-log: when a sibling ICP in the same
        // vertical has already searched these coordinates with one of our
        // terms, we skip that term. The previous run's place results are
        // already in companies.json + scrape-cache, so re-searching would
        // just rediscover them at full cost. Net effect: each (vertical,
        // area, term) tuple gets paid for exactly once across all ICPs.
        const allTerms = (icp.searchTerms && icp.searchTerms.length > 0)
            ? icp.searchTerms
            : [icp.vertical || 'business'];
        const newTerms = icp.vertical
            ? searchLog.unmatchedTerms(icp.vertical, cell.lat, cell.lng, allTerms)
            : allTerms;
        const skippedTerms = allTerms.filter((t) => !newTerms.includes(t));
        if (skippedTerms.length > 0) {
            console.log(`[Sweep] ↻ skipping ${skippedTerms.length} term(s) already run for ${icp.vertical} at this location: ${skippedTerms.join(', ')}`);
        }

        pushEvent({
            type: 'places_fetching',
            icpId: icp.id,
            cellId: cell.id,
            parentCity: cell.parentCity || null,
            message: `Fetching places for ${cell.parentCity || 'cell'} (${newTerms.length} term${newTerms.length === 1 ? '' : 's'})`,
        });
        const allRaw = [];
        for (const term of newTerms) {
            const { results: termResults } = await searchMaps({
                query: term,
                ll: cell.ll,
                country: cell.country,
                language: cell.language,
                domain: cell.domain,
                page: 0,
            });
            if (icp.vertical) {
                searchLog.add(icp.vertical, cell.lat, cell.lng, term, {
                    cellId: cell.id,
                    icpId: icp.id,
                    resultCount: (termResults || []).length,
                });
            }
            allRaw.push(...(termResults || []));
        }
        pushEvent({
            type: 'places_fetched',
            icpId: icp.id,
            cellId: cell.id,
            parentCity: cell.parentCity || null,
            placesFound: allRaw.length,
            message: `Found ${allRaw.length} raw places across ${newTerms.length} term${newTerms.length === 1 ? '' : 's'}`,
        });

        // Dedup across terms - different terms can return the same place.
        // Key on data_id when available, falling back to website domain.
        const seen = new Set();
        const rawResults = allRaw.filter((r) => {
            const k = r.data_id || r.place_id || extractDomain(r.website) || r.title;
            if (!k || seen.has(k)) return false;
            seen.add(k);
            return true;
        });

        // Step 2-3: filter chains + non-target types
        const survivors = [];
        for (const r of rawResults) {
            const types = Array.isArray(r.types) ? r.types : (r.type ? [r.type] : []);
            const domain = extractDomain(r.website);
            if (domain && isChain(domain)) { chainsFiltered++; continue; }
            if (!isTargetType(types)) { nonTargetFiltered++; continue; }
            // Scrapingdog returns `gps_coordinates: { latitude, longitude }`
            // for every Google Maps place - captured here so the Database
            // map view can plot each company at its real location.
            const gps = r.gps_coordinates || {};
            const lat = Number(gps.latitude);
            const lng = Number(gps.longitude);
            survivors.push({
                title: r.title,
                website: r.website,
                domain,
                phone: r.phone,
                address: r.address,
                rating: r.rating,
                reviews: r.reviews,
                placeId: r.place_id,
                dataId: r.data_id,
                primaryType: r.type,
                allTypes: types,
                location: (Number.isFinite(lat) && Number.isFinite(lng)) ? { lat, lng } : null,
            });
        }
        placesFound = survivors.length;

        // Step 4: dedupe against companies.json (skip already-classified)
        const knownDomains = await loadKnownDomains();
        const fresh = survivors.filter(s => {
            if (!s.domain || !knownDomains.has(s.domain.toLowerCase())) return true;
            alreadyKnown++;
            return false;
        });
        console.log(`[Sweep]   ┌─ ${fresh.length} fresh companies queued (after ${chainsFiltered} chains + ${nonTargetFiltered} non-target + ${alreadyKnown} already-known filtered out)`);

        // Step 5: per-survivor scrape + classify + upsert, two-stage pipeline.
        //
        // The naive version awaits Firecrawl, awaits GPT, awaits upsert, then
        // moves to the next company — that leaves either API idle ~half the
        // time. We chain two single-concurrency pipelines instead:
        //   - prevScrape gates Firecrawl: company N+1's scrape waits for
        //     company N's scrape to finish, so at most one Firecrawl call
        //     is in flight at a time.
        //   - prevClassify gates the classify+upsert tail: company N+1's
        //     classify waits for company N's classify+upsert to finish, so
        //     at most one OpenAI call and one companies.json write are in
        //     flight at a time.
        // The two stages run side-by-side: while company N is being
        // classified, company N+1 is already being scraped. Same rate-limit
        // pressure as the sequential version, ~20-30% wall-time savings on
        // cold sweeps (Firecrawl is the dominant per-company cost).
        //
        // Cache hits short-circuit the scrape stage to a near-instant
        // resolve, so cache-heavy sweeps don't pay anything for the
        // pipeline machinery.

        // Scrape stage: returns { ok, markdown, pageTitle, fromCache } or
        // { ok: false, error }. Wrapped so the prevScrape chain never
        // rejects — a failed scrape is reported via the return value, not
        // a thrown promise, so the next iteration can still kick off.
        async function scrapeStage(place, url, domain) {
            try {
                const cached = await scrapeCache.get(domain);
                if (cached && cached.markdown) {
                    return {
                        ok: true,
                        markdown: cached.markdown,
                        pageTitle: cached.pageTitle || place.title || '',
                        fromCache: true,
                        cacheVertical: cached.vertical || null,
                    };
                }
                const scrape = await scrapeUrl(url);
                const markdown = scrape?.markdown || scrape?.data?.markdown || '';
                const pageTitle = scrape?.metadata?.title || scrape?.data?.metadata?.title || place.title || '';
                // Persist the scrape so a sibling ICP in the same vertical
                // can re-classify without paying Firecrawl again.
                await scrapeCache.put(domain, {
                    vertical: icp.vertical || null,
                    url,
                    pageTitle,
                    markdown,
                    scrapedAt: Date.now(),
                });
                return { ok: true, markdown, pageTitle, fromCache: false };
            } catch (err) {
                return { ok: false, error: err };
            }
        }

        let prevScrape = Promise.resolve(null);
        let prevClassify = Promise.resolve();
        const totalFresh = fresh.length;
        let processedIdx = 0;

        for (const place of fresh) {
            // Sticky 1-based index for activity events. Captured per iter
            // so the per-company log lines all match what the user sees
            // in the progress bar.
            processedIdx += 1;
            const companyIdx = processedIdx;

            if (!place.website) {
                console.log(`[Sweep]   ▷ [${companyIdx}/${totalFresh}] ${place.title || '(no title)'} — skipping (no website on Google Maps record)`);
                // Serialize no-website upserts behind prevClassify so
                // record ordering on companies.json stays predictable
                // and the file write doesn't race with a parallel upsert.
                // Capture prevClassify synchronously here too — see the
                // long comment on the main branch below for why.
                const prevForNoWebsite = prevClassify;
                prevClassify = (async () => {
                    try { await prevForNoWebsite; } catch { /* swallow */ }
                    try {
                        await upsertCompany({
                            url: null,
                            domain: place.domain || null,
                            icpId: icp.id,
                            vertical: icp.vertical || null,
                            city: cell.parentCity || null,
                            classification: { is_match: null, reason: 'no website on Google Maps record' },
                            scrapedAt: Date.now(),
                            source: `${icp.id}:${cell.parentCity}:no-website`,
                            location: place.location,
                        });
                    } catch { /* non-fatal */ }
                    pushEvent({
                        type: 'company_rejected',
                        icpId: icp.id,
                        cellId: cell.id,
                        parentCity: cell.parentCity || null,
                        domain: place.domain || '',
                        title: place.title || '',
                        reason: 'no website on Google Maps record',
                        companyIdx,
                        totalCompanies: totalFresh,
                        message: `${place.title || '(no title)'} — no website on Google Maps record`,
                    });
                })();
                continue;
            }
            const url = /^https?:\/\//i.test(place.website) ? place.website : `https://${place.website}`;
            const domain = place.domain || extractDomain(url);

            // Stage 1: kick off the scrape after the previous scrape lands.
            // Per-iteration progress events fire from inside this IIFE so
            // the activity feed shows scrape progress for every company,
            // not just a single "Sweeping London" line.
            const myScrape = (async () => {
                await prevScrape;
                console.log(`[Sweep]   ▷ [${companyIdx}/${totalFresh}] scrape START: ${place.title || domain} (${domain})`);
                pushEvent({
                    type: 'company_scrape_start',
                    icpId: icp.id,
                    cellId: cell.id,
                    parentCity: cell.parentCity || null,
                    domain,
                    title: place.title || '',
                    companyIdx,
                    totalCompanies: totalFresh,
                    message: `${place.title || domain} — scraping (${companyIdx}/${totalFresh})`,
                });
                return scrapeStage(place, url, domain);
            })();
            prevScrape = myScrape;

            // Stage 2: classify + upsert, serialized behind the previous
            // iteration's classify so companies.json writes and per-company
            // events stay strictly in order.
            //
            // CRITICAL: capture `prevClassify` into a const NOW, before the
            // IIFE is constructed. Reading `prevClassify` from inside the
            // IIFE (after `await myScrape` resumes) would read the value
            // AFTER the for-loop has reassigned it to the LAST iteration's
            // promise — every iteration would end up awaiting the final
            // iteration, which awaits itself → deadlock. Capturing here
            // locks each iteration to its immediate predecessor.
            const prevClassifyForThis = prevClassify;
            prevClassify = (async () => {
                let scrapeResult;
                try {
                    scrapeResult = await myScrape;
                } catch (err) {
                    scrapeResult = { ok: false, error: err };
                }
                try {
                    await prevClassifyForThis;
                } catch { /* swallow previous-iteration errors */ }

                if (!scrapeResult || !scrapeResult.ok) {
                    const err = scrapeResult?.error || new Error('unknown scrape error');
                    console.warn(`[Sweep]   ⚠ ${domain}: ${err.message}`);
                    try {
                        await upsertCompany({
                            url,
                            domain,
                            icpId: icp.id,
                            vertical: icp.vertical || null,
                            city: cell.parentCity || null,
                            classification: { is_match: null, reason: `scrape error: ${err.message?.slice(0, 200)}` },
                            scrapedAt: Date.now(),
                            source: `${icp.id}:${cell.parentCity}:scrape-error`,
                            location: place.location,
                        });
                    } catch { /* non-fatal */ }
                    pushEvent({
                        type: 'company_rejected',
                        icpId: icp.id,
                        cellId: cell.id,
                        parentCity: cell.parentCity || null,
                        domain,
                        title: place.title || '',
                        reason: `scrape error: ${err.message?.slice(0, 120)}`,
                        companyIdx,
                        totalCompanies: totalFresh,
                        message: `${place.title || domain} — scrape failed`,
                    });
                    return;
                }

                const { markdown, pageTitle, fromCache, cacheVertical } = scrapeResult;
                if (fromCache) {
                    console.log(`[Sweep]   ↻ [${companyIdx}/${totalFresh}] scrape CACHE-HIT: ${domain} (vertical=${cacheVertical || '?'}, ${markdown.length} chars)`);
                } else {
                    console.log(`[Sweep]   ✓ [${companyIdx}/${totalFresh}] scrape DONE: ${domain} (${markdown.length} chars)`);
                }
                console.log(`[Sweep]   ▷ [${companyIdx}/${totalFresh}] classify START: ${domain} → GPT`);
                pushEvent({
                    type: 'company_classify_start',
                    icpId: icp.id,
                    cellId: cell.id,
                    parentCity: cell.parentCity || null,
                    domain,
                    title: place.title || '',
                    companyIdx,
                    totalCompanies: totalFresh,
                    message: `${place.title || domain} — classifying (${companyIdx}/${totalFresh})`,
                });
                try {
                    const verdict = await classify(markdown, pageTitle, icp.classifyPrompt);
                    await upsertCompany({
                        url,
                        domain,
                        icpId: icp.id,
                        vertical: icp.vertical || null,
                        city: cell.parentCity || null,
                        classification: {
                            is_match: verdict.is_match,
                            reason: verdict.reason,
                            title: place.title,
                            phone: place.phone,
                            address: place.address,
                            rating: place.rating,
                            reviews: place.reviews,
                        },
                        scrapedAt: Date.now(),
                        source: `${icp.id}:${cell.parentCity}`,
                        location: place.location,
                    });
                    if (verdict.is_match) leadsQualified++;
                    touchedDomains.push(domain);
                    console.log(`[Sweep]   ${verdict.is_match ? '✓' : '✗'} [${companyIdx}/${totalFresh}] classify VERDICT: ${domain} → ${verdict.is_match ? 'QUALIFIED' : 'rejected'} — ${verdict.reason}`);
                    pushEvent({
                        type: verdict.is_match ? 'company_qualified' : 'company_rejected',
                        icpId: icp.id,
                        cellId: cell.id,
                        parentCity: cell.parentCity || null,
                        domain,
                        title: place.title || '',
                        reason: verdict.reason,
                        companyIdx,
                        totalCompanies: totalFresh,
                        message: `${place.title || domain} — ${verdict.is_match ? 'qualified' : 'rejected'}`,
                    });
                } catch (err) {
                    console.warn(`[Sweep]   ⚠ ${domain} classify/upsert: ${err.message}`);
                    pushEvent({
                        type: 'company_rejected',
                        icpId: icp.id,
                        cellId: cell.id,
                        parentCity: cell.parentCity || null,
                        domain,
                        title: place.title || '',
                        reason: `classify/upsert error: ${err.message?.slice(0, 120)}`,
                        companyIdx,
                        totalCompanies: totalFresh,
                        message: `${place.title || domain} — error during classify`,
                    });
                }
            })();
        }

        // Drain the pipeline tail before letting the cell complete.
        await prevScrape;
        await prevClassify;

        // Completion criteria - described in icp-mapping-plan.md.
        // Cell is `complete` when there were any non-chain, non-already-
        // known survivors to qualify. Otherwise `empty` - no follow-up
        // scan needed (no rentals here at this resolution).
        const newSurvivors = placesFound - alreadyKnown;
        const finalState = newSurvivors > 0 ? 'complete' : 'empty';

        await grid.updateCell(cell.id, {
            state: finalState,
            placesFound,
            leadsQualified,
            chainsFiltered,
            nonTargetFiltered,
            alreadyKnown,
            lastScannedAt: Date.now(),
        });

        console.log(`[Sweep] ◀ ${cell.parentCity}/${cell.id.slice(0, 8)} → ${finalState} (places=${placesFound}, qualified=${leadsQualified}, chains=${chainsFiltered}, non-target=${nonTargetFiltered}, dedup=${alreadyKnown})`);
        pushEvent({
            type: 'cell_complete',
            icpId: icp.id,
            cellId: cell.id,
            parentCity: cell.parentCity || null,
            state: finalState,
            placesFound,
            qualifiedCount: leadsQualified,
            message: `${cell.parentCity || 'cell'} ${finalState} — ${placesFound} places, ${leadsQualified} qualified, ${chainsFiltered} chains filtered, ${alreadyKnown} already known`,
        });

        // Auto-fanout to sibling ICPs in the same vertical. Each sibling
        // runs its own classifyPrompt against the cached markdown - no
        // Scrapingdog, no Firecrawl. Idempotent on already-classified
        // domains. Errors per sibling are caught inside fanoutForDomains.
        if (icp.vertical && touchedDomains.length > 0) {
            try {
                const fanned = await fanoutForDomains(touchedDomains, icp.vertical, icp.id, cell.parentCity);
                if (fanned > 0) console.log(`[Sweep]   ↻ fanout: ${fanned} sibling-ICP classifications written`);
            } catch (err) {
                console.warn(`[Sweep]   ⚠ fanout error: ${err.message}`);
            }
        }

        return { state: finalState, placesFound, leadsQualified };
    } catch (err) {
        console.error(`[Sweep] 💥 ${cell.parentCity}/${cell.id.slice(0, 8)} hard error: ${err.message}`);
        // Reset to pending so the next tick retries from scratch
        await grid.updateCell(cell.id, { state: 'pending', lastError: err.message?.slice(0, 300) });
        throw err;
    }
}

// ─── DEMO HELPERS ────────────────────────────────────────────────────────
// Plausible-sounding indie rental names. Combined with the cell's parentCity
// to produce things like "Premier London Vehicle Hire". Easy to extend with
// more variety if the demo grows.
const DEMO_NAME_PREFIXES = [
    'Premier', 'City', 'Express', 'Royal', 'Capital', 'Metro', 'Crown',
    'Apex', 'Astra', 'Pioneer', 'Vista', 'Orion', 'Trident', 'Halo', 'Maple',
    'Sterling', 'Ascot', 'Regal', 'Beacon', 'Heritage',
];
const DEMO_NAME_SUFFIXES = [
    'Vehicle Hire', 'Car Rentals', 'Auto Hire', 'Rentals Ltd',
    'Cars', 'Auto Rental', 'Vehicle Rentals', 'Car Hire',
];
// Reasons the GPT classifier might reject something that looks rental-shaped
// on Google Maps but isn't a fit. Used for the small "not qualified" slice.
const DEMO_REJECT_REASONS = [
    { titlePrefix: 'Royal', titleBody: 'Chauffeur Services',  reason: 'chauffeur-driven service, not self-drive rental' },
    { titlePrefix: 'Movit',   titleBody: 'Van Hire',           reason: 'commercial moving vans only, not passenger rentals' },
    { titlePrefix: 'Big Yellow', titleBody: 'Self Storage',    reason: 'storage rental, not vehicle' },
    { titlePrefix: 'Saxon', titleBody: 'Limousine Hire',       reason: 'limo/event hire, doesn\'t fit standard self-drive ICP' },
];

// Fake-lead components used by the demo path. Drawn at random per company
// so each qualified record gets a small contact list - gives the Database
// drawer something to render under "Leads" instead of just "0".
const DEMO_FIRST_NAMES = ['James', 'Sarah', 'Michael', 'Emma', 'David', 'Anna', 'Chris', 'Sophie', 'Daniel', 'Olivia', 'Matthew', 'Hannah', 'Luke', 'Grace'];
const DEMO_LAST_NAMES  = ['Smith', 'Jones', 'Patel', 'Brown', 'Wilson', 'Taylor', 'Davies', 'Evans', 'Williams', 'Thomas', 'Roberts', 'Walker'];
const DEMO_TITLES      = ['Operations Manager', 'Managing Director', 'Owner', 'Fleet Manager', 'General Manager', 'CEO', 'Founder', 'Branch Manager'];
const DEMO_FLEET_SIZES = ['5–10 vehicles', '10–25 vehicles', '25–50 vehicles', '50–100 vehicles'];
const DEMO_VEHICLE_TYPES = ['economy cars', 'SUVs', 'minivans', 'luxury cars', 'commercial vans', 'minibuses'];
const DEMO_BOOKING_PLATFORMS = ['direct website', 'Booking.com', 'rentalcars.com', 'phone-only'];
const DEMO_SIGNALS = [
    'Real local address listed',
    'Direct booking via own website',
    'Single-location operation',
    'Phone answered on first call',
    'Independent - no franchise affiliation',
    'Pricing shown publicly',
    'Open 7 days a week',
];

function pickSubset(arr, rnd, minCount = 1, maxCount = 3) {
    const count = minCount + Math.floor(rnd() * (maxCount - minCount + 1));
    const shuffled = [...arr].sort(() => rnd() - 0.5);
    return shuffled.slice(0, Math.min(count, arr.length));
}

function makeDemoLeads(domain, rnd) {
    const count = 1 + Math.floor(rnd() * 3); // 1–3 leads per qualified company
    const used = new Set();
    const leads = [];
    while (leads.length < count) {
        const first = pick(DEMO_FIRST_NAMES, rnd);
        const last = pick(DEMO_LAST_NAMES, rnd);
        const key = `${first}|${last}`;
        if (used.has(key)) continue;
        used.add(key);
        leads.push({
            firstName: first,
            lastName: last,
            title: pick(DEMO_TITLES, rnd),
            email: `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`,
            emailStatus: 'verified',
            linkedinUrl: `https://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}-${Math.floor(rnd() * 9000 + 1000)}`,
            hasEmail: true,
            apolloId: `demo-${Math.floor(rnd() * 1e8)}`,
            enriched: true,
            enrichedAt: Date.now(),
        });
    }
    return leads;
}

function pick(arr, rnd) { return arr[Math.floor(rnd() * arr.length)]; }
function makeRng(seed) {
    let s = (seed | 0) || 1;
    return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

// Fake replacement for the live Scrapingdog → filter → Firecrawl → GPT chain.
// Sleeps in stages with progress events between each stage so the frontend's
// "Now sweeping" panel can show what's currently happening (Fetching places →
// Scraping company X → Classifying company X → next), instead of one long
// opaque pause. Total wall time ≈ live sweep so the demo paces realistically.
async function runDemoSweep(icp, cell) {
    // Per-cell deterministic seed plus a small wallclock jitter so re-sweeps
    // are mostly stable but not boringly identical.
    const seed = Math.abs(((cell.lat * 1e4) + (cell.lng * 1e3)) | 0) + (Date.now() % 1000);
    const rnd = makeRng(seed);
    const cityLabel = cell.parentCity || 'London';

    // Stage 1 - Scrapingdog Maps: ~1.5 s. Equivalent live call returns the
    // candidate place list before any per-company work begins.
    //
    // Search-log dedup (demo mirror of the live optimization): if every
    // search term in the ICP has already been run for this (vertical,
    // area), we skip the fetch entirely - the previous ICP already paid
    // Scrapingdog for these queries and the candidate pool is unchanged.
    // The cell still gets marked `complete` and we still trigger fanout
    // on the existing companies in case sibling ICPs haven't classified
    // them yet.
    const allTerms = (icp.searchTerms && icp.searchTerms.length > 0)
        ? icp.searchTerms
        : [icp.vertical || 'business'];
    const newTerms = icp.vertical
        ? searchLog.unmatchedTerms(icp.vertical, cell.lat, cell.lng, allTerms)
        : allTerms;
    const skippedTerms = allTerms.filter((t) => !newTerms.includes(t));

    pushEvent({
        type: 'places_fetching',
        icpId: icp.id,
        cellId: cell.id,
        parentCity: cityLabel,
        message: skippedTerms.length > 0
            ? `${cityLabel}: ${skippedTerms.length} term(s) already run for ${icp.vertical}, fetching ${newTerms.length} new`
            : `${cityLabel}: fetching places from Maps`,
    });
    await new Promise((r) => setTimeout(r, 1200 + Math.floor(rnd() * 800)));

    // Log the (vertical, area, term) tuples we'd have run live. Future
    // sibling-ICP sweeps at this geography will see these and skip.
    if (icp.vertical) {
        for (const term of newTerms) {
            searchLog.add(icp.vertical, cell.lat, cell.lng, term, {
                cellId: cell.id,
                icpId: icp.id,
                resultCount: null, // demo doesn't actually have a count
            });
        }
    }

    // ~8 % of cells come back empty - visual variety + lets you see the
    // gray-dot state on the globe without seeding a literal ocean cell.
    if (rnd() < 0.08) {
        await grid.updateCell(cell.id, {
            state: 'empty',
            placesFound: 0,
            leadsQualified: 0,
            chainsFiltered: 1 + Math.floor(rnd() * 2),
            nonTargetFiltered: Math.floor(rnd() * 2),
            alreadyKnown: 0,
            lastScannedAt: Date.now(),
        });
        console.log(`[Sweep DEMO] ◀ ${cell.parentCity}/${cell.id.slice(0, 8)} → empty`);
        pushEvent({
            type: 'cell_complete',
            icpId: icp.id,
            cellId: cell.id,
            parentCity: cell.parentCity || null,
            state: 'empty',
            message: `${cell.parentCity || 'cell'}: no rentals at this location`,
        });
        return { state: 'empty', placesFound: 0, leadsQualified: 0 };
    }

    const chainsFiltered = Math.floor(rnd() * 3);          // 0–2 chains filtered
    const nonTargetFiltered = Math.floor(rnd() * 2);       // 0–1 non-target
    const qualifiedCount = 1 + Math.floor(rnd() * 4);      // 1–4 qualified indies
    const rejectedCount = Math.floor(rnd() * 2);           // 0–1 rejected by classifier

    // Total companies the cell will process post-filter. Fed into every per-
    // company event so the frontend progress bar can compute idx / total.
    const totalSurvivors = qualifiedCount + rejectedCount;

    // Collect every domain we touch this sweep. After the cell's primary
    // classification finishes, we fan these out to sibling ICPs in the
    // same vertical so they pick up the new companies without manual
    // reclassify clicks. Idempotent - the fanout helper skips siblings
    // that have already classified each domain.
    const touchedDomains = [];

    // Stage 2 - Scrapingdog Maps returned the place list. Emit a `places_fetched`
    // event so the frontend can flip the Now-Sweeping panel out of the "fetching"
    // state into the per-company progress mode.
    pushEvent({
        type: 'places_fetched',
        icpId: icp.id,
        cellId: cell.id,
        parentCity: cityLabel,
        totalSurvivors,
        chainsFiltered,
        nonTargetFiltered,
        message: `${cityLabel}: ${totalSurvivors} place${totalSurvivors === 1 ? '' : 's'} after filtering chains and non-target types`,
    });

    // Persist qualified indies so they show up in the Database page.
    for (let i = 0; i < qualifiedCount; i++) {
        const prefix = pick(DEMO_NAME_PREFIXES, rnd);
        const suffix = pick(DEMO_NAME_SUFFIXES, rnd);
        const title = `${prefix} ${cityLabel} ${suffix}`;
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const domain = `${slug}.co.uk`;
        const url = `https://${domain}`;

        // Stage 3a - scrape. Fires before the (real) Firecrawl call; the
        // demo sleeps to fake the wall time so the panel can show "Scraping
        // domain.co.uk" for a beat.
        pushEvent({
            type: 'company_scrape_start',
            icpId: icp.id,
            cellId: cell.id,
            parentCity: cityLabel,
            domain,
            title,
            companyIdx: i + 1,
            totalCompanies: totalSurvivors,
            message: `Scraping ${domain} (${i + 1}/${totalSurvivors})`,
        });
        await new Promise((r) => setTimeout(r, 1100 + Math.floor(rnd() * 900)));

        // Stage 3b - classify. Fires before the (real) GPT call so the
        // panel switches from "Scraping" to "Classifying" mid-company.
        pushEvent({
            type: 'company_classify_start',
            icpId: icp.id,
            cellId: cell.id,
            parentCity: cityLabel,
            domain,
            title,
            companyIdx: i + 1,
            totalCompanies: totalSurvivors,
            message: `Classifying ${domain} (${i + 1}/${totalSurvivors})`,
        });
        await new Promise((r) => setTimeout(r, 500 + Math.floor(rnd() * 500)));

        // Scatter the fake company within ~2 km of the cell center so the
        // Database map view shows realistic clustering instead of every
        // dot pinned to the cell's exact coordinate.
        const jitter = () => (rnd() - 0.5) * 0.04; // ~2 km in lat/lng degrees
        const placeLocation = { lat: cell.lat + jitter(), lng: cell.lng + jitter() };
        // Rich classification record - populates the "report" view in the
        // Database map drawer with realistic-looking GPT output. Field
        // names match what the existing CompanyDetails component reads
        // (name, tagline, city, country, fleetSizeHint, signals, etc.)
        // so the demo data renders the same as live classifier output.
        const phone = `+44 20 ${1000 + Math.floor(rnd() * 9000)} ${1000 + Math.floor(rnd() * 9000)}`;
        const address = `${1 + Math.floor(rnd() * 200)} ${cityLabel} Rd, ${cityLabel}`;
        const tagline = `Independent ${cityLabel} vehicle hire - ${pick(['airport pickup', 'long-term rentals', 'corporate accounts', 'leisure travel'], rnd)}`;
        const fleetSizeHint = pick(DEMO_FLEET_SIZES, rnd);
        const fleetVehicleTypes = pickSubset(DEMO_VEHICLE_TYPES, rnd, 2, 4);
        const bookingPlatformHints = pickSubset(DEMO_BOOKING_PLATFORMS, rnd, 1, 3);
        const signals = pickSubset(DEMO_SIGNALS, rnd, 3, 5);
        let savedCompany = null;
        try {
            savedCompany = await upsertCompany({
                url,
                domain,
                icpId: icp.id,
                vertical: icp.vertical || null,
                city: cityLabel,
                classification: {
                    is_match: true,
                    reason: 'independent vehicle hire - fits ICP (demo)',
                    // Surface fields used by the simple drawer
                    title,
                    phone,
                    address,
                    rating: Number((3.8 + rnd() * 1.2).toFixed(1)),
                    reviews: 20 + Math.floor(rnd() * 400),
                    // Rich fields used by the full CompanyDetails report
                    name: title,
                    tagline,
                    city: cityLabel,
                    country: cell.country || 'GB',
                    email: `info@${domain}`,
                    languages: cell.language ? [cell.language] : ['en'],
                    hasOnlineBooking: rnd() > 0.35,
                    fleetSizeHint,
                    fleetVehicleTypes,
                    bookingPlatformHints,
                    signals,
                    reasoning: 'Classified as independent vehicle hire based on: clear single-location address, direct booking via own website, no franchise/chain branding, transparent pricing on the homepage, and operations focused on local self-drive rentals (not chauffeur or peer-to-peer).',
                    isCarRental: true,
                    isIndependent: true,
                    confidence: pick(['high', 'high', 'medium'], rnd),
                },
                scrapedAt: Date.now(),
                source: `${icp.id}:${cityLabel}:demo`,
                location: placeLocation,
            });
            // Synthetic scrape cache write - gives the reclassify-existing
            // flow real markdown to feed the GPT classifier with, even in
            // demo mode where Firecrawl isn't actually called. Real-world
            // sweeps will write Firecrawl's actual markdown here instead.
            await scrapeCache.put(domain, {
                vertical: icp.vertical || null,
                url,
                pageTitle: title,
                markdown: [
                    `# ${title}`,
                    '',
                    tagline,
                    '',
                    `Address: ${address}`,
                    `Phone: ${phone}`,
                    `Email: info@${domain}`,
                    '',
                    `## About`,
                    `${title} is an independent ${cityLabel}-based vehicle hire business. ${signals.join(' ')}`,
                    '',
                    `## Fleet`,
                    `Size: ${fleetSizeHint}. Vehicle types: ${fleetVehicleTypes.join(', ')}.`,
                    '',
                    `## Booking`,
                    `Platforms: ${bookingPlatformHints.join(', ')}.`,
                ].join('\n'),
                scrapedAt: Date.now(),
            });
        } catch { /* non-fatal */ }
        // Attach a small fake contact list so the drawer's Leads section
        // has something to show. Real Sales-Agent Apollo enrichment would
        // overwrite these on a re-run.
        if (savedCompany) {
            try {
                await attachLeads(savedCompany.id, makeDemoLeads(domain, rnd));
            } catch { /* non-fatal */ }
        }
        console.log(`[Sweep DEMO]   ✓ ${domain} - qualified`);
        touchedDomains.push(domain);
        pushEvent({
            type: 'company_qualified',
            icpId: icp.id,
            cellId: cell.id,
            parentCity: cityLabel,
            domain,
            title,
            companyIdx: i + 1,
            totalCompanies: totalSurvivors,
            message: `${title} - qualified`,
        });
    }

    // Persist rejects too so the Database page shows the "scanned but didn't
    // pass classifier" rows alongside the wins.
    for (let i = 0; i < rejectedCount; i++) {
        const r = pick(DEMO_REJECT_REASONS, rnd);
        const title = `${r.titlePrefix} ${cityLabel} ${r.titleBody}`;
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const domain = `${slug}.co.uk`;
        // Continue the running idx after the qualified loop so the progress
        // bar advances monotonically across both qualified and rejected
        // companies (the user just sees "scraping/classifying X of total").
        const runningIdx = qualifiedCount + i + 1;

        pushEvent({
            type: 'company_scrape_start',
            icpId: icp.id,
            cellId: cell.id,
            parentCity: cityLabel,
            domain,
            title,
            companyIdx: runningIdx,
            totalCompanies: totalSurvivors,
            message: `Scraping ${domain} (${runningIdx}/${totalSurvivors})`,
        });
        await new Promise((r) => setTimeout(r, 1100 + Math.floor(rnd() * 900)));

        pushEvent({
            type: 'company_classify_start',
            icpId: icp.id,
            cellId: cell.id,
            parentCity: cityLabel,
            domain,
            title,
            companyIdx: runningIdx,
            totalCompanies: totalSurvivors,
            message: `Classifying ${domain} (${runningIdx}/${totalSurvivors})`,
        });
        await new Promise((r) => setTimeout(r, 500 + Math.floor(rnd() * 500)));

        const jitter = () => (rnd() - 0.5) * 0.04;
        const placeLocation = { lat: cell.lat + jitter(), lng: cell.lng + jitter() };
        try {
            await upsertCompany({
                url: `https://${domain}`,
                domain,
                icpId: icp.id,
                vertical: icp.vertical || null,
                city: cityLabel,
                classification: {
                    is_match: false,
                    reason: r.reason,
                    title,
                },
                scrapedAt: Date.now(),
                source: `${icp.id}:${cityLabel}:demo`,
                location: placeLocation,
            });
            // Cache a short markdown for rejected companies too - keeps the
            // reclassify flow working uniformly across qualified + rejected.
            // The new ICP's prompt might decide one of these is actually a
            // match (different criteria), so we want the data available.
            await scrapeCache.put(domain, {
                vertical: icp.vertical || null,
                url: `https://${domain}`,
                pageTitle: title,
                markdown: `# ${title}\n\n${title} - ${r.reason}.`,
                scrapedAt: Date.now(),
            });
        } catch { /* non-fatal */ }
        console.log(`[Sweep DEMO]   ✗ ${domain} - ${r.reason}`);
        touchedDomains.push(domain);
        pushEvent({
            type: 'company_rejected',
            icpId: icp.id,
            cellId: cell.id,
            parentCity: cityLabel,
            domain,
            title,
            reason: r.reason,
            companyIdx: runningIdx,
            totalCompanies: totalSurvivors,
            message: `${title} - ${r.reason}`,
        });
    }

    const placesFound = qualifiedCount + rejectedCount;
    await grid.updateCell(cell.id, {
        state: 'complete',
        placesFound,
        leadsQualified: qualifiedCount,
        chainsFiltered,
        nonTargetFiltered,
        alreadyKnown: 0,
        lastScannedAt: Date.now(),
    });

    console.log(`[Sweep DEMO] ◀ ${cell.parentCity}/${cell.id.slice(0, 8)} → complete (places=${placesFound}, qualified=${qualifiedCount}, chains=${chainsFiltered}, non-target=${nonTargetFiltered})`);
    pushEvent({
        type: 'cell_complete',
        icpId: icp.id,
        cellId: cell.id,
        parentCity: cityLabel,
        state: 'complete',
        placesFound,
        qualifiedCount,
        message: `${cityLabel} cell complete · ${placesFound} place${placesFound === 1 ? '' : 's'}, ${qualifiedCount} qualified`,
    });

    // Fanout - for each domain we touched, classify under every other ICP
    // in the vertical. Idempotent + non-fatal (errors are logged but don't
    // fail the sweep). Runs after the cell-complete event so the user sees
    // their primary ICP results first, then the sibling fanout fills in.
    if (icp.vertical && touchedDomains.length > 0) {
        try {
            const fanned = await fanoutForDomains(touchedDomains, icp.vertical, icp.id, cityLabel);
            if (fanned > 0) {
                console.log(`[Sweep DEMO]   ↻ fanout: ${fanned} sibling-ICP classifications written`);
            }
        } catch (err) {
            console.warn(`[Sweep DEMO]   ⚠ fanout error: ${err.message}`);
        }
    }

    return { state: 'complete', placesFound, leadsQualified: qualifiedCount };
}

module.exports = { sweepCell };
