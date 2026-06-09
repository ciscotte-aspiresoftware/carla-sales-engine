// Major airports dataset - anchors high-conversion cells for ICPs where
// car rental, fleet hire, ground transportation cluster heavily (basically
// anything travel-adjacent). Loaded only when an ICP's coverage config
// has `airports: true`.
//
// Today this is a curated list in api/data/airports.json with ~50 major
// airports across UK / US / CA / NL. To expand globally swap for the
// OurAirports CSV (50 k+ airports worldwide, free - see ourairports.com).

const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', 'data', 'airports.json');

let cache = null;

function loadAll() {
    if (cache) return cache;
    if (!fs.existsSync(FILE)) {
        cache = [];
        return cache;
    }
    try {
        cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) || [];
    } catch {
        cache = [];
    }
    return cache;
}

function getAirportsForCountry(countryCode) {
    if (!countryCode) return [];
    return loadAll().filter(a => a.country === countryCode);
}

module.exports = { loadAll, getAirportsForCountry };
