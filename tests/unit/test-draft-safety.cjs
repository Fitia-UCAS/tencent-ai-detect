// Regression tests for user text preservation. These cases run locally; no server calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../src/content/auto.js'), 'utf8');

function page({ text = '', editorPresent = true, onInput = null } = {}) {
    const storage = new Map();
    const editor = {
        textContent: text,
        focus() {},
        dispatchEvent(event) {
            if (onInput) onInput(this, event);
            return true;
        }
    };
    const document = {
        querySelector() { return editorPresent ? editor : null; },
        querySelectorAll() { return []; }
    };
    const sandbox = {
        document,
        localStorage: {
            getItem: key => storage.has(key) ? storage.get(key) : null,
            setItem: (key, value) => storage.set(key, String(value)),
            removeItem: key => storage.delete(key)
        },
        InputEvent: class InputEvent {
            constructor(type, options) { this.type = type; this.bubbles = options.bubbles; }
        },
        setInterval() { return 1; },
        clearInterval() {}
    };
    sandbox.window = sandbox;
    vm.runInNewContext(source, sandbox, { filename: 'auto.js' });
    return {
        editor, storage, sandbox, ZQ: sandbox.__zq,
        setEditorPresent(present) { editorPresent = present; }
    };
}

const tests = [
    ['saveDraft preserves leading, trailing, and internal whitespace', () => {
        const p = page({ text: '  第一段\n  第二段  ' });
        assert.equal(p.ZQ.saveDraft(), true);
        assert.equal(p.storage.get('zqDraft'), '  第一段\n  第二段  ');
    }],
    ['saveDraft ignores an editor containing only whitespace', () => {
        const p = page({ text: '\t \n  ' });
        assert.equal(p.ZQ.saveDraft(), false);
        assert.equal(p.storage.has('zqDraft'), false);
    }],
    ['restoreDraft retains backup until a missing editor appears', () => {
        const p = page({ editorPresent: false });
        p.storage.set('zqDraft', 'saved');
        assert.equal(p.ZQ.restoreDraft(), false);
        assert.equal(p.storage.get('zqDraft'), 'saved');
        p.setEditorPresent(true);
        assert.equal(p.ZQ.restoreDraft(), true);
        assert.equal(p.editor.textContent, 'saved');
        assert.equal(p.storage.has('zqDraft'), false);
    }],
    ['restoreDraft does not overwrite edits already in the editor', () => {
        const p = page({ text: 'user entered new text' });
        p.storage.set('zqDraft', 'older backup');
        assert.equal(p.ZQ.restoreDraft(), false);
        assert.equal(p.editor.textContent, 'user entered new text');
        assert.equal(p.storage.get('zqDraft'), 'older backup');
        p.editor.textContent = '';
        assert.equal(p.ZQ.restoreDraft(), false, 'clearing newer text must not resurrect old backup');
        assert.equal(p.editor.textContent, '');
        assert.equal(p.storage.get('zqDraft'), 'older backup');
    }],
    ['restoreDraft leaves backup when writing returns false', () => {
        const p = page();
        p.storage.set('zqDraft', 'saved');
        p.ZQ.writeEditor = () => false;
        assert.equal(p.ZQ.restoreDraft(), false);
        assert.equal(p.storage.get('zqDraft'), 'saved');
    }],
    ['restoreDraft leaves backup when a page input listener throws', () => {
        const p = page({ onInput() { throw Error('site handler failure'); } });
        p.storage.set('zqDraft', 'saved');
        assert.equal(p.ZQ.restoreDraft(), false);
        assert.equal(p.storage.get('zqDraft'), 'saved');
    }],
    ['restoreDraft leaves backup when the input listener clears the editor', () => {
        const p = page({ onInput(editor) { editor.textContent = ''; } });
        p.storage.set('zqDraft', 'saved');
        assert.equal(p.ZQ.restoreDraft(), false);
        assert.equal(p.storage.get('zqDraft'), 'saved');
    }],
    ['restoreDraft succeeds if the editor retained non-empty text', () => {
        const p = page({ onInput(editor) { editor.textContent = 'normalized text'; } });
        p.storage.set('zqDraft', 'original text');
        assert.equal(p.ZQ.restoreDraft(), true);
        assert.equal(p.editor.textContent, 'normalized text');
        assert.equal(p.storage.has('zqDraft'), false);
    }],
    ['restoreDraft never treats a blocked storage read as an empty success', () => {
        const p = page();
        p.sandbox.localStorage.getItem = () => { throw Error('blocked'); };
        assert.equal(p.ZQ.restoreDraft(), false);
    }]
];

let failures = 0;
for (const [name, run] of tests) {
    try {
        run();
        console.log('  ok    ' + name);
    } catch (error) {
        failures += 1;
        console.error('  FAIL  ' + name + ': ' + error.message);
    }
}
console.log(`\n${failures ? 'FAIL' : 'PASS'}: ${tests.length - failures}/${tests.length} draft safety checks`);
if (failures) process.exitCode = 1;
