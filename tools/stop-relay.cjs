// Explicit maintenance command: stop only a Windows loopback listener that the
// OS identifies as this checkout's relay.cjs. The HTTP PID is never trusted.
//
// Two independent conditions must both hold before a process is signalled:
//   1. the listener answers /health with this project's service marker, and
//   2. the OS attributes the port to a node process running scripts/relay.cjs.
// The service marker is public and cannot authenticate a process.
// Exact absolute paths are matched to this checkout, but a relative command
// such as `node scripts/relay.cjs` cannot prove the process working directory;
// these checks prevent typical accidental collisions, not hostile impersonation.
const http = require('node:http');
const { relayPidForPort } = require('./find-relay-pid.cjs');

const SERVICE_MARKER = 'zq-local-relay-v1';
const port = Number(process.argv[2] || 9420);

function serviceMarker() {
    return new Promise(resolve => {
        const request = http.get(
            { host: '127.0.0.1', port, path: '/health', timeout: 1500 },
            response => {
                let body = '';
                response.setEncoding('utf8');
                response.on('data', chunk => { body += chunk; });
                response.on('end', () => {
                    try {
                        resolve(JSON.parse(body).service || null);
                    } catch (e) {
                        resolve(null);
                    }
                });
            }
        );

        request.on('timeout', () => { request.destroy(); resolve(null); });
        request.on('error', () => resolve(null));
    });
}

(async () => {
    const marker = await serviceMarker();

    if (marker !== SERVICE_MARKER) {
        process.stderr.write(
            `refused: listener on ${port} did not report service "${SERVICE_MARKER}"; nothing terminated\n`
        );
        process.exitCode = 1;
        return;
    }

    const pid = relayPidForPort(port);

    if (!pid) {
        process.stderr.write('refused: no verified relay owned by this checkout on the port; nothing terminated\n');
        process.exitCode = 1;
        return;
    }

    // Recheck immediately before signalling to reduce accidental PID reuse races.
    if (relayPidForPort(port) !== pid) {
        process.stderr.write('refused: listener identity changed before termination\n');
        process.exitCode = 1;
        return;
    }

    try {
        process.kill(pid);
        process.stdout.write(`stopped verified local relay ${pid}\n`);
    } catch (error) {
        process.stderr.write(`failed to stop ${pid}: ${error.message}\n`);
        process.exitCode = 1;
    }
})();
