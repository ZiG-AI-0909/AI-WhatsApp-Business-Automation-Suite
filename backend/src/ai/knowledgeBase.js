const db = require('../database/db');

class KnowledgeBase {
    getRelevantContext(query, maxChunks = 5, userId = null) {
        try {
            const queryWords = query.toLowerCase()
                .replace(/[^\w\s]/g, '')
                .split(/\s+/)
                .filter(w => w.length > 2);

            if (queryWords.length === 0) return '';

            // Per-user retrieval: only THIS user's active documents and
            // chunks are searched. A user's knowledge never leaks into
            // another user's AI replies.
            const docWhere = userId ? 'user_id = ? AND status = ?' : 'status = ?';
            const docParams = userId ? [userId, 'active'] : ['active'];

            // Fetch active documents first, then their chunks. Alias-prefixed
            // columns and "as" aliases are not valid PostgREST, and the
            // "active" status lives on knowledge_documents, not chunks.
            return db.select('knowledge_documents', 'id', docWhere, docParams, '', 1000, 0)
                .then(activeDocs => {
                    const docIds = activeDocs.map(d => d.id);
                    if (docIds.length === 0) return [];
                    return db.select(
                        'knowledge_chunks',
                        'content, documents(name)',
                        'document_id IN (?)',
                        [docIds],
                        'id',
                        1000,
                        0
                    );
                })
                .then(results => {
                    const scored = results.map(chunk => {
                        const text = chunk.content.toLowerCase();
                        const score = queryWords.reduce((acc, w) => {
                            return acc + (text.includes(w) ? 1 : 0);
                        }, 0);
                        return {
                            content: chunk.content,
                            doc_name: chunk.documents?.name || 'Unknown',
                            score,
                        };
                    });

                    const relevant = scored
                        .filter(c => c.score > 0)
                        .sort((a, b) => b.score - a.score)
                        .slice(0, maxChunks);

                    if (relevant.length === 0) return '';

                    return relevant.map(c =>
                        `[${c.doc_name}]\n${c.content}`
                    ).join('\n\n---\n\n');
                });
        } catch (err) {
            console.error('KnowledgeBase error:', err.message);
            return '';
        }
    }

    async addDocument(userId, name, category, content, filePath = null) {
        const existing = await db.getOne('knowledge_documents', 'name', name, userId);

        let docId;
        if (existing) {
            await db.update('knowledge_documents', {
                category,
                content,
                file_path: filePath,
                status: 'active',
            }, 'id = ? AND user_id = ?', [existing.id, userId]);
            await db.del('knowledge_chunks', 'document_id = ? AND user_id = ?', [existing.id, userId]);
            docId = existing.id;
        } else {
            const result = await db.insert('knowledge_documents', {
                name,
                category,
                content,
                file_path: filePath,
                user_id: userId,
            });
            docId = result.id;
        }

        // Split into chunks
        const chunks = this._chunkText(content, 500);
        const chunkData = chunks.map((chunk, i) => ({
            document_id: docId,
            content: chunk,
            chunk_index: i,
            user_id: userId,
        }));
        await db.insertMany('knowledge_chunks', chunkData);

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

    async listDocuments(userId) {
        const docs = await db.select(
            'knowledge_documents',
            'id, name, category, status, created_at',
            'user_id = ?',
            [userId],
            'created_at',
            1000,
            0
        );
        return docs.map(doc => ({
            ...doc,
            content_length: doc.content ? doc.content.length : 0,
        }));
    }

    async deleteDocument(id, userId) {
        await db.del('knowledge_documents', 'id = ? AND user_id = ?', [id, userId]);
    }

    async deleteMany(ids, userId) {
        for (const id of ids) {
            await this.deleteDocument(id, userId);
        }
    }

    async getDocument(id, userId) {
        return db.getById('knowledge_documents', id, userId);
    }

    async updateDocument(id, userId, updates) {
        const doc = await this.getDocument(id, userId);
        if (!doc) return null;
        const name = updates.name ?? doc.name;
        const category = updates.category ?? doc.category;
        const content = updates.content ?? doc.content;

        await db.update('knowledge_documents', {
            name,
            category,
            content,
        }, 'id = ? AND user_id = ?', [id, userId]);

        // Re-chunk
        await db.del('knowledge_chunks', 'document_id = ? AND user_id = ?', [id, userId]);
        const chunks = this._chunkText(content, 500);
        const chunkData = chunks.map((chunk, i) => ({
            document_id: id,
            content: chunk,
            chunk_index: i,
            user_id: userId,
        }));
        await db.insertMany('knowledge_chunks', chunkData);
        return this.getDocument(id, userId);
    }
}

module.exports = new KnowledgeBase();
