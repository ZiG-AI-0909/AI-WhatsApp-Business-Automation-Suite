// =============================================================
// Upload Middleware — Supabase Storage Backend
// Replaces local disk storage (uploads/, campaign-media/, knowledge/)
// with Supabase Storage buckets for Render free tier compatibility.
// =============================================================
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

// Storage bucket names (create these in Supabase dashboard if not auto-created)
const BUCKETS = {
    excel: 'campaign-excel-uploads',
    knowledge: 'knowledge-documents',
    campaignMedia: 'campaign-media',
};

// Initialize Supabase client for storage operations (using anon key for storage, not service role)
// Storage operations can use the anon key with proper bucket policies
const supabaseStorage = (SUPABASE_URL && SUPABASE_ANON_KEY)
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

function isStorageAvailable() {
    return supabaseStorage !== null;
}

/**
 * Upload a file to Supabase Storage and return the public URL
 */
async function uploadToStorage(bucket, filePath, fileBuffer, fileName, contentType) {
    if (!isStorageAvailable()) {
        throw new Error('Supabase Storage is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.');
    }

    const uniqueFileName = `${Date.now()}_${fileName}`;

    const { data, error } = await supabaseStorage
        .storage
        .from(bucket)
        .upload(uniqueFileName, fileBuffer, {
            contentType: contentType || 'application/octet-stream',
            upsert: false,
        });

    if (error) {
        console.error(`[upload] Error uploading to ${bucket}:`, error.message);
        throw new Error(`Failed to upload file: ${error.message}`);
    }

    // Get the public URL
    const { data: urlData } = supabaseStorage
        .storage
        .from(bucket)
        .getPublicUrl(uniqueFileName);

    return {
        path: urlData.publicUrl,
        filename: uniqueFileName,
        bucket: bucket,
    };
}

/**
 * Download a file from Supabase Storage
 */
async function downloadFromStorage(bucket, filePath) {
    if (!isStorageAvailable()) {
        throw new Error('Supabase Storage is not configured.');
    }

    // Extract the file name from the URL if it's a full URL
    let fileName = filePath;
    if (filePath.startsWith('https://')) {
        // Extract file name from URL
        const urlParts = filePath.split('/');
        fileName = urlParts[urlParts.length - 1];
    }

    const { data, error } = await supabaseStorage
        .storage
        .from(bucket)
        .download(fileName);

    if (error) {
        throw new Error(`Failed to download file: ${error.message}`);
    }

    return data;
}

/**
 * Delete a file from Supabase Storage
 */
async function deleteFromStorage(bucket, filePath) {
    if (!isStorageAvailable()) {
        return; // No-op if storage not available
    }

    let fileName = filePath;
    if (filePath.startsWith('https://')) {
        const urlParts = filePath.split('/');
        fileName = urlParts[urlParts.length - 1];
    }

    await supabaseStorage
        .storage
        .from(bucket)
        .remove([fileName]);
}

/**
 * Multer-like storage engine that uploads to Supabase instead of local disk
 * Returns a compatible interface for existing code that expects req.file
 */
function createStorageEngine(bucket, filenamePrefix = '') {
    return {
        _bucket: bucket,
        _prefix: filenamePrefix,

        _handleFile(req, file, cb) {
            const originalName = file.originalname || 'unknown';
            const ext = path.extname(originalName);
            const baseName = path.basename(originalName, ext);
            const fileName = `${filenamePrefix}${Date.now()}_${baseName}${ext}`;

            // Convert buffer to Uint8Array if needed
            const buffer = file.buffer instanceof Uint8Array
                ? file.buffer
                : Buffer.from(file.buffer);

            uploadToStorage(bucket, fileName, buffer, originalName, file.mimetype)
                .then(result => {
                    // Create a file-like object compatible with existing code
                    cb(null, {
                        path: result.path,
                        filename: result.filename,
                        bucket: result.bucket,
                        originalname: originalName,
                        mimetype: file.mimetype,
                        size: file.size,
                        // For backward compatibility with code that uses .path for local files
                        _localPath: null, // No local path since we're in cloud storage
                        _isRemote: true,
                    });
                })
                .catch(err => cb(err));
        },

        _removeFile(req, file, cb) {
            if (file && file._isRemote && file.bucket && file.filename) {
                deleteFromStorage(file.bucket, file.filename)
                    .then(() => cb())
                    .catch(err => cb(err));
            } else {
                cb();
            }
        },
    };
}

// Multer-like configuration for different upload types
// Note: We're not using multer directly anymore, but providing compatible configurations

/**
 * Upload Excel files to Supabase Storage
 * Returns middleware-compatible configuration
 */
const excelStorageConfig = {
    bucket: BUCKETS.excel,
    prefix: 'campaign_',
    acceptedTypes: ['.xlsx'],
    maxSize: 10 * 1024 * 1024, // 10MB
};

/**
 * Upload knowledge document files to Supabase Storage
 */
const knowledgeStorageConfig = {
    bucket: BUCKETS.knowledge,
    prefix: 'doc_',
    acceptedTypes: ['.txt', '.md', '.pdf', '.docx'],
    maxSize: 5 * 1024 * 1024, // 5MB
};

/**
 * Upload campaign media files to Supabase Storage
 */
const campaignMediaStorageConfig = {
    bucket: BUCKETS.campaignMedia,
    prefix: 'media_',
    acceptedTypes: ['.jpg', '.jpeg', '.png', '.webp', '.pdf', '.doc', '.docx', '.xls', '.xlsx'],
    maxSize: 16 * 1024 * 1024, // 16MB
};

/**
 * Check if a file path is from Supabase Storage (remote) or local
 */
function isRemotePath(filePath) {
    return filePath && filePath.startsWith('https://');
}

/**
 * Get the file name from a URL or local path
 */
function getFileNameFromPath(filePath) {
    if (!filePath) return '';
    if (filePath.startsWith('https://')) {
        const parts = filePath.split('/');
        return parts[parts.length - 1];
    }
    return path.basename(filePath);
}

/**
 * Get the bucket name from a file path or config
 */
function getBucketForPath(filePath, type) {
    if (isRemotePath(filePath)) {
        // Try to determine bucket from URL or return default based on type
        return BUCKETS[type] || BUCKETS.excel;
    }
    // Local path - return the appropriate bucket
    const bucketMap = {
        excel: BUCKETS.excel,
        knowledge: BUCKETS.knowledge,
        media: BUCKETS.campaignMedia,
    };
    return bucketMap[type] || BUCKETS.excel;
}

module.exports = {
    // Storage configs (for reference, actual handling done in route handlers)
    excelStorageConfig,
    knowledgeStorageConfig,
    campaignMediaStorageConfig,

    // Storage operations
    uploadToStorage,
    downloadFromStorage,
    deleteFromStorage,

    // Storage engine for multer-like usage
    createStorageEngine,

    // Utility functions
    isStorageAvailable,
    isRemotePath,
    getFileNameFromPath,
    getBucketForPath,

    // Bucket names (need to be created in Supabase dashboard)
    BUCKETS,

    // Legacy directory constants (kept for reference, no longer used for storage)
    // These are now pointing to Supabase Storage URLs
    UPLOAD_DIR: 'supabase://campaign-excel-uploads',
    KNOWLEDGE_DIR: 'supabase://knowledge-documents',
    CAMPAIGN_MEDIA_DIR: 'supabase://campaign-media',
};
