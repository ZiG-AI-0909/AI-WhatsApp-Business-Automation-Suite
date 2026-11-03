// =============================================================
// Smoke test — db.applyWhere turns "(a LIKE ? OR b LIKE ?)" into one
// PostgREST .or() filter. User search text must stay inside its quoted
// value: a backslash before a quote must not end the value early and
// add filters of its own.
//
// Run: node backend/src/database/__tests__/db-where-escape-smoke.test.js
// =============================================================
const assert = require('node:assert/strict');
const { applyWhere } = require('../db');

function capture() {
    const calls = [];
    const query = new Proxy({}, {
        get: (_target, method) => (...args) => { calls.push([method, ...args]); return query; },
    });
    return { query, calls };
}

const orFilter = (search) => {
    const { query, calls } = capture();
    applyWhere(query, 'contacts', 'user_id = ? AND (name LIKE ? OR phone LIKE ?)', ['u1', search, search]);
    assert.deepEqual(calls[0], ['eq', 'user_id', 'u1']);
    assert.equal(calls[1][0], 'or');
    return calls[1][1];
};

// A plain term needs no quoting.
assert.equal(orFilter('%ravi%'), 'name.like.*ravi*,phone.like.*ravi*');

// Spaces / commas are quoted.
assert.equal(orFilter('%a, b%'), 'name.like."*a, b*",phone.like."*a, b*"');

// `\"` must become `\\\"` (escaped backslash, then escaped quote), so the
// injected ",id.gt.0" stays part of the searched text.
const injected = orFilter('%x\\",id.gt.0%');
assert.equal(injected, 'name.like."*x\\\\\\",id.gt.0*",phone.like."*x\\\\\\",id.gt.0*"');

// A lone backslash is escaped too.
assert.equal(orFilter('%a\\b%'), 'name.like."*a\\\\b*",phone.like."*a\\\\b*"');

console.log('ok   db.applyWhere: OR-group values are quoted and escaped');
