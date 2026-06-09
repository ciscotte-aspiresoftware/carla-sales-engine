// Disk-backed scrape cache, keyed by domain.
//
// Why this exists: Firecrawl scrape is the most expensive step of a sweep
// (~1 credit + a few seconds per company). Once we've scraped a company's
// home page, the markdown is good for re-classification under any new ICP
// in the same vertical - the page didn't change just because we wrote a
// new prompt. This cache makes "add a second ICP in an existing vertical"
// nearly free: the second pass only pays for GPT classification, not
// Firecrawl.
//
// File layout:
//   api/data/scrape-cache/<domain-slug>.json
// where domain-slug is the lowercase domain with dots → dashes (e.g.
// `premier-london-vehicle-hire-co-uk.json`). One file per company keeps
// reads cheap (no need to scan a giant array for one entry) and isolates
// concurrent writes - different companies hit different files.
//
// Each entry shape:
//   {
//     domain:    "premier-london-vehicle-hire.co.uk",
//     vertical:  "Car Rental",        // tag of the ICP that scraped it
//     url:       "https://...",       // the URL we actually fetched
//     pageTitle: "...",
//     markdown:  "...",                // Firecrawl raw markdown
//     scrapedAt: 1715200000000,
//   }
//
// Cache invalidation: deliberately not automatic. Sites rarely change in
// ways that would flip an ICP classification, and re-scraping every time
// would defeat the purpose. Add a manual "refresh scrape" button per
// company in the database UI when we need it. For now, once cached,
// always served.

const fs = require('fs');
const path = require('path');
const { isEnabled, getClient } = require('../db');

const CACHE_DIR = path.resolve(__dirname, '..', 'data', 'scrape-cache');

// Map a Supabase scrape_cache row → the JSON entry shape callers expect
// (page_title→pageTitle, scraped_at timestamptz → epoch ms).
function rowToEntry(d) {
    return {
        domain: d.domain,
        vertical: d.vertical || null,
        url: d.url || null,
        pageTitle: d.page_title || null,
        markdown: d.markdown || '',
        scrapedAt: d.scraped_at ? new Date(d.scraped_at).getTime() : 0,
    };
}

function ensureDir() {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// "premier-london-vehicle-hire.co.uk" → "premier-london-vehicle-hire-co-uk"
// Stable, filesystem-safe, reversible isn't needed because we always look
// up by exact domain (we never read the slug back).
function slug(domain) {
    return String(domain || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function pathFor(domain) {
    const s = slug(domain);
    if (!s) return null;
    return path.join(CACHE_DIR, `${s}.json`);
}

function has(domain) {
    const p = pathFor(domain);
    return !!(p && fs.existsSync(p));
}

// Read a cached scrape. Returns null on miss or parse error - both treated
// as cache miss so callers can fall through to a real scrape.
async function get(domain) {
    if (isEnabled()) {
        const key = String(domain || '').toLowerCase();
        if (!key) return null;
        try {
            const { data, error } = await getClient()
                .from('scrape_cache').select('*').eq('domain', key).maybeSingle();
            if (error || !data) return null;
            console.log(`[ScrapeCache] HIT (db) domain=${domain} | vertical=${data.vertical || '?'} | ${data.markdown?.length || 0} chars`);
            return rowToEntry(data);
        } catch {
            return null;
        }
    }
    const p = pathFor(domain);
    if (!p || !fs.existsSync(p)) {
        return null;
    }
    try {
        const raw = await fs.promises.readFile(p, 'utf8');
        const entry = JSON.parse(raw);
        console.log(`[ScrapeCache] HIT  domain=${domain} | vertical=${entry.vertical || '?'} | ${entry.markdown?.length || 0} chars`);
        return entry;
    } catch {
        return null;
    }
}

// Write a cached scrape. Atomic-ish: we write then rename. The temp suffix
// avoids leaving a partial file if the process dies mid-write - a future
// reader either sees the previous good copy or the new full copy, never
// half of either.
async function put(domain, { vertical, url, pageTitle, markdown, scrapedAt }) {
    if (isEnabled()) {
        const key = String(domain || '').toLowerCase();
        if (!key) return null;
        const ts = scrapedAt || Date.now();
        try {
            const { error } = await getClient().from('scrape_cache').upsert({
                domain: key,
                vertical: vertical || null,
                url: url || null,
                page_title: pageTitle || null,
                markdown: markdown || '',
                scraped_at: new Date(ts).toISOString(),
            }, { onConflict: 'domain' });
            if (error) console.warn(`[ScrapeCache] DB write failed domain=${domain}: ${error.message}`);
            else console.log(`[ScrapeCache] WRITE (db) domain=${domain} | vertical=${vertical || '?'} | ${markdown?.length || 0} chars`);
        } catch (err) {
            console.warn(`[ScrapeCache] DB write threw domain=${domain}: ${err.message}`);
        }
        return { domain: key, vertical: vertical || null, url: url || null, pageTitle: pageTitle || null, markdown: markdown || '', scrapedAt: ts };
    }
    ensureDir();
    const p = pathFor(domain);
    if (!p) return null;
    const entry = {
        domain: String(domain).toLowerCase(),
        vertical: vertical || null,
        url: url || null,
        pageTitle: pageTitle || null,
        markdown: markdown || '',
        scrapedAt: scrapedAt || Date.now(),
    };
    const tmp = `${p}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(entry, null, 2));
    await fs.promises.rename(tmp, p);
    console.log(`[ScrapeCache] WRITE domain=${domain} | vertical=${vertical || '?'} | ${markdown?.length || 0} chars`);
    return entry;
}

// Walk the whole cache and return entries matching a vertical. Used by
// the `reclassify` flow to find every company whose markdown we have for
// a given vertical. O(N) on cache size - fine up to thousands of entries
// since each file is tiny and we only read on explicit user action.
async function listByVertical(vertical) {
    if (!vertical) return [];
    if (isEnabled()) {
        try {
            const { data, error } = await getClient()
                .from('scrape_cache').select('*').ilike('vertical', vertical);
            if (error || !data) return [];
            return data.map(rowToEntry);
        } catch {
            return [];
        }
    }
    ensureDir();
    const target = String(vertical).toLowerCase();
    const files = await fs.promises.readdir(CACHE_DIR).catch(() => []);
    const out = [];
    for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
            const raw = await fs.promises.readFile(path.join(CACHE_DIR, f), 'utf8');
            const entry = JSON.parse(raw);
            if ((entry.vertical || '').toLowerCase() === target) out.push(entry);
        } catch { /* skip malformed */ }
    }
    return out;
}

// Wipe everything. Used by Reset all when the user wants a clean slate.
async function clearAll() {
    if (isEnabled()) {
        try {
            const { error } = await getClient().from('scrape_cache').delete().neq('domain', '');
            if (error) { console.warn(`[ScrapeCache] DB clearAll failed: ${error.message}`); return 0; }
            return -1; // count not tracked for the DB path
        } catch {
            return 0;
        }
    }
    ensureDir();
    const files = await fs.promises.readdir(CACHE_DIR).catch(() => []);
    let removed = 0;
    for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
            await fs.promises.unlink(path.join(CACHE_DIR, f));
            removed++;
        } catch { /* ignore */ }
    }
    return removed;
}

module.exports = { has, get, put, listByVertical, clearAll };
