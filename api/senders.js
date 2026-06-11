// Carla sender list.
// Demo only has Fazal - easy to add more reps later by appending to the
// array. Keeping the same shape as valsource's senders.js so the email
// generator can read these without conditional code.

const SENDERS = [
    {
        id: 'fazal',
        name: 'Fazal Khaishgi',
        firstName: 'Fazal',
        title: 'Group Managing Director',
        company: 'Carla Auto Rental Software',
        signoff: 'Fazal',
        // Placeholder - replace with the real email + tone you want for production.
        email: 'fazal@carla-arc.com',
        intro: "I'm Fazal, the Group Managing Director at Carla Auto Rental Software, where we help independent rental operators run their fleets, reservations, and counter operations with one purpose-built platform.",
    },
];

const DEFAULT_SENDER = SENDERS[0];

function getSender(id) {
    return SENDERS.find(s => s.id === id) || DEFAULT_SENDER;
}

module.exports = { SENDERS, DEFAULT_SENDER, getSender };
