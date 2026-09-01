const net = require('net');
const { spawn } = require('child_process');

const root = require('path').join(__dirname, '..');
const services = [
    { name: 'backend', port: 3000, command: 'npm', args: ['run', 'dev:backend'] },
    { name: 'frontend', port: 5173, command: 'npm', args: ['run', 'dev:frontend'] },
];
const children = [];

function isPortOpen(port) {
    return new Promise(resolve => {
        const socket = net.createConnection({ port, host: '127.0.0.1' });
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(false));
    });
}

async function start() {
    for (const service of services) {
        if (await isPortOpen(service.port)) {
            console.log(`[${service.name}] already running on http://localhost:${service.port}`);
            continue;
        }

        const command = process.platform === 'win32' ? process.env.ComSpec : service.command;
        const args = process.platform === 'win32'
            ? ['/d', '/s', '/c', [service.command, ...service.args].join(' ')]
            : service.args;
        const child = spawn(command, args, {
            cwd: root,
            stdio: 'inherit',
            shell: false,
        });
        children.push(child);
        child.on('exit', code => {
            if (code && code !== 0) process.exitCode = code;
        });
    }

    if (children.length === 0) console.log('Development services are already running.');
}

function stop() {
    for (const child of children) {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
        } else {
            child.kill('SIGTERM');
        }
    }
}

process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
start().catch(error => { console.error(error); process.exit(1); });
