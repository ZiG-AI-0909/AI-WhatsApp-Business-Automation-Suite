const multer = require('multer');
const path = require('path');
const fs = require('fs');

const UPLOAD_DIR = path.join(__dirname, '..', '..', '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const KNOWLEDGE_DIR = path.join(__dirname, '..', '..', '..', 'knowledge');
if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });

const CAMPAIGN_MEDIA_DIR = path.join(__dirname, '..', '..', '..', 'campaign-media');
if (!fs.existsSync(CAMPAIGN_MEDIA_DIR)) fs.mkdirSync(CAMPAIGN_MEDIA_DIR, { recursive: true });

const excelStorage = multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
        cb(null, `campaign_${Date.now()}${path.extname(file.originalname)}`);
    },
});

const knowledgeStorage = multer.diskStorage({
    destination: KNOWLEDGE_DIR,
    filename: (req, file, cb) => {
        cb(null, `doc_${Date.now()}_${file.originalname}`);
    },
});

const campaignMediaStorage = multer.diskStorage({
    destination: CAMPAIGN_MEDIA_DIR,
    filename: (req, file, cb) => {
        cb(null, `media_${Date.now()}${path.extname(file.originalname).toLowerCase()}`);
    },
});

const excelFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.xlsx') cb(null, true);
    else cb(new Error('Only Excel (.xlsx) files are allowed'));
};

const textFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.txt', '.md', '.pdf', '.docx'].includes(ext)) cb(null, true);
    else cb(new Error('Only .txt, .md files are supported for knowledge documents'));
};

const campaignMediaFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mimeType = file.mimetype.toLowerCase();
    
    // Image extensions and mimetypes
    if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext) && ['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
        cb(null, true);
        return;
    }
    
    // Document extensions and mimetypes
    if (['.pdf', '.doc', '.docx', '.xls', '.xlsx'].includes(ext) && 
        ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(mimeType)) {
        cb(null, true);
        return;
    }
    
    cb(new Error('Only JPG, PNG, WEBP images, and PDF, DOC, DOCX, XLS, XLSX documents are allowed'));
};

const uploadExcel = multer({ storage: excelStorage, fileFilter: excelFilter, limits: { fileSize: 10 * 1024 * 1024 } });
const uploadKnowledge = multer({ storage: knowledgeStorage, fileFilter: textFilter, limits: { fileSize: 5 * 1024 * 1024 } });
const uploadCampaignMedia = multer({ storage: campaignMediaStorage, fileFilter: campaignMediaFilter, limits: { fileSize: 16 * 1024 * 1024 } });

module.exports = { uploadExcel, uploadKnowledge, uploadCampaignMedia, UPLOAD_DIR, KNOWLEDGE_DIR, CAMPAIGN_MEDIA_DIR };
