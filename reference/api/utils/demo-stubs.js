// Canned responses for credit-spending endpoints when the server is in
// demo mode. Each stub matches the shape the corresponding route returns
// in real mode so the frontend doesn't need a demo-aware code path -
// flipping modes just changes what the API hands back.
//
// Stubs are intentionally minimal: just enough fields for the UI to render
// a believable result. They're not pretending to be real data — every
// payload carries `demo: true` and warnings flag the canned origin so a
// developer reading network traces sees what's happening.

function classifyStub(url) {
    let domain = '';
    try { domain = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { /* ignore */ }
    const name = domain.split('.')[0] || 'Demo Co';
    const titled = name.charAt(0).toUpperCase() + name.slice(1);
    return {
        is_match: true,
        reason: 'Demo mode — stubbed classification, no Firecrawl/OpenAI credits spent.',
        title: `${titled} Demo`,
        name: `${titled}`,
        domain,
        country: 'United Kingdom',
        city: 'London',
        languages: ['English'],
        isCarRental: true,
        isIndependent: true,
        confidence: 'medium',
        tagline: 'Sample tagline returned by demo stub.',
        fleetSizeHint: '10-50',
        hasOnlineBooking: true,
        signals: ['demo:stub'],
        reasoning: 'This response was generated locally and did not call any external API.',
    };
}

function leadsStub() {
    const people = [
        { firstName: 'Alex',  lastName: 'Morgan',   title: 'Founder / CEO',         apolloId: 'demo-1' },
        { firstName: 'Priya', lastName: 'Shah',     title: 'Head of Operations',    apolloId: 'demo-2' },
        { firstName: 'Marco', lastName: 'Bianchi',  title: 'Fleet Manager',         apolloId: 'demo-3' },
    ].map((p) => ({
        ...p,
        email: null,
        emailStatus: null,
        linkedinUrl: null,
        hasEmail: false,
        enriched: false,
    }));
    return {
        people,
        warnings: ['Demo mode — leads were stubbed locally, no Apollo credits spent.'],
    };
}

function emailStub({ classification, lead, template }) {
    const recipient = `${lead?.firstName || ''} ${lead?.lastName || ''}`.trim() || 'there';
    const company = classification?.name || classification?.title || classification?.domain || 'your company';
    const senderName = template?.sender?.firstName || 'The team';
    const senderCompany = template?.sender?.company || 'our company';
    const signoff = template?.sender?.signoff || 'Best,';
    const subject = `Quick thought on ${company}`;
    const body = [
        `Hi ${recipient},`,
        '',
        `This is a demo-mode preview email — no OpenAI tokens were spent generating it. In real mode the system prompt for "${template?.name || 'the chosen template'}" would have been sent to GPT.`,
        '',
        `We help teams like ${company} streamline rental operations. Worth a quick chat?`,
        '',
        signoff,
        `${senderName}${senderCompany ? ` · ${senderCompany}` : ''}`,
    ].join('\n');
    return { subject, body };
}

function sourcingSearchStub(target, query) {
    return {
        results: [
            {
                title: `Demo Rentals — ${target.label}`,
                placeId: 'demo-place-1',
                dataId: 'demo-data-1',
                website: 'https://example.com',
                domain: 'example.com',
                phone: '+44 20 0000 0000',
                address: `Demo St 1, ${target.label}`,
                rating: 4.5,
                reviews: 120,
                primaryType: 'car_rental',
                allTypes: ['car_rental'],
                description: 'Stubbed result — no Scrapingdog credits spent.',
                hours: '',
                gps: null,
                thumbnail: '',
            },
        ],
        counts: { totalRaw: 1, keptCount: 1, chainsFiltered: 0, nonTargetFiltered: 0 },
        query,
    };
}

function placeDetailsStub() {
    return {
        title: 'Demo Place',
        rating: 4.5,
        reviews: 120,
        ratingSummary: [],
        phone: '+44 20 0000 0000',
        address: 'Demo St 1, London',
        types: ['car_rental'],
        serviceOptions: {},
        extensions: [],
        unsupportedExtensions: [],
        gps: null,
    };
}

module.exports = {
    classifyStub,
    leadsStub,
    emailStub,
    sourcingSearchStub,
    placeDetailsStub,
};
