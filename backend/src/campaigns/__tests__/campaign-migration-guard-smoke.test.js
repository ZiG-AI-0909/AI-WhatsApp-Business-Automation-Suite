const assert = require('node:assert/strict');
const express = require('express');
const db = require('../../database/db');
const campaignRoutes = require('../../routes/campaigns');
const {
    CAMPAIGN_MIGRATION_PENDING_MESSAGE,
    CHECK_INTERVAL_MS,
    createCampaignReliabilityMigrationGuard,
} = require('../../database/campaignReliabilityMigrationGuard');

async function testMigrationGuardDetectsMissingSchemaAndRecovers() {
    let currentTime = 1000;
    let rpcAvailable = false;
    let columnAvailable = true;
    const messages = [];
    const logger = {
        error: message => messages.push(message),
        info: message => messages.push(message),
    };
    const client = {
        from(table) {
            assert.equal(table, 'campaigns');
            return {
                select(columns) {
                    assert.equal(columns, 'pause_reason,last_error,media_bucket,media_object_path');
                    return {
                        limit(limit) {
                            assert.equal(limit, 0);
                            return Promise.resolve(columnAvailable
                                ? { data: [], error: null }
                                : { data: null, error: { code: 'PGRST204', message: "Could not find the 'pause_reason' column of 'campaigns' in the schema cache" } });
                        },
                    };
                },
            };
        },
        async rpc(name, args) {
            assert.equal(name, 'recount_campaign_counters');
            assert.deepEqual(args, {
                p_campaign_id: 0,
                p_user_id: '00000000-0000-0000-0000-000000000000',
            });
            return rpcAvailable
                ? { data: [], error: null }
                : { data: null, error: { code: 'PGRST202', message: 'Could not find the function in the schema cache' } };
        },
    };
    const guard = createCampaignReliabilityMigrationGuard({
        client,
        databaseAvailable: () => true,
        logger,
        now: () => currentTime,
    });

    assert.deepEqual(await guard.check(), { ok: false, missing: true });
    assert.deepEqual(messages, [CAMPAIGN_MIGRATION_PENDING_MESSAGE]);

    currentTime += CHECK_INTERVAL_MS - 1;
    assert.deepEqual(await guard.check(), { ok: false, skipped: true }, 'checks are throttled within one minute');
    assert.equal(messages.length, 1, 'a missing migration is logged once rather than on every check');

    currentTime += 1;
    rpcAvailable = true;
    assert.deepEqual(await guard.check(), { ok: true }, 'guard recovers after the migration is installed');
    assert.deepEqual(messages, [
        CAMPAIGN_MIGRATION_PENDING_MESSAGE,
        '[migration-guard] Campaign reliability migration is now available.',
    ]);

    currentTime += CHECK_INTERVAL_MS;
    columnAvailable = false;
    assert.deepEqual(await guard.check(), { ok: false, missing: true }, 'a missing required column is detected');
    assert.equal(messages.at(-1), CAMPAIGN_MIGRATION_PENDING_MESSAGE);
}

async function testCampaignEndpointsTranslateMissingColumnErrors() {
    const originalGetById = db.getById;
    db.getById = async () => {
        throw new Error("Could not find the 'pause_reason' column of 'campaigns' in the schema cache");
    };

    const app = express();
    app.use((req, _res, next) => {
        req.user = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
        next();
    });
    app.use('/api/campaigns', campaignRoutes);
    const server = app.listen(0);
    try {
        const baseUrl = `http://127.0.0.1:${server.address().port}/api/campaigns/42`;
        for (const endpoint of ['/start', '/retry-failed']) {
            const response = await fetch(`${baseUrl}${endpoint}`, { method: 'POST' });
            assert.equal(response.status, 400);
            assert.deepEqual(await response.json(), { error: CAMPAIGN_MIGRATION_PENDING_MESSAGE });
        }
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.getById = originalGetById;
    }
}

async function main() {
    await testMigrationGuardDetectsMissingSchemaAndRecovers();
    await testCampaignEndpointsTranslateMissingColumnErrors();
    console.log('Campaign migration guard smoke test passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
