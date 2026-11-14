// Guards the side panel's asset references.
//
// The panel's script was renamed during the directory move and the HTML kept pointing at the old
// name, so the script silently never loaded: the markup still rendered and every message that
// bypassed the panel still worked, which is exactly why a render-and-click check did not notice.
// This resolves every reference the document makes and fails when one is missing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const panelDir = path.join(__dirname, '..', '..', 'src', 'sidepanel');
const html = fs.readFileSync(path.join(panelDir, 'index.html'), 'utf8');

const resolved = [];
const missing = [];

for (const match of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) {
  resolved.push({ kind: 'script', ref: match[1] });
}
for (const match of html.matchAll(/<link[^>]*\bhref="([^"]+)"/g)) {
  resolved.push({ kind: 'stylesheet', ref: match[1] });
}
for (const match of html.matchAll(/<img[^>]*\bsrc="([^"]+)"/g)) {
  resolved.push({ kind: 'image', ref: match[1] });
}

for (const entry of resolved) {
  if (/^(https?:|data:|chrome-extension:)/.test(entry.ref)) continue;
  const target = path.resolve(panelDir, entry.ref);
  if (!fs.existsSync(target)) missing.push(`${entry.kind} "${entry.ref}"`);
}

assert.deepEqual(missing, [], `side panel references missing files: ${missing.join(', ')}`);

// The panel must actually load a script, otherwise its buttons would be inert markup.
assert.ok(
  resolved.some(entry => entry.kind === 'script'),
  'side panel must load a script'
);

// Inline styles belong in the stylesheet: the document is markup, not a place to park CSS.
assert.ok(!/<style[\s>]/.test(html), 'side panel must not embed a <style> block');
assert.ok(
  resolved.some(entry => entry.kind === 'stylesheet'),
  'side panel must link an external stylesheet'
);

const css = fs.readFileSync(path.join(panelDir, 'styles.css'), 'utf8');
assert.ok(css.includes('.brandbar'), 'stylesheet must carry the panel styles');

// Every icon the panel shows has to exist in the package.
const iconPath = path.join(panelDir, '..', '..', 'icon.png');
assert.ok(fs.existsSync(iconPath) || !html.includes('icon.png'), 'declared icon must exist');

// A native host that cannot start looks like a healthy idle panel, so the panel carries a banner
// for it. The ids below are the contract between the markup and the script: renaming either side
// silently disables the only place that explains why nothing works.
const script = fs.readFileSync(path.join(panelDir, 'index.js'), 'utf8');
for (const id of ['host-alert', 'host-alert-detail']) {
  assert.ok(html.includes(`id="${id}"`), `markup must define #${id}`);
  assert.ok(script.includes(`getElementById('${id}')`), `script must wire #${id}`);
}
assert.ok(css.includes('.host-alert'), 'stylesheet must style the host alert');

console.log(`PASS: ${resolved.length} side panel references resolve, styles are external`);
