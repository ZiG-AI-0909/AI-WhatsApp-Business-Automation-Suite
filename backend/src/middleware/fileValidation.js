// =============================================================
// Upload content validation — magic-byte sniffing.
//
// Multer's fileFilter only sees the client-supplied mimetype and
// filename extension, both trivially spoofable. This module inspects
// the actual bytes in memory (uploads are parsed to memory storage)
// and rejects anything whose content doesn't match its extension.
//
// Every upload route MUST call validateUploadBuffer() on req.file
// (or each file of req.files) before persisting or parsing.
// =============================================================
const path = require('path');

// ZIP local-file-header magic — OOXML files (.docx/.xlsx) are ZIPs.
function isZip(buf) {
    return buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

// OLE2 compound-document magic — legacy .doc/.xls binaries.
function isOle2(buf) {
    return buf.length > 7 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0;
}

// Text formats have no reliable magic; validate as clean UTF-8 text
// (knowledge documents are decoded with .toString('utf8') and fed
// into AI prompts, so binary masquerading as .txt/.md must not pass).
function isUtf8Text(buf) {
    if (buf.length === 0) return false;
    if (buf.includes(0)) return false; // NUL byte → binary
    return !buf.toString('utf8').includes('\uFFFD'); // U+FFFD → invalid UTF-8
}

const MAGIC_SPECS = [
    { exts: ['.jpg', '.jpeg'], test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    {
        exts: ['.png'],
        test: (b) => b.length > 8
            && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
            && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
    },
    { exts: ['.webp'], test: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
    { exts: ['.pdf'], test: (b) => b.length > 4 && b.toString('latin1', 0, 5) === '%PDF-' },
    { exts: ['.xlsx', '.docx'], test: isZip },
    { exts: ['.xls', '.doc'], test: isOle2 },
    { exts: ['.txt', '.md'], test: isUtf8Text },
];

/**
 * Validate an in-memory upload against its claimed extension.
 * @param {Buffer} buffer - file content (req.file.buffer)
 * @param {string} originalname - client-supplied filename
 * @returns {{ ok: boolean, error?: string, ext?: string }}
 */
function validateUploadBuffer(buffer, originalname) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return { ok: false, error: 'Uploaded file is empty.' };
    }
    const ext = path.extname(originalname || '').toLowerCase();
    if (!ext) {
        return { ok: false, error: 'File has no extension.' };
    }
    const spec = MAGIC_SPECS.find((s) => s.exts.includes(ext));
    // Reject any extension we do not explicitly recognize.
    if (!spec) {
        return { ok: false, error: `Unsupported file type "${ext}".` };
    }
    if (!spec.test(buffer)) {
        return { error: `File content does not match its "${ext}" extension — upload rejected.`, ok: false };
    }
    return { ok: true, ext };
}

/**
 * Express helper for single uploads: returns true if valid, otherwise
 * responds 400 and returns false. Usage:
 *   if (!respondIfInvalidUpload(req, res)) return;
 */
function respondIfInvalidUpload(req, res) {
    const check = validateUploadBuffer(req.file?.buffer, req.file?.originalname);
    if (!check.ok) {
        res.status(400).json({ error: check.error });
        return false;
    }
    return true;
}

module.exports = { validateUploadBuffer, respondIfInvalidUpload };
