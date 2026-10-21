#!/usr/bin/env node
// QA gate for a translated chunk:  node importer/i18n/check-chunk.mjs <queue/chunk-NN.json> <done/chunk-NN.json>
// Fails (exit 1) on: missing/extra hashes, empty output, numbers dropped or invented, list-marker or
// line-count drift, or Spanish left untranslated (heuristic, warning only).
import { readFileSync } from 'node:fs';
const [qf, df] = process.argv.slice(2);
const q = JSON.parse(readFileSync(qf, 'utf8')), d = JSON.parse(readFileSync(df, 'utf8'));
const out = new Map(d.map((x) => [x.h, x.en]));
const errs = [], warns = [];
const nums = (s) => (s.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(',', '.')).sort().join('|');
const lines = (s) => s.split('\n').length;
const bullets = (s) => (s.match(/^\s*(?:[-•]|\d+\.)\s/gm) || []).length;
const SPANISH = /\b(?:el|los|las|del|para|con|que|por|una|enfermedad|síntomas|también)\b/gi;
for (const { h, es } of q) {
  const en = out.get(h);
  if (typeof en !== 'string' || !en.trim()) { errs.push(`${h}: missing or empty`); continue; }
  if (nums(es) !== nums(en)) errs.push(`${h}: numbers differ  es[${nums(es)}] en[${nums(en)}]`);
  if (lines(es) !== lines(en)) errs.push(`${h}: line count ${lines(es)} → ${lines(en)}`);
  if (bullets(es) !== bullets(en)) errs.push(`${h}: list markers ${bullets(es)} → ${bullets(en)}`);
  const sp = (en.match(SPANISH) || []).length;
  if (en === es && /[a-záéíóúñ]{4,}/i.test(es) && (es.match(SPANISH) || []).length) warns.push(`${h}: unchanged Spanish`);
  else if (sp >= 3) warns.push(`${h}: ${sp} Spanish function words remain`);
}
for (const h of out.keys()) if (!q.some((x) => x.h === h)) errs.push(`${h}: not in queue`);
console.log(`${df}: ${q.length} items, ${errs.length} errors, ${warns.length} warnings`);
for (const e of errs.slice(0, 40)) console.log('  ERROR', e);
for (const w of warns.slice(0, 20)) console.log('  warn ', w);
process.exit(errs.length ? 1 : 0);
