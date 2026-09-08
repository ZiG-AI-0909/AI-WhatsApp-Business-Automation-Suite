// =============================================================
// Upload Middleware — Supabase Storage Backend
// Multer parses multipart uploads into an in-memory buffer, then each
// route handler explicitly uploads req.file.buffer to the correct
// Supabase Storage bucket. This replaces the previous custom multer
// storage engine, which was fragile and hard to debug.
// =============================================================
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';

// Storage bucket names (create these in Supabase dashboard if not auto-created)
const BUCKETS = {
    excel: 'campaign-excel-uploads',
    knowledge: 'knowledge-documents',
    campaignMedia: 'campaign-media',
};

// Initialize Supabase client for storage operations using the secret
// (service-role) key — required for writes to private/RLS-protected buckets.
const supabaseStorage = (SUPABASE_URL && SUPABASE_SECRET_KEY)
    ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

function isStorageAvailable() {
    return supabaseStorage !== null;
}

/**
 * Upload a file buffer to Supabase Storage and return the public URL
 */
async function uploadToStorage(bucket, filePath, fileBuffer, fileName, contentType) {
    if (!isStorageAvailable()) {
        throw new Error('Supabase Storage is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY.');
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
 * Build a real multer instance using in-memory storage. The route handler
 * is responsible for uploading req.file.buffer to the given bucket.
 */
function createMulterUpload(config) {
    return multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: config.maxSize },
        fileFilter: (_req, file, cb) => {
            const ext = path.extname(file.originalname || '').toLowerCase();
            if (config.acceptedTypes.includes(ext)) return cb(null, true);
            cb(new Error(`Invalid file type. Accepted: ${config.acceptedTypes.join(', ')}`));
        },
    });
}

/**
 * Upload Excel files to Supabase Storage
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

// Actual multer middleware instances — parse uploads into memory.
const uploadExcel = createMulterUpload(excelStorageConfig);
const uploadKnowledge = createMulterUpload(knowledgeStorageConfig);
const uploadCampaignMedia = createMulterUpload(campaignMediaStorageConfig);

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
    // Multer middleware instances (memory storage) + their storage configs
    uploadExcel,
    uploadKnowledge,
    uploadCampaignMedia,
    excelStorageConfig,
    knowledgeStorageConfig,
    campaignMediaStorageConfig,

    // Storage operations
    uploadToStorage,
    downloadFromStorage,
    deleteFromStorage,

    // Utility functions
    isStorageAvailable,
    isRemotePath,
    getFileNameFromPath,
    getBucketForPath,

    // Bucket names (need to be created in Supabase dashboard)
    BUCKETS,
};
