const B = (process.env.BASE_URL || 'http://127.0.0.1:18621') + '/api/v1'; let cookie = '', csrf = '';
async function call(method, path, body) {
  const t = performance.now();
  const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf, origin: (process.env.BASE_URL || 'http://127.0.0.1:18621') }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const txt = await r.text(); return { status: r.status, ms: performance.now() - t, bytes: txt.length, json: (() => { try { return JSON.parse(txt); } catch { return null; } })() };
}
const l = await call('POST', '/auth/login', { email: 'a@p.test', password: 'Violet-Harbor-Lantern-42' }); csrf = l.json.csrfToken;
const N = Number(process.argv[2] || 1000); const t0 = performance.now(); const pairs = ['pb-001','pb-006','pb-007','pb-036','pb-097','pb-068'];
let fins = 0;
for (let i = 0; i < N; i++) {
  const p = await call('POST', '/patients', { firstName: 'Load' + i, lastName: 'Patient' + (i % 300), dob: '1970-01-' + String(1 + (i % 28)).padStart(2, '0'), sex: i % 2 ? 'female' : 'male' });
  const pid = p.json.id ?? p.json.patient?.id;
  await call('POST', `/patients/${pid}/consents`, { type: 'intake', answers: {}, contraindications: { relative: [], absolute: [] }, signatureName: 'Load', signedAt: new Date().toISOString() });
  for (let s = 0; s < 3; s++) {
    const se = await call('POST', `/patients/${pid}/sessions`, { methodology: 'biomagnetism', protocolIds: [], chiefComplaint: 'load test', symptoms: [] });
    const sid = se.json.id ?? se.json.session?.id;
    for (const pr of pairs.slice(0, 2 + (i % 4))) { await call('POST', `/sessions/${sid}/findings`, { pairId: pr, trackingSide: 'R', impactSide: 'L', phenomena: [], status: 'found' }); fins++; }
  }
}
console.log(`seeded ${N} patients, ${N * 3} sessions, ${fins} findings in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
const rows = [];
for (const [m, p, b] of [['GET', '/patients?limit=50'], ['GET', '/patients?limit=50&offset=900'], ['POST', '/patients/search', { q: 'Patient17' }], ['GET', '/sessions?limit=50'], ['GET', '/sessions?status=draft&latest=1&limit=50'], ['GET', '/sessions?followUpTo=2030-01-01&latest=1&limit=50'], ['GET', '/audit?limit=50'], ['GET', '/audit/verify']]) {
  const a = []; let r; for (let i = 0; i < 5; i++) { r = await call(m, p, b); a.push(r.ms); } a.sort((x, y) => x - y);
  rows.push(`${m} ${p} | ${r.status} | ${(r.bytes / 1024).toFixed(1)} KB | p50 ${a[2].toFixed(1)} ms | max ${a[4].toFixed(1)} ms`);
}
console.log(rows.join('\n'));
