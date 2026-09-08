const db = require('../database/db');

class AnalyticsService {
    async getDashboard() {
        const contactStats = await db.select('contacts', 'COUNT(*) as total, SUM(CASE WHEN marketing_opt_in = 0 THEN 1 ELSE 0 END) as opted_out', '', [], '', 1, 0);
        const convStats = await db.select('conversations', 'COUNT(*) as total, SUM(CASE WHEN status = \'open\' THEN 1 ELSE 0 END) as open, SUM(CASE WHEN status = \'human_takeover\' THEN 1 ELSE 0 END) as human_takeover, SUM(CASE WHEN status = \'resolved\' THEN 1 ELSE 0 END) as resolved', '', [], '', 1, 0);
        const msgStats = await db.select('messages', 'COUNT(*) as total, SUM(CASE WHEN direction = \'inbound\' THEN 1 ELSE 0 END) as inbound, SUM(CASE WHEN direction = \'outbound\' THEN 1 ELSE 0 END) as outbound', '', [], '', 1, 0);
        const campaignStats = await db.select('campaigns', 'COUNT(*) as total, SUM(CASE WHEN status = \'running\' THEN 1 ELSE 0 END) as active, SUM(COALESCE(sent, 0)) as total_sent, SUM(COALESCE(failed, 0)) as total_failed, SUM(COALESCE(replies, 0)) as total_replies, SUM(COALESCE(opt_outs, 0)) as total_opt_outs', '', [], '', 1, 0);
        const recentCampaigns = await db.select('campaigns', 'id, name, status, sent, failed, total_contacts, replies, opt_outs, created_at', '', [], 'created_at', 5, 0);
        const recentMessages = await db.select(
            'messages',
            'm.body, m.direction, m.created_at, c.phone, c.name, c.is_lid',
            '1=1',
            [],
            'm.created_at',
            10,
            0
        );

        return {
            contacts: {
                total: parseInt(contactStats[0]?.total) || 0,
                optedOut: parseInt(contactStats[0]?.opted_out) || 0,
                active: (parseInt(contactStats[0]?.total) || 0) - (parseInt(contactStats[0]?.opted_out) || 0),
            },
            conversations: {
                total: parseInt(convStats[0]?.total) || 0,
                open: parseInt(convStats[0]?.open) || 0,
                resolved: parseInt(convStats[0]?.resolved) || 0,
                human_takeover: parseInt(convStats[0]?.human_takeover) || 0,
            },
            messages: {
                total: parseInt(msgStats[0]?.total) || 0,
                inbound: parseInt(msgStats[0]?.inbound) || 0,
                outbound: parseInt(msgStats[0]?.outbound) || 0,
            },
            campaigns: {
                total: parseInt(campaignStats[0]?.total) || 0,
                active: parseInt(campaignStats[0]?.active) || 0,
                total_sent: parseInt(campaignStats[0]?.total_sent) || 0,
                total_failed: parseInt(campaignStats[0]?.total_failed) || 0,
                total_replies: parseInt(campaignStats[0]?.total_replies) || 0,
                total_opt_outs: parseInt(campaignStats[0]?.total_opt_outs) || 0,
            },
            recentCampaigns,
            recentMessages,
        };
    }

    async getCampaignAnalytics(campaignId) {
        const campaign = await db.getById('campaigns', campaignId);
        if (!campaign) return null;

        const statusBreakdown = await db.select(
            'campaign_contacts',
            'status, COUNT(*) as count',
            'campaign_id = ?',
            [campaignId],
            'status',
            100,
            0
        );

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
