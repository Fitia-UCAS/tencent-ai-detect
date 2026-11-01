#!/usr/bin/env node

const DEFAULT_ENDPOINT = 'wss://matrix.tencent.com/ai_gen_txt_server/getClassify';
const DEFAULT_TIMEOUT_MS = 8000;

// CLI probe for the site's classification WebSocket endpoint.
// Each run generates a fresh anonymous fingerprint and reports the server verdict.

function usage() {
  return [
    'Usage: node scripts/probe-ws.mjs [options]',
    '',
    'Options:',
    '  -n, --attempts <count>  Number of probes, default 1',
    '      --gap <seconds>     Delay between probes, default 0',
    '      --ticket <mode>     none | fake, default none; fake appends a bogus captcha ticket',
    '      --timeout <ms>      Per-probe timeout, default 8000',
    '  -h, --help              Show this help',
    '',
    'Every probe generates a new 32-char anonymous fp and talks to the site\'s own WebSocket:',
    '  ok      server returned {"status":"success","availableUses":N}',
    '  failed  server returned {"status":"failed","msg":"..."}, commonly "Invalid request"',
    '  timeout no response within the timeout window',
    '',
    'Note: each run consumes one "new fp" allowance. Back-to-back runs may hit server-side rate limiting; keep a gap of several minutes.',
    '',
    'Exit codes: 0 all succeeded / 1 at least one failure or timeout / 2 bad arguments'
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { attempts: 1, gap: 0, ticket: 'none', timeout: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '-n' || arg === '--attempts') {
      opts.attempts = Number(argv[i += 1]);
    } else if (arg === '--gap') {
      opts.gap = Number(argv[i += 1]);
    } else if (arg === '--ticket') {
      opts.ticket = String(argv[i += 1]);
    } else if (arg === '--timeout') {
      opts.timeout = Number(argv[i += 1]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(opts.attempts) || opts.attempts < 1) {
    throw new Error('--attempts must be a positive integer');
  }
  if (!Number.isFinite(opts.gap) || opts.gap < 0) {
    throw new Error('--gap must be a non-negative number');
  }
  if (!['none', 'fake'].includes(opts.ticket)) {
    throw new Error('--ticket must be either none or fake');
  }
  if (!Number.isFinite(opts.timeout) || opts.timeout < 1000) {
    throw new Error('--timeout must be at least 1000 ms');
  }
  return opts;
}

function newFp() {
  const chars = 'abcdef0123456789';
  let fp = '';
  for (let i = 0; i < 32; i += 1) {
    fp += chars[Math.floor(Math.random() * chars.length)];
  }
  return fp;
}

function fakeTicket() {
  return `terror_1001_2089775896_${Math.floor(Date.now() / 1000)}`.slice(0, 32);
}

function classify(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // Non-JSON payload: surface it verbatim.
    return { kind: 'raw', detail: raw };
  }
  if (data.status === 'success') {
    return { kind: 'ok', detail: `availableUses=${data.availableUses}` };
  }
  if (data.status === 'failed') {
    return { kind: 'failed', detail: data.msg || '(empty)' };
  }
  if (data.code) {
    return { kind: 'code', detail: `code=${data.code} ${data.msg || ''}`.trim() };
  }
  return { kind: 'other', detail: raw };
}

function probe({ ticket, timeout }) {
  return new Promise(resolve => {
    const fp = newFp();
    const started = Date.now();
    const messages = [];
    let settled = false;
    let ws;

    // Resolve once and always tear down the socket and timers.
    const finish = (kind, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(ticketTimer);
      try {
        ws.close();
      } catch {}
      resolve({ fp, kind, detail, messages, ms: Date.now() - started });
    };

    let ticketTimer = null;
    const timer = setTimeout(() => finish('timeout', `No response within ${timeout}ms`), timeout);

    try {
      ws = new WebSocket(DEFAULT_ENDPOINT);
    } catch (error) {
      finish('error', error.message);
      return;
    }

    ws.onopen = () => {
      ws.send(JSON.stringify({ fp }));
      if (ticket === 'fake') {
        // Send the bogus ticket slightly after the handshake message.
        ticketTimer = setTimeout(() => {
          ws.send(JSON.stringify({ ticket: fakeTicket(), randstr: `@${Math.random().toString(36).slice(2)}` }));
        }, 500);
      }
    };

    ws.onmessage = event => {
      const raw = String(event.data);
      messages.push(raw);
      const result = classify(raw);
      // In fake-ticket mode the first frame is the fp ack; wait for the verdict.
      if (ticket === 'fake' && messages.length === 1) return;
      if (result.kind === 'ok') finish('ok', result.detail);
      else finish(result.kind, result.detail);
    };

    ws.onerror = () => finish('error', 'Connection failed');

    ws.onclose = event => {
      if (!settled) finish('closed', `Connection closed code=${event.code}`);
    };
  });
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error('');
    console.error(usage());
    process.exit(2);
  }
  if (opts.help) {
    console.log(usage());
    return;
  }

  const results = [];
  for (let i = 0; i < opts.attempts; i += 1) {
    if (i > 0 && opts.gap > 0) {
      await new Promise(r => setTimeout(r, opts.gap * 1000));
    }
    const result = await probe(opts);
    results.push(result);
    console.log(`${new Date().toISOString()}  fp=${result.fp}  ${result.kind}  ${result.detail}  (${result.ms}ms)`);
  }

  const ok = results.filter(r => r.kind === 'ok').length;
  console.log('');
  console.log(`Summary: ${ok}/${results.length} succeeded`);
  if (ok !== results.length) {
    const failed = results.filter(r => r.kind !== 'ok');
    console.log(`${failed.length} failed - possibly inside an IP rate-limit window, retry later.`);
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
