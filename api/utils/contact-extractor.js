// Pull contact details out of scraped website markdown.
//
// Firecrawl returns the page (or, in crawl mode, every page concatenated)
// as markdown. Independent businesses almost always list a phone + an
// info@ email + sometimes a LinkedIn link right on the site - often the
// ONLY reachable contact for a micro-business Apollo has never heard of.
// This extractor harvests those so the email/outreach flow has a fallback
// when Apollo comes back empty.
//
// Two confidence tiers:
//   - High: mailto:/tel: links and explicit linkedin.com URLs. These are
//     structured, near-zero false positives.
//   - Medium: free-text email + phone regex over the body. Phones in
//     particular are noisy (prices, review counts, years), so each
//     candidate is validated by digit count before being kept.
//
// Returns deduped arrays. Never throws - bad input yields empty arrays.

// ─── Email ────────────────────────────────────────────────────────────
const MAILTO_RE = /mailto:([^\s)"'>?]+)/gi;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// Drop matches that are really image/asset filenames or known tracking /
// placeholder addresses, not real contact emails.
const EMAIL_JUNK_RE = /\.(png|jpe?g|gif|svg|webp|ico|css|js)$/i;
const EMAIL_JUNK_DOMAINS = ['example.com', 'sentry.io', 'wixpress.com', 'domain.com', 'email.com', 'yourcompany.com'];

// ─── Phone ────────────────────────────────────────────────────────────
// Parens are not legal in a real tel: URL (would be percent-encoded) so
// they're excluded - including them let captures bleed past the URL's
// real end, e.g. <a href="tel:7135103235">…</a>) 1300 → "7135103235) 1300".
// Spaces are kept because RFC 3966 allows hyphens/spaces inside the
// number itself; tel:+1 832 510 6936 is valid.
const TEL_RE = /tel:([+\d][\d\s.-]{5,})/gi;
// Free-text phone candidates. Deliberately broad - validated downstream
// by stripping to digits and checking the count. Three shapes:
//   +44 20 1234 5678   (international)
//   (020) 1234 5678    (parenthesized area code)
//   01234 567890       (spaced/dashed national)
const PHONE_FREE_RE = /(?:\+\d[\d\s().-]{6,}\d)|(?:\(\d{2,5}\)[\s.-]?\d[\d\s.-]{4,}\d)|(?:\b\d{2,5}[\s.-]\d{2,4}[\s.-]\d{2,4}(?:[\s.-]\d{2,4})?\b)|(?:\b\d{2,4}[\s.-]\d{6,9}\b)/g;

// Phone-shaped non-phones the loose regex would otherwise grab:
//   • opening-hours ranges: "09.00-17.00", "9:00 - 17:30"
//   • single times:         "09.00"
//   • dates DD-first:       "25-05-2026", "01/01/26"
//   • dates YYYY-first:     "2017-07-12", "2017-07-12 18" (ISO 8601 timestamps
//                           - these appear in scraped review feeds + post logs
//                           and look exactly like phone numbers to the loose
//                           regex: 4-2-2-2 dash chunks with 10 digits total)
//   • decimal coordinates:  "51.8306625" (NL lat scrapped from map blocks)
//   • registration IDs:     "8596.94.008" (NL KvK), "202.4752.5607" (structured codes)
//   • IBAN fragments:       "0000 4187 1146" (4+ leading zeros never appear in phone systems)
// These are rejected before a candidate is accepted as a phone.
const TIME_RANGE_RE = /\d{1,2}[.:]\d{2}\s*[-–-]\s*\d{1,2}[.:]\d{2}/;
const TIME_RE = /^\s*\d{1,2}[.:]\d{2}\s*$/;
const DATE_RE = /\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/;
// ISO 8601 date: YYYY-MM-DD with optional time tail (" 18", " 18:30", "T18:30").
// Anchored on a 4-digit year + dash/slash + 1-2 digit month + dash/slash + 1-2
// digit day so a real phone like "1234-567-8901" (which has only 4 digits in
// the first chunk) doesn't false-match - the day chunk must be 1-2 digits, the
// month chunk must be 1-2 digits.
const ISO_DATE_RE = /\b\d{4}[-/.][01]?\d[-/.][0-3]?\d(?:[\sT]\d{1,2}(?::\d{2})?)?\b/;

// ─── LinkedIn ─────────────────────────────────────────────────────────
const LI_PERSON_RE = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_%-]+/gi;
const LI_COMPANY_RE = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/company\/[A-Za-z0-9_%-]+/gi;

function uniqLower(arr) {
    const seen = new Set();
    const out = [];
    for (const v of arr) {
        const key = v.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(v);
    }
    return out;
}

// Decide if a candidate is plausibly a real phone number. Reject opening
// hours / single times / dates first (they're digit-grouped like phones),
// then require ≥9 digits - real contact numbers carry an area or country
// code, so 8-and-under almost always means hours (09001700) or a date
// (25052026), not a phone. E.164 caps the upper bound at 15.
function isPlausiblePhone(raw) {
    const s = String(raw).trim();
    if (TIME_RANGE_RE.test(s) || TIME_RE.test(s) || DATE_RE.test(s) || ISO_DATE_RE.test(s)) return false;
    const digits = s.replace(/[^\d]/g, '');
    if (digits.length < 9 || digits.length > 15) return false;
    if (/^(\d)\1+$/.test(digits)) return false; // 0000000, 1111111
    // 4+ leading zeros are an IBAN / bookkeeping fragment ("0000 4187 1146"),
    // never a phone-system prefix. Tighter than the all-same-digit check above.
    if (/^0{4,}/.test(digits)) return false;
    // Dot-grouped candidates: real phone formats that use dots (NL/BE/FR/DE)
    // always group in 2-3 digit chunks ("010.123.45.67", "+33.6.12.34.56.78").
    // Any chunk with 4+ digits is almost always one of:
    //   • a decimal coordinate (lat/lng): "51.8306625"  → chunks=[51, 8306625]
    //   • a registration ID (NL KvK/BTW): "8596.94.008" → chunks=[8596, 94, 008]
    //   • a structured numeric code: "202.4752.5607"   → chunks=[202, 4752, 5607]
    // None of those are reachable phone numbers; reject them outright. Real
    // phones using dots all pass this rule because they don't carry 4-digit
    // sub-blocks. Empirically catches every false positive in the audit
    // without dropping any real numbers.
    if (s.includes('.')) {
        const chunks = s.replace(/^[+]/, '').split('.');
        if (chunks.some((c) => /^\d{4,}$/.test(c))) return false;
    }
    return true;
}

// Normalize a phone for dedupe: keep a leading +, drop other non-digits.
function normalizePhone(raw) {
    const trimmed = String(raw).trim();
    const hasPlus = trimmed.startsWith('+');
    const digits = trimmed.replace(/[^\d]/g, '');
    return (hasPlus ? '+' : '') + digits;
}

function cleanEmail(e) {
    return e.trim().replace(/[.,;:]+$/, ''); // drop trailing punctuation
}

function isJunkEmail(e) {
    if (EMAIL_JUNK_RE.test(e)) return true;
    const domain = e.split('@')[1]?.toLowerCase() || '';
    return EMAIL_JUNK_DOMAINS.includes(domain);
}

// "info@x.nl" → ["info", "x.nl"] (both lowercased). Splits on the LAST @
// so a stray @ in the local part doesn't mangle the domain.
function splitEmail(e) {
    const at = e.lastIndexOf('@');
    if (at === -1) return [null, null];
    return [e.slice(0, at).toLowerCase(), e.slice(at + 1).toLowerCase()];
}

function extractEmails(text) {
    let m;
    const mailto = [];
    MAILTO_RE.lastIndex = 0;
    while ((m = MAILTO_RE.exec(text)) !== null) mailto.push(cleanEmail(m[1]));
    const free = [];
    EMAIL_RE.lastIndex = 0;
    while ((m = EMAIL_RE.exec(text)) !== null) free.push(cleanEmail(m[0]));

    const mailtoClean = mailto.filter((e) => !isJunkEmail(e));
    const freeClean = free.filter((e) => !isJunkEmail(e));

    // De-glue free-text emails. A plain-text scan can fuse a connecting word
    // onto a real address when the page collapses whitespace - e.g. Dutch
    // "Mail ons info@x.nl" becomes "onsinfo@x.nl". The site's own mailto:
    // links are ground truth, so drop any free-text email whose local-part
    // is a longer, purely-letter-prefixed superstring of a mailto address on
    // the same domain ("onsinfo" ends with the published "info", prefix
    // "ons" is all letters → it's a scan artifact, not a real mailbox).
    const mailtoByDomain = new Map(); // domain → Set(localLower)
    for (const e of mailtoClean) {
        const [local, domain] = splitEmail(e);
        if (!local || !domain) continue;
        if (!mailtoByDomain.has(domain)) mailtoByDomain.set(domain, new Set());
        mailtoByDomain.get(domain).add(local);
    }
    const isGlued = (e) => {
        const [local, domain] = splitEmail(e);
        const locals = mailtoByDomain.get(domain);
        if (!local || !locals || locals.has(local)) return false; // unknown or exact published address
        for (const ml of locals) {
            if (local.length > ml.length && local.endsWith(ml)) {
                const prefix = local.slice(0, local.length - ml.length);
                if (/^[a-z]+$/.test(prefix)) return true;
            }
        }
        return false;
    };
    const freeKept = freeClean.filter((e) => !isGlued(e));

    // Mailto first so the canonical published address sorts ahead of any
    // free-text variants when deduped.
    return uniqLower([...mailtoClean, ...freeKept]);
}

function extractPhones(text) {
    const found = [];
    let m;
    TEL_RE.lastIndex = 0;
    while ((m = TEL_RE.exec(text)) !== null) found.push(m[1]);
    PHONE_FREE_RE.lastIndex = 0;
    while ((m = PHONE_FREE_RE.exec(text)) !== null) found.push(m[0]);
    const plausible = found
        .filter(isPlausiblePhone)
        // Trim surrounding junk: leading non-(digit/+/'(') and trailing
        // non-digits. Fixes the leaked closing paren on "tel:(020 123 456)"
        // → "020 123 456" without touching valid "(020) 123 456" formats.
        .map((p) => p.trim().replace(/^[^\d+(]+/, '').replace(/[^\d]+$/, ''))
        .filter(Boolean);
    // Dedupe on the normalized digit form so "+44 20 1234 5678" and
    // "+442012345678" collapse to one, but keep the nicely-formatted
    // original for display.
    const seen = new Set();
    const out = [];
    for (const p of plausible) {
        const key = normalizePhone(p);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(p.replace(/\s+/g, ' '));
    }
    return out;
}

function extractLinkedIn(text, re) {
    const found = [];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
        let url = m[0];
        if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
        // Normalize host to lowercase, strip a trailing slash.
        url = url.replace(/\/+$/, '');
        found.push(url);
    }
    return uniqLower(found);
}

/**
 * Extract all contact signals from scraped markdown.
 * @param {string} markdown
 * @returns {{ emails: string[], phones: string[], linkedinPersonUrls: string[], linkedinCompanyUrls: string[] }}
 */
function extractContacts(markdown) {
    if (!markdown || typeof markdown !== 'string') {
        return { emails: [], phones: [], linkedinPersonUrls: [], linkedinCompanyUrls: [] };
    }
    return {
        emails: extractEmails(markdown),
        phones: extractPhones(markdown),
        linkedinPersonUrls: extractLinkedIn(markdown, LI_PERSON_RE),
        linkedinCompanyUrls: extractLinkedIn(markdown, LI_COMPANY_RE),
    };
}

// True when there's at least one contact of any kind - lets callers skip
// persisting an all-empty object.
function hasAnyContact(c) {
    return !!c && (
        (c.emails && c.emails.length > 0) ||
        (c.phones && c.phones.length > 0) ||
        (c.linkedinPersonUrls && c.linkedinPersonUrls.length > 0) ||
        (c.linkedinCompanyUrls && c.linkedinCompanyUrls.length > 0)
    );
}

module.exports = { extractContacts, hasAnyContact };
