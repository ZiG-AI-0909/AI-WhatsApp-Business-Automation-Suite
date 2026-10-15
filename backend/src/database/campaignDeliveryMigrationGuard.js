'use strict';

// Detects supabase-campaign-delivery-migration.sql. Unlike the reliability
// guard this migration is optional: code that writes the new columns asks
// isCampaignDeliveryMigrationAvailable() first and keeps the old behaviour
// until the migration has been run.
const { supabase, isAvailable } = require('./supabaseClient');

const PENDING_MESSAGE = 'Database migration pending: run supabase-campaign-delivery-migration.sql in the Supabase SQL Editor (delivery receipts, opt-out records and rate-limit cooldowns are disabled until then)';
const INTERVAL_MS = 60_000;

function createCampaignDeliveryMigrationGuard({
    client,
    databaseAvailable,
    logger = console,
    now = Date.now,
    intervalMs = INTERVAL_MS,
}) {
    let lastCheckedAt = null;
    let available = false;
    let reportedMissing = false;
    let inFlight = null;
    let timer = null;

    async function check() {
        if (inFlight) return inFlight;
        const timestamp = now();
        if (lastCheckedAt !== null && timestamp - lastCheckedAt < intervalMs) return { ok: available, skipped: true };
        lastCheckedAt = timestamp;
        inFlight = (async () => {
            try {
                if (!databaseAvailable() || !client) throw new Error('Supabase service-role client is unavailable.');
                const checks = [
                    ['campaign_contacts', 'delivery_status,delivered_at,read_at,error_code'],
                    ['campaigns', 'delivered,read_count,resume_after'],
                    ['contacts', 'opted_out_at,opt_out_source,opted_in_at,opt_in_source'],
                ];
                for (const [table, columns] of checks) {
                    const { error } = await client.from(table).select(columns).limit(0);
                    if (error) throw error;
                }
                const { error } = await client.rpc('recount_campaign_delivery', {
                    p_campaign_id: 0,
                    p_user_id: '00000000-0000-0000-0000-000000000000',
                });
                if (error) throw error;
                if (reportedMissing) logger.info('[delivery-migration-guard] Campaign delivery migration is now available.');
                available = true;
                reportedMissing = false;
                return { ok: true };
            } catch (error) {
                available = false;
                if (!reportedMissing) logger.error(PENDING_MESSAGE);
                reportedMissing = true;
                return { ok: false, error };
            } finally {
                inFlight = null;
            }
        })();
        return inFlight;
    }

    async function start() {
        await check();
        if (!timer) {
            timer = setInterval(() => check().catch((error) => logger.error(`[delivery-migration-guard] ${error.message}`)), intervalMs);
            timer.unref?.();
        }
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    return {
        check,
        start,
        stop,
        isAvailable: () => available,
        // Tests (and a manual override) can force the flag.
        setAvailable: (value) => { available = !!value; },
    };
}

const guard = createCampaignDeliveryMigrationGuard({ client: supabase, databaseAvailable: isAvailable });

module.exports = {
    PENDING_MESSAGE,
    createCampaignDeliveryMigrationGuard,
    startCampaignDeliveryMigrationGuard: guard.start,
    checkCampaignDeliveryMigration: guard.check,
    stopCampaignDeliveryMigrationGuard: guard.stop,
    isCampaignDeliveryMigrationAvailable: guard.isAvailable,
    setCampaignDeliveryMigrationAvailable: guard.setAvailable,
};
