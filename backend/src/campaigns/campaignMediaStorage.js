const { supabase, isAvailable } = require('../database/supabaseClient');

const CAMPAIGN_MEDIA_BUCKET = 'campaign-media';
const CAMPAIGN_MEDIA_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

function decodeObjectPath(value) {
    try {
        return value.split('/').map(segment => decodeURIComponent(segment)).join('/');
    } catch (error) {
        throw new Error(`Invalid encoded campaign media path: ${error.message}`);
    }
}

function resolveCampaignMediaLocation(campaign) {
    if (campaign?.media_bucket && campaign?.media_object_path) {
        return {
            bucket: String(campaign.media_bucket),
            objectPath: decodeObjectPath(String(campaign.media_object_path).replace(/^\/+/, '')),
        };
    }

    const mediaPath = String(campaign?.media_path || '');
    if (!mediaPath) throw new Error('Campaign has no attachment.');

    if (/^https?:\/\//i.test(mediaPath)) {
        let url;
        try {
            url = new URL(mediaPath);
        } catch {
            throw new Error('Campaign attachment URL is invalid.');
        }
        const parts = url.pathname.split('/').filter(Boolean);
        const objectIndex = parts.indexOf('object');
        if (objectIndex < 0 || !parts[objectIndex + 2] || parts.length <= objectIndex + 3) {
            throw new Error('Campaign attachment URL does not contain a Supabase Storage object path.');
        }
        return {
            bucket: decodeURIComponent(parts[objectIndex + 2]),
            objectPath: decodeObjectPath(parts.slice(objectIndex + 3).join('/')),
        };
    }

    const plainPath = decodeObjectPath(mediaPath.replace(/^\/+/, ''));
    if (plainPath.startsWith(`${CAMPAIGN_MEDIA_BUCKET}/`)) {
        return { bucket: CAMPAIGN_MEDIA_BUCKET, objectPath: plainPath.slice(CAMPAIGN_MEDIA_BUCKET.length + 1) };
    }
    return { bucket: CAMPAIGN_MEDIA_BUCKET, objectPath: plainPath };
}

async function downloadCampaignMedia(campaign) {
    if (!isAvailable() || !supabase) {
        throw new Error('Supabase Storage is unavailable. Configure SUPABASE_URL and SUPABASE_SECRET_KEY.');
    }
    let bucket;
    let objectPath;
    try {
        ({ bucket, objectPath } = resolveCampaignMediaLocation(campaign));
    } catch (error) {
        console.error(`[campaign-media] invalid storage path campaign=${campaign?.id || 'unknown'}: ${error.message}`);
        throw error;
    }
    if (bucket !== CAMPAIGN_MEDIA_BUCKET || !objectPath || objectPath.split('/').some(segment => segment === '.' || segment === '..')) {
        const error = new Error('Campaign attachments must reference an object in the campaign-media bucket.');
        console.error(`[campaign-media] invalid object bucket=${bucket} object=${objectPath || '(empty)'}: ${error.message}`);
        throw error;
    }
    let data;
    try {
        const result = await supabase.storage.from(bucket).download(objectPath);
        data = result.data;
        if (result.error) throw result.error;
    } catch (error) {
        console.error(`[campaign-media] download failed bucket=${bucket} object=${objectPath}: ${error.message}`);
        throw new Error(`Attachment could not be loaded from Supabase Storage (${bucket}/${objectPath}): ${error.message}`);
    }

    try {
        if (Buffer.isBuffer(data)) return { buffer: data, bucket, objectPath };
        if (data instanceof ArrayBuffer) return { buffer: Buffer.from(data), bucket, objectPath };
        if (typeof Blob !== 'undefined' && data instanceof Blob) {
            return { buffer: Buffer.from(await data.arrayBuffer()), bucket, objectPath };
        }
        if (ArrayBuffer.isView(data)) {
            return { buffer: Buffer.from(data.buffer, data.byteOffset, data.byteLength), bucket, objectPath };
        }
        if (data && typeof data.arrayBuffer === 'function') {
            return { buffer: Buffer.from(await data.arrayBuffer()), bucket, objectPath };
        }
    } catch (conversionError) {
        console.error(`[campaign-media] download conversion failed bucket=${bucket} object=${objectPath}: ${conversionError.message}`);
        throw new Error(`Attachment could not be converted from Supabase Storage (${bucket}/${objectPath}): ${conversionError.message}`);
    }
    throw new Error(`Attachment could not be loaded from Supabase Storage (${bucket}/${objectPath}): unexpected response type.`);
}

async function ensureCampaignMediaBucket() {
    if (!isAvailable() || !supabase) {
        console.error('[campaign-media] Cannot ensure storage bucket: Supabase service-role client is unavailable.');
        return false;
    }

    try {
        const { data: buckets, error: listError } = await supabase.storage.listBuckets();
        if (listError) throw listError;
        const existing = (buckets || []).find(bucket => bucket.name === CAMPAIGN_MEDIA_BUCKET);
        if (existing) {
            console.log(`[campaign-media] Storage bucket "${CAMPAIGN_MEDIA_BUCKET}" exists and is ${existing.public ? 'public' : 'private'}.`);
            return true;
        }

        const { error } = await supabase.storage.createBucket(CAMPAIGN_MEDIA_BUCKET, {
            public: false,
            fileSizeLimit: '16777216',
            allowedMimeTypes: CAMPAIGN_MEDIA_MIME_TYPES,
        });
        if (error) throw error;
        console.log(`[campaign-media] Created storage bucket "${CAMPAIGN_MEDIA_BUCKET}" as private.`);
        return true;
    } catch (error) {
        console.error(`[campaign-media] Failed to ensure storage bucket "${CAMPAIGN_MEDIA_BUCKET}": ${error.message}`);
        return false;
    }
}

async function deleteCampaignMedia(campaign) {
    if (!isAvailable() || !supabase || !campaign?.media_object_path) return false;
    const { bucket, objectPath } = resolveCampaignMediaLocation(campaign);
    if (bucket !== CAMPAIGN_MEDIA_BUCKET || !objectPath || objectPath.split('/').some(segment => segment === '.' || segment === '..')) {
        throw new Error('Campaign attachments must reference an object in the campaign-media bucket.');
    }
    const { error } = await supabase.storage.from(bucket).remove([objectPath]);
    if (error) throw new Error(`Could not delete campaign attachment (${bucket}/${objectPath}): ${error.message}`);
    require('../storage/storageJobs').checkSoon(); // refresh storage usage
    return true;
}

module.exports = {
    CAMPAIGN_MEDIA_BUCKET,
    CAMPAIGN_MEDIA_MIME_TYPES,
    resolveCampaignMediaLocation,
    downloadCampaignMedia,
    deleteCampaignMedia,
    ensureCampaignMediaBucket,
};
