const db = require('../database/db');

class KnowledgeBase {
    getRelevantContext(query, maxChunks = 5) {
        try {
            const queryWords = query.toLowerCase()
                .replace(/[^\w\s]/g, '')
                .split(/\s+/)
                .filter(w => w.length > 2);

            if (queryWords.length === 0) return '';

            // Fetch all active chunks and score them client-side
            // Supabase doesn't support complex scoring queries directly
            const chunks = db.select(
                'knowledge_chunks',
                'kc.content, kd.name as doc_name, kd.category',
                'kd.status = ?',
                ['active'],
                'kc.id',
                1000,
                0
            ).then(results => {
                const scored = results.map(chunk => {
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
            });

            return chunks;
        } catch (err) {
            console.error('KnowledgeBase error:', err.message);
            return '';
        }
    }

    async addDocument(name, category, content, filePath = null) {
        const existing = await db.getOne('knowledge_documents', 'name', name);

        let docId;
        if (existing) {
            await db.update('knowledge_documents', {
                category,
                content,
                file_path: filePath,
                status: 'active',
            }, 'id = ?', [existing.id]);
            await db.del('knowledge_chunks', 'document_id = ?', [existing.id]);
            docId = existing.id;
        } else {
            const result = await db.insert('knowledge_documents', {
                name,
                category,
                content,
                file_path: filePath,
            });
            docId = result.id;
        }

        // Split into chunks
        const chunks = this._chunkText(content, 500);
        const chunkData = chunks.map((chunk, i) => ({
            document_id: docId,
            content: chunk,
            chunk_index: i,
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

    async listDocuments() {
        const docs = await db.select(
            'knowledge_documents',
            'id, name, category, status, created_at',
            '',
            [],
            'created_at',
            1000,
            0
        );
        return docs.map(doc => ({
            ...doc,
            content_length: doc.content ? doc.content.length : 0,
        }));
    }

    async deleteDocument(id) {
        await db.del('knowledge_documents', 'id = ?', [id]);
    }

    async deleteMany(ids) {
        for (const id of ids) {
            await this.deleteDocument(id);
        }
    }

    async getDocument(id) {
        return db.getById('knowledge_documents', id);
    }

    async updateDocument(id, updates) {
        const doc = await this.getDocument(id);
        if (!doc) return null;
        const name = updates.name ?? doc.name;
        const category = updates.category ?? doc.category;
        const content = updates.content ?? doc.content;

        await db.update('knowledge_documents', {
            name,
            category,
            content,
        }, 'id = ?', [id]);

        // Re-chunk
        await db.del('knowledge_chunks', 'document_id = ?', [id]);
        const chunks = this._chunkText(content, 500);
        const chunkData = chunks.map((chunk, i) => ({
            document_id: id,
            content: chunk,
            chunk_index: i,
        }));
        await db.insertMany('knowledge_chunks', chunkData);
        return this.getDocument(id);
    }
}

module.exports = new KnowledgeBase();
