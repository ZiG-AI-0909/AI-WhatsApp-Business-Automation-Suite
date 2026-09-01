const path = require('path');
const { UPLOAD_DIR, CAMPAIGN_MEDIA_DIR } = require('../middleware/upload');

function confinedPath(filePath, directory, message) {
    if (!filePath || path.dirname(path.resolve(filePath)) !== path.resolve(directory)) throw new Error(message);
    return path.resolve(filePath);
}

function uploadedFilePath(filePath) { return confinedPath(filePath, UPLOAD_DIR, 'Invalid uploaded file path'); }
function uploadedMediaPath(filePath) { return confinedPath(filePath, CAMPAIGN_MEDIA_DIR, 'Invalid campaign media path'); }

module.exports = { uploadedFilePath, uploadedMediaPath };