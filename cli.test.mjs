import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cli, tmp, read, exists, tree, FIX, mockFetch, fakeCompiler, stdinOf } from './helpers.mjs';

const REG = path.join(FIX, 'registry');

test('--version, help, usage errors', async () => {
  assert.equal((await cli(['--version'])).out.trim(), '0.1.0');
  assert.equal((await cli(['help'])).code, 0);
  assert.equal((await cli([])).code, 2);
  assert.equal((await cli(['nope'])).code, 2);
  assert.equal((await cli(['run'])).code, 2);
  assert.equal((await cli(['--bogus'])).code, 2);
});
test('run a local script file with variables', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 's.xfcmd'), 'create file {dir}/a.fscss with "x"\nsay "made {dir}"');
  const r = await cli(['run', 's.xfcmd', '--cwd', d, '--var', 'dir=gen']);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /Created gen\/a\.fscss/); assert.equal(read(d, 'gen/a.fscss'), 'x');
  assert.equal((await cli(['run', 's.xfcmd', '--cwd', d, '--var', 'broken'])).code, 1);
});
test('run a registry command from a local registry directory', async () => {
  const d = tmp();
  const r = await cli(['run', 'starter', '--registry', REG, '--cwd', d], { compiler: fakeCompiler() });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(tree(d).filter(f => !f.startsWith('.xfcmd')), ['dist/starter/styles/theme.css', 'starter/app.js', 'starter/index.html', 'starter/styles/theme.fscss']);
  assert.equal(JSON.parse(read(d, '.xfcmd/state.json')).entry, 'starter/styles/theme.fscss');
  assert.equal((await cli(['run', 'does-not-exist', '--registry', REG, '--cwd', d])).code, 2);
});
test('multipage: partial imports bundle, only the root compiles', async () => {
  const d = tmp(), c = fakeCompiler();
  const r = await cli(['run', 'multipage', '--registry', REG, '--cwd', d], { compiler: c });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(tree(d).filter(f => f.startsWith('dist/')), ['dist/site/styles/site.css']);
  assert.match(c.seen[0], /from data:text\/plain/); assert.match(r.out, /\/site\/about\.html/);
});
test('--dry-run changes nothing', async () => {
  const d = tmp();
  const r = await cli(['run', 'starter', '--registry', REG, '--cwd', d, '--dry-run'], { compiler: fakeCompiler() });
  assert.equal(r.code, 0, r.err); assert.deepEqual(tree(d), []); assert.match(r.out, /dry run: nothing was written/); assert.match(r.out, /\[dry-run\]/);
});
test('check: gcc style lines, json, strict, stdin, defaults to every script here', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'ok.xfcmd'), 'say "fine"');
  fs.writeFileSync(path.join(d, 'bad.xfcmd'), 'say "a"\nfrob now\nshow nowhere');
  let r = await cli(['check', 'ok.xfcmd', '--cwd', d]); assert.equal(r.code, 0);
  r = await cli(['check', 'bad.xfcmd', '--cwd', d]);
  assert.equal(r.code, 1); assert.match(r.out, /^bad\.xfcmd:2:1: error: Unknown sentence: frob now$/m); assert.match(r.out, /bad\.xfcmd:3:1: warning: unknown view/);
  r = await cli(['check', 'bad.xfcmd', '--json', '--cwd', d]);
  const j = JSON.parse(r.out); assert.deepEqual(j.map(x => [x.line, x.severity]), [[2, 'error'], [3, 'warning']]);
  fs.writeFileSync(path.join(d, 'warn.xfcmd'), 'show nowhere');
  assert.equal((await cli(['check', 'warn.xfcmd', '--cwd', d])).code, 0);
  assert.equal((await cli(['check', 'warn.xfcmd', '--strict', '--cwd', d])).code, 1);
  r = await cli(['check', '-', '--name', 'buffer.xfcmd', '--cwd', d], { stdin: stdinOf('say "x"\nnope') });
  assert.equal(r.code, 1); assert.match(r.out, /^buffer\.xfcmd:2:1: error/m);
  assert.equal((await cli(['check', '--cwd', d])).code, 1, 'no files given checks all, and bad.xfcmd fails');
});
test('eval runs one sentence', async () => {
  const r = await cli(['eval', 'say', '"hello"']); assert.equal(r.code, 0); assert.equal(r.out.trim(), 'hello');
  assert.equal((await cli(['eval', 'frob'])).code, 1);
});
test('list shows registry commands, package hooks and local scripts', async () => {
  const d = tmp(); fs.writeFileSync(path.join(d, 'mine.xfcmd'), 'say "x"');
  const r = await cli(['list', '--registry', REG, '--cwd', d]);
  assert.match(r.out, /starter/); assert.match(r.out, /\[pkg\] st-core/); assert.match(r.out, /\[local\] mine\.xfcmd/);
  const j = JSON.parse((await cli(['list', '--json', '--registry', REG, '--cwd', d])).out);
  assert.ok(j.commands.hello && j.packages['st-core'] && j.local.includes('mine.xfcmd'));
});

test('packages: libs, libck, libon, liboff against mocked GitHub with the real st-core scripts', async () => {
  const d = tmp(), f = mockFetch(), c = fakeCompiler();
  const run = (args, o = {}) => cli([...args, '--cwd', d, '--registry', REG], { fetch: f, compiler: c, ...o });

  let r = await run(['libs']);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /st-core@2/);
  assert.ok(exists(d, '.xfcmd/libs-cache.json'), 'libs are cached');

  r = await run(['libck', 'st-core']);                     // not a TTY: reports and tells you how to enable
  assert.equal(r.code, 0, r.err); assert.match(r.out, /8 passed, 0 warnings, 0 failed/); assert.match(r.out, /all 23 helpers found/);
  assert.match(r.out, /xfcmd from package\.json: 17 sentences/); assert.match(r.out, /Run: xfcmd libon st-core/);
  assert.deepEqual(tree(d).filter(x => x.startsWith('st-core-demo')), []);

  r = await run(['libon', 'st-core', '--dry-run']);
  assert.equal(r.code, 0, r.err); assert.deepEqual(tree(d).filter(x => !x.startsWith('.xfcmd')), []);

  r = await run(['libck', 'st-core', '--yes']);            // report, then enable
  assert.equal(r.code, 0, r.err); assert.match(r.out, /Enabled st-core/);
  assert.deepEqual(tree(d).filter(x => x.startsWith('st-core-demo') || x.startsWith('dist')), ['dist/st-core-demo/chart.css', 'dist/st-core-demo/spider.css', 'st-core-demo/chart.fscss', 'st-core-demo/index.html', 'st-core-demo/spider.fscss']);
  assert.match(read(d, 'st-core-demo/chart.fscss'), /@import\(\(\*\) from st-core@v2\)/);
  const snips = JSON.parse(read(d, '.vscode/xfcmd.code-snippets'));
  assert.equal(Object.keys(snips).length, 26); assert.deepEqual(snips['st-chart-fill'].body, ['@st-chart-fill(${1:.st-chart-fill}, ${2:p})']);
  assert.ok(JSON.parse(read(d, '.xfcmd/state.json')).packages['st-core']);
  assert.ok(c.seen.some(t => t.includes('@import((*) from st-core@v2)')), 'registry imports are left for FSCSS');

  r = await run(['libs', 'on']); assert.match(r.out, /\[on\] st-core@2  import st-core@v2/);
  r = await run(['libon', 'st-core']); assert.match(r.out, /already enabled/);
  r = await run(['libck', 'st-core']); assert.match(r.out, /Status: enabled/);

  r = await run(['liboff', 'st-core']);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /Disabled st-core/); assert.match(r.out, /Disabled st-core\. Its helper snippets were removed/);
  assert.equal(exists(d, '.vscode/xfcmd.code-snippets'), false); assert.equal(JSON.parse(read(d, '.xfcmd/state.json')).packages['st-core'], undefined);
  assert.ok(exists(d, 'st-core-demo/chart.fscss'), 'demo files are kept');
  assert.equal((await run(['liboff', 'st-core'])).code, 1);
});
test('packages: unknown names, builtins, and failing checks', async () => {
  const d = tmp(), f = mockFetch();
  const run = a => cli([...a, '--cwd', d, '--registry', REG], { fetch: f });
  let r = await run(['libck', 'does-not-exist']); assert.equal(r.code, 1); assert.match(r.err, /No component named/);
  r = await run(['libck', 'fscss:micros']); assert.equal(r.code, 0); assert.match(r.out, /built into the compiler/);
  /* a compiler older than the package needs makes a warning, not a failure */
  r = await run(['libck', 'st-core', '--fscss-version', '1.1.0']); assert.equal(r.code, 0); assert.match(r.err, /needs fscss >=1\.2\.3 but the compiler is 1\.1\.0/);
  /* a module that cannot be downloaded fails the check, and --force overrides */
  const broken = async u => String(u).endsWith('st-core@v2.fscss') ? { ok: false, status: 404, text: async () => '' } : f(u);
  const rb = a => cli([...a, '--cwd', d, '--registry', REG], { fetch: broken, compiler: fakeCompiler() });
  r = await rb(['libck', 'st-core']); assert.equal(r.code, 1); assert.match(r.err, /\[fail\] module \.\/st-core@v2\.fscss: HTTP 404/);
  r = await rb(['libon', 'st-core']); assert.equal(r.code, 1); assert.match(r.err, /checks failed/);
  assert.equal((await rb(['libon', 'st-core', '--force'])).code, 0);
});
