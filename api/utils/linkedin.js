// LinkedIn profile + posts scraper.
//
// Ported from valsource (be-vms-checker/utils/linkedin-helpers.js), trimmed
// to just what BlueBird's email flow needs:
//   - Token rotation across APIFY_API_TOKEN[_2/_3/_4] env vars
//   - scrapeLinkedInProfile()  → flattened profile summary
//   - scrapeRecentPosts()      → up to 5 recent posts with dates
//   - formatPostsForPrompt()   → 12-month window with 3-month emphasis tag
//   - postMonthsAgo()          → unified relative/absolute date parser
//
// Cost (Apify supreme_coder actors):
//   profile scrape:  $0.004 per profile
//   posts scrape:    $0.001 × 5 = $0.005 per profile (limitPerSource=5)
// → ~$0.009 added to each email gen that has a LinkedIn URL.

const axios = require('axios');
const { getLinkedin } = require('./settings');
const { recordUsage, priceService } = require('./api-cost');

const APIFY_TOKENS = [
    process.env.APIFY_API_TOKEN,
    process.env.APIFY_API_TOKEN_2,
    process.env.APIFY_API_TOKEN_3,
    process.env.APIFY_API_TOKEN_4,
].filter(Boolean);

if (APIFY_TOKENS.length === 0) {
    console.warn('[Apify] No API tokens configured - LinkedIn scraping disabled');
} else {
    console.log(`[Apify] ${APIFY_TOKENS.length} key(s) configured, starting with key 1`);
}

// Pointer survives across requests, rotates on auth/credit failure, wraps
// at the end so a key that's regained credits gets retried.
let currentTokenIndex = 0;

async function apifyPost(url, body, token) {
    return axios.post(`${url}?token=${token}`, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 120000,
    });
}

// Try each token until one succeeds. Auth/credit errors rotate; other errors
// propagate so the caller's catch block can handle them as scrape failures.
async function apifyWithRotation(urlTemplate, body, label) {
    if (APIFY_TOKENS.length === 0) {
        throw new Error('No Apify API tokens configured');
    }
    const tried = new Set();
    while (tried.size < APIFY_TOKENS.length) {
        const idx = currentTokenIndex;
        tried.add(idx);
        const token = APIFY_TOKENS[idx];
        try {
            const response = await apifyPost(urlTemplate, body, token);
            return response.data;
        } catch (err) {
            const status = err.response?.status;
            const errText = JSON.stringify(err.response?.data || err.message || '').toLowerCase();
            const isAuthOrCredit = status === 401 || status === 402 || status === 403 ||
                /insufficient.credits|no credits|credits.exhausted|billing|quota|rate.limit|too many requests/i.test(errText);
            if (isAuthOrCredit) {
                currentTokenIndex = (currentTokenIndex + 1) % APIFY_TOKENS.length;
                console.warn(`[Apify][${label}] Token ${idx + 1} failed (${status || err.code}) - rotating to token ${currentTokenIndex + 1}/${APIFY_TOKENS.length}`);
                continue;
            }
            throw err;
        }
    }
    throw new Error(`All ${APIFY_TOKENS.length} Apify API tokens failed for ${label}`);
}

function formatDate(d) {
    if (!d) return '';
    if (typeof d === 'string') return d;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = d.month ? months[d.month - 1] || '' : '';
    const year = d.year || '';
    return month ? `${month} ${year}` : `${year}`;
}

// Flattens Apify's raw profile shape into the fields the email prompt cares
// about. `hasPresentRole` derives from whether any experience entry has no
// usable endDate - more reliable than trusting `currentPosition`, which
// sometimes lists recent-but-completed roles. `recentPromotion` fires when
// the current role started in the last 6 months AND a prior role at the
// same company exists (the signature of an internal promotion).
function summarizeProfile(profile) {
    if (!profile) return null;
    const name = `${profile.firstName || ''} ${profile.lastName || ''}`.trim();
    const headline = profile.headline || '';
    const about = profile.about || '';
    const location = profile.location?.linkedinText || '';

    const current = (profile.currentPosition || [])
        .map(p => p.companyName)
        .filter(Boolean)
        .join(', ');

    const experience = (profile.experience || []).slice(0, 5).map(exp => {
        const company = exp.companyName || '';
        const position = exp.position || '';
        const duration = exp.duration || '';
        const startDate = formatDate(exp.startDate);
        const endDate = formatDate(exp.endDate) || 'Present';
        const desc = exp.description ? exp.description.substring(0, 400) : '';
        const dateRange = startDate ? `${startDate} – ${endDate}` : '';
        return `- ${position} at ${company} (${duration})${dateRange ? ` [${dateRange}]` : ''}\n  ${desc}`;
    }).join('\n');

    const companyCounts = {};
    for (const exp of (profile.experience || [])) {
        const c = exp.companyName || '';
        if (c) companyCounts[c] = (companyCounts[c] || 0) + 1;
    }
    const promotions = Object.entries(companyCounts)
        .filter(([, count]) => count > 1)
        .map(([company, count]) => `${company} (${count} roles - likely promoted)`)
        .join(', ');

    const lastRoleCompany = (profile.experience || []).find(e => e?.companyName)?.companyName || null;
    const hasPresentRole = (profile.experience || []).some(e => e && !formatDate(e.endDate));

    // Recent-promotion signal - present role started ≤6mo ago AND a prior
    // role at the same company exists.
    const recentPromotion = (() => {
        const exps = profile.experience || [];
        if (exps.length < 2) return null;
        const cur = exps[0];
        if (!cur || !cur.companyName) return null;
        if (formatDate(cur.endDate)) return null;
        const sYear = cur.startDate?.year;
        if (!sYear) return null;
        const sMonth = cur.startDate?.month || 1;
        const now = new Date();
        const monthsAgo = (now.getFullYear() - sYear) * 12 + (now.getMonth() + 1 - sMonth);
        if (monthsAgo < 0 || monthsAgo > 6) return null;
        const same = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
        const prior = exps.find((e, i) => i > 0 && e && same(e.companyName, cur.companyName));
        if (!prior) return null;
        return { company: cur.companyName, newRole: cur.position || null, priorRole: prior.position || null, monthsAgo };
    })();

    return { name, headline, about, location, current, experience, promotions, lastRoleCompany, hasPresentRole, recentPromotion };
}

async function scrapeLinkedInProfile(linkedinUrl) {
    if (APIFY_TOKENS.length === 0) return null;
    console.log(`[Apify] Scraping profile: ${linkedinUrl}`);
    const startTime = Date.now();
    try {
        const profiles = await apifyWithRotation(
            'https://api.apify.com/v2/acts/harvestapi~linkedin-profile-scraper/run-sync-get-dataset-items',
            { profileScraperMode: 'Profile details no email ($4 per 1k)', queries: [linkedinUrl] },
            'linkedin_profile_scraper'
        );
        const durationMs = Date.now() - startTime;
        console.log(`[Apify] Profile scrape done in ${(durationMs / 1000).toFixed(1)}s - ${profiles?.length || 0} result(s)`);
        // Apify charges per profile attempted (Harvest API actor), so log
        // even when the result list is empty.
        recordUsage({
            service: 'apify',
            operation: 'profile_scrape',
            unitsIn: 1,
            units: 1,
            usdCost: priceService('apify', 1, 'profile'),
            durationMs,
            metadata: { linkedinUrl, profilesReturned: profiles?.length || 0 },
        });
        if (!profiles || profiles.length === 0) return null;
        return summarizeProfile(profiles[0]);
    } catch (err) {
        console.warn(`[Apify] Profile scrape failed for ${linkedinUrl}: ${err.message}`);
        return null;
    }
}

async function scrapeRecentPosts(linkedinUrl) {
    if (APIFY_TOKENS.length === 0) return [];
    // Admin-tunable: how many recent posts per profile. Direct multiplier
    // on Apify cost (~$0.001 per post). Default 5.
    const limitPerSource = Math.max(1, Math.min(parseInt(getLinkedin().postsPerProfile, 10) || 5, 25));
    console.log(`[Apify] Scraping posts: ${linkedinUrl} (limit=${limitPerSource})`);
    const startTime = Date.now();
    try {
        // deepScrape: true unlocks the date fields (timeSincePosted /
        // postedAtISO / postedAtTimestamp) - without it dates come back
        // blank.
        const posts = (await apifyWithRotation(
            'https://api.apify.com/v2/acts/supreme_coder~linkedin-post/run-sync-get-dataset-items',
            { urls: [linkedinUrl], limitPerSource, deepScrape: true },
            'linkedin_posts_scraper'
        )) || [];
        const durationMs = Date.now() - startTime;
        console.log(`[Apify] Posts scrape done in ${(durationMs / 1000).toFixed(1)}s - ${posts.length} post(s)`);
        // Apify charges per post returned (supreme_coder actor, ~$0.001 each).
        recordUsage({
            service: 'apify',
            operation: 'posts_scrape',
            unitsOut: posts.length,
            units: posts.length,
            usdCost: priceService('apify', posts.length, 'post'),
            durationMs,
            metadata: { linkedinUrl, postsReturned: posts.length, limitPerSource },
        });
        return posts.slice(0, limitPerSource).map(post => {
            const text = (post.text || post.content || '').substring(0, 500);
            // Date field comes back under different names; check the
            // confirmed-working ones first (supreme_coder's actor) then
            // fall through to legacy names for resilience.
            const date = post.timeSincePosted
                || post.postedAtISO
                || (post.postedAtTimestamp ? new Date(post.postedAtTimestamp).toISOString() : '')
                || post.postedDate
                || post.date
                || post.relativeTime
                || '';
            const likes = post.numLikes || post.likes || post.reactionsCount || 0;
            const comments = post.numComments || post.comments || post.commentsCount || 0;
            return { text, date, likes, comments };
        }).filter(p => p.text);
    } catch (err) {
        console.warn(`[Apify] Posts scrape failed for ${linkedinUrl}: ${err.message}`);
        return [];
    }
}

// Unified relative+absolute date parser. Returns months-ago (integer) or
// null when the date string can't be parsed. Handles:
//   - Relative: "3mo ago", "2 weeks ago", "5d ago", "1y ago", "today",
//                "yesterday", "just now"
//   - Absolute: "Oct 2025", "October 2025", "2025-10-15", ISO 8601
// Conservative: null on unknown formats so callers decide what to do.
function postMonthsAgo(post) {
    if (!post || !post.date) return null;
    const s = String(post.date).toLowerCase().trim();
    if (/^(today|now|just\s*now|yesterday)\b/.test(s)) return 0;
    const yAgo = s.match(/(\d+)\s*y(?:ear)?s?\b/);
    if (yAgo) return parseInt(yAgo[1], 10) * 12;
    const mAgo = s.match(/(\d+)\s*mo(?:nth)?s?\b/);
    if (mAgo) return parseInt(mAgo[1], 10);
    const wAgo = s.match(/(\d+)\s*w(?:eek)?s?\b/);
    if (wAgo) return Math.floor(parseInt(wAgo[1], 10) / 4);
    if (/\d+\s*(d(?:ay)?s?|h(?:our|r)?s?|m(?:in(?:ute)?)?s?)\b/.test(s)) return 0;
    const yearMatch = s.match(/\b(20\d{2})\b/);
    if (yearMatch) {
        const year = parseInt(yearMatch[1], 10);
        const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const monthMatch = s.match(new RegExp(`(${monthNames.join('|')})`));
        const month = monthMatch ? monthNames.indexOf(monthMatch[1]) + 1 : 1;
        const now = new Date();
        const diff = (now.getFullYear() - year) * 12 + (now.getMonth() + 1 - month);
        return diff >= 0 ? diff : null;
    }
    return null;
}

// Builds the recent-posts block for the email prompt. Drops posts older
// than 12 months. Sorts newest-first. Tags posts ≤3mo with a "prefer this"
// hint so the body LLM emphasizes the freshest material. Detects hiring
// keywords in the fresh window only.
function formatPostsForPrompt(posts) {
    if (!posts || posts.length === 0) return { postsText: '', hiringSignal: false };

    const HIRING_KEYWORDS = ['hiring', "we're hiring", 'we are hiring', 'job opening', 'open role', 'apply now', 'apply here', 'join our team', 'looking for a', 'looking for an', '#hiring'];
    const MAX_MONTHS = 12;
    const RECENT_MONTHS = 3;
    const HIRING_MAX_MONTHS = 8;

    let hiringSignal = false;
    const relevant = [];

    for (const p of posts) {
        const lower = (p.text || '').toLowerCase();
        const monthsAgo = postMonthsAgo(p);

        if (HIRING_KEYWORDS.some(k => lower.includes(k))) {
            if (monthsAgo !== null && monthsAgo <= HIRING_MAX_MONTHS) hiringSignal = true;
            continue;
        }

        if (monthsAgo !== null && monthsAgo > MAX_MONTHS) continue;
        relevant.push({ ...p, _monthsAgo: monthsAgo });
    }

    if (relevant.length === 0) return { postsText: '', hiringSignal };

    relevant.sort((a, b) => {
        const am = a._monthsAgo, bm = b._monthsAgo;
        if (am === null && bm === null) return 0;
        if (am === null) return 1;
        if (bm === null) return -1;
        return am - bm;
    });

    const postsText = relevant.map((p, i) => {
        const engagement = `${p.likes} likes, ${p.comments} comments`;
        const recencyTag = (p._monthsAgo !== null && p._monthsAgo <= RECENT_MONTHS)
            ? ' ← within last 3 months, prefer this'
            : '';
        const date = p.date ? ` (${p.date}${recencyTag})` : (recencyTag ? ` (${recencyTag.trim()})` : '');
        return `${i + 1}. ${p.text.substring(0, 300)}...${date} [${engagement}]`;
    }).join('\n\n');

    return { postsText, hiringSignal };
}

// A scraped LI summary is "useful" only when at least one of the fields
// the email prompt actually reads is populated with non-empty text.
// summarizeProfile() returns an object full of empty-string defaults when
// Apify hits a blocked/partial response, and the original cache check
// `liSummary && ...` accepted that empty shell as a valid cache hit -
// generic emails got anchored forever for that lead. Both /api/email and
// /api/li-message use this so the cache semantics stay aligned. Keep in
// sync with buildLinkedInBlock's `if (s.X)` checks in prompts/email.js.
function isUsefulLiSummary(s) {
    if (!s || typeof s !== 'object') return false;
    const fields = ['headline', 'current', 'about', 'experience', 'location', 'promotions'];
    for (const f of fields) {
        if (typeof s[f] === 'string' && s[f].trim()) return true;
    }
    if (s.recentPromotion && s.recentPromotion.newRole) return true;
    return false;
}

// At least one post must have actual body text - empty arrays and arrays of
// date-only stubs don't count as cache content.
function hasUsefulPosts(posts) {
    if (!Array.isArray(posts) || posts.length === 0) return false;
    return posts.some((p) => p && typeof p.text === 'string' && p.text.trim());
}

// Compact tag string for logs so the operator can see at a glance which LI
// fields are feeding the prompt.
function describeLiSummary(s) {
    if (!s) return 'empty';
    const tags = [];
    if (s.headline) tags.push('headline');
    if (s.current) tags.push('current');
    if (s.about) tags.push('about');
    if (s.experience) tags.push('experience');
    if (s.location) tags.push('location');
    if (s.recentPromotion) tags.push('recentPromotion');
    return tags.length ? tags.join('+') : 'empty';
}

module.exports = {
    scrapeLinkedInProfile,
    scrapeRecentPosts,
    summarizeProfile,
    postMonthsAgo,
    formatPostsForPrompt,
    isUsefulLiSummary,
    hasUsefulPosts,
    describeLiSummary,
};
