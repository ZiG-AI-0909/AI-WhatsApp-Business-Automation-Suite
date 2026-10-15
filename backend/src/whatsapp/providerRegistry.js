// =============================================================
// Messaging provider registry.
//
// One place that says which provider can do what, so campaign code
// asks for a capability instead of branching on provider names.
//
//   web       WhatsApp Web via Baileys. UNOFFICIAL: it automates a
//             linked device, is not covered by WhatsApp's Business
//             terms for bulk sending, has no template or quality
//             signals, and the number can be banned without warning.
//             Kept for existing users; prefer `business` for campaigns.
//   business  WhatsApp Business Platform Cloud API (official). Supports
//             approved templates, delivery webhooks, quality rating and
//             messaging-limit tiers.
//
// Every function takes the owner's userId and only uses that user's
// own connection (there is no shared or fallback session).
// =============================================================

const CAPABILITIES = {
    web: {
        official: false,
        templates: false,
        interactiveButtons: false,
        deliveryReceipts: true,
        qualitySignals: false,
        // WhatsApp Web presence updates are not an official feature and
        // are never used to make automated campaign traffic look manual.
        typingIndicator: false,
    },
    business: {
        official: true,
        templates: true,
        interactiveButtons: true,
        deliveryReceipts: true,
        qualitySignals: true,
        // Official typing indicator exists only for replies to a received
        // message, never for campaign (business-initiated) messages.
        typingIndicator: 'replies_only',
    },
};

const LABELS = {
    web: 'WhatsApp Web (unofficial, linked device)',
    business: 'WhatsApp Business Platform (official Cloud API)',
};

function normalizeProvider(name) {
    return name === 'business' ? 'business' : 'web';
}

function reviveTimeoutMs() {
    return Number(process.env.WA_SEND_REVIVE_TIMEOUT_MS || 45000);
}

function get(name) {
    const id = normalizeProvider(name);
    if (id === 'business') {
        const business = () => require('./businessApiProvider');
        return {
            id,
            label: LABELS[id],
            capabilities: CAPABILITIES[id],
            getStatus: userId => business().getStatus(userId),
            async isConnected(userId) {
                return business().getStatus(userId) === 'connected';
            },
            async getSender(userId) {
                if (business().getStatus(userId) !== 'connected') {
                    throw new Error('Your WhatsApp Business API is not connected. Reconnect it to continue this campaign.');
                }
                // options.callbackData comes back in delivery webhooks
                // (biz_opaque_callback_data) so receipts map to recipients.
                return (phone, body, media, buttons, options = {}) => (options.template?.name
                    ? business().sendTemplate(userId, phone, options.template, media, options)
                    : business().sendMessage(userId, phone, body, media, buttons, options));
            },
            getHealth: userId => business().getPhoneHealth(userId),
        };
    }
    const sessions = () => require('./sessionManager');
    return {
        id,
        label: LABELS[id],
        capabilities: CAPABILITIES[id],
        getStatus: userId => sessions().getStatus(userId),
        async isConnected(userId) {
            if (sessions().getStatus(userId) === 'connected') return true;
            return !!await sessions().ensureConnected(userId, reviveTimeoutMs());
        },
        async getSender(userId) {
            if (sessions().getStatus(userId) !== 'connected') {
                // Unattended revival: a scheduled campaign may fire after the
                // idle timeout dropped the socket. Reconnect from the stored
                // auth state before giving up.
                const revived = await sessions().ensureConnected(userId, reviveTimeoutMs());
                if (!revived) {
                    throw new Error('Your WhatsApp session is not connected. Reconnect WhatsApp to continue this campaign.');
                }
            }
            // options.messageId: assigned by the queue before sending so
            // receipts and retries refer to the same WhatsApp message.
            return (phone, body, media, _buttons, options = {}) => sessions().sendMessage(userId, phone, body, null, media, { messageId: options.messageId });
        },
        getHealth: async () => null,
    };
}

module.exports = { CAPABILITIES, LABELS, get, normalizeProvider };
