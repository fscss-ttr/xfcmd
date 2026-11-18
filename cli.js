/* cli.js: the xfcmd command line. main(argv, io) returns an exit code and never calls process.exit,
   so it can be tested and embedded.
   Exit codes: 0 ok, 1 a script, check or package step failed, 2 usage error. */
import fs from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { parse, describe } from './parser.js';
import { runSteps, mkCtx } from './runner.js';
import { NodeHost } from './node-host.js';
import { PkgClient, reportLines, createRemoteRegistry, createDirRegistry } from './pkg.js';

const HELP = `xfcmd - run .xfcmd scripts and manage FSCSS packages

Usage
  xfcmd run <file|command>      run a script file, or a command from the registry
  xfcmd check [files...|-]      parse and lint scripts (no files: every .xfcmd here, - reads stdin)
  xfcmd eval <sentence>         run one sentence, e.g. xfcmd eval 'say "hi"'
  xfcmd list                    registry commands, package hooks and local scripts
  xfcmd libs [query|on|refresh] list or search components
  xfcmd libck <name>            load and check a package, then offer to enable it
  xfcmd libon <name>            enable a package (runs its enable script)
  xfcmd liboff <name>           disable a package (runs its disable script)

Options
  --cwd <dir>           workspace folder (default: current folder)
  --dry-run             show what would happen, change nothing
  --var <key=value>     set a script variable, repeatable (use as {key})
  --registry <dir|url>  use another registry (default: the FSCSS repo xfcmds/ folder)
  --compiler <module>   FSCSS compiler module (default: fscss from node_modules)
  --fscss-version <v>   compiler version used for package range checks
  --open <command>      open files in an editor, e.g. --open code
  --scope <ids>         language scope for generated VS Code snippets
  -y, --yes             answer yes to prompts
  --force               enable a package even when checks failed
  --strict              check: treat warnings as errors
  --json                check, list: machine readable output
  --name <label>        check -: name to show for stdin
  -h, --help   -v, --version
`;

async function version() {
  try { return JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '0.0.0'; }
}
async function readStdin(stdin) { const c = []; for await (const x of stdin) c.push(x); return Buffer.concat(c.map(x => Buffer.from(x))).toString('utf8'); }

export async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout, stderr = io.stderr || process.stderr, stdin = io.stdin || process.stdin;
  const fetchImpl = io.fetch || globalThis.fetch;
  const outln = t => stdout.write(t + '\n'), errln = t => stderr.write(t + '\n');
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true,
      options: {
        cwd: { type: 'string' }, 'dry-run': { type: 'boolean' }, var: { type: 'string', multiple: true }, registry: { type: 'string' },
        compiler: { type: 'string' }, 'fscss-version': { type: 'string' }, open: { type: 'string' }, scope: { type: 'string' },
        yes: { type: 'boolean', short: 'y' }, force: { type: 'boolean' }, strict: { type: 'boolean' }, json: { type: 'boolean' },
        name: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' }
      }
    });
  } catch (e) { errln('error: ' + e.message); return 2; }
  const o = parsed.values, [cmd, ...rest] = parsed.positionals;
  if (o.version) { outln(await version()); return 0; }
  if (o.help || cmd === 'help') { outln(HELP); return 0; }
  if (!cmd) { errln(HELP); return 2; }

  const root = path.resolve(o.cwd || io.cwd || process.cwd());
  const mkHost = () => new NodeHost({
    root, dryRun: !!o['dry-run'], editor: o.open || '', compiler: io.compiler || o.compiler, snippetScope: o.scope || '',
    sink: (l, t) => l === 'out' ? outln(t) : errln((l === 'warn' ? 'warning: ' : 'error: ') + t)
  });
  let _client;
  const getClient = async () => {
    if (_client) return _client;
    const reg = o.registry ? (/^https?:/i.test(o.registry) ? createRemoteRegistry(fetchImpl, o.registry) : await createDirRegistry(path.resolve(root, o.registry))) : createRemoteRegistry(fetchImpl);
    let v = o['fscss-version'];
    if (!v) { try { v = JSON.parse(await fs.readFile(path.join(root, 'node_modules/fscss/package.json'), 'utf8')).version; } catch { v = '1.2.6'; } }
    return _client = new PkgClient({ fetch: fetchImpl, registry: reg, fscssVersion: v });
  };
  const cacheFile = path.join(root, '.xfcmd/libs-cache.json');
  const cache = {
    get() { try { return JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { return null; } },
    set(v) { if (o['dry-run']) return; try { mkdirSync(path.dirname(cacheFile), { recursive: true }); writeFileSync(cacheFile, JSON.stringify(v)); } catch { /* cache is optional */ } }
  };
  const ask = q => new Promise(res => { const rl = readline.createInterface({ input: stdin, output: stdout }); rl.question(q, a => { rl.close(); res(/^y(es)?$/i.test(a.trim())); }); });
  const diag = (file, d, sev) => `${file}:${d.line}:1: ${sev}: ${d.msg}`;

  /* run parsed text against a host, printing lint advice first */
  const execute = async (text, label, ctx) => {
    const host = mkHost(); await host.loadState();
    const p = parse(text);
    p.warnings.forEach(w => errln(diag(label, w, 'warning')));
    if (p.errors.length) { p.errors.forEach(e => errln(diag(label, e, 'error'))); return 1; }
    const ok = await runSteps(p.steps, ctx, host);
    if (o['dry-run']) outln('dry run: nothing was written (' + host.virtual.size + ' file change' + (host.virtual.size === 1 ? '' : 's') + ' skipped)');
    return ok && host.errors === 0 ? 0 : 1;
  };
  const varsCtx = () => {
    const ctx = mkCtx(null);
    for (const v of o.var || []) { const i = v.indexOf('='); if (i < 1) throw new Error('--var needs key=value, got "' + v + '"'); ctx[v.slice(0, i)] = v.slice(i + 1); }
    return ctx;
  };

  try {
    /* ---------- run, eval ---------- */
    if (cmd === 'run') {
      const target = rest[0];
      if (!target) { errln('error: Usage: xfcmd run <file|command>'); return 2; }
      let text;
      try { text = await fs.readFile(path.resolve(root, target), 'utf8'); }
      catch {
        const c = await getClient(), e = (await c.getRegistryJson()).commands?.[target];
        if (!e) { errln('error: no file or registry command named "' + target + '". Try: xfcmd list'); return 2; }
        text = await c.registry.script(e.script);
        if (text == null) { errln('error: could not load ' + e.script); return 1; }
      }
      return execute(text, target, varsCtx());
    }
    if (cmd === 'eval') {
      if (!rest.length) { errln('error: Usage: xfcmd eval <sentence>'); return 2; }
      return execute(rest.join(' '), 'eval', varsCtx());
    }

    /* ---------- check ---------- */
    if (cmd === 'check') {
      let files = rest;
      if (!files.length) files = Object.keys(await mkHost().scan()).filter(f => f.endsWith('.xfcmd'));
      if (!files.length) { errln('no .xfcmd files found'); return 0; }
      const all = []; let E = 0, W = 0;
      for (const f of files) {
        let text, label = f;
        if (f === '-') { text = await readStdin(stdin); label = o.name || '<stdin>'; }
        else { try { text = await fs.readFile(path.resolve(root, f), 'utf8'); } catch (e) { errln('error: cannot read ' + f); E++; continue; } }
        const p = parse(text);
        p.errors.forEach(d => { E++; all.push({ file: label, line: d.line, column: 1, severity: 'error', message: d.msg }); });
        p.warnings.forEach(d => { W++; all.push({ file: label, line: d.line, column: 1, severity: 'warning', message: d.msg }); });
      }
      if (o.json) outln(JSON.stringify(all, null, 2));
      else all.forEach(d => outln(`${d.file}:${d.line}:${d.column}: ${d.severity}: ${d.message}`));
      errln(`${files.length} file${files.length === 1 ? '' : 's'} checked, ${E} error${E === 1 ? '' : 's'}, ${W} warning${W === 1 ? '' : 's'}`);
      return E || (o.strict && W) ? 1 : 0;
    }

    /* ---------- list ---------- */
    if (cmd === 'list') {
      const c = await getClient(), reg = await c.getRegistryJson(), local = Object.keys(await mkHost().scan()).filter(f => f.endsWith('.xfcmd')).sort();
      if (o.json) { outln(JSON.stringify({ registry: c.registry.kind, commands: reg.commands || {}, packages: reg.packages || {}, local }, null, 2)); return 0; }
      if (reg._missing) errln('warning: registry not reachable (' + c.registry.base + ')');
      Object.entries(reg.commands || {}).forEach(([n, x]) => outln('  ' + n.padEnd(16) + (x.about || x.script)));
      Object.entries(reg.packages || {}).forEach(([n, x]) => outln('  ' + ('[pkg] ' + n).padEnd(16) + (x.about || x.enable)));
      local.forEach(f => outln('  ' + ('[local] ' + f)));
      return 0;
    }

    /* ---------- packages ---------- */
    if (['libs', 'libck', 'libon', 'liboff'].includes(cmd)) {
      const c = await getClient(), host = mkHost(), st = await host.loadState();
      const libs = () => c.loadLibs({ cache, force: rest[0] === 'refresh' });

      if (cmd === 'libs') {
        const sub = (rest[0] || '').toLowerCase();
        if (sub === 'on' || sub === 'enabled') {
          const k = Object.keys(st.packages);
          k.length ? k.forEach(n => outln('[on] ' + n + '@' + st.packages[n].version + '  import ' + st.packages[n].imp)) : outln('No packages enabled. Try: xfcmd libck <name>');
          return 0;
        }
        const term = sub && sub !== 'refresh' ? sub : '';
        const list = (await libs()).filter(l => !term || [l.name, l.description, l.author, ...(l.keywords || [])].some(x => String(x || '').toLowerCase().includes(term)));
        list.forEach(l => outln((l.name in st.packages ? '[on] ' : '     ') + l.name + '@' + (l.version || '?') + '  ' + (l.description || '')));
        outln(list.length + ' components. xfcmd libck <name> checks one, xfcmd libon <name> enables it.');
        return 0;
      }

      const q = rest[0];
      if (!q) { errln('error: Usage: xfcmd ' + cmd + ' <name>'); return 2; }

      const enable = async d => {
        const i = d.info, rec = { version: i.version, repoUrl: d.v.repoUrl, imp: i.imp, helpers: i.helpers, at: Date.now(), snips: [], files: [] };
        const ctx = mkCtx(i); ctx._rec = rec;
        outln((o['dry-run'] ? '[dry-run] ' : '') + 'Enabling ' + i.name + '@' + i.version + '...');
        if (!(await runSteps(d.steps, ctx, host))) { await host.removeSnippets(rec.snips); errln('error: enable stopped, ' + i.name + ' was not enabled'); return 1; }
        st.packages[i.name] = rec; await host.saveState();
        outln('Enabled ' + i.name + '. Import it with @import((*) from ' + i.imp + ')');
        return host.errors ? 1 : 0;
      };

      if (cmd === 'liboff') {
        const key = Object.keys(st.packages).find(k => k.toLowerCase() === q.replace(/@.*$/, '').toLowerCase());
        if (!key) { errln('error: ' + q + ' is not enabled'); return 1; }
        const rec = st.packages[key];
        try {
          const v = await c.fetchPkg(rec.repoUrl), sc = await c.findScript((await import('./pkg.js')).norm(v), v, 'disable');
          if (sc) { const p = parse(sc.text); if (!p.errors.length) await runSteps(p.steps, mkCtx((await import('./pkg.js')).norm(v)), host); }
        } catch { /* a missing disable script must not block disabling */ }
        await host.removeSnippets(rec.snips || []);
        delete st.packages[key]; await host.saveState();
        outln('Disabled ' + key + '. Files it created were kept' + (rec.files?.length ? ': ' + rec.files.join(', ') : '') + '.');
        return 0;
      }

      outln('Checking ' + q + '...');
      const d = await c.inspect(q, await libs());
      if (d.builtin) { outln(d.builtin + ' is built into the compiler. Nothing to download or enable.'); return 0; }
      const on = Object.keys(st.packages).find(k => k.toLowerCase() === d.info.name.toLowerCase());

      if (cmd === 'libon') {
        if (on && !o.force) { outln(d.info.name + ' is already enabled. Use --force to run it again.'); return 0; }
        if (d.failed && !o.force) { reportLines(d).forEach(l => l.level === 'out' ? outln(l.text) : errln(l.text)); errln('error: checks failed. Use --force to enable anyway'); return 1; }
        return enable(d);
      }

      reportLines(d).forEach(l => l.level === 'out' ? outln(l.text) : errln(l.text));
      if (on) { outln('Status: enabled (' + st.packages[on].version + '). Use xfcmd liboff ' + on + ' to disable.'); return d.failed ? 1 : 0; }
      if (d.failed) { errln('error: fix the failed checks before enabling, or use: xfcmd libon ' + d.info.name + ' --force'); return 1; }
      outln('Status: not enabled. On enable it ' + describe(d.steps, mkCtx(d.info)) + '.');
      if (o.yes || (stdin.isTTY && await ask('Enable ' + d.info.name + '? [y/N] '))) return enable(d);
      outln('Run: xfcmd libon ' + d.info.name);
      return 0;
    }

    errln('error: unknown command "' + cmd + '". Try: xfcmd help');
    return 2;
  } catch (e) {
    errln('error: ' + (e && e.message || e));
    return 1;
  }
}
