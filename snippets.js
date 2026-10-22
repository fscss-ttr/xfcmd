/* snippets.js: build an editor snippet from a package helper signature.
   "siri-blob-variant(st, color)" -> "@siri-blob-variant(${1:st}, ${2:color})"
   "siri-wave(st:.siri-wave)"     -> "@siri-wave(${1:.siri-wave})"
   "st-root"                      -> "@st-root($0)"                              */
export function helperBody(raw) {
  const m = String(raw).trim().match(/^([\w-]+)\s*(?:\((.*)\))?$/);
  if (!m) return null;
  const ps = (m[2] || '').split(',').map(s => s.trim()).filter(Boolean);
  const ph = ps.map((p, i) => {
    const [n, ...d] = p.split(':'), def = (d.join(':').trim() || n.trim()).replace(/[\\$}]/g, '\\$&');
    return '${' + (i + 1) + ':' + def + '}';
  });
  return { name: m[1], body: '@' + m[1] + '(' + (ph.length ? ph.join(', ') : '$0') + ')' };
}
