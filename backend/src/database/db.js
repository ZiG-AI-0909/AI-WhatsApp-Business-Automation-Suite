// Native node:sqlite — available in Node 22.5+ (stable in Node 26)
// No native compilation needed, no external dependencies.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'Bhavesh.db');
const db = new DatabaseSync(DB_PATH);

// Enable WAL mode and foreign keys
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

function initSchema() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT UNIQUE NOT NULL,
            name TEXT DEFAULT '',
            company TEXT DEFAULT '',
            city TEXT DEFAULT '',
            marketing_opt_in INTEGER DEFAULT 1,
            tags TEXT DEFAULT '[]',
            notes TEXT DEFAULT '',
            is_lid INTEGER DEFAULT 0,
            last_message_at TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
            status TEXT DEFAULT 'open',
            ai_enabled INTEGER DEFAULT 1,
            last_message_at TEXT,
            unread_count INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
            direction TEXT NOT NULL,
            body TEXT NOT NULL,
            status TEXT DEFAULT 'sent',
            wa_message_id TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS campaigns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            status TEXT DEFAULT 'draft',
            template_message TEXT NOT NULL,
            total_contacts INTEGER DEFAULT 0,
            processed INTEGER DEFAULT 0,
            sent INTEGER DEFAULT 0,
            failed INTEGER DEFAULT 0,
            replies INTEGER DEFAULT 0,
            opt_outs INTEGER DEFAULT 0,
            settings TEXT DEFAULT '{}',
            media_path TEXT,
            media_type TEXT,
            buttons TEXT DEFAULT '[]',
            created_at TEXT DEFAULT (datetime('now')),
            started_at TEXT,
            completed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS campaign_contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
            contact_id INTEGER REFERENCES contacts(id),
            rendered_message TEXT,
            status TEXT DEFAULT 'pending',
            attempts INTEGER DEFAULT 0,
            last_error TEXT,
            sent_at TEXT
        );

        CREATE TABLE IF NOT EXISTS knowledge_documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            category TEXT DEFAULT 'general',
            content TEXT DEFAULT '',
            file_path TEXT,
            status TEXT DEFAULT 'active',
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS knowledge_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id INTEGER REFERENCES knowledge_documents(id) ON DELETE CASCADE,
            content TEXT NOT NULL,
            chunk_index INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS campaign_schedules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            template_message TEXT NOT NULL,
            file_path TEXT NOT NULL,
            media_path TEXT,
            media_type TEXT,
            buttons TEXT DEFAULT '[]',
            settings TEXT DEFAULT '{}',
            allow_missing_fields INTEGER DEFAULT 0,
            schedule_type TEXT NOT NULL,
            run_at TEXT,
            recurrence_cron TEXT,
            status TEXT DEFAULT 'pending',
            last_run_at TEXT,
            next_run_at TEXT,
            last_campaign_id INTEGER,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_conversations_contact ON conversations(contact_id);
        CREATE INDEX IF NOT EXISTS idx_campaign_contacts_campaign ON campaign_contacts(campaign_id);
        CREATE INDEX IF NOT EXISTS idx_campaign_contacts_status ON campaign_contacts(status);
        CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
    `);

    for (const column of [
        'provider TEXT DEFAULT \'\'',
        'sender TEXT DEFAULT \'\'',
        'timestamp INTEGER',
    ]) {
        try { db.exec(`ALTER TABLE messages ADD COLUMN ${column}`); } catch (error) {
            if (!error.message.includes('duplicate column')) throw error;
        }
    }
    try { db.exec('ALTER TABLE contacts ADD COLUMN jid TEXT'); } catch (error) {
        if (!error.message.includes('duplicate column')) throw error;
    }
    try { db.exec('ALTER TABLE contacts ADD COLUMN is_lid INTEGER DEFAULT 0'); } catch (error) {
        if (!error.message.includes('duplicate column')) throw error;
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_provider_id ON messages(wa_message_id) WHERE wa_message_id IS NOT NULL');

    const migrations = [
        ['campaigns', 'updated_at TEXT'],
        ['campaigns', 'provider TEXT DEFAULT \'web\''],
        ['campaigns', 'skipped INTEGER DEFAULT 0'],
        ['campaigns', 'media_path TEXT'],
        ['campaigns', 'media_type TEXT'],
        ['campaigns', 'media_filename TEXT'],
        ['campaigns', 'media_mimetype TEXT'],
        ['campaigns', 'buttons TEXT DEFAULT \'[]\''],
        ['campaign_contacts', 'provider_message_id TEXT'],
        ['campaign_contacts', 'retry_at TEXT'],
        ['campaign_schedules', 'last_error TEXT'],
        ['campaign_schedules', 'media_filename TEXT'],
        ['campaign_schedules', 'media_mimetype TEXT'],
    ];
    for (const [table, column] of migrations) {
        try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`); } catch (error) {
            if (!error.message.includes('duplicate column')) throw error;
        }
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_contact_provider_message ON campaign_contacts(provider_message_id) WHERE provider_message_id IS NOT NULL');

    console.log('✅ Database schema initialized');
}

initSchema();

// ─── Query helpers matching better-sqlite3 API style ───────────────────────
// node:sqlite's DatabaseSync already has synchronous .prepare()/.run()/.get()/.all()
// but we wrap for a consistent ergonomic interface.

const originalPrepare = db.prepare.bind(db);
db.prepare = (sql) => originalPrepare(sql);

module.exports = db;
