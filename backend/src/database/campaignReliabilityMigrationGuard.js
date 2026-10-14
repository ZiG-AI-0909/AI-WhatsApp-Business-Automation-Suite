const { supabase, isAvailable } = require('./supabaseClient');

const CAMPAIGN_MIGRATION_PENDING_MESSAGE =
    'Database migration pending: run supabase-campaign-reliability-migration.sql in the Supabase SQL Editor';
const CHECK_INTERVAL_MS = 60_000;

function isMissingMigrationError(error) {
    const message = String(error?.message || error || '');
    return ['PGRST202', 'PGRST204', '42703', '42883'].includes(error?.code)
        || /schema cache/i.test(message) && /\b(column|function|rpc)\b/i.test(message)
        || /function .*recount_campaign_counters.* does not exist/i.test(message);
}

function createCampaignReliabilityMigrationGuard({
    client,
    databaseAvailable,
    logger = console,
    now = Date.now,
    intervalMs = CHECK_INTERVAL_MS,
}) {
    let lastCheckAt = null;
    let inFlight = null;
    let timer = null;
    let migrationWasMissing = false;

    async function check() {
        if (inFlight) return inFlight;
        const checkedAt = now();
        if (lastCheckAt !== null && checkedAt - lastCheckAt < intervalMs) {
            return { ok: !migrationWasMissing, skipped: true };
        }
        lastCheckAt = checkedAt;

        inFlight = (async () => {
            try {
                if (!databaseAvailable() || !client) {
                    logger.error('[migration-guard] Cannot check campaign reliability migration: Supabase service-role client is unavailable.');
                    return { ok: false, unavailable: true };
                }

                const { error: columnsError } = await client
                    .from('campaigns')
                    .select('pause_reason,last_error,media_bucket,media_object_path')
                    .limit(0);
                if (columnsError) throw columnsError;

                const { error: rpcError } = await client.rpc('recount_campaign_counters', {
                    p_campaign_id: 0,
                    p_user_id: '00000000-0000-0000-0000-000000000000',
                });
                if (rpcError) throw rpcError;

                if (migrationWasMissing) {
                    logger.info('[migration-guard] Campaign reliability migration is now available.');
                }
                migrationWasMissing = false;
                return { ok: true };
            } catch (error) {
                if (isMissingMigrationError(error)) {
                    if (!migrationWasMissing) logger.error(CAMPAIGN_MIGRATION_PENDING_MESSAGE);
                    migrationWasMissing = true;
                    return { ok: false, missing: true };
                }
                logger.error(`[migration-guard] Campaign reliability migration check failed: ${error.message}`);
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
            timer = setInterval(() => {
                check().catch(error => logger.error(`[migration-guard] Campaign reliability migration check failed: ${error.message}`));
            }, intervalMs);
            timer.unref?.();
        }
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { check, start, stop };
}

const guard = createCampaignReliabilityMigrationGuard({
    client: supabase,
    databaseAvailable: isAvailable,
});

module.exports = {
    CAMPAIGN_MIGRATION_PENDING_MESSAGE,
    CHECK_INTERVAL_MS,
    createCampaignReliabilityMigrationGuard,
    isMissingMigrationError,
    startCampaignReliabilityMigrationGuard: guard.start,
    checkCampaignReliabilityMigration: guard.check,
    stopCampaignReliabilityMigrationGuard: guard.stop,
};
