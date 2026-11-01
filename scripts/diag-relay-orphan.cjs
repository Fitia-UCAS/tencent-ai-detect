// Does the relay child die when its host exits?
//
// Measures Windows child-process lifetime: start a Native Host, ask it to start
// a relay, terminate the host, then probe whether the relay child remains alive.
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const HOST = path.join(__dirname, 'nm-host.cjs');
const PORT = 19424;

function healthy() {
    return new Promise(resolve => {
        const request = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 1500 }, response => {
            let body = '';
            response.on('data', c => { body += c; });
            response.on('end', () => resolve(/zq-local-relay-v1/.test(body)));
            response.on('error', () => resolve(false));
        });
        request.on('error', () => resolve(false));
        request.on('timeout', () => { request.destroy(); resolve(false); });
    });
}

function frame(message) {
    const json = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length, 0);
    return Buffer.concat([header, json]);
}

(async () => {
    if (await healthy()) {
        process.stdout.write('port already in use; stopping\n');
        return;
    }

    const host = spawn(process.execPath, [HOST], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, {
            RELAY_PORT: String(PORT),
            RELAY_IDLE_MS: '60000'
        }),
        windowsHide: true
    });

    host.stderr.on('data', d => process.stdout.write('  host: ' + String(d)));

    host.stdin.write(frame({ type: 'ensure' }));

    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
        await new Promise(r => setTimeout(r, 100));
        up = await healthy();
    }

    process.stdout.write(`relay up before killing the host: ${up}\n`);

    if (!up) {
        host.kill();
        return;
    }

    host.kill();
    await new Promise(r => setTimeout(r, 800));

    process.stdout.write(`relay up right after killing the host: ${await healthy()}\n`);

    await new Promise(r => setTimeout(r, 3000));
    process.stdout.write(`relay up 3s later: ${await healthy()}\n`);
})();
