// Verifies the exhausted-quota page is recognised from the wording it actually uses.
//
// The site's counter is part of the detect button and changes as the count falls, ending as
// "今日次数已用完". The previous check enumerated four fixed phrases, none of which is that
// wording, so an empty allowance read as Ready and no rotation ever started. These cases pin the
// detection to the forms the site really renders, including the one taken from a live page.
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');

const CONTENT_DIR = path.join(__dirname, '..', '..', 'src', 'content');
const SOURCES = ['core.js', 'detection.js', 'engine.js', 'index.js'].map(name => ({
  name: 'src/content/' + name,
  text: require('node:fs').readFileSync(path.join(CONTENT_DIR, name), 'utf8')
}));

// Builds the content namespace with a given body text. Only detection is exercised, so the rest of
// the chrome surface stays inert.
function load(bodyText) {
  const sandbox = {
    window: {},
    document: {
      body: { innerText: bodyText },
      documentElement: {},
      addEventListener() {},
      querySelectorAll() { return []; },
      cookie: ''
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { reload() {} },
    chrome: {
      runtime: {
        lastError: undefined,
        sendMessage() { return Promise.resolve(null); },
        onMessage: { addListener() {} }
      },
      storage: { local: { get() {}, set() {} }, onChanged: { addListener() {} } }
    },
    MutationObserver: function () { this.observe = () => {}; },
    setTimeout, clearTimeout, setInterval, clearInterval, console, Date, Promise
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const source of SOURCES) {
    vm.runInContext(source.text, sandbox, { filename: source.name });
  }

  // index.js starts the rotation watchdog, whose interval would keep this process alive. The
  // cases here only exercise detection, so the timer is torn down before returning.
  if (sandbox.window.__zq && typeof sandbox.window.__zq.stopWatchdog === 'function') {
    sandbox.window.__zq.stopWatchdog();
  }

  return sandbox.window.__zq;
}

const checks = [];
const check = (name, fn) => {
  try {
    fn();
    checks.push(true);
    console.log('  ok    ' + name);
  } catch (error) {
    checks.push(false);
    console.log('  FAIL  ' + name + ' — ' + error.message);
  }
};

// The live page as the user saw it: button reads 立即检测(今日剩余5次) while the allowance stands.
{
  const zq = load('上传 清空 立即检测(今日剩余5次) 人工创作特征较弱');
  check('a live counter of 5 reads as ok with the count parsed', () => {
    assert.equal(zq.pageState(), 'ok');
    assert.deepEqual({ ...zq.readQuota() }, { remaining: 5, exhausted: false });
  });
}

// The exact wording from the reported failure: the button says the allowance is gone.
{
  const zq = load('上传 清空 今日次数已用完 赞/踩可获取奖励次数');
  check('the exhausted button wording is treated as exhausted', () => {
    assert.equal(zq.pageState(), 'quota');
    assert.equal(zq.readQuota().exhausted, true);
  });
}

// A counter that reached zero is exhausted even though the wording differs from the above.
{
  const zq = load('立即检测(今日剩余0次)');
  check('a counter of zero reads as exhausted', () => {
    assert.equal(zq.pageState(), 'quota');
    assert.equal(zq.readQuota().remaining, 0);
  });
}

// The wordings carried over from before must keep working.
{
  for (const [text, name] of [
    ['今日免费次数已用完', 'free-allowance-exhausted wording'],
    ['已达到今日免费检测次数', 'daily-limit-reached wording'],
    ['今日剩余次数：0', 'zero-remaining with full-width colon'],
    ['今日剩余次数:0', 'zero-remaining with half-width colon'],
    ['本额度已用完', 'allowance-exhausted variant'],
    ['检测次数用尽', 'attempts-used-up variant']
  ]) {
    const zq = load(text);
    check('still exhausted: ' + name, () => assert.equal(zq.pageState(), 'quota'));
  }
}

// An opaque refusal is not a quota signal: rotating on it reloads in a loop while the real cause
// is an unsolved captcha, which rotation can never fix.
{
  const zq = load('Invalid request');
  check('Invalid request stays ambiguous, not quota', () => {
    assert.equal(zq.pageState(), 'ambiguous');
    assert.equal(zq.readQuota().exhausted, false);
  });
}

{
  const zq = load('验证失败，请完成验证');
  check('a captcha failure is reported as captcha', () => {
    assert.equal(zq.pageState(), 'captcha');
  });
}

// A stale exhausted sentence elsewhere on the page must not outvote a live positive counter.
{
  const zq = load('今日免费次数已用完 立即检测(今日剩余3次)');
  check('a live positive counter wins over stale exhausted wording', () => {
    assert.equal(zq.pageState(), 'ok');
    assert.equal(zq.readQuota().remaining, 3);
  });
}

// No counter at all: status is ok and the count is unknown rather than zero.
{
  const zq = load('上传 清空 立即检测');
  check('a page with no counter reports ok and no count', () => {
    assert.equal(zq.pageState(), 'ok');
    assert.equal(zq.readQuota().remaining, null);
  });
}

// The state object handed to the panel carries the count through.
{
  const zq = load('立即检测(今日剩余4次)');
  check('the reported state carries the remaining count', () => {
    assert.equal(zq.currentState('ok').remaining, 4);
  });
}

const failed = checks.filter(ok => !ok).length;
console.log('');
if (failed) {
  console.error(`${failed}/${checks.length} quota wording checks failed`);
  process.exitCode = 1;
} else {
  console.log(`PASS: ${checks.length}/${checks.length} quota wording checks`);
}
