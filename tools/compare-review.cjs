// Compares an external review patch against what this repository actually did.
//
// A review hands over suggestions in several shapes: a diff, a table of file/line findings, and
// prose recommendations. Diffing the patch alone answers only the first, and even that answer is
// easy to get wrong by eye once both sides have moved on. This script reconstructs the reviewed
// state from the base commit plus the patch, then answers three questions per file and per
// proposal:
//
//   * what did the patch change (mechanical, from the hunks)
//   * what does our HEAD have at that location (mechanical)
//   * did we take the proposal, take it further, or refuse it (asserted, not narrated)
//
// The third one is the part a plain diff cannot express, so each proposal carries probes: strings
// that must be present (or absent) in the reviewed code and in ours. A probe that fails is printed
// as a failure rather than quietly described as done - the report is only worth handing over if it
// can be wrong out loud.
//
//   node tools/compare-review.cjs --patch <file.diff> [--base <commit>] [--out <file.md>]
//
// The patch is applied in memory: the base content of each touched file is read from git, the
// hunks are replayed onto it, and nothing in the working tree is touched.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function git(args, options = {}) {
    return execFileSync('git', args, {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        ...options
    });
}

function arg(name, fallback) {
    const index = process.argv.indexOf('--' + name);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

// Where the patch probably is, so the common case needs no arguments.
function findPatch(explicit) {
    if (explicit) {
        if (!fs.existsSync(explicit)) throw new Error('patch not found: ' + explicit);
        return path.resolve(explicit);
    }

    const roots = [
        path.join(ROOT, 'review'),
        path.join(os.homedir(), 'Downloads'),
        path.join(os.homedir(), 'Desktop'),
        'D:/EdgeDownloads'
    ];

    const found = [];
    for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        for (const entry of fs.readdirSync(root)) {
            if (!/\.(diff|patch)$/i.test(entry)) continue;
            const full = path.join(root, entry);
            found.push({ full, at: fs.statSync(full).mtimeMs });
        }
    }

    if (!found.length) {
        throw new Error('no .diff/.patch found; pass --patch <file>');
    }

    found.sort((a, b) => b.at - a.at);
    return found[0].full;
}

// --- reading the patch --------------------------------------------------------

function parsePatch(text) {
    const files = [];
    let current = null;
    let hunk = null;

    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('diff --git ')) {
            const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
            if (!match) continue;
            current = { path: match[2], hunks: [], isNew: false };
            files.push(current);
            hunk = null;
            continue;
        }

        if (!current) continue;

        if (line.startsWith('new file mode')) {
            current.isNew = true;
            continue;
        }

        if (line.startsWith('deleted file mode')) {
            current.deleted = true;
            continue;
        }

        const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (header) {
            hunk = {
                oldStart: Number(header[1]),
                oldCount: header[2] === undefined ? 1 : Number(header[2]),
                newStart: Number(header[3]),
                newCount: header[4] === undefined ? 1 : Number(header[4]),
                lines: []
            };
            current.hunks.push(hunk);
            continue;
        }

        if (!hunk) continue;
        // A newline marker belongs to the previous line; a blank line is the end of the diff body.
        if (line.startsWith('\\') || line === '') continue;
        // The ending is dropped here too, so a body line and the base line it refers to compare
        // equal regardless of what the patch file used.
        if (line[0] === ' ' || line[0] === '+' || line[0] === '-') {
            hunk.lines.push(line.replace(/\r$/, ''));
        }
    }

    return files;
}

// Replays the hunks onto the base lines. Returns the reconstructed text and a count of context
// lines that did not match, which would mean the patch was cut against a different base.
function applyHunks(baseLines, hunks) {
    const out = [];
    let cursor = 0;
    let drift = 0;
    const errors = [];

    for (const hunk of hunks) {
        const oldSeen = hunk.lines.filter(line => line[0] === ' ' || line[0] === '-').length;
        const newSeen = hunk.lines.filter(line => line[0] === ' ' || line[0] === '+').length;

        if (oldSeen !== hunk.oldCount || newSeen !== hunk.newCount) {
            errors.push(
                `hunk -${hunk.oldStart},+${hunk.newStart}: header declares ${hunk.oldCount}/${hunk.newCount} lines, ` +
                `body contains ${oldSeen}/${newSeen}`
            );
        }

        // For a zero-length old range, oldStart is the number of lines before the insertion.
        // For a non-empty range, unified diff line numbers are one-based.
        const start = hunk.oldCount === 0 ? hunk.oldStart : Math.max(0, hunk.oldStart - 1);

        if (start < cursor) {
            errors.push(`hunk -${hunk.oldStart},+${hunk.newStart}: hunks overlap or are out of order`);
        }
        if (start > baseLines.length) {
            errors.push(`hunk -${hunk.oldStart},+${hunk.newStart}: old range starts beyond end of base`);
        }

        while (cursor < start && cursor < baseLines.length) out.push(baseLines[cursor++]);

        for (const line of hunk.lines) {
            const tag = line[0];
            const body = line.slice(1);

            if (tag === ' ') {
                if (cursor >= baseLines.length) {
                    errors.push(`hunk -${hunk.oldStart},+${hunk.newStart}: context extends beyond end of base`);
                    out.push(body);
                } else {
                    if (baseLines[cursor] !== body) drift += 1;
                    out.push(baseLines[cursor]);
                    cursor += 1;
                }
            } else if (tag === '-') {
                if (cursor >= baseLines.length) {
                    errors.push(`hunk -${hunk.oldStart},+${hunk.newStart}: deletion extends beyond end of base`);
                } else {
                    if (baseLines[cursor] !== body) drift += 1;
                    cursor += 1;
                }
            } else if (tag === '+') {
                out.push(body);
            }
        }
    }

    while (cursor < baseLines.length) out.push(baseLines[cursor++]);

    return { lines: out, drift, errors };
}

// Trailing CR is dropped: this tool compares content. The repo stores bytes exactly
// (gitattributes `* -text`), and a patch may carry CRLF on some lines and not others, so keeping
// the endings would report drift on every context line and bury the actual difference.
function splitLines(text) {
    return text.split('\n').map(line => line.replace(/\r$/, ''));
}

function readAt(commit, file) {
    try {
        return splitLines(git(['show', commit + ':' + file], { stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch (error) {
        return null;
    }
}

function readWorking(file) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) return null;
    // A proposal may name a directory (tests/unit/), which has no text of its own.
    if (!fs.statSync(full).isFile()) return null;
    return splitLines(fs.readFileSync(full, 'utf8'));
}

// Trailing blank lines are a difference in how the file ends, not in what it says. Comparing on the
// normalised form keeps a missing final newline from reporting a whole file as diverged.
function normalize(lines) {
    if (!lines) return lines;
    let end = lines.length;
    while (end > 0 && lines[end - 1] === '') end -= 1;
    return lines.slice(0, end);
}

function sameLines(a, b) {
    if (!a || !b) return a === b;
    const left = normalize(a);
    const right = normalize(b);
    if (left.length !== right.length) return false;
    return left.every((line, index) => line === right[index]);
}

function countChanged(before, after) {
    if (!after) return { added: 0, removed: 0 };
    if (!before) return { added: normalize(after).length, removed: 0 };

    before = normalize(before);

    // A cheap LCS would be overkill here: the numbers only need to say how much moved.
    const beforeSet = new Map();
    for (const line of before) beforeSet.set(line, (beforeSet.get(line) || 0) + 1);

    let added = 0;
    for (const line of normalize(after)) {
        const left = beforeSet.get(line) || 0;
        if (left > 0) beforeSet.set(line, left - 1);
        else added += 1;
    }

    let removed = 0;
    for (const count of beforeSet.values()) removed += count;

    return { added, removed };
}

function unified(before, after, file) {
    if (sameLines(before, after)) return '';

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-'));
    const left = path.join(dir, 'a.txt');
    const right = path.join(dir, 'b.txt');
    fs.writeFileSync(left, (before || []).join('\n'));
    fs.writeFileSync(right, (after || []).join('\n'));

    let text = '';
    try {
        text = execFileSync('git', ['diff', '--no-index', '--no-color', '-U2', '--', left, right], {
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024
        });
    } catch (error) {
        // git diff --no-index exits 1 when the files differ; the output is still on stdout.
        text = String(error.stdout || '');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // git names the files after the temp copies, and on Windows it quotes and escapes those paths.
    // Only the hunks are useful here, so the header is rebuilt with names that mean something.
    const body = text.split('\n').filter(line => !/^(diff --git |index |--- |\+\+\+ )/.test(line));

    return ['--- review/' + file, '+++ ours/' + file, ...body].join('\n');
}

// --- the proposals ------------------------------------------------------------
//
// One entry per recommendation the review made. `probe` describes what must be true in a given
// text for the claim to hold, so the table below is checked rather than asserted.
//
// verdict:
//   adopted             took it as offered
//   extended            took it and went further
//   rejected            declined, with the reason recorded
//   open                agreed with it but have not done it yet
const PROPOSALS = [
    {
        id: 'P0-1',
        file: 'src/content/index.js',
        topic: 'observe 改为观察 document，而不是 documentElement',
        verdict: 'adopted',
        claim: '审查方的判断：document_start 可能在 <html> 出现之前执行，observe() 会抛异常，后面整段初始化都不会跑。这个我没看到，已照改。',
        probe: { must: [/observer\.observe\(document,/] }
    },
    {
        id: 'P0-2',
        file: 'src/content/auto.js',
        topic: 'restoreDraft 不能在编辑器确认接收之前删掉备份',
        verdict: 'adopted',
        claim: '审查方的判断：原实现先 removeItem 再 writeEditor，编辑器尚未渲染时写入返回 false，但唯一的草稿副本已经删了。轮换刷新一次就吃掉用户文本。已照改。',
        probe: { must: [/if \(!ZQ\.writeEditor\(text\)\) return false;/] }
    },
    {
        id: 'P0-3',
        file: 'src/content/auto.js',
        topic: '编辑器已有内容时，整个页面加载期间都不再复活旧草稿',
        verdict: 'adopted',
        claim: '审查方的判断：用户清空刚输入的新文本后，后面的定时器仍可能把旧草稿写回来。原实现没有这个判断，已照改。',
        probe: { must: [/draftRestoreConflict/] }
    },
    {
        id: 'P0-4',
        file: 'src/content/auto.js',
        topic: 'saveDraft 存原始文本，不用会 trim 的 readEditor()',
        verdict: 'adopted',
        claim: '审查方的判断：readEditor() 会 trim，存进草稿的文本丢了首尾空白。已照改。',
        probe: { must: [/editor \? \(editor\.textContent \|\| ''\) : ''/] }
    },
    {
        id: 'P1-1',
        file: 'src/background/identity.js',
        topic: 'apply() 在 updateDynamicRules 完成前就报成功',
        verdict: 'extended',
        claim: '审查方标了高严重度，但自己的修改建议表里没有这一项。我们补完了：回复现在等到 getDynamicRules() 读回三条规则、逐个核对地址一致才发出，更新操作串行化（慢的早期更新无法覆盖后到的），并用 sync() 在 worker 重启后从浏览器实际持有的规则重建状态。sync() 后来也进了同一条队列，规则调用另加了超时，避免一次不回调把队列永久堵死。',
        probe: { must: [/addressFromRules/, /updateDynamicRulesAsync/, /enqueue/, /withTimeout/] }
    },
    {
        id: 'P1-2',
        file: 'src/background/messages.js',
        topic: 'setIdentity 不能为没核验过的更新回 success',
        verdict: 'extended',
        claim: '审查方的判断：消息处理器在更新完成前就可能返回成功。现在改成等读回核验之后再回，失败回 ignored 或 error，不再回 success。',
        probe: { must: [/\.then\(applied =>/] }
    },
    {
        id: 'P1-3',
        file: 'src/content/auto.js',
        topic: '规则被拒时应当停止点击，而不是只打日志',
        verdict: 'extended',
        claim: '审查方没提这一条，是 P1-2 的直接后果：identity.js 现在记录后台是否确认了规则，确认被拒时 autoDetect() 拒绝点击 —— 那个地址组合每次都会被服务端拒，点下去只是白烧一个地址。悬而未决时不拦，否则安装稍慢就会让自动化永久停摆。',
        probe: { must: [/identityConfirmed === false/] }
    },
    {
        id: 'P1-4',
        file: 'src/content/auto.js',
        topic: '按下按钮应记作"尝试"，而不是"已完成检测"',
        verdict: 'extended',
        claim: '审查方的判断：存的就是文本本身，等于宣称检测完成，实际只发生了一次点击。现在记录观察到的状态：submitted-unconfirmed / completed / blocked，并附带按下时的额度快照 —— 站点计数器下降是唯一能证明服务端受理过的信号。这几种状态都不允许自动重按。',
        probe: { must: [/submitted-unconfirmed/, /attemptState/, /q: currentQuota\(\)/] }
    },
    {
        id: 'P1-5',
        file: 'src/content/auto.js',
        topic: 'fingerprint() 改为只归一化换行符与 nbsp',
        verdict: 'rejected',
        claim: '驳回。实测的站点重渲染会把换行变成「空格 + CRLF + 空格」；只统一换行符，后面用于缩进的空格还在，两个指纹依然不同，草稿又会被判为新文本再点一次、这次没有票据。删除全部空白覆盖了实测形态；把「a b」和「ab」归为同一指纹只是少检一次重复内容。审查方后来也撤回了这条。',
        probe: { must: [/replace\(\/[^a-zA-Z]s\+/], mustNot: [/\u00a0/] }
    },
    {
        id: 'P1-6',
        file: 'src/background/identity.js',
        topic: 'COVERED_RESOURCE_TYPES 的注释声称"除 main_frame 外全覆盖"不准确',
        verdict: 'adopted',
        claim: '采纳了它建议的窄的那一半：注释改成说明这份列表覆盖的是本流程实际用到的类型，不再声称穷尽。webtransport / webbundle 没有加进规则 —— 这条链路不用这两个协议，加上只是扩大改动面。',
        probe: { must: [/webtransport and webbundle are also absent/] }
    },
    {
        id: 'P1-7',
        file: 'src/shim/index.js',
        topic: '连不上就静默切回原始地址，掩盖了传输失败',
        verdict: 'extended',
        claim: '由交付包实现：_fallback() 被删除，relay 在 open 之前失败时走 _failRelay() → _fail()，只派发一次终态 error 与 close，不再切回原始地址。我们在此基础上补了闭环 —— fail-closed 之后页面手里是一个死 socket，页面自己不会开第二个，所以 shim 用 zq:relay-failed 事件通知内容脚本：relay 真的挂了就走轮换路径（请求重连并自身重试），relay 还活着则每次页面加载只允许一次 reload，之后只上报，避免死循环。',
        probe: { must: [/_failRelay\(\)/, /zq:relay-failed/] }
    },
    {
        id: 'P1-7b',
        file: 'src/content/engine.js',
        topic: 'fail-closed 之后要有闭环，否则页面拿着死 socket 永远不恢复',
        verdict: 'extended',
        claim: '审查方没提这一条，是 P1-7 的直接后果。删掉 fallback 是对的，但页面自己不会重开 socket，relay 恢复后也只会一直瘫着。engine.js 现在监听 zq:relay-failed：relay 不在就交给轮换路径（请求重连 + 自身重试，恢复后 reload）；relay 还在则每次页面加载只允许一次 reload 然后只上报，避免变成刷新循环。',
        probe: { must: [/handleTransportFailure/, /transportRetried/] }
    },
    {
        id: 'P1-8',
        file: 'src/content/engine.js',
        topic: '额度耗尽时应当停止任务，而不是继续轮换',
        verdict: 'rejected',
        claim: '在这个项目里驳回。轮换就是被要求的行为：这个扩展存在的意义就是不让用户点任何按钮地保持额度可用。审查方的替代方案适合普通自动化，不适合这一个。',
        probe: { must: [/ZQ\.rotate\(reason\);/] }
    },
    {
        id: 'P1-9',
        file: 'src/background/identity.js',
        topic: '三条动态规则是全局的，不按标签页隔离',
        verdict: 'open',
        claim: '同意。规则确实没有 tab 条件，同时开两个检测页会互相覆盖地址。代码没改：这个扩展是单标签页使用的，做标签页级规则还要配 sessionRuleIds 和标签页生命周期清理。限制本身写进了 README 的「已知限制」，包括将来要支持多标签页需要 updateSessionRules + tabIds 并跟踪标签页生命周期。',
        probe: { must: [/IDENTITY_RULE_ID/], mustNot: [/tabIds/] }
    },
    {
        id: 'P2-1',
        file: 'tests/unit/',
        topic: '补 DOM 未就绪、存储失败、重复提交、双标签页的回归测试',
        verdict: 'extended',
        claim: '四条里覆盖了三条：test-document-start.cjs、test-draft-safety.cjs（九个存储与写入失败场景）、以及 test-auto-detect.cjs 里的提交状态用例。双标签页仍无覆盖，与 P1-9 一致。',
        probe: { files: ['tests/unit/test-document-start.cjs', 'tests/unit/test-draft-safety.cjs'] }
    },
    {
        id: 'P1-10',
        file: 'src/content/engine.js',
        topic: 'localStorage 读写失败时，跨页面 reload 预算失效',
        verdict: 'extended',
        claim: '审查方发现了这条，修的是故障路径（读写异常、记录损坏、时间戳异常一律 fail-closed）。但预算仍放在网站 origin 的 localStorage 里 —— 那一份是页面自己能清的，所以"扩展控制"这半个要求没做到。已迁到 chrome.storage.local，读写失败与回读不一致同样 fail-closed。',
        probe: { must: [/chrome\.storage\.local/, /validBudget/, /recordTransportReload/], mustNot: [/localStorage\.setItem\(ZQ\.TRANSPORT_RELOAD_KEY/] }
    },
    {
        id: 'P1-11',
        file: 'src/content/auto.js',
        topic: '计数器下降不能证明本次检测完成，不该叫 completed',
        verdict: 'adopted',
        claim: '审查方的判断：页面显示的额度下降无法归因到这一次请求，没有请求 ID 就没有因果关系。这个判据是我自己找的，也确实撑不住，已改成 quota-decrement-observed，旧记录按观察态读，重复提交防护不变。',
        probe: { must: [/quota-decrement-observed/], mustNot: [/settled = 'completed'/] }
    },
    {
        id: 'P1-12',
        file: 'src/content/engine.js',
        topic: '站点 SDK 是否会自己重连，没验证前不该再叠加一套 reload',
        verdict: 'extended',
        claim: '审查方要求先被动观测。已经实测（tools/diagnostics/diag-sdk-reconnect.cjs，不杀本机 relay）：页面加载时会自己建一个 socket，把它关掉之后 30 秒内没有出现第二个，页面也没有自行刷新。所以没有 SDK 重连可依赖，reload 是唯一的恢复手段，保留。',
        probe: { files: ['tools/diagnostics/diag-sdk-reconnect.cjs'] }
    },
    {
        id: 'P1-13',
        file: 'src/background/identity.js',
        topic: 'sync() 与 apply() 没有统一串行化',
        verdict: 'adopted',
        claim: '审查方的判断成立：sync() 在队列外直接读规则，worker 重启时若排在一次 apply 之后完成，会把旧地址写回 current，下一次发布就会跳过一次本该做的更新。已让 sync() 进同一条队列，并给规则调用加超时，避免一次不回调把队列永久堵死。',
        probe: { must: [/function enqueue/, /withTimeout/, /sync\(\) \{\s*return enqueue/] }
    }
];

function runProbe(proposal, text, fileSet) {
    const probe = proposal.probe || {};

    if (probe.files) {
        const missing = probe.files.filter(file => !fileSet.has(file));
        return missing.length ? 'missing file(s): ' + missing.join(', ') : null;
    }

    if (!text) return 'no such file';

    for (const pattern of probe.must || []) {
        if (!pattern.test(text)) return 'expected ' + pattern + ' in ' + proposal.file;
    }

    for (const pattern of probe.mustNot || []) {
        if (pattern.test(text)) return 'did not expect ' + pattern + ' in ' + proposal.file;
    }

    return null;
}

// A file probe compares two snapshots, not just the current disk. Checking fs.existsSync inside
// runProbe falsely gave the reviewed patch credit for files added only by our later commits.
function probeFileSets(proposals, patchFiles, existsAtBase, existsWorking) {
    const changes = new Map(patchFiles.map(file => [file.path, file]));
    const referenced = new Set(proposals.flatMap(proposal => (proposal.probe || {}).files || []));
    const theirs = new Set();
    const ours = new Set();

    for (const file of referenced) {
        const change = changes.get(file);
        if (change ? !change.deleted : existsAtBase(file)) theirs.add(file);
        if (existsWorking(file)) ours.add(file);
    }

    return { theirs, ours };
}

// The unresolved section must come from the same verdicts as the proposal table. Keeping a
// handwritten list here once made a completed shim fix appear as still open even while all probes
// passed. New or resolved proposals now update the section without a second manual edit.
function openIssueLines(proposals) {
    const open = proposals.filter(proposal => proposal.verdict === 'open');
    if (!open.length) return ['目前没有标记为“同意但未做”的事项。'];

    return [
        `当前有 ${open.length} 项标记为“同意但未做”：`,
        '',
        ...open.map(proposal => `- ${proposal.id} \`${proposal.file}\`：${proposal.topic}`)
    ];
}

// --- the report ---------------------------------------------------------------

function main() {
    const patchPath = findPatch(arg('patch'));
    const base = arg('base', '8e39d72');
    const head = git(['rev-parse', '--short', 'HEAD']).trim();
    const out = arg('out', path.join(os.homedir(), 'Desktop', 'tencent-ai-detect-比对报告.md'));

    const patchFiles = parsePatch(fs.readFileSync(patchPath, 'utf8'));
    if (!patchFiles.length) throw new Error('the patch has no file sections: ' + patchPath);

    // Their state: the base content with their hunks replayed onto it.
    const theirs = new Map();
    let drift = 0;
    const hunkErrors = [];
    for (const file of patchFiles) {
        const baseLines = file.isNew ? [] : readAt(base, file.path);
        if (baseLines === null) {
            theirs.set(file.path, { lines: null, error: 'not in ' + base });
            continue;
        }
        const applied = applyHunks(baseLines, file.hunks);
        drift += applied.drift;
        for (const error of applied.errors) hunkErrors.push(file.path + ': ' + error);
        theirs.set(file.path, { lines: applied.lines, baseLines });
    }

    const ours = new Map();
    const fileSet = new Set();
    for (const file of patchFiles) {
        const lines = readWorking(file.path);
        ours.set(file.path, lines);
        if (lines) fileSet.add(file.path);
    }

    // Files we changed that the patch never mentioned, so the table shows both directions.
    const changedByUs = git(['diff', '--name-only', base + '..HEAD']).split('\n').filter(Boolean);

    const rows = [];
    for (const file of patchFiles) {
        const baseLines = theirs.get(file.path).baseLines || null;
        const theirLines = theirs.get(file.path).lines;
        const ourLines = ours.get(file.path);

        const theirChange = countChanged(baseLines, theirLines);
        const ourChange = countChanged(baseLines, ourLines);

        let state;
        if (sameLines(theirLines, ourLines)) state = 'identical';
        else if (sameLines(ourLines, baseLines)) state = 'not applied';
        else if (sameLines(theirLines, baseLines)) state = 'we only';
        else state = 'diverged';

        rows.push({ file: file.path, state, theirChange, ourChange, baseLines, theirLines, ourLines });
    }

    const extra = changedByUs.filter(file => !theirs.has(file));

    const { theirs: theirFiles, ours: ourFiles } = probeFileSets(
        PROPOSALS, patchFiles,
        file => readAt(base, file) !== null,
        file => fs.existsSync(path.join(ROOT, file))
    );

    const probeResults = PROPOSALS.map(proposal => {
        // Probes may point at files the patch never touched: the review's findings were spread over
        // the whole worker, while its patch only carried four files.
        const ourCache = new Map();
        function workingText(file) {
            if (!ourCache.has(file)) ourCache.set(file, readWorking(file) ? readWorking(file).join('\n') : null);
            return ourCache.get(file);
        }

        const theirText = proposal.probe && proposal.probe.files
            ? null
            : (theirs.has(proposal.file) && theirs.get(proposal.file).lines
                ? theirs.get(proposal.file).lines.join('\n')
                : readAt(base, proposal.file) ? readAt(base, proposal.file).join('\n') : null);
        const ourText = proposal.probe && proposal.probe.files ? null : workingText(proposal.file);

        return {
            proposal,
            theirFailure: runProbe(proposal, theirText, theirFiles),
            ourFailure: runProbe(proposal, ourText, ourFiles)
        };
    });

    const commits = git(['log', '--oneline', base + '..HEAD']).split('\n').filter(Boolean);

    const md = [];
    md.push('# 外部审查与本地实现的对比');
    md.push('');
    md.push('这份报告由 `tools/compare-review.cjs` 生成，可以随时重跑：脚本从 base 提交取出被改文件的原内容，在内存里重放外部补丁的每个 hunk 得到"审查方改完的样子"，再与当前工作树逐文件、逐提议对比。工作树不会被改动。');
    md.push('');
    md.push('| 项目 | 值 |');
    md.push('|---|---|');
    md.push('| 对比基准（补丁的 base） | `' + base + '` |');
    md.push('| 补丁文件 | `' + path.basename(patchPath) + '` |');
    md.push('| 当前 HEAD | `' + head + '` |');
    md.push('| 补丁涉及文件 | ' + patchFiles.length + ' |');
    md.push('| 我们还改了、补丁没提的文件 | ' + extra.length + ' |');
    md.push('| hunk 重放时的上下文不匹配行数 | ' + drift + (drift ? '（补丁可能不是切在这个 base 上）' : '（补丁与 base 一致）') + ' |');
    md.push('| hunk 结构错误 | ' + hunkErrors.length + ' |');
    md.push('');

    if (hunkErrors.length) {
        md.push('### Hunk 结构校验失败');
        md.push('');
        for (const error of hunkErrors) md.push('- ' + error);
        md.push('');
    }

    md.push('## 一、文件级对比');
    md.push('');
    md.push('`identical` = 我们和审查方改出了同样的内容；`diverged` = 双方都改了这个文件但结果不同；`not applied` = 我们没动；`we only` = 审查方没动我们动了。');
    md.push('');
    md.push('| 文件 | 状态 | 审查方 ± | 我们 ± |');
    md.push('|---|---|---:|---:|');
    for (const row of rows) {
        md.push('| `' + row.file + '` | ' + row.state + ' | +' + row.theirChange.added + ' / −' + row.theirChange.removed +
            ' | +' + row.ourChange.added + ' / −' + row.ourChange.removed + ' |');
    }
    md.push('');

    if (extra.length) {
        md.push('补丁之外我们另外改的文件：');
        md.push('');
        for (const file of extra) md.push('- `' + file + '`');
        md.push('');
    }

    md.push('## 二、逐条提议的裁定');
    md.push('');
    md.push('每条裁定都挂着一个探针：在"审查方改完的样子"和"我们的代码"里各跑一次。探针失败会打印出来，所以这张表可以被证明是错的，而不是只凭我这么说。');
    md.push('');
    const label = {
        adopted: '采纳',
        extended: '采纳并推进',
        rejected: '驳回',
        open: '同意但未做'
    };
    md.push('| # | 文件 | 提议 | 裁定 | 我们的代码通过探针 | 审查方补丁通过探针 |');
    md.push('|---|---|---|---|---|---|');
    for (const result of probeResults) {
        const p = result.proposal;
        md.push('| ' + p.id + ' | `' + p.file + '` | ' + p.topic + ' | ' + label[p.verdict] +
            ' | ' + (result.ourFailure ? 'FAIL — ' + result.ourFailure : 'PASS') +
            ' | ' + (result.theirFailure ? '未包含（' + result.theirFailure + '）' : 'PASS') + ' |');
    }
    md.push('');

    md.push('## 三、每条的理由');
    md.push('');
    for (const result of probeResults) {
        const p = result.proposal;
        md.push('### ' + p.id + '　' + p.topic);
        md.push('');
        md.push('裁定：**' + label[p.verdict] + '**');
        md.push('');
        md.push(p.claim);
        md.push('');
    }

    const failures = probeResults.filter(result => result.ourFailure);
    md.push('## 四、我们自己跑探针的结果');
    md.push('');
    if (failures.length) {
        md.push('有 ' + failures.length + ' 条没有通过，说明这张表和代码不一致，需要先修代码或修表：');
        md.push('');
        for (const result of failures) {
            md.push('- ' + result.proposal.id + ' `' + result.proposal.file + '`：' + result.ourFailure);
        }
    } else {
        md.push('全部 ' + probeResults.length + ' 条探针通过：表里每一句关于"我们做了什么"的说法，都能在代码里找到对应物。');
    }
    md.push('');

    md.push('## 五、仍未解决的部分');
    md.push('');
    md.push(...openIssueLines(PROPOSALS));
    md.push('');

    md.push('## 六、附：每个有分歧的文件的实际差异');
    md.push('');
    md.push('左边是审查方补丁后的样子，右边是我们现在的代码。');
    md.push('');
    for (const row of rows) {
        if (row.state === 'identical') continue;
        md.push('### `' + row.file + '`　' + row.state);
        md.push('');
        const diff = unified(row.theirLines, row.ourLines, row.file);
        if (!diff.trim()) {
            md.push('（无差异）');
        } else {
            md.push('```diff');
            md.push(diff.trimEnd());
            md.push('```');
        }
        md.push('');
    }

    if (commits.length) {
        md.push('## 七、base 之后的提交');
        md.push('');
        md.push('```');
        for (const line of commits) md.push(line);
        md.push('```');
        md.push('');
    }

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, md.join('\n'), 'utf8');

    console.log('base      ', base);
    console.log('head      ', head);
    console.log('patch     ', patchPath);
    console.log('files     ', patchFiles.length, 'in patch,', extra.length, 'changed by us only');
    console.log('proposals ', probeResults.length - failures.length, '/', probeResults.length, 'probes pass');
    console.log('report    ', out);

    if (failures.length || hunkErrors.length) {
        for (const result of failures) {
            console.error('  FAIL ' + result.proposal.id + ': ' + result.ourFailure);
        }
        for (const error of hunkErrors) console.error('  HUNK FAIL ' + error);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error('compare failed: ' + (error && error.message ? error.message : error));
        process.exitCode = 1;
    }
}

module.exports = { parsePatch, applyHunks, openIssueLines, runProbe, probeFileSets };
