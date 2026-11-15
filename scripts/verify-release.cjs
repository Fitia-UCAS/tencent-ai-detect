// Checks a built release archive as an installer would meet it: extracted, then every script parsed.
//
// A zip whose layout is right can still be broken inside - a syntax error in a content script means
// the extension loads, shows its panel and does nothing, which is the failure the packer exists to
// prevent. Parsing is the cheapest way to fail here rather than at the user.
//
// Extraction uses scripts/zip-reader.cjs rather than an external tool, so this runs identically on
// the Windows checkout and on the Ubuntu runner that builds the release.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { extractZip } = require('./zip-reader.cjs');

const archive = process.argv[2];
if (!archive) {
    process.stderr.write('usage: verify-release.cjs <archive.zip>\n');
    process.exit(2);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zq-verify-'));

try {
    extractZip(archive, dir);

    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        process.stderr.write('manifest.json is not at the root of the archive\n');
        process.exit(1);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const problems = [];

    // Everything the manifest names has to exist after extraction, not just in the archive listing.
    const named = [];
    for (const size of Object.keys(manifest.icons || {})) named.push(manifest.icons[size]);
    for (const size of Object.keys((manifest.action && manifest.action.default_icon) || {})) {
        named.push(manifest.action.default_icon[size]);
    }
    named.push(manifest.side_panel.default_path);
    named.push(manifest.background.service_worker);
    for (const entry of manifest.content_scripts || []) {
        named.push(...(entry.js || []));
        named.push(...(entry.css || []));
    }

    for (const file of new Set(named)) {
        if (!fs.existsSync(path.join(dir, file))) problems.push('missing after extraction: ' + file);
    }

    // The side panel's own assets are referenced from its HTML, not from the manifest.
    const panelHtml = path.join(dir, manifest.side_panel.default_path);
    if (fs.existsSync(panelHtml)) {
        const html = fs.readFileSync(panelHtml, 'utf8');
        for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
            const ref = match[1];
            if (/^(https?:|data:|#)/.test(ref)) continue;
            const resolved = path.resolve(path.dirname(panelHtml), ref);
            if (!fs.existsSync(resolved)) problems.push('panel asset missing: ' + ref);
        }
    }

    // Classify by how the browser will load it: package.json says "type": "module", so a .js file is
    // a module and a .cjs is not.
    const scripts = [];
    const walk = current => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(absolute);
            } else if (/\.(js|cjs)$/.test(entry.name)) {
                scripts.push({ absolute, module: entry.name.endsWith('.js') });
            }
        }
    };
    walk(path.join(dir, 'src'));

    for (const { absolute, module } of scripts) {
        const source = fs.readFileSync(absolute, 'utf8');
        const label = path.relative(dir, absolute).replace(/\\/g, '/');

        try {
            if (module) {
                // Parsed as a module without being executed: this is the same syntax check the
                // browser performs when it loads the content script.
                new vm.SourceTextModule(source, { identifier: label });
            } else {
                new vm.Script(source, { filename: label });
            }
        } catch (error) {
            const message = /SourceTextModule is not a constructor/.test(String(error.message))
                ? 'needs --experimental-vm-modules to check modules'
                : error.message;
            problems.push('will not parse: ' + label + ' - ' + message);
        }
    }

    const total = fs.readdirSync(dir, { recursive: true }).filter(name => {
        try {
            return fs.statSync(path.join(dir, name)).isFile();
        } catch (_) {
            return false;
        }
    }).length;

    process.stdout.write('version   : ' + manifest.version + '\n');
    process.stdout.write('files     : ' + total + '\n');
    process.stdout.write('scripts   : ' + scripts.length + ' parsed\n');

    if (problems.length) {
        process.stderr.write('\n' + problems.length + ' problem(s):\n');
        for (const problem of problems) process.stderr.write('  ' + problem + '\n');
        process.exitCode = 1;
    } else {
        process.stdout.write('\nOK: the archive extracts to a loadable extension\n');
    }
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
