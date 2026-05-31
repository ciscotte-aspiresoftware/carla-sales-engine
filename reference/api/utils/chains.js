// Major-chain blocklist + target-type allowlist for filtering Scrapingdog
// search results down to "independent rentals only". Mirrors the lists in
// BlueBird/find-leads.js so the two sourcing paths (batch script + UI)
// behave identically.
//
// Add a domain here when a new aggregator/chain shows up cluttering scans.

const CHAIN_DOMAINS = new Set([
    // Hertz family
    'hertz.com', 'hertz.co.uk', 'hertz.de', 'hertz.fr', 'hertz.nl', 'hertz.es', 'hertz.it', 'hertz.ca', 'hertz.com.au',
    // Enterprise family
    'enterprise.com', 'enterprise.co.uk', 'enterprise.de', 'enterprise.fr', 'enterprise.nl', 'enterprise.es', 'enterprise.it', 'enterprise.ca',
    // Avis family
    'avis.com', 'avis.co.uk', 'avis.de', 'avis.fr', 'avis.nl', 'avis.es', 'avis.it', 'avis.ca', 'avis.com.au',
    // Budget family
    'budget.com', 'budget.co.uk', 'budget.de', 'budget.fr', 'budget.nl', 'budget.es', 'budget.com.au',
    // Alamo / National
    'alamo.com', 'alamo.co.uk', 'national.com', 'nationalcar.com', 'nationalcar.co.uk',
    // Sixt
    'sixt.com', 'sixt.co.uk', 'sixt.de', 'sixt.fr', 'sixt.nl', 'sixt.es',
    // Europcar
    'europcar.com', 'europcar.co.uk', 'europcar.de', 'europcar.fr', 'europcar.nl', 'europcar.es', 'europcar.it',
    // Smaller chains / aggregators that still aren't ICP
    'dollar.com', 'thrifty.com', 'foxrentacar.com', 'aceriacar.com', 'acerentacar.com',
    'paylesscar.com', 'easirent.com', 'goldcar.es', 'firefly.com',
    'drivalia.com', 'drivalia.co.uk',
    'greenmotion.com',
]);

// Google Maps `types[]` / `type` strings that mean "this IS a car rental".
// We only KEEP results whose types intersect this set. Multilingual variants
// included so the same allowlist works across markets.
const TARGET_TYPES = new Set([
    // English
    'Car rental agency', 'Car rental service', 'Van rental agency', 'Truck rental agency',
    'Vehicle rental agency', 'Vehicle rental',
    // Dutch
    'Autoverhuurbedrijf', 'Autoverhuur',
    // German
    'Autovermietung', 'Autovermietagentur', 'Mietwagenfirma',
    // French
    'Agence de location de voitures', 'Société de location de voitures',
    // Spanish
    'Agencia de alquiler de coches', 'Empresa de alquiler de coches',
    // Italian
    'Autonoleggio',
    // Portuguese
    'Locadora de veículos', 'Empresa de aluguer de automóveis',
]);

function extractDomain(url) {
    if (!url) return '';
    try {
        return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
        return '';
    }
}

function isChain(domain) {
    return !!domain && CHAIN_DOMAINS.has(domain);
}

function isTargetType(types) {
    if (!Array.isArray(types) && typeof types !== 'string') return false;
    const list = Array.isArray(types) ? types : [types];
    return list.some(t => TARGET_TYPES.has(t));
}

module.exports = { CHAIN_DOMAINS, TARGET_TYPES, extractDomain, isChain, isTargetType };
