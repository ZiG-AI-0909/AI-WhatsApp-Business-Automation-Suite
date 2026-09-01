require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_PLAIN = process.env.ADMIN_PASSWORD || 'admin123';
const AUTH_DISABLED = process.env.AUTH_DISABLED === 'true';

// Hash once at startup so the first login cannot race initialization.
const hashedPassword = bcrypt.hashSync(ADMIN_PASSWORD_PLAIN, 10);

/**
 * Login handler — returns JWT on success.
 */
async function login(req, res) {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }
    if (username !== ADMIN_USERNAME) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    const valid = await bcrypt.compare(password, hashedPassword);
    if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username });
}

/**
 * JWT authentication middleware.
 */
function requireAuth(req, res, next) {
    if (AUTH_DISABLED) return next();
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    const token = header.slice(7);
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
}

module.exports = { login, requireAuth };
