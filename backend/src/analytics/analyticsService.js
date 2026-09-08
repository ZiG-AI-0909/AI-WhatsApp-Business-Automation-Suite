const db = require('../database/db');

class AnalyticsService {
    async getDashboard() {
        // Counts use db.count() (PostgREST head/count option), which the
        // Supabase client supports natively. SQL aggregate syntax like
        // "COUNT(*) as total" is not valid PostgREST select syntax.
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
            db.count('contacts'),
            db.count('contacts', 'marketing_opt_in = ?', [0]),
            db.count('conversations'),
            db.count('conversations', 'status = ?', ['open']),
            db.count('conversations', 'status = ?', ['human_takeover']),
            db.count('conversations', 'status = ?', ['resolved']),
            db.count('messages'),
            db.count('messages', 'direction = ?', ['inbound']),
            db.count('messages', 'direction = ?', ['outbound']),
            db.count('campaigns'),
            db.count('campaigns', 'status = ?', ['running']),
        ]);

        // Campaign totals: sum numeric columns client-side. Campaigns are few,
        // and this avoids PostgREST aggregate syntax (may be disabled server-side).
        const allCampaigns = await db.select('campaigns', 'sent, failed, replies, opt_outs', '', [], '', 1000, 0);
        const sum = (key) => allCampaigns.reduce((acc, c) => acc + (parseInt(c[key], 10) || 0), 0);

        const recentCampaigns = await db.select(
            'campaigns',
            'id, name, status, sent, failed, total_contacts, replies, opt_outs, created_at',
            '',
            [],
            'created_at',
            5,
            0
        );

        // Recent messages with contact info via PostgREST embedded resources
        // (messages -> conversations -> contacts). Flatten the nested result
        // back to the shape the frontend expects.
        const recentMessages = (await db.select(
            'messages',
            'body, direction, created_at, conversations(contacts(phone, name, is_lid))',
            '1=1',
            [],
            'created_at',
            10,
            0
        )).map((m) => ({
            body: m.body,
            direction: m.direction,
            created_at: m.created_at,
            phone: m.conversations?.contacts?.phone || '',
            name: m.conversations?.contacts?.name || '',
            is_lid: m.conversations?.contacts?.is_lid || 0,
        }));

        return {
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
            recentCampaigns,
            recentMessages,
        };
    }

    async getCampaignAnalytics(campaignId) {
        const campaign = await db.getById('campaigns', campaignId);
        if (!campaign) return null;

        // Aggregate functions are disabled on the Supabase PostgREST server
        // (error PGRST123 "Use of aggregate functions is not allowed"), so
        // count per status with db.count() and assemble the breakdown
        // client-side instead of using a "status, count()" group-by query.
        const STATUSES = ['pending', 'processing', 'sent', 'failed', 'opted_out', 'skipped'];
        const counts = await Promise.all(STATUSES.map((status) =>
            db.count('campaign_contacts', 'campaign_id = ? AND status = ?', [campaignId, status])
        ));
        const statusBreakdown = STATUSES
            .map((status, i) => ({ status, count: counts[i] }))
            .filter((s) => s.count > 0);

        // For timeline, we need to group by date - this requires raw SQL
        // For now, return the data we have
        return { campaign, statusBreakdown };
    }

    async getMessageTrend(days = 7) {
        // Postgres date functions are different from SQLite
        // For now, return empty or implement client-side filtering
        const messages = await db.select(
            'messages',
            'body, direction, created_at',
            'created_at >= ?',
            [new Date(Date.now() - days * 24 * 60 * 60 * 1000)],
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
