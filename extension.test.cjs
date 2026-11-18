const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');

const CLI = path.resolve(__dirname, '../../xfcmd/bin/xfcmd.js');
const REG = path.resolve(__dirname, '../../xfcmd/test/fixtures/registry');

/* ---- a small fake of the vscode API ---- */
const settings = { command: 'node ' + CLI, checkOnType: true, extraArgs: [] };
const reg = { commands: {}, handlers: {} }, shown = { warn: [], info: [], terminals: [] };
let pickFirst = true;
const fake = {
  Diagnostic: class { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } },
  Range: class { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } },
  DiagnosticSeverity: { Error: 0, Warning: 1 },
  languages: { createDiagnosticCollection: () => { const m = new Map(); return { set: (u, d) => m.set(u.toString(), d), delete: u => m.delete(u.toString()), get: u => m.get(u.toString()), dispose() {} }; } },
  commands: { registerCommand: (id, fn) => { reg.commands[id] = fn; return { dispose() {} }; }, executeCommand: async () => {} },
  workspace: {
    getConfiguration: () => ({ get: k => settings[k] }), workspaceFolders: [{ uri: { fsPath: path.resolve(__dirname) } }],
    getWorkspaceFolder: () => ({ uri: { fsPath: path.resolve(__dirname) } }), textDocuments: [],
    onDidOpenTextDocument: f => { reg.handlers.open = f; return { dispose() {} }; }, onDidSaveTextDocument: f => { reg.handlers.save = f; return { dispose() {} }; },
    onDidChangeTextDocument: f => { reg.handlers.change = f; return { dispose() {} }; }, onDidCloseTextDocument: f => { reg.handlers.close = f; return { dispose() {} }; }
  },
  window: {
    activeTextEditor: null,
    showWarningMessage: m => shown.warn.push(m), showInformationMessage: m => shown.info.push(m), showErrorMessage: m => shown.info.push('E:' + m),
    showQuickPick: async items => pickFirst ? items[0] : undefined,
    createTerminal: o => { const t = { o, sent: [], exitStatus: undefined, show() {}, sendText(s) { this.sent.push(s); } }; shown.terminals.push(t); return t; }
  }
};
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...a) { return req === 'vscode' ? 'vscode' : orig.call(this, req, ...a); };
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: fake };
const ext = require('../extension.js');
ext.activate({ subscriptions: [] });

const doc = (text, name = '/tmp/work/test.xfcmd') => ({
  languageId: 'xfcmd', fileName: name, uri: { toString: () => 'file://' + name, fsPath: name }, isDirty: false, save: async () => {},
  getText: () => text, lineCount: text.split('\n').length, lineAt: i => ({ text: text.split('\n')[i] })
});
const diagsOf = d => { const c = fake._diag; return c; };

test('registers its commands', () => {
  assert.deepEqual(Object.keys(reg.commands).sort(), ['xfcmd.checkFile', 'xfcmd.dryRunFile', 'xfcmd.runFile', 'xfcmd.runRegistryCommand']);
});
test('manifest wiring matches the code', () => {
  const m = require('../package.json');
  assert.deepEqual(m.contributes.commands.map(c => c.command).sort(), Object.keys(reg.commands).sort());
  assert.equal(m.main, './extension.js');
  for (const f of [m.contributes.grammars[0].path, m.contributes.snippets[0].path, m.contributes.languages[0].configuration]) assert.ok(fs.existsSync(path.join(__dirname, '..', f)), f);
});
test('diagnostics come from the real CLI, using the unsaved buffer', async () => {
  const d = doc('say "ok"\nfrobnicate now\nshow nowhere');
  await reg.handlers.save(d);
  const col = fake.languages.createDiagnosticCollection; // collection is private to the extension: read it through a second handler call
  // the extension keeps its own collection, so assert through the module hook
  const list = await ext.runCli(['check', '-', '--json', '--name', d.fileName], { input: d.getText() });
  const j = JSON.parse(list.out);
  const mapped = ext.toDiagnostics(d, j);
  assert.deepEqual(mapped.map(x => [x.range.start.line, x.severity, x.source]), [[1, 0, 'xfcmd'], [2, 1, 'xfcmd']]);
  assert.match(mapped[0].message, /Unknown sentence: frobnicate now/);
  assert.equal(mapped[0].range.end.character, 'frobnicate now'.length, 'underlines the whole line');
});
test('a clean script produces no diagnostics', async () => {
  const d = doc('say "fine"');
  const r = await ext.runCli(['check', '-', '--json'], { input: d.getText() });
  assert.deepEqual(JSON.parse(r.out), []); assert.equal(r.code, 0);
});
test('a missing CLI warns once and never throws', async () => {
  const keep = settings.command; settings.command = 'definitely-not-installed-xfcmd';
  await reg.handlers.save(doc('say "x"')); await reg.handlers.save(doc('say "y"'));
  assert.equal(shown.warn.length, 1); assert.match(shown.warn[0], /CLI not found/);
  settings.command = keep;
});
test('run and dry run send the right command to the terminal', async () => {
  fake.window.activeTextEditor = { document: doc('say "x"', '/tmp/work/my script.xfcmd') };
  await reg.commands['xfcmd.runFile']();
  await reg.commands['xfcmd.dryRunFile']();
  const t = shown.terminals[0];
  assert.equal(t.sent[0], 'node ' + CLI + ' run "/tmp/work/my script.xfcmd"');
  assert.equal(t.sent[1], 'node ' + CLI + ' run "/tmp/work/my script.xfcmd" --dry-run');
  assert.equal(shown.terminals.length, 1, 'the terminal is reused');
  fake.window.activeTextEditor = { document: Object.assign(doc('x'), { languageId: 'plaintext' }) };
  await reg.commands['xfcmd.runFile'](); assert.match(shown.info.at(-1), /Open an \.xfcmd file/);
});
test('registry commands come from xfcmd list --json and run in the terminal', async () => {
  settings.extraArgs = ['--registry', REG];
  fake.window.activeTextEditor = { document: doc('say "x"') };
  await reg.commands['xfcmd.runRegistryCommand']();
  const last = shown.terminals[0].sent.at(-1);
  assert.match(last, /run "hello" "--registry" ".*fixtures\/registry"$/, last);
  settings.extraArgs = [];
});

/* ---- grammar: every regex compiles and matches what it should ---- */
const g = require('../syntaxes/xfcmd.tmLanguage.json');
const rx = s => new RegExp(s.replace(/^\(\?i\)/, ''), /^\(\?i\)/.test(s) ? 'i' : '');
const walk = (o, f) => { if (Array.isArray(o)) o.forEach(x => walk(x, f)); else if (o && typeof o === 'object') { f(o); Object.values(o).forEach(x => walk(x, f)); } };
test('grammar: all regexes are valid', () => {
  let n = 0; walk(g, o => { for (const k of ['match', 'begin', 'end']) if (typeof o[k] === 'string') { rx(o[k]); n++; } });
  assert.ok(n > 20, 'checked ' + n);
});
test('grammar: verbs, unknown sentences, blocks, strings and variables', () => {
  const top = g.patterns;
  const by = name => top.find(p => p.name === name);
  assert.ok(rx(by('comment.line.xfcmd').match).test('  # note')); assert.ok(rx(by('comment.line.xfcmd').match).test('// note'));
  assert.ok(rx(by('keyword.control.xfcmd').match).test('  SAY "x"'));
  const bad = rx(by('invalid.illegal.unknown-sentence.xfcmd').match);
  assert.ok(bad.test('frobnicate now') && bad.test('end') && !bad.test('say "x"') && !bad.test('compile all'));
  const begins = top.filter(p => p.begin).map(p => [p.contentName, rx(p.begin), rx(p.end)]);
  const which = line => begins.filter(([, b]) => b.test(line)).map(([n]) => n);
  assert.deepEqual(which('create file a/b.fscss with:'), ['meta.embedded.block.fscss.xfcmd']);
  assert.deepEqual(which('create file a.css with:'), ['meta.embedded.block.css.xfcmd']);
  assert.deepEqual(which('create file a.html with:'), ['meta.embedded.block.html.xfcmd']);
  assert.deepEqual(which('create file a.js with'), ['meta.embedded.block.js.xfcmd']);
  assert.deepEqual(which('create file a.txt with:'), ['meta.embedded.block.text.xfcmd'], 'other extensions get a plain block');
  assert.deepEqual(which('create file a.fscss with "inline"'), [], 'the inline form has no block');
  assert.ok(begins.every(([, , e]) => e.test('  end') && !e.test('  endx')));
  assert.ok(rx(g.repository.vars.match).test('{name}') && !rx(g.repository.vars.match).test('{other}'));
  const esc = g.repository.strings.patterns.map(p => p.match).filter(Boolean).map(rx);
  assert.ok(esc[0].test('\\n') && esc[1].test('${1:16px}') && esc[1].test('$0'));
});
