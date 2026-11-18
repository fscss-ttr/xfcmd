/* xfcmd for VS Code. A thin wrapper: grammar, snippets and the problem matcher are static,
   and everything else calls the xfcmd CLI (npm i -g xfcmd, or set xfcmd.command to "npx xfcmd"). */
const vscode = require('vscode');
const cp = require('child_process');

let diagnostics, terminal, warnedMissing = false;
const timers = new Map();

const config = () => vscode.workspace.getConfiguration('xfcmd');
const folderOf = doc => (vscode.workspace.getWorkspaceFolder && doc && vscode.workspace.getWorkspaceFolder(doc.uri))?.uri.fsPath
  || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const quote = s => '"' + String(s).replace(/"/g, '\\"') + '"';

/* run the CLI and collect its output. input is sent to stdin (used for unsaved buffers). */
function runCli(args, { cwd, input } = {}) {
  return new Promise(resolve => {
    const [cmd, ...pre] = String(config().get('command') || 'xfcmd').trim().split(/\s+/);
    let out = '', err = '', child;
    try { child = cp.spawn(cmd, [...pre, ...args], { cwd, shell: process.platform === 'win32' }); }
    catch (e) { return resolve({ code: -1, out, err: String(e), missing: true }); }
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => resolve({ code: -1, out, err: String(e), missing: e.code === 'ENOENT' }));
    child.on('close', code => resolve({ code, out, err }));
    if (child.stdin) { if (input != null) child.stdin.write(input); child.stdin.end(); }
  });
}

function toDiagnostics(doc, list) {
  return list.map(d => {
    const i = Math.max(0, Math.min((d.line || 1) - 1, doc.lineCount - 1));
    const len = doc.lineAt ? doc.lineAt(i).text.length : 0;
    const x = new vscode.Diagnostic(new vscode.Range(i, 0, i, len), d.message,
      d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
    x.source = 'xfcmd';
    return x;
  });
}

async function lint(doc) {
  if (!doc || doc.languageId !== 'xfcmd') return;
  const r = await runCli(['check', '-', '--json', '--name', doc.fileName], { cwd: folderOf(doc), input: doc.getText() });
  if (r.missing) {
    if (!warnedMissing) { warnedMissing = true; vscode.window.showWarningMessage('xfcmd CLI not found. Install it with "npm i -g xfcmd" or set the xfcmd.command setting.'); }
    return;
  }
  let list = [];
  try { list = JSON.parse(r.out || '[]'); } catch { return; }
  diagnostics.set(doc.uri, toDiagnostics(doc, list));
}

function lintSoon(doc) {
  if (!config().get('checkOnType')) return;
  const k = doc.uri.toString();
  clearTimeout(timers.get(k));
  timers.set(k, setTimeout(() => lint(doc), 350));
}

function inTerminal(line, doc) {
  if (!terminal || terminal.exitStatus) terminal = vscode.window.createTerminal({ name: 'xfcmd', cwd: folderOf(doc) });
  terminal.show(true);
  terminal.sendText(line);
}

async function runFile(dry) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== 'xfcmd') return vscode.window.showInformationMessage('Open an .xfcmd file first.');
  if (ed.document.isDirty) await ed.document.save();
  const command = String(config().get('command') || 'xfcmd').trim();
  const extra = (config().get('extraArgs') || []).map(quote).join(' ');
  inTerminal([command, 'run', quote(ed.document.fileName), dry ? '--dry-run' : '', extra].filter(Boolean).join(' '), ed.document);
}

async function runRegistryCommand() {
  const folder = folderOf(vscode.window.activeTextEditor?.document);
  const extra = config().get('extraArgs') || [];
  const r = await runCli(['list', '--json', ...extra], { cwd: folder });
  if (r.code !== 0) return vscode.window.showErrorMessage('xfcmd list failed: ' + (r.err || r.out).trim().split('\n').pop());
  let j; try { j = JSON.parse(r.out); } catch { return vscode.window.showErrorMessage('xfcmd list returned unreadable output.'); }
  const items = Object.entries(j.commands || {}).map(([name, c]) => ({ label: name, description: c.about || c.script }));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Run an xfcmd command' });
  if (!pick) return;
  const command = String(config().get('command') || 'xfcmd').trim();
  inTerminal([command, 'run', quote(pick.label), ...extra.map(quote)].join(' '), vscode.window.activeTextEditor?.document);
}

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection('xfcmd');
  const sub = d => context.subscriptions.push(d);
  sub(diagnostics);
  sub(vscode.commands.registerCommand('xfcmd.runFile', () => runFile(false)));
  sub(vscode.commands.registerCommand('xfcmd.dryRunFile', () => runFile(true)));
  sub(vscode.commands.registerCommand('xfcmd.checkFile', async () => {
    const d = vscode.window.activeTextEditor?.document;
    await lint(d);
    vscode.commands.executeCommand('workbench.actions.view.problems');
  }));
  sub(vscode.commands.registerCommand('xfcmd.runRegistryCommand', runRegistryCommand));
  sub(vscode.workspace.onDidOpenTextDocument(lint));
  sub(vscode.workspace.onDidSaveTextDocument(lint));
  sub(vscode.workspace.onDidChangeTextDocument(e => lintSoon(e.document)));
  sub(vscode.workspace.onDidCloseTextDocument(d => diagnostics.delete(d.uri)));
  vscode.workspace.textDocuments.forEach(lint);
}

function deactivate() { for (const t of timers.values()) clearTimeout(t); timers.clear(); }

module.exports = { activate, deactivate, toDiagnostics, runCli };
