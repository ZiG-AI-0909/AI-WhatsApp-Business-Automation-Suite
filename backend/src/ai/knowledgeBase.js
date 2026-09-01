const db = require('../database/db');

/**
 * KnowledgeBase — Retrieves relevant company knowledge for AI context.
 * Uses simple keyword matching. Chunks documents for retrieval.
 */
class KnowledgeBase {
    /**
     * Find the most relevant knowledge chunks for a given query.
     * @param {string} query
     * @param {number} maxChunks
     * @returns {string} Combined relevant text
     */
    getRelevantContext(query, maxChunks = 5) {
        try {
            const queryWords = query.toLowerCase()
                .replace(/[^\w\s]/g, '')
                .split(/\s+/)
                .filter(w => w.length > 2);

            if (queryWords.length === 0) return '';

            // Score each chunk by keyword overlap
            const chunks = db.prepare(`
                SELECT kc.content, kd.name as doc_name, kd.category
                FROM knowledge_chunks kc
                JOIN knowledge_documents kd ON kd.id = kc.document_id
                WHERE kd.status = 'active'
                ORDER BY kc.id
            `).all();

            const scored = chunks.map(chunk => {
                const text = chunk.content.toLowerCase();
                const score = queryWords.reduce((acc, w) => {
                    return acc + (text.includes(w) ? 1 : 0);
                }, 0);
                return { ...chunk, score };
            });

            const relevant = scored
                .filter(c => c.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, maxChunks);

            if (relevant.length === 0) return '';

            return relevant.map(c =>
                `[${c.doc_name}]\n${c.content}`
            ).join('\n\n---\n\n');
        } catch (err) {
            console.error('KnowledgeBase error:', err.message);
            return '';
        }
    }

    /**
     * Add or update a document, splitting into chunks for retrieval.
     */
    addDocument(name, category, content, filePath = null) {
        const existing = db.prepare(
            'SELECT id FROM knowledge_documents WHERE name = ?'
        ).get(name);

        let docId;
        if (existing) {
            db.prepare(`
                UPDATE knowledge_documents SET category=?, content=?, file_path=?, status='active'
                WHERE id=?
            `).run(category, content, filePath, existing.id);
            db.prepare('DELETE FROM knowledge_chunks WHERE document_id=?').run(existing.id);
            docId = existing.id;
        } else {
            const result = db.prepare(`
                INSERT INTO knowledge_documents (name, category, content, file_path)
                VALUES (?, ?, ?, ?)
            `).run(name, category, content, filePath);
            docId = result.lastInsertRowid;
        }

        // Split into chunks of ~500 chars at sentence boundaries
        const chunks = this._chunkText(content, 500);
        const insertChunk = db.prepare(
            'INSERT INTO knowledge_chunks (document_id, content, chunk_index) VALUES (?, ?, ?)'
        );
        chunks.forEach((chunk, i) => insertChunk.run(docId, chunk, i));

        return docId;
    }

    _chunkText(text, maxLen) {
        const sentences = text.match(/[^.!?\n]+[.!?\n]+/g) || [text];
        const chunks = [];
        let current = '';

        for (const sentence of sentences) {
            if (current.length + sentence.length > maxLen && current.length > 0) {
                chunks.push(current.trim());
                current = sentence;
            } else {
                current += sentence;
            }
        }
        if (current.trim()) chunks.push(current.trim());
        return chunks.length ? chunks : [text];
    }

    listDocuments() {
        return db.prepare(`
            SELECT id, name, category, status, created_at,
                   length(content) as content_length
            FROM knowledge_documents
            ORDER BY created_at DESC
        `).all();
    }

    deleteDocument(id) {
        db.prepare('DELETE FROM knowledge_documents WHERE id=?').run(id);
    }

    deleteMany(ids) {
        db.exec('BEGIN');
        try {
            for (const id of ids) db.prepare('DELETE FROM knowledge_documents WHERE id=?').run(id);
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    getDocument(id) {
        return db.prepare('SELECT * FROM knowledge_documents WHERE id=?').get(id);
    }

    updateDocument(id, updates) {
        const doc = this.getDocument(id);
        if (!doc) return null;
        const name = updates.name ?? doc.name;
        const category = updates.category ?? doc.category;
        const content = updates.content ?? doc.content;

        db.prepare(`
            UPDATE knowledge_documents SET name=?, category=?, content=? WHERE id=?
        `).run(name, category, content, id);

        // Re-chunk
        db.prepare('DELETE FROM knowledge_chunks WHERE document_id=?').run(id);
        const chunks = this._chunkText(content, 500);
        const insertChunk = db.prepare(
            'INSERT INTO knowledge_chunks (document_id, content, chunk_index) VALUES (?, ?, ?)'
        );
        chunks.forEach((chunk, i) => insertChunk.run(id, chunk, i));
        return this.getDocument(id);
    }
}

module.exports = new KnowledgeBase();
