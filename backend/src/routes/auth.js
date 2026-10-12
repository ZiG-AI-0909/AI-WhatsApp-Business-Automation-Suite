const express = require('express');
const router = express.Router();

// Authentication is handled entirely by Supabase Auth on the client side.
// The custom /api/auth/login route has been removed — tokens issued by
// Supabase are validated in middleware/auth.js via supabase.auth.getUser().
//
// This file is kept as a placeholder. Add any server-side auth utility
// endpoints here in the future (e.g., session revocation, admin actions).

module.exports = router;
