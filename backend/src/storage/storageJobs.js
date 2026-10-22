'use strict';

// Storage scheduler. The backend runs as a long-lived Node process (Render),
// so a timer drives it — but every decision is made from database state
// (last snapshot, alert level) and guarded by a database lock, so restarts
// and several instances never send the same alert twice.
//
// If the server can sleep (e.g. a free Render instance), point an external
// scheduler (Render Cron Job, cron-job.org, …) at
//   POST /api/storage/cron   header  X-Cron-Secret: <STORAGE_CRON_SECRET>
// every 15 minutes; it runs the same tick.

const monitor = require('./storageMonitor');

const TICK_MS = Math.max(1, Number(process.env.STORAGE_TICK_MINUTES || 10)) * 60_000;
const FIRST_TICK_MS = 60_000;

let timer = null;
let ticking = null;

/** Measure, record a snapshot and send any due warning. */
async function tick() {
    if (ticking) return ticking;
    ticking = monitor.evaluate()
        .then((result) => (result.skipped ? { skipped: true } : { severity: result.severity }))
        .catch((error) => {
            if (error.code !== 'STORAGE_MIGRATION_PENDING') console.error(`[storage] tick failed: ${error.message}`);
            return { error: error.message };
        })
        .finally(() => { ticking = null; });
    return ticking;
}

/** Ask for a check soon after an upload or delete (debounced). */
let soon = null;
function checkSoon() {
    monitor.invalidate();
    if (soon || !timer) return;
    soon = setTimeout(() => { soon = null; tick(); }, 15_000);
    soon.unref?.();
}

function start(io) {
    monitor.setIo(io);
    if (timer || process.env.STORAGE_MONITOR_DISABLED === 'true') return;
    setTimeout(tick, FIRST_TICK_MS).unref?.();
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
    console.log(`[storage] monitor started (every ${TICK_MS / 60_000} min)`);
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

module.exports = { tick, start, stop, checkSoon };
