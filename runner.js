/* runner.js
   Runs parsed steps against a host. The host is the only thing that touches the outside world:
     host.log(level, text)            level: out | warn | error
     host.toast(text, type)           optional
     host.createFile(path, content)   -> { path, kept }
     host.openFile(path)  host.setEntry(path)  host.addImport(name)
     host.compile(mode)   host.show(view)      host.addSnippet({ key, title, desc, body })
     host.runCommand(cmd) host.sleep(ms)       optional unless the script uses them
   The IDE host edits the workspace in the browser. The Node host writes real files. */
import { parse, fill, cleanName, VIEWS, ALLOWED, MAX_STEPS } from './parser.js';
import { helperBody } from './snippets.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const need = (h, m) => { if (typeof h[m] !== 'function') throw new Error('this host does not support: ' + m); };

export function mkCtx(info) {
  return {
    name: info?.name || '', version: info?.version || '', author: info?.author || '', description: info?.description || '',
    license: info?.license || '', import: info?.imp || '', helpers: (info?.helpers || []).join(', '), helperRaw: info?.helperRaw || [],
    fscss: info?.fscssRange || '', repo: info?.repo || '', file: ''
  };
}

const addSnippet = (h, c, sn) => {
  need(h, 'addSnippet');
  h.addSnippet(sn);
  if (c._rec) { c._rec.snips = (c._rec.snips || []).filter(x => x !== sn.key); c._rec.snips.push(sn.key); }
};

const EXEC = {
  say: (s, c, h) => h.log('out', fill(s.text, c)),
  warn: (s, c, h) => h.log('warn', fill(s.text, c)),
  error: (s, c, h) => h.log('error', fill(s.text, c)),
  toast: (s, c, h) => h.toast ? h.toast(fill(s.text, c), s.type) : h.log('out', fill(s.text, c)),
  import: async (s, c, h) => { need(h, 'addImport'); await h.addImport(fill(s.name, c)); },
  create: async (s, c, h) => {
    need(h, 'createFile');
    const want = cleanName(fill(s.path, c));
    if (!want) throw new Error('empty file name');
    const r = await h.createFile(want, fill(s.content, c));
    c.file = r.path;
    if (!r.kept) c._rec?.files.push(r.path);
    h.log('out', (r.kept ? 'Kept existing ' : 'Created ') + r.path);
  },
  open: async (s, c, h) => { need(h, 'openFile'); await h.openFile(fill(s.path, c)); },
  entry: async (s, c, h) => { need(h, 'setEntry'); await h.setEntry(fill(s.path, c)); },
  compile: async (s, c, h) => { need(h, 'compile'); await h.compile(s.mode); },
  show: (s, c, h) => {
    if (!VIEWS.includes(s.what)) throw new Error('cannot show "' + s.what + '"');
    if (h.show) h.show(s.what);
  },
  snippet: (s, c, h) => addSnippet(h, c, { key: s.key, title: s.title, desc: (c.name || 'xfcmd') + ' snippet', body: fill(s.body, c) }),
  snips: (s, c, h) => {
    let n = 0;
    for (const raw of c.helperRaw || []) {
      const hb = helperBody(raw);
      if (hb) { addSnippet(h, c, { key: hb.name, title: '@' + hb.name + '()', desc: c.name + ' helper', body: hb.body }); n++; }
    }
    h.log('out', 'Added ' + n + ' snippets');
  },
  run: async (s, c, h) => {
    const cmd = fill(s.cmd, c), w = cmd.trim().split(/\s+/)[0].toLowerCase();
    if (!ALLOWED.includes(w)) throw new Error('"' + w + '" is not allowed in scripts');
    need(h, 'runCommand');
    await h.runCommand(cmd);
  },
  wait: (s, c, h) => (h.sleep || sleep)(s.ms)
};

export async function runSteps(steps, ctx, host, { maxSteps = MAX_STEPS } = {}) {
  if (steps.length > maxSteps) { host.log('error', 'script is too long (max ' + maxSteps + ' sentences)'); return false; }
  for (const s of steps) {
    try { await EXEC[s.op](s, ctx, host); }
    catch (e) { host.log('error', 'xfcmd line ' + s.line + ': ' + e.message); return false; }
  }
  return true;
}

/** parse then run. Any parse error means nothing runs. */
export async function runText(text, ctx, host, label = 'script') {
  const p = parse(text);
  if (p.errors.length) { p.errors.forEach(e => host.log('error', label + ' line ' + e.line + ': ' + e.msg)); return false; }
  return runSteps(p.steps, ctx, host);
}
