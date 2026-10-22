/* parser.js
   The .xfcmd sentence format: tokenizer, parser, linter, variable filling.
   Pure functions. No DOM, no Node APIs, so the IDE, the CLI and editors share it. */

export const VERBS = ['say', 'print', 'info', 'warn', 'error', 'toast', 'add', 'import', 'create', 'open', 'set', 'compile', 'preview', 'show', 'run', 'wait'];
export const VIEWS = ['files', 'components', 'libs', 'snippets', 'tools', 'terminal', 'problems', 'css', 'preview'];
export const ALLOWED = ['compile', 'run', 'all', 'preview', 'ls', 'open', 'new', 'libs', 'clear', 'theme', 'routes', 'deps', 'resolve'];
export const MAX_STEPS = 200;
export const MAX_WAIT = 3000;

/* same rules as the IDE: spaces become dashes, unsafe characters are dropped, default extension */
export const cleanName = n => {
  let s = String(n).trim().replace(/\\/g, '/').replace(/\s+/g, '-').replace(/[^\w.\-\/]/g, '').replace(/\/{2,}/g, '/').replace(/^\/+/, '');
  if (s && !/\.[a-z0-9]+$/i.test(s)) s += '.fscss';
  return s;
};

export const fill = (t, c) => String(t).replace(/\{(\w+)\}/g, (m, k) => (k in c && k[0] !== '_') ? String(c[k]) : m);

export function tokenize(s) {
  const out = [], re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s))) {
    out.push(m[1] !== undefined
      ? { q: true, v: m[1].replace(/\\(.)/g, (_, c) => c === 'n' ? '\n' : c === 't' ? '\t' : c) }
      : { q: false, v: m[2] });
  }
  return out;
}

const dedent = lines => {
  const ind = Math.min(99, ...lines.filter(l => l.trim()).map(l => l.match(/^ */)[0].length));
  return lines.map(l => l.slice(Math.min(ind, l.match(/^ */)[0].length))).join('\n').replace(/^\n+|\n+$/g, '') + '\n';
};

/** parse(text) -> { steps, errors, warnings }. Errors stop a script, warnings are advice. */
export function parse(text) {
  const L = String(text).replace(/\r/g, '').split('\n'), steps = [], errors = [], warnings = [];
  for (let i = 0; i < L.length; i++) {
    const t = L[i].trim();
    if (!t || t[0] === '#' || t.startsWith('//')) continue;
    const tk = tokenize(t.replace(/"\.$/, '"')), a = tk.map(x => x.q ? '' : x.v.toLowerCase()), line = i + 1;
    const q = n => tk[n] && tk[n].q ? tk[n].v : null;
    let s = null;
    if (['say', 'print', 'info'].includes(a[0]) && q(1) !== null) s = { op: 'say', text: q(1) };
    else if (a[0] === 'warn' && q(1) !== null) s = { op: 'warn', text: q(1) };
    else if (a[0] === 'error' && q(1) !== null) s = { op: 'error', text: q(1) };
    else if (a[0] === 'toast' && q(1) !== null) s = { op: 'toast', text: q(1), type: a[2] || '' };
    else if (a[0] === 'add' && a[1] === 'import' && tk[2]) s = { op: 'import', name: tk[2].v };
    else if (a[0] === 'create' && a[1] === 'file' && tk[2] && (a[3] === 'with:' || a[3] === 'with')) {
      if (q(4) !== null) s = { op: 'create', path: tk[2].v, content: q(4) };
      else {
        const body = []; let j = i + 1;
        while (j < L.length && L[j].trim().toLowerCase() !== 'end') body.push(L[j++]);
        if (j >= L.length) { errors.push({ line, msg: 'create file block is missing "end"' }); break; }
        s = { op: 'create', path: tk[2].v, content: dedent(body) }; i = j;
      }
    }
    else if (a[0] === 'open' && a[1] === 'file' && tk[2]) s = { op: 'open', path: tk[2].v };
    else if (a[0] === 'set' && a[1] === 'entry' && tk[2]) s = { op: 'entry', path: tk[2].v };
    else if (a[0] === 'compile') s = { op: 'compile', mode: a[1] === 'all' ? 'all' : '' };
    else if (a[0] === 'preview') s = { op: 'compile', mode: 'preview' };
    else if (a[0] === 'show' && a[1]) s = { op: 'show', what: a[1] };
    else if (a[0] === 'add' && a[1] === 'snippets' && a[2] === 'for' && a[3] === 'helpers') s = { op: 'snips' };
    else if (a[0] === 'add' && a[1] === 'snippet' && tk[2] && q(3) !== null && a[4] === 'as' && q(5) !== null) s = { op: 'snippet', key: tk[2].v, title: q(3), body: q(5) };
    else if (a[0] === 'run' && a[1] === 'command' && q(2) !== null) s = { op: 'run', cmd: q(2) };
    else if (a[0] === 'wait' && /^\d+$/.test(a[1] || '')) s = { op: 'wait', ms: Math.min(+a[1], MAX_WAIT) };
    if (!s) { errors.push({ line, msg: 'Unknown sentence: ' + t.slice(0, 60) }); continue; }
    s.line = line; steps.push(s);

    /* lint: things the runner would refuse or change */
    if (s.op === 'create' && /(^|\/)\.\.(\/|$)|^\/|^[a-z]:/i.test(s.path)) warnings.push({ line, msg: 'path "' + s.path + '" leaves the workspace and will be refused' });
    if (s.op === 'show' && !VIEWS.includes(s.what)) warnings.push({ line, msg: 'unknown view "' + s.what + '"' });
    if (s.op === 'run' && !ALLOWED.includes(s.cmd.trim().split(/\s+/)[0].toLowerCase())) warnings.push({ line, msg: '"' + s.cmd.trim().split(/\s+/)[0] + '" is not an allowed command' });
    if (s.op === 'wait' && +a[1] > MAX_WAIT) warnings.push({ line, msg: 'wait is capped at ' + MAX_WAIT + ' ms' });
  }
  if (steps.length > MAX_STEPS) errors.push({ line: 1, msg: 'script is too long (' + steps.length + ' sentences, max ' + MAX_STEPS + ')' });
  return { steps, errors, warnings };
}

export function describe(steps, ctx = {}) {
  const p = [], f = steps.filter(s => s.op === 'create').map(s => fill(s.path, ctx));
  if (f.length) p.push('creates ' + f.join(', '));
  if (steps.some(s => s.op === 'snips' || s.op === 'snippet')) p.push('adds snippets');
  if (steps.some(s => s.op === 'import')) p.push('inserts an import');
  if (steps.some(s => s.op === 'compile')) p.push('compiles');
  const r = steps.filter(s => s.op === 'run').map(s => s.cmd);
  if (r.length) p.push('runs: ' + r.join(', '));
  return p.join('; ') || 'only prints messages';
}
