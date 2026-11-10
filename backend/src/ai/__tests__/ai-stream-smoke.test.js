// =============================================================
// Streaming completions (aiService._complete with stream:true) against a
// local fake OpenAI-compatible server — no real provider is called.
//
// Covers: a slow answer that keeps sending runs past the idle limit and
// succeeds; a silent (stalled) attempt is cut at the idle limit and the
// retry succeeds; reasoning-only chunks keep the attempt alive but are not
// part of the answer; a provider error body reaches the error; a
// mid-stream error is a retryable provider failure.
//
// Run: node backend/src/ai/__tests__/ai-stream-smoke.test.js
// =============================================================
'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');

process.env.AI_API_KEY = process.env.AI_API_KEY || 'test';
const aiService = require('../aiService');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (content) => sse({ id: 'cmpl-1', choices: [{ delta: { content } }] });

let behaviour = null;
let requests = 0;
const server = http.createServer(async (req, res) => {
    requests++;
    let body = '';
    for await (const chunk of req) body += chunk;
    await behaviour(req, res, JSON.parse(body), requests);
});

async function run() {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    const call = (extra = {}) => aiService._complete([{ role: 'user', content: 'hi' }], {
        apiKey: 'test', baseURL, model: 'm', stream: true, retries: 1, minAttemptMs: 100, ...extra,
    });
    const quiet = console.error;
    const quietWarn = console.warn;
    console.error = () => {};
    console.warn = () => {};

    try {
        // Slow but steady: 6 chunks 120ms apart (720ms total) with a 300ms
        // idle limit — never silent for 300ms, so it must not be cut.
        requests = 0;
        behaviour = async (req, res, payload) => {
            assert.equal(payload.stream, true, 'stream:true is sent');
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(sse({ id: 'cmpl-1', choices: [{ delta: { reasoning_content: 'thinking…' } }] }));
            for (const part of ['{"a"', ':', '1', ',"b"', ':2', '}']) {
                await sleep(120);
                res.write(delta(part));
            }
            res.end('data: [DONE]\n\n');
        };
        assert.equal(await call({ timeoutMs: 5000, idleTimeoutMs: 300, logLabel: 'slow' }), '{"a":1,"b":2}');
        assert.equal(requests, 1, 'a slow answer that keeps sending is not retried');

        // Stall on attempt 1 (headers, then nothing), answer on attempt 2.
        requests = 0;
        behaviour = async (req, res, payload, n) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            if (n === 1) return; // silent: never writes, never ends
            res.write(delta('ok'));
            res.end('data: [DONE]\n\n');
        };
        const started = Date.now();
        assert.equal(await call({ timeoutMs: 5000, idleTimeoutMs: 300, deadlineMs: Date.now() + 5000 }), 'ok');
        assert.equal(requests, 2, 'a stalled attempt is retried');
        assert.ok(Date.now() - started < 2000, 'the stall is cut at the idle limit, not the total timeout');

        // Both attempts stall: a timeout error the routes can recognise.
        behaviour = async (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); };
        await assert.rejects(call({ timeoutMs: 5000, idleTimeoutMs: 200 }), (error) => error.aiKind === 'timeout');

        // Provider rejects the request: its own message reaches the error.
        requests = 0;
        behaviour = async (req, res) => {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'model not found' } }));
        };
        await assert.rejects(call({ timeoutMs: 5000 }), (error) => error.providerStatus === 400 && /model not found/.test(error.message));
        assert.equal(requests, 1, 'a 400 is permanent: no retry');

        // Mid-stream error: retryable provider failure.
        requests = 0;
        behaviour = async (req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(delta('{"a"'));
            res.end(sse({ error: { message: 'overloaded' } }));
        };
        await assert.rejects(call({ timeoutMs: 5000 }), (error) => error.aiKind === 'provider' && error.providerStatus === 502);
        assert.equal(requests, 2, 'a mid-stream failure is retried');

        // Connection dropped mid-answer: retryable network failure.
        requests = 0;
        behaviour = async (req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(delta('{"a"'));
            await sleep(20);
            res.socket.destroy();
        };
        await assert.rejects(call({ timeoutMs: 5000 }), (error) => error.aiKind === 'network');
        assert.equal(requests, 2, 'a dropped connection is retried');
    } finally {
        console.error = quiet;
        console.warn = quietWarn;
        server.closeAllConnections?.();
        server.close();
    }
    console.log('ai-stream-smoke: all checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
