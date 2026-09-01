const db = require('../database/db');

class AnalyticsService {
    getDashboard() {
        const contactStats = db.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN marketing_opt_in=0 THEN 1 ELSE 0 END) as opted_out FROM contacts').get();
        const convStats = db.prepare(`
            SELECT COUNT(*) as total,
                   SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) as open,
                   SUM(CASE WHEN status='human_takeover' THEN 1 ELSE 0 END) as human_takeover,
                   SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) as resolved
            FROM conversations
        `).get();
        const msgStats = db.prepare(`
            SELECT COUNT(*) as total,
                   SUM(CASE WHEN direction='inbound' THEN 1 ELSE 0 END) as inbound,
                   SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END) as outbound
            FROM messages
        `).get();
        const campaignStats = db.prepare(`
            SELECT COUNT(*) as total,
                   SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) as active,
                   SUM(COALESCE(sent,0)) as total_sent,
                   SUM(COALESCE(failed,0)) as total_failed,
                   SUM(COALESCE(replies,0)) as total_replies,
                   SUM(COALESCE(opt_outs,0)) as total_opt_outs
            FROM campaigns
        `).get();
        const recentCampaigns = db.prepare(`
            SELECT id, name, status, sent, failed, total_contacts, replies, opt_outs, created_at
            FROM campaigns ORDER BY created_at DESC LIMIT 5
        `).all();
        const recentMessages = db.prepare(`
            SELECT m.body, m.direction, m.created_at, c.phone, c.name, c.is_lid
            FROM messages m
            JOIN conversations cv ON cv.id = m.conversation_id
            JOIN contacts c ON c.id = cv.contact_id
            ORDER BY m.created_at DESC LIMIT 10
        `).all();

        return {
            contacts: {
                total: contactStats.total,
                optedOut: contactStats.opted_out,
                active: contactStats.total - contactStats.opted_out,
            },
            conversations: convStats,
            messages: msgStats,
            campaigns: campaignStats,
            recentCampaigns,
            recentMessages,
        };
    }

    getCampaignAnalytics(campaignId) {
        const campaign = db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaignId);
        if (!campaign) return null;

        const statusBreakdown = db.prepare(`
            SELECT status, COUNT(*) as count
            FROM campaign_contacts WHERE campaign_id=?
            GROUP BY status
        `).all(campaignId);

        const timeline = db.prepare(`
            SELECT date(sent_at) as date, COUNT(*) as sent
            FROM campaign_contacts
            WHERE campaign_id=? AND status='sent' AND sent_at IS NOT NULL
            GROUP BY date(sent_at) ORDER BY date ASC
        `).all(campaignId);

        return { campaign, statusBreakdown, timeline };
    }

    getMessageTrend(days = 7) {
        return db.prepare(`
            SELECT date(created_at) as date,
                   SUM(CASE WHEN direction='inbound' THEN 1 ELSE 0 END) as inbound,
                   SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END) as outbound
            FROM messages
            WHERE created_at >= datetime('now', ? || ' days')
            GROUP BY date(created_at) ORDER BY date ASC
        `).all(-days);
    }
}

module.exports = new AnalyticsService();
