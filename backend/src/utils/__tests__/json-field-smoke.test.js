const assert = require('node:assert/strict');
const { parseJsonField } = require('../jsonField');

const fallback = { fallback: true };
const objectValue = { enabled: true };
const arrayValue = [{ id: 1 }];

assert.strictEqual(parseJsonField(objectValue, fallback), objectValue);
assert.deepStrictEqual(parseJsonField('{"enabled":true}', fallback), objectValue);
assert.deepStrictEqual(parseJsonField(JSON.stringify('{"enabled":true}'), fallback), objectValue);
assert.strictEqual(parseJsonField(arrayValue, fallback), arrayValue);
assert.strictEqual(parseJsonField(null, fallback), fallback);
assert.strictEqual(parseJsonField(undefined, fallback), fallback);
assert.strictEqual(parseJsonField('', fallback), fallback);
assert.strictEqual(parseJsonField('{invalid json', fallback), fallback);

console.log('JSON field smoke test passed');
