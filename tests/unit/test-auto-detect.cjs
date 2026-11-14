// Verifies the extension starts detections itself instead of waiting for a click.
//
// Maintaining the allowance is useless if nothing ever asks for a detection: the user still had to
// paste text and press 立即检测 for every run. These cases pin the parts that make it hands-off -
// the click, the guards around it, and the draft that survives the reload a rotation performs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'content', 'auto.js'),
  'utf8'
);

// A page with one editor and one detect button. `clicks` records what the extension pressed so the
// assertions can be about behaviour rather than about markup.
function load({ text = '', disabled = false, captcha = false } = {}) {
  const store = new Map();
  const clicks = [];
  const inputs = [];

  const editor = {
    textContent: text,
    focus() {},
    dispatchEvent(event) { inputs.push(event); return true; }
  };

  const button = {
    textContent: '立即检测',
    get disabled() { return disabled; },
    click() { clicks.push(editor.textContent); }
  };

  const sandbox = {
    window: {},
    document: {
      querySelector(selector) {
        return selector.includes('contenteditable') ? editor : null;
      },
      querySelectorAll(selector) {
        return selector === 'button' ? [button] : [];
      }
    },
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key)
    },
    // The site's own listeners only react to real input events, so the module constructs one.
    InputEvent: class InputEvent {
      constructor(type, init) { this.type = type; this.bubbles = !!(init && init.bubbles); }
    },
    setInterval: () => 0,
    clearInterval() {},
    console
  };

  sandbox.window = sandbox;

  vm.runInNewContext(SOURCE, sandbox, { filename: 'auto.js' });

  const ZQ = sandbox.__zq;
  ZQ.state = { enabled: true, autoRefresh: true, rotating: false, contextAlive: true };
  ZQ.captchaOpen = () => captcha;

  return { ZQ, store, clicks, inputs, editor, button };
}

const failures = [];
const check = (name, fn) => {
  try {
    fn();
    process.stdout.write(`  ok    ${name}\n`);
  } catch (error) {
    failures.push(name);
    process.stdout.write(`  FAIL  ${name} - ${error.message}\n`);
  }
};

// --- the click itself ------------------------------------------------------

check('a filled editor is detected without any user action', () => {
  const page = load({ text: '一段待检测的文字' });
  assert.equal(page.ZQ.autoDetect(), true, 'it must press the control');
  assert.equal(page.clicks.length, 1, 'exactly one detection per content');
  assert.equal(page.clicks[0], '一段待检测的文字');
});

check('the same text is not detected twice', () => {
  const page = load({ text: '同一段文字' });
  page.ZQ.autoDetect();
  page.ZQ.autoDetect();
  page.ZQ.autoDetect();
  assert.equal(page.clicks.length, 1, 'the interval must not re-fire on unchanged text');
});

check('new text is detected again', () => {
  const page = load({ text: '第一段' });
  page.ZQ.autoDetect();
  page.editor.textContent = '第二段';
  page.ZQ.autoDetect();
  assert.equal(page.clicks.length, 2, 'each distinct text is one detection');
});

// --- the guards around it --------------------------------------------------

check('an empty editor is left alone', () => {
  const page = load({ text: '   ' });
  assert.equal(page.ZQ.autoDetect(), false);
  assert.equal(page.clicks.length, 0, 'there is nothing to detect');
});

check('nothing is pressed behind an open captcha', () => {
  const page = load({ text: '文字', captcha: true });
  assert.equal(page.ZQ.autoDetect(), false);
  assert.equal(page.clicks.length, 0, 'the challenge is the user\'s to answer');
});

check('a disabled control is not pressed', () => {
  const page = load({ text: '文字', disabled: true });
  assert.equal(page.ZQ.autoDetect(), false);
  assert.equal(page.clicks.length, 0);
});

check('the switches turn it off', () => {
  const off = load({ text: '文字' });
  off.ZQ.state.enabled = false;
  assert.equal(off.ZQ.autoDetect(), false);

  const noRefresh = load({ text: '文字' });
  noRefresh.ZQ.state.autoRefresh = false;
  assert.equal(noRefresh.ZQ.autoDetect(), false);

  const busy = load({ text: '文字' });
  busy.ZQ.state.rotating = true;
  assert.equal(busy.ZQ.autoDetect(), false);

  assert.equal(off.clicks.length + noRefresh.clicks.length + busy.clicks.length, 0);
});

// --- the draft that survives a reload -------------------------------------

check('the pasted text is saved before a reload', () => {
  const page = load({ text: '要保住的一段话' });
  assert.equal(page.ZQ.saveDraft(), true);
  assert.equal(page.store.get('zqDraft'), '要保住的一段话');
});

check('the draft is put back after the reload and then forgotten', () => {
  const page = load({ text: '' });
  page.store.set('zqDraft', '刷新前的文字');

  assert.equal(page.ZQ.restoreDraft(), true, 'the draft must be written back');
  assert.equal(page.editor.textContent, '刷新前的文字');
  assert.equal(page.inputs.length, 1, 'the site must be told the editor changed');
  assert.equal(page.store.has('zqDraft'), false, 'a restored draft must not linger');

  assert.equal(page.ZQ.restoreDraft(), false, 'nothing left to restore');
});

check('a rotation keeps the text it was triggered by', () => {
  const page = load({ text: '轮换前的内容' });
  page.ZQ.saveDraft();

  // The reload empties the editor, as a real one would.
  page.editor.textContent = '';
  assert.equal(page.ZQ.readEditor(), '');

  page.ZQ.restoreDraft();
  assert.equal(page.ZQ.readEditor(), '轮换前的内容');
});

// --- the site normalises whitespace, so a restored draft must not look new -----

check('a draft whose spacing changed is not detected again', () => {
  const page = load({ text: '第一段\n第二段' });
  page.ZQ.autoDetect();
  assert.equal(page.clicks.length, 1);

  // The editor re-renders the same content with different whitespace, which is what the site does
  // after a reload. Re-pressing detect here would fire a detection with no captcha ticket, and the
  // server answers those with "Invalid request".
  page.editor.textContent = '第一段  \r\n  第二段';
  page.ZQ.autoDetect();

  assert.equal(page.clicks.length, 1, 'whitespace alone must not count as new text');
});

check('genuinely different text is still detected', () => {
  const page = load({ text: '原来的内容' });
  page.ZQ.autoDetect();
  page.editor.textContent = '改过的内容';
  page.ZQ.autoDetect();
  assert.equal(page.clicks.length, 2);
});

if (failures.length) {
  process.stdout.write(`\nFAIL: ${failures.length} of 12 checks\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\nPASS: 12/12 auto-detect checks\n');
}
