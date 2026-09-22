const db = require('../database/db');

// ─── Short-TTL cache for the dashboard payload ───────────────
// The Dashboard view polls /analytics/dashboard every 10s (App.jsx). A
// 30s TTL means at most one DB aggregation per 30s per user while every
// poll still returns fresh-enough numbers — the UI refreshes far faster
// than the underlying counters change. invalidateDashboardCache() lets
// write paths bust it immediately when exactness matters.
const DASHBOARD_CACHE_TTL_MS = Number(process.env.ANALYTICS_CACHE_TTL_MS || 30000);
const dashboardCache = new Map(); // userId → { expiresAt, data }

function invalidateDashboardCache(userId) {
    if (userId) dashboardCache.delete(userId);
    else dashboardCache.clear();
}

class AnalyticsService {
    async getDashboard(userId) {
        const cached = dashboardCache.get(userId);
        if (cached && cached.expiresAt > Date.now()) return cached.data;

        const data = await this._computeDashboard(userId);
        dashboardCache.set(userId, { expiresAt: Date.now() + DASHBOARD_CACHE_TTL_MS, data });
        return data;
    }

    async _computeDashboard(userId) {
        // FAST PATH (2026-09 performance fix): ONE Postgres function
        // computes every metric server-side — 1 rpc + 2 selects instead of
        // 14 PostgREST round trips. RPC bodies run inside the database, so
        // the PGRST123 "aggregate functions are not allowed" PostgREST
        // restriction doesn't apply to them. Requires
        // supabase-analytics-dashboard-migration.sql to have been run;
        // until then the RPC 404s (PGRST202) and we fall back.
        try {
            const { data: metrics, error } = await require('../database/supabaseClient').supabase
                .rpc('get_dashboard_metrics', { p_user_id: userId });
            if (!error && metrics) {
                const m = metrics;
                return await this._attachRecentActivity(userId, {
                    contacts: {
                        total: Number(m.total_contacts) || 0,
                        optedOut: Number(m.opted_out) || 0,
                        active: (Number(m.total_contacts) || 0) - (Number(m.opted_out) || 0),
                    },
                    conversations: {
                        total: Number(m.total_conversations) || 0,
                        open: Number(m.conversations_open) || 0,
                        resolved: Number(m.conversations_resolved) || 0,
                        human_takeover: Number(m.conversations_takeover) || 0,
                    },
                    messages: {
                        total: Number(m.total_messages) || 0,
                        inbound: Number(m.messages_inbound) || 0,
                        outbound: Number(m.messages_outbound) || 0,
                    },
                    campaigns: {
                        total: Number(m.total_campaigns) || 0,
                        active: Number(m.campaigns_running) || 0,
                        total_sent: Number(m.campaigns_sent) || 0,
                        total_failed: Number(m.campaigns_failed) || 0,
                        total_replies: Number(m.campaigns_replies) || 0,
                        total_opt_outs: Number(m.campaigns_opt_outs) || 0,
                    },
                });
            }
            if (error && error.code !== 'PGRST202') {
                // Real failure (permissions, SQL error, connection) — say so
                // once and fall back; PGRST202 (function not found) is the
                // expected pre-migration state and stays silent.
                console.warn(`[analytics] get_dashboard_metrics rpc failed (${error.code || 'no code'}): ${error.message} — falling back to per-query aggregation`);
            }
        } catch (rpcError) {
            console.warn(`[analytics] rpc unavailable (${rpcError.message}) — falling back to per-query aggregation`);
        }

        // ─── LEGACY PATH ─────────────────────────────────────────
        // The original 14-call aggregation, kept as the fallback for
        // databases where the dashboard migration hasn't run yet. Counts
        // use db.count() (PostgREST head/count option), which the Supabase
        // client supports natively. SQL aggregate syntax like "COUNT(*) as
        // total" is not valid PostgREST select syntax.
        const [
            totalContacts,
            optedOut,
            totalConversations,
            openConversations,
            humanTakeover,
            resolvedConversations,
            totalMessages,
            inbound,
            outbound,
            totalCampaigns,
            activeCampaigns,
        ] = await Promise.all([
            db.count('contacts', 'user_id = ?', [userId]),
            db.count('contacts', 'user_id = ? AND marketing_opt_in = ?', [userId, 0]),
            db.count('conversations', 'user_id = ?', [userId]),
            db.count('conversations', 'user_id = ? AND status = ?', [userId, 'open']),
            db.count('conversations', 'user_id = ? AND status = ?', [userId, 'human_takeover']),
            db.count('conversations', 'user_id = ? AND status = ?', [userId, 'resolved']),
            db.count('messages', 'user_id = ?', [userId]),
            db.count('messages', 'user_id = ? AND direction = ?', [userId, 'inbound']),
            db.count('messages', 'user_id = ? AND direction = ?', [userId, 'outbound']),
            db.count('campaigns', 'user_id = ?', [userId]),
            db.count('campaigns', 'user_id = ? AND status = ?', [userId, 'running']),
        ]);

        // Campaign totals: sum numeric columns client-side. Campaigns are few,
        // and this avoids PostgREST aggregate syntax (may be disabled server-side).
        const allCampaigns = await db.select('campaigns', 'sent, failed, replies, opt_outs', 'user_id = ?', [userId], '', 1000, 0);
        const sum = (key) => allCampaigns.reduce((acc, c) => acc + (parseInt(c[key], 10) || 0), 0);

        return await this._attachRecentActivity(userId, {
            contacts: {
                total: totalContacts,
                optedOut,
                active: totalContacts - optedOut,
            },
            conversations: {
                total: totalConversations,
                open: openConversations,
                resolved: resolvedConversations,
                human_takeover: humanTakeover,
            },
            messages: {
                total: totalMessages,
                inbound,
                outbound,
            },
            campaigns: {
                total: totalCampaigns,
                active: activeCampaigns,
                total_sent: sum('sent'),
                total_failed: sum('failed'),
                total_replies: sum('replies'),
                total_opt_outs: sum('opt_outs'),
            },
        });
    }

    /**
     * Recent campaigns + messages (shared by both paths). Two selects with
     * an embedded-resource join; Promise.all'd so they cost one round trip
     * of wall time, not two.
     */
    async _attachRecentActivity(userId, payload) {
        const [recentCampaigns, recentMessagesRaw] = await Promise.all([
            db.select(
                'campaigns',
                'id, name, status, sent, failed, total_contacts, replies, opt_outs, created_at',
                'user_id = ?',
                [userId],
                'created_at',
                5,
                0
            ),
            db.select(
                'messages',
                'body, direction, created_at, conversations(contacts(phone, name, is_lid))',
                'user_id = ?',
                [userId],
                'created_at',
                10,
                0
            ),
        ]);

        // Flatten the PostgREST nested resource back to the shape the
        // frontend expects.
        payload.recentCampaigns = recentCampaigns;
        payload.recentMessages = recentMessagesRaw.map((m) => ({
            body: m.body,
            direction: m.direction,
            created_at: m.created_at,
            phone: m.conversations?.contacts?.phone || '',
            name: m.conversations?.contacts?.name || '',
            is_lid: m.conversations?.contacts?.is_lid || 0,
        }));
        return payload;
    }

    async getCampaignAnalytics(campaignId, userId) {
        const campaign = await db.getById('campaigns', campaignId, userId);
        if (!campaign) return null;

        // Aggregate functions are disabled on the Supabase PostgREST server
        // (error PGRST123 "Use of aggregate functions is not allowed"), so
        // count per status with db.count() and assemble the breakdown
        // client-side instead of using a "status, count()" group-by query.
        const STATUSES = ['pending', 'processing', 'sent', 'failed', 'opted_out', 'skipped'];
        const counts = await Promise.all(STATUSES.map((status) =>
            db.count('campaign_contacts', 'campaign_id = ? AND user_id = ? AND status = ?', [campaignId, userId, status])
        ));
        const statusBreakdown = STATUSES
            .map((status, i) => ({ status, count: counts[i] }))
            .filter((s) => s.count > 0);

        // For timeline, we need to group by date - this requires raw SQL
        // For now, return the data we have
        return { campaign, statusBreakdown };
    }

    async getMessageTrend(userId, days = 7) {
        // Postgres date functions are different from SQLite
        // For now, return empty or implement client-side filtering
        const messages = await db.select(
            'messages',
            'body, direction, created_at',
            'user_id = ? AND created_at >= ?',
            [userId, new Date(Date.now() - days * 24 * 60 * 60 * 1000)],
            'created_at',
            10000,
            0
        );

        // Group by date client-side
        const trendMap = {};
        for (const msg of messages) {
            const date = new Date(msg.created_at).toISOString().split('T')[0];
            if (!trendMap[date]) {
                trendMap[date] = { date, inbound: 0, outbound: 0 };
            }
            if (msg.direction === 'inbound') trendMap[date].inbound++;
            else trendMap[date].outbound++;
        }

        return Object.values(trendMap).sort((a, b) => a.date.localeCompare(b.date));
    }
}

module.exports = new AnalyticsService();
module.exports.invalidateDashboardCache = invalidateDashboardCache;
module.exports.DASHBOARD_CACHE_TTL_MS = DASHBOARD_CACHE_TTL_MS;
