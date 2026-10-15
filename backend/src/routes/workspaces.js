// GET /api/workspaces — the signed-in user's own workspace plus every
// workspace another user shared with them (private.user_data_shares).
// Mounted behind requireAuth; the list is always computed for the
// signed-in user (req.user.authId), never for the active workspace.
const express = require('express');
const { listDataOwners } = require('../security/dataOwner');

const router = express.Router();

router.get('/', async (req, res) => {
    try {
        const authId = req.user.authId || req.user.id;
        const shared = await listDataOwners(authId);
        res.json({
            self: { id: authId, email: req.user.email || '' },
            active: req.user.id,
            sharedAccess: !!req.user.sharedAccess,
            shared: shared.map(owner => ({ id: owner.ownerUserId, email: owner.ownerEmail, sharedAt: owner.sharedAt })),
        });
    } catch (error) {
        console.error('[workspaces] list failed:', error.message);
        res.status(500).json({ error: 'Could not load shared workspaces.' });
    }
});

module.exports = router;
