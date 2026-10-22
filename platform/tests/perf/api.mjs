const B = (process.env.BASE_URL || 'http://127.0.0.1:18621') + '/api/v1';
const fs = await import('node:fs');
let cookie = '', csrf = '';
async function call(method, path, body) {
  const t = performance.now();
  const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf, origin: (process.env.BASE_URL || 'http://127.0.0.1:18621') }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const txt = await r.text(); const ms = performance.now() - t;
  return { status: r.status, ms, bytes: txt.length, json: (() => { try { return JSON.parse(txt); } catch { return null; } })() };
}
const token = fs.readFileSync(process.argv[2] + '/setup-token', 'utf8').trim();
await call('POST', '/setup', { setupToken: token, org: { name: 'Perf' }, admin: { email: 'a@p.test', name: 'Perf Admin', password: 'Violet-Harbor-Lantern-42' } });
const l = await call('POST', '/auth/login', { email: 'a@p.test', password: 'Violet-Harbor-Lantern-42' }); csrf = l.json?.csrfToken;
const rows = [];
for (const p of ['/catalog/manifest', '/catalog/points', '/catalog/regions', '/catalog/pairs', '/catalog/pairs?level=1', '/catalog/pairs/pb-006', '/catalog/points/higado/pairs', '/catalog/entities', '/catalog/entities?q=rabia', '/catalog/protocols', '/catalog/protocols/app-19-circulacion-de-piernas', '/catalog/symptoms', '/catalog/search?q=dolor', '/catalog/contraindications', '/i18n/packs', '/i18n/packs/en/ui', '/patients', '/sessions']) {
  const a = []; let r;
  for (let i = 0; i < 5; i++) { r = await call('GET', p); a.push(r.ms); }
  a.sort((x, y) => x - y);
  rows.push([p, r.status, (r.bytes / 1024).toFixed(1) + ' KB', a[0].toFixed(1), a[2].toFixed(1), a[4].toFixed(1)]);
}
const sg = []; for (let i = 0; i < 5; i++) sg.push((await call('POST', '/catalog/suggest', { symptoms: ['cefalea', 'mareo', 'nausea'], text: 'dolor de cabeza y mareo' })).ms);
rows.push(['POST /catalog/suggest', 200, '', ...[0, 2, 4].map((i) => sg.sort((a, b) => a - b)[i].toFixed(1))]);
console.log('endpoint | status | size | min | p50 | max (ms)');
for (const r of rows) console.log(r.join(' | '));
