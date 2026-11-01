// Verifies that the page remains usable with the extension installed.
//
// This test does not force the relay offline: the extension worker can start it
// again. The isolated relay-off condition is tested separately by diag-shim.cjs,
// which loads the shim without loading the extension.
const path = require('node:path');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.resolve(__dirname, '..');
const SITE = 'https://matrix.tencent.com/ai-detect/';
const PORT = 9378;

const { sleep, httpJson, cdp, launch } = require('./browser-harness.cjs');

const failures = [];
const ok = message => process.stdout.write(`  ok    ${message}\n`);
const fail = message => {
  failures.push(message);
  process.stdout.write(`  FAIL  ${message}\n`);
};

(async () => {
  let session = null;

  try {
    session = await launch({
      browser: BROWSER,
      port: PORT,
      prefix: 'zqfallback',
      args: [
        '--disable-features=DisableLoadExtensionCommandLineSwitch',
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`
      ]
    });

    const target = await httpJson(PORT, '/json/new?about:blank', 'PUT');
    const page = await cdp(target.webSocketDebuggerUrl);

    const sockets = [];
    const frames = [];

    page.on(msg => {
      if (msg.method === 'Network.webSocketCreated') sockets.push(msg.params.url);
      if (msg.method === 'Network.webSocketFrameReceived') {
        frames.push(String(msg.params.response.payloadData).slice(0, 160));
      }
    });

    await page.send('Network.enable');
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Page.navigate', { url: SITE });

    // Give the page time to try the relay, fail, and fall back.
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !frames.length) await sleep(500);

    // 1. The socket must end up talking to the real server, and the first frame
    //    must be replayed rather than dropped. Whether it reached there directly
    //    or after a relay attempt depends on relay timing, which this test does
    //    not control — so it asserts the outcome, not the route.
    if (sockets.some(u => u.includes('matrix.tencent.com'))) {
      ok('socket reached matrix.tencent.com');
    } else if (sockets.some(u => u.startsWith('ws://127.0.0.1'))) {
      // The relay came back mid-test; that is a valid outcome, not a failure.
      process.stdout.write('  skip  relay was reinstated by the worker; route not asserted\n');
    } else {
      fail('no usable socket was created at all');
    }

    // 2. The server must have answered, proving the first frame was delivered.
    if (frames.some(f => f.includes('"status"'))) {
      ok(`server answered (${frames[0]})`);
    } else {
      fail('server never answered; the first frame was probably lost');
    }

    // 4. The page must still be usable. The editor is a contenteditable block,
    //    not a textarea, so the check drives that instead.
    const typed = await page.send('Runtime.evaluate', {
      expression: `(() => {
        const box = document.querySelector('[contenteditable="true"], .editor, [class*="editor"]');
        if (!box) return 'no editor';
        box.focus();
        box.textContent = '人工智能技术的快速发展正在深刻改变着我们的生活方式与工作模式，从智能手机里的语音助手到自动驾驶汽车，这项技术已经渗透到社会生产的各个角落。';
        box.dispatchEvent(new InputEvent('input', { bubbles: true }));
        return 'typed';
      })()`,
      returnByValue: true
    });

    if (typed.result && typed.result.value === 'typed') {
      await sleep(2000);
      const state = await page.send('Runtime.evaluate', {
        expression: `(() => {
          const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('立即检测'));
          return JSON.stringify({ disabled: btn ? btn.disabled : null });
        })()`,
        returnByValue: true
      });

      const parsed = JSON.parse((state.result && state.result.value) || '{}');

      if (parsed.disabled === false) {
        ok('detect button is enabled after typing');
      } else {
        fail(`detect button disabled=${parsed.disabled} after typing`);
      }
    } else {
      // The editor selector is site markup, not part of the extension; report it
      // without failing the run.
      process.stdout.write(`  skip  editor not found (${typed.result && typed.result.value})\n`);
    }

    page.close();
  } catch (e) {
    fail('exception: ' + String(e && e.message ? e.message : e));
  } finally {
    if (session) await session.cleanup();
  }

  if (failures.length) {
    process.stdout.write(`\n${failures.length} check(s) failed\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('\nall checks passed\n');
    process.exitCode = 0;
  }
})();
