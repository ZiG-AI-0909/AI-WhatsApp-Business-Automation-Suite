#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const API_BASE_URL = process.env.API_BASE_URL;
const TEST_JWT = process.env.TEST_JWT;
const WRITE = process.argv.includes('--write');
const LIST_ONLY = process.argv.includes('--list-only');
const routesDir = path.join(__dirname, '..', 'src', 'routes');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

function registeredRoutes() {
    const mounts = new Map();
    for (const line of serverSource.split(/\r?\n/)) {
        const match = line.match(/app\.use\(\s*['"]\/api\/([^'"]+)['"][^\n]*require\(['"]\.\/routes\/([^'"]+)['"]\)/);
        if (match) mounts.set(match[2], { prefix: `/api/${match[1]}`, protected: /requireAuth/.test(line) });
    }

    const routes = [];
    if (/app\.get\(\s*['"]\/api\/health['"]/.test(serverSource)) {
        routes.push({ method: 'GET', path: '/api/health', protected: false });
    }
    for (const file of fs.readdirSync(routesDir).filter(name => name.endsWith('.js'))) {
        const source = fs.readFileSync(path.join(routesDir, file), 'utf8');
        const name = file.replace(/\.js$/, '');
        const mount = mounts.get(name);
        const nestedProductMount = name === 'productIdentification'
            ? { prefix: '/api/image-extractor', protected: true }
            : null;
        const target = mount || nestedProductMount;
        if (!target) continue;

        const routePattern = /router\.(get|post|put|patch|delete)\(\s*(['"])([^'"]+)\2/gi;
        for (const match of source.matchAll(routePattern)) {
            const routePath = match[3] === '/' ? '' : match[3];
            routes.push({
                method: match[1].toUpperCase(),
                path: `${target.prefix}${routePath}`,
                protected: target.protected,
            });
        }
    }
    return [...new Map(routes.map(route => [`${route.method} ${route.path}`, route])).values()];
}

if (LIST_ONLY) {
    console.table(registeredRoutes().map(({ method, path: routePath }) => ({ method, path: routePath })));
    process.exit(0);
}

if (!API_BASE_URL || !TEST_JWT) {
    console.error('Set API_BASE_URL and TEST_JWT before running the API smoke check.');
    process.exit(1);
}

const baseUrl = API_BASE_URL.replace(/\/+$/, '').replace(/\/api$/i, '');

function concretePath(route) {
    let pathValue = route.path
        .replace(/:jobId/g, 'smoke-job')
        .replace(/:id/g, '1')
        .replace(/\*/g, 'smoke');
    if (pathValue === '/api/webhooks/whatsapp') {
        pathValue += '?hub.mode=subscribe&hub.verify_token=smoke&hub.challenge=1';
    } else if (pathValue === '/api/campaigns') {
        pathValue += '?page=1&limit=1';
    } else if (/\/contacts$/.test(pathValue) || /\/messages$/.test(pathValue)) {
        pathValue += '?page=1&limit=1';
    }
    return pathValue;
}

async function makeTestWorkbook() {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Contacts');
    sheet.columns = [{ header: 'Phone', key: 'phone' }, { header: 'Name', key: 'name' }];
    sheet.addRow({ phone: '15551234567', name: 'API Smoke Test' });
    const bytes = await workbook.xlsx.writeBuffer();
    const form = new FormData();
    form.append('file', new Blob([bytes], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }), 'test.xlsx');
    form.append('countryCode', '1');
    return form;
}

async function main() {
    const routes = registeredRoutes();
    const results = [];
    for (const route of routes) {
        const pathValue = concretePath(route);
        const isExcelValidation = route.method === 'POST' && route.path === '/api/campaigns/validate-excel';
        const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(route.method);
        const liveAction = /\/campaigns\/\d+\/(?:start|resume|pause|stop|retry-failed)$|\/conversations\/\d+\/send$|\/whatsapp\/(?:connect|reconnect|disconnect|logout|business\/connect)$|\/schedules\/\d+\/(?:resume|retry|cancel)$/.test(pathValue);
        if (liveAction || (mutating && !WRITE && !isExcelValidation)) {
            results.push({
                method: route.method,
                path: pathValue,
                status: 'SKIP',
                result: liveAction ? 'SKIP (live action)' : 'SKIP (--write)',
                time: '—',
            });
            continue;
        }

        const start = performance.now();
        try {
            const headers = { Authorization: `Bearer ${TEST_JWT}`, Accept: 'application/json' };
            const options = { method: route.method, headers, signal: AbortSignal.timeout(30000) };
            if (isExcelValidation) {
                options.body = await makeTestWorkbook();
            } else if (mutating) {
                headers['Content-Type'] = 'application/json';
                options.body = JSON.stringify({});
            }
            const response = await fetch(`${baseUrl}${pathValue}`, options);
            const elapsed = `${Math.round(performance.now() - start)} ms`;
            const authFailure = route.protected && [401, 403].includes(response.status);
            const ok = (isExcelValidation ? response.ok : response.status < 500)
                && response.status !== 429
                && !authFailure;
            results.push({
                method: route.method,
                path: pathValue,
                status: response.status,
                result: ok ? 'PASS' : 'FAIL',
                time: elapsed,
            });
            await response.body?.cancel();
        } catch (error) {
            results.push({
                method: route.method,
                path: pathValue,
                status: 'ERROR',
                result: 'FAIL',
                time: `${Math.round(performance.now() - start)} ms`,
            });
            console.error(`${route.method} ${pathValue}: ${error.message}`);
        }
    }
    console.table(results);
    const failed = results.filter(result => result.result === 'FAIL').length;
    console.log(`Checked ${results.length} registered routes; ${failed} failed.`);
    if (failed) process.exitCode = 1;
}

main().catch(error => {
    console.error('API smoke check failed:', error);
    process.exitCode = 1;
});
