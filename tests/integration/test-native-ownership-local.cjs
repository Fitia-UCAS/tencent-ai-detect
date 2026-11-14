// Local process-lifecycle tests. No browser and no upstream WebSocket requests.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

async function availablePort() {
    return new Promise(resolve => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}
function health(port) {
    return new Promise(resolve => {
        const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 350 }, res => {
            let body = '';
            res.on('data', b => (body += b));
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 5000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (await check()) return true;
        await sleep(70);
    }
    return false;
}
function startHost(port) {
    const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'host', 'native-host.cjs')], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, RELAY_PORT: String(port), RELAY_IDLE_MS: '120000' }
    });
    const messages = [];
    let buffer = Buffer.alloc(0);
    let errors = '';
    child.stderr.on('data', data => (errors += String(data)));
    child.stdout.on('data', data => {
        buffer = Buffer.concat([buffer, data]);
        while (buffer.length >= 4) {
            const length = buffer.readUInt32LE(0);
            if (buffer.length < length + 4) break;
            messages.push(JSON.parse(buffer.subarray(4, length + 4).toString()));
            buffer = buffer.subarray(length + 4);
        }
    });
    child.on('error', error => { errors += error.stack || String(error); });
    const send = message => {
        const payload = Buffer.from(JSON.stringify(message));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(payload.length);
        child.stdin.write(Buffer.concat([header, payload]));
    };
    return { child, messages, send, get errors() { return errors; } };
}
async function closeHost(host) {
    host.child.stdin.end();
    const stopped = await until(() => host.child.exitCode !== null || host.child.signalCode !== null, 3000);
    if (!stopped) host.child.kill();
    assert(stopped, 'Native Host stopped after stdin closed');
}
(async () => {
    const children = [];
    try {
        const ownPort = await availablePort();
        const host = startHost(ownPort);
        children.push(host.child);
        assert(await until(() => host.messages.some(m => m.type === 'ready')), host.errors);
        host.send({ type: 'ensure' });
        assert(await until(() => host.messages.some(m => m.type === 'relay')), host.errors);
        const created = host.messages.find(m => m.type === 'relay');
        assert.equal(created.ok, true, host.errors);
        assert.equal(created.reused, false);
        assert(await until(async () => (await health(ownPort))?.ok === true));
        host.send({ type: 'heartbeat' });
        await sleep(150);
        assert.equal((await health(ownPort)).ok, true);
        console.log('ok 1 owned relay starts and host accepts heartbeat');
        await closeHost(host);
        assert(await until(async () => (await health(ownPort)) === null, 2500), 'owned relay must close');
        console.log('ok 2 closing host stops only its owned relay');

        const externalPort = await availablePort();
        const standalone = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'relay', 'server.cjs')], {
            stdio: 'ignore',
            env: { ...process.env, RELAY_PORT: String(externalPort), RELAY_IDLE_MS: '0' }
        });
        children.push(standalone);
        assert(await until(async () => (await health(externalPort))?.ok === true));
        const reuser = startHost(externalPort);
        children.push(reuser.child);
        assert(await until(() => reuser.messages.some(m => m.type === 'ready')), reuser.errors);
        reuser.send({ type: 'ensure' });
        assert(await until(() => reuser.messages.some(m => m.type === 'relay')), reuser.errors);
        const reused = reuser.messages.find(m => m.type === 'relay');
        assert.equal(reused.ok, true, reuser.errors);
        assert.equal(reused.reused, true);
        await closeHost(reuser);
        assert.equal((await health(externalPort))?.ok, true, 'reused relay should remain owner-controlled');
        console.log('ok 3 reused external relay is not terminated by the host');
        console.log('PASS: 3/3 local Native Host ownership checks');
    } finally {
        for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) child.kill();
        }
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
