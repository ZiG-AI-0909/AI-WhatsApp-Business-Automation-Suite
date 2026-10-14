'use strict';

const { supabase, isAvailable } = require('./supabaseClient');

const PENDING_MESSAGE = 'Database migration pending: run supabase-quotation-migration.sql in the Supabase SQL Editor';
const INTERVAL_MS = 60_000;

function createQuotationMigrationGuard({
    client,
    databaseAvailable,
    logger = console,
    now = Date.now,
    intervalMs = INTERVAL_MS,
}) {
    let lastCheckedAt = null;
    let missing = false;
    let inFlight = null;
    let timer = null;

    async function check() {
        if (inFlight) return inFlight;
        const timestamp = now();
        if (lastCheckedAt !== null && timestamp - lastCheckedAt < intervalMs) return { ok: !missing, skipped: true };
        lastCheckedAt = timestamp;
        inFlight = (async () => {
            try {
                if (!databaseAvailable() || !client) throw new Error('Supabase service-role client is unavailable.');
                const checks = [
                    ['price_list_items', 'id,user_id,item_code,name,category,size,pressure_class,specification,unit,rate,hsn_code,gst_percent,active,updated_at'],
                    ['quotations', 'id,user_id,boq_document_id,quote_number,customer_name,customer_phone,customer_address,customer_state,customer_gstin,project_name,status,validity_days,payment_terms,delivery_terms,freight,discount_percent,notes,subtotal,tax_total,grand_total,sent_at,send_claimed_at,created_at,updated_at'],
                    ['quotation_items', 'id,quotation_id,user_id,line_no,boq_item_ref,price_list_item_id,description,size,unit,quantity,rate,discount_percent,gst_percent,hsn_code,amount,match_status,created_at,updated_at'],
                    ['quotation_audit', 'id,user_id,quotation_id,quotation_item_id,actor_user_id,field_name,old_value,new_value,created_at'],
                    ['quotation_counters', 'user_id,fiscal_year,last_number'],
                ];
                for (const [table, columns] of checks) {
                    const { error } = await client.from(table).select(columns).limit(0);
                    if (error) throw error;
                }
                const { data, error } = await client.rpc('quotation_migration_ready');
                if (error) throw error;
                if (data !== true) throw new Error('Quotation schema objects are incomplete.');
                if (missing) logger.info('[quotation-migration-guard] Quotation migration is now available.');
                missing = false;
                return { ok: true };
            } catch (error) {
                if (!missing) logger.error(PENDING_MESSAGE);
                missing = true;
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
            timer = setInterval(() => check().catch((error) => logger.error(`[quotation-migration-guard] ${error.message}`)), intervalMs);
            timer.unref?.();
        }
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { check, start, stop };
}

const guard = createQuotationMigrationGuard({ client: supabase, databaseAvailable: isAvailable });

module.exports = {
    PENDING_MESSAGE,
    INTERVAL_MS,
    createQuotationMigrationGuard,
    startQuotationMigrationGuard: guard.start,
    checkQuotationMigration: guard.check,
    stopQuotationMigrationGuard: guard.stop,
};
