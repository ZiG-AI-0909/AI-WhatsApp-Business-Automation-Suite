const assert = require('node:assert/strict');
const messageQueue = require('../messageQueue');

assert.equal(messageQueue.shouldRetrySendError({ response: { status: 400 } }), false);
assert.equal(messageQueue.shouldRetrySendError({
    message: 'WhatsApp number is not registered: [redacted]',
}), false);
assert.equal(messageQueue.shouldRetrySendError({ response: { status: 503 } }), true);
assert.equal(messageQueue.shouldRetrySendError(new Error('Socket closed')), true);

console.log('Message queue send-error retry smoke test passed');
