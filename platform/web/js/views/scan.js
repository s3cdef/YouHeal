// Scan workspace: protocol runner (left) · body viewer (center) · session panel (right).
import { el, mount, clear, debounce, isTypingTarget, nextId } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { api, items, errorMessage, NetworkError, ApiError } from '../api.js';
import { t, locText, locNode, getLocale, fmtDuration, ageFrom, fmtDate, vocab } from '../i18n.js';
import { navigate, setLeaveGuard } from '../router.js';
import { state, can, loadCore, getPair, getPointPairs, getProtocol, protocolPairIds, polarity, getList, normSession, normQualifiers } from '../state.js';
import { combobox } from '../ui/combobox.js';
import { tabs, segmented, toggleSwitch, stateBadge, categoryChip, pairPoles, emptyState, alertBox, skeleton, chip, field, input, textarea, kbd, ratingsRow, statusBadge, pairNum } from '../ui/components.js';
import { openModal, confirmDialog } from '../ui/modal.js';
import { toast, announce } from '../ui/toast.js';
import { createViewer, renderSnapshots } from '../bodymap/host.js';
import { pairDetailBody } from './pair-detail.js';
import { fullName, errorPanel, methodologyLabel, addDaysISO } from './common.js';
import { PROTOCOL_KINDS } from './start-scan.js';
import { latestConsent } from './start-scan.js';

const PHENOMENA = ['infiltrate', 'exudate', 'cyst', 'abscess', 'neoplasia'];
// qualifiers: S superior, INF inferior, A anterior, P posterior, LAT lateral (CONTRACT §4.6)
const QUALIFIERS = ['S', 'INF', 'A', 'P', 'LAT'];
const SIDES = ['R', 'L', 'C'];
const FINDING_STATES = ['found', 'impacted', 'cleared'];
// Runner state (checklist, not-present marks, cursor) is UI-only: the API has no field for it, and we keep it
// out of browser storage. It survives in-app navigation for the lifetime of the page.
const runnerMemory = new Map();

// ---------------------------------------------------------------- autosave queue
class SaveQueue {
  constructor(onStatus) { this.q = []; this.running = false; this.onStatus = onStatus; this.idMap = new Map(); this.failures = 0; this.timer = null; }
  get pending() { return this.q.length; }
  push(op) {
    // coalesce PATCHes to the same target
    if (op.coalesce) {
      const prev = this.q.find((o, i) => (i > 0 || !this.running) && o.coalesce === op.coalesce);
      if (prev) { prev.body = { ...prev.body, ...op.body }; this.emit(); return; }
    }
    this.q.push(op); this.emit(); this.kick();
  }
  realId(idv) { return this.idMap.get(idv) || idv; }
  emit() { this.onStatus({ pending: this.q.length, failures: this.failures, running: this.running }); }
  kick() { if (!this.running && !this.timer) this.run(); }
  async run() {
    this.running = true; this.emit();
    while (this.q.length) {
      const op = this.q[0];
      try {
        const res = await op.exec(this);
        this.q.shift(); this.failures = 0;
        if (op.done) op.done(res, this);
      } catch (err) {
        const retryable = err instanceof NetworkError || (err instanceof ApiError && err.status >= 500);
        if (retryable) {
          this.failures++; this.running = false; this.emit();
          const delay = Math.min(30000, 1000 * 2 ** Math.min(this.failures - 1, 5));
          this.timer = setTimeout(() => { this.timer = null; this.run(); }, delay);
          return;
        }
        this.q.shift();
        if (op.fail) op.fail(err);
      }
      this.emit();
    }
    this.running = false; this.emit();
  }
  async flush(timeoutMs = 15000) {
    const start = Date.now();
    if (this.timer) { clearTimeout(this.timer); this.timer = null; this.run(); }
    while (this.q.length && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 120));
    return this.q.length === 0;
  }
  dispose() { clearTimeout(this.timer); }
}

// ---------------------------------------------------------------- view
export async function renderScan({ main, params }) {
  mount(main, el('div.scan-loading', skeleton(8)));
  let session; let core; let patient;
  try {
    [session, core] = await Promise.all([api.get(`/sessions/${encodeURIComponent(params.id)}`).then(normSession), loadCore()]);
    patient = session.patient && session.patient.dob !== undefined ? session.patient : await api.get(`/patients/${encodeURIComponent(session.patientId)}`).catch(() => session.patient || {});
  } catch (err) { mount(main, el('div.page', errorPanel(err, () => renderScan({ main, params })))); return null; }

  const readOnly = session.status !== 'draft' || !can.findings() || !!session.supersededBy;
  const disposers = [];
  const timers = new Map(); // findingId -> { endsAt, total }
  let viewer = null; let viewerKind = null;
  let symptomsCatalog = [];
  const st = {
    findings: (session.findings || []).map((f) => ({ ...f, qualifiers: normQualifiers(f.qualifiers) })),
    checklist: [],
    notPresent: new Set(),
    cursor: 0,
    activeProtocols: [],
    showAll: false, // default: only the points of the checklist + findings (the full catalog has ~300 points)
    view: 'anterior',
    drawerPoint: null,
    expandedFinding: null,
    symptoms: [...(session.symptoms || [])].map((x) => (typeof x === 'string' ? x : x.id)),
    leftOpen: false, rightOpen: false,
  };

  // ---------- autosave status ----------
  const saveStatus = el('span.save-status', { role: 'status', aria: { live: 'polite' } });
  const queue = new SaveQueue(({ pending, failures, running }) => {
    saveStatus.dataset.state = failures ? 'error' : pending || running ? 'saving' : 'saved';
    clear(saveStatus).append(
      icon(failures ? 'alert' : pending || running ? 'refresh' : 'check', { size: 16, cls: pending && !failures ? 'spin' : '' }),
      el('span', failures ? t('scan.saveRetry', { n: failures }) : pending || running ? t('scan.saving') : t('scan.saved')));
  });
  queue.emit();
  disposers.push(() => queue.dispose());

  // ---------- helpers ----------
  const pointsMap = core.points;
  const pairOf = (id) => core.pairs.get(id);
  const findingFor = (pairId) => st.findings.find((f) => f.pairId === pairId);
  const stateOf = (pairId) => { const f = findingFor(pairId); if (f) return f.status; return st.notPresent.has(pairId) ? 'not-present' : 'candidate'; };
  const defaultSides = (pair) => {
    const sameBilateral = pair.tracking.point === pair.impact.point && pointsMap.get(pair.tracking.point)?.laterality === 'bilateral';
    const map = (s, which) => (s === 'RL' ? (sameBilateral ? (which === 'tracking' ? 'R' : 'L') : 'R') : s || 'C');
    return { trackingSide: map(pair.tracking.side, 'tracking'), impactSide: map(pair.impact.side, 'impact') };
  };

  let lastProtocolIds = JSON.stringify(session.protocolIds || []);
  const persistScanState = debounce(() => {
    runnerMemory.set(session.id, { checklist: st.checklist, notPresent: [...st.notPresent], cursor: st.cursor, activeProtocols: st.activeProtocols });
    if (readOnly) return;
    const protocolIds = st.activeProtocols.filter((p) => p !== '__h2t');
    if (JSON.stringify(protocolIds) === lastProtocolIds) return;
    lastProtocolIds = JSON.stringify(protocolIds);
    patchSession({ protocolIds });
  }, 600);
  const onSaveError = (err) => {
    if (err && (err.code === 'SESSION_LOCKED' || err.status === 409)) { toast(t('scan.lockedElsewhere'), { tone: 'error', timeout: 10000 }); setTimeout(() => renderScan({ main, params }), 300); return; }
    toast(errorMessage(err), { tone: 'error' });
  };
  const patchSession = (body) => {
    if (readOnly) return;
    queue.push({ coalesce: 'session', body, exec() { return api.patch(`/sessions/${session.id}`, this.body); }, fail: onSaveError });
  };

  // ---------- findings ops (optimistic) ----------
  function addFinding(pairId, status = 'found', extra = {}) {
    if (readOnly) return null;
    const existing = findingFor(pairId);
    if (existing) { if (existing.status !== status) updateFinding(existing.id, { status }); return existing; }
    const pair = pairOf(pairId);
    const tmpId = nextId('tmp');
    const f = { id: tmpId, pairId, trackingPoint: pair?.tracking.point, impactPoint: pair?.impact.point, ...(pair ? defaultSides(pair) : { trackingSide: 'C', impactSide: 'C' }), qualifiers: { tracking: [...(pair?.tracking.qualifiers || [])], impact: [...(pair?.impact.qualifiers || [])] }, phenomena: [], dwellMinutes: 15, status, notes: '', ...extra, _pending: true };
    st.findings.push(f);
    st.notPresent.delete(pairId);
    if (!st.checklist.some((c) => c.pairId === pairId)) st.checklist.push({ pairId, source: 'manual' });
    queue.push({
      exec: () => api.post(`/sessions/${session.id}/findings`, { pairId, trackingPoint: f.trackingPoint, impactPoint: f.impactPoint, trackingSide: f.trackingSide, impactSide: f.impactSide, qualifiers: f.qualifiers, phenomena: f.phenomena, dwellMinutes: f.dwellMinutes, status: f.status, notes: f.notes || null }),
      done: (res, q) => { q.idMap.set(tmpId, res.id); const cur = st.findings.find((x) => x.id === tmpId); if (cur) { cur.id = res.id; delete cur._pending; } if (timers.has(tmpId)) { timers.set(res.id, timers.get(tmpId)); timers.delete(tmpId); } if (st.expandedFinding === tmpId) st.expandedFinding = res.id; renderFindings(); },
      fail: (err) => { st.findings = st.findings.filter((x) => x.id !== tmpId); onSaveError(err); renderAll(); },
    });
    persistScanState();
    announce(t('scan.announceFound', { pair: pair ? locText(pair.name) : pairId }));
    renderAll();
    return f;
  }
  function updateFinding(fid, patch) {
    if (readOnly) return;
    const f = st.findings.find((x) => x.id === fid); if (!f) return;
    const before = { ...f };
    Object.assign(f, patch);
    queue.push({
      coalesce: `f:${fid}`, body: patch,
      exec(q) { return api.patch(`/sessions/${session.id}/findings/${encodeURIComponent(q.realId(fid))}`, this.body); },
      fail: (err) => { Object.assign(f, before); onSaveError(err); renderAll(); },
    });
    if ('status' in patch) { renderAll(); announce(t('scan.announceStatus', { status: t(`state.${patch.status}`) })); } else { syncViewer(); renderChecklist(); }
  }
  function removeFinding(fid, { undo = true } = {}) {
    if (readOnly) return;
    const f = st.findings.find((x) => x.id === fid); if (!f) return;
    st.findings = st.findings.filter((x) => x.id !== fid);
    timers.delete(fid);
    queue.push({ exec: (q) => api.del(`/sessions/${session.id}/findings/${encodeURIComponent(q.realId(fid))}`), fail: (err) => { st.findings.push(f); onSaveError(err); renderAll(); } });
    renderAll();
    if (undo) {
      const pair = pairOf(f.pairId);
      toast(t('scan.findingRemoved', { pair: pair ? locText(pair.name) : '' }), { tone: 'info', action: { label: t('common.undo'), onClick: () => addFinding(f.pairId, f.status, { trackingSide: f.trackingSide, impactSide: f.impactSide, qualifiers: f.qualifiers, phenomena: f.phenomena, dwellMinutes: f.dwellMinutes, notes: f.notes }) } });
    }
  }
  function setItemState(pairId, s) {
    if (readOnly) return;
    if (s === 'not-present') {
      const f = findingFor(pairId);
      if (f) removeFinding(f.id, { undo: true });
      st.notPresent.add(pairId); persistScanState(); renderAll();
      announce(t('scan.announceNotPresent'));
      return;
    }
    if (s === 'candidate') { const f = findingFor(pairId); if (f) removeFinding(f.id); st.notPresent.delete(pairId); persistScanState(); renderAll(); return; }
    addFinding(pairId, s);
  }

  // ---------- checklist ----------
  async function addProtocol(protoId) {
    if (st.activeProtocols.includes(protoId)) { toast(t('scan.protocolAlready'), { tone: 'info' }); return; }
    let ids = [];
    if (protoId === '__h2t') {
      // Full head-to-toe over the numbered guide pairs (levels 1–2): by tracking-point height when anatomy is known, else by number.
      const y = (p) => pointsMap.get(p.tracking.point)?.pos?.y;
      ids = [...core.pairs.values()].filter((p) => p.level === 1 || p.level === 2)
        .sort((a, b) => ((y(b) ?? -1) - (y(a) ?? -1)) || (a.number ?? 1e9) - (b.number ?? 1e9)).map((p) => p.id);
    } else {
      try { ids = protocolPairIds(await getProtocol(protoId)); } catch (err) { toast(errorMessage(err), { tone: 'error' }); return; }
    }
    st.activeProtocols.push(protoId);
    let added = 0;
    for (const pid of ids) if (!st.checklist.some((c) => c.pairId === pid)) { st.checklist.push({ pairId: pid, source: 'protocol', protocolId: protoId }); added++; }
    persistScanState(); renderLeft(); syncViewer();
    toast(t('scan.protocolAdded', { count: added }), { tone: 'success' });
  }
  function removeProtocol(protoId) {
    st.activeProtocols = st.activeProtocols.filter((p) => p !== protoId);
    st.checklist = st.checklist.filter((c) => c.protocolId !== protoId || findingFor(c.pairId));
    st.cursor = Math.min(st.cursor, Math.max(0, st.checklist.length - 1));
    persistScanState(); renderLeft(); syncViewer();
  }
  function addToChecklist(pairId, source = 'directed') {
    if (st.checklist.some((c) => c.pairId === pairId)) return false;
    st.checklist.push({ pairId, source }); persistScanState(); return true;
  }
  function setCursor(i, { focus = true } = {}) {
    if (!st.checklist.length) return;
    st.cursor = Math.max(0, Math.min(st.checklist.length - 1, i));
    renderChecklist();
    const cur = st.checklist[st.cursor];
    const pair = pairOf(cur.pairId);
    if (pair && viewer) {
      // Highlight only — moving the camera on every j/k would disorient the practitioner mid-scan.
      viewer.highlight([pair.tracking.point, pair.impact.point], { pulse: true });
      const tp = pointsMap.get(pair.tracking.point);
      const want = tp && tp.view === 'posterior' ? 'posterior' : 'anterior';
      if ((st.view === 'anterior' || st.view === 'posterior') && st.view !== want) { st.view = want; viewSeg.setValue(want); viewer.setView(want); }
    }
    syncViewer();
    if (focus) { const li = checklistEl.querySelector('.ck-item.is-current'); if (li) { li.scrollIntoView({ block: 'nearest' }); if (document.activeElement && checklistEl.contains(document.activeElement)) li.focus({ preventScroll: true }); } }
    persistScanState();
  }

  // ---------- initial checklist ----------
  const ss = runnerMemory.get(session.id) || session.scanState || {};
  if (Array.isArray(ss.checklist) && ss.checklist.length) {
    st.checklist = ss.checklist.filter((c) => core.pairs.has(c.pairId));
    st.notPresent = new Set(ss.notPresent || []);
    st.cursor = Math.min(ss.cursor || 0, Math.max(0, st.checklist.length - 1));
    st.activeProtocols = ss.activeProtocols || [...(session.protocolIds || [])];
  } else {
    for (const pid of session.protocolIds || []) {
      try {
        const ids = protocolPairIds(await getProtocol(pid));
        st.activeProtocols.push(pid);
        for (const id of ids) if (!st.checklist.some((c) => c.pairId === id)) st.checklist.push({ pairId: id, source: 'protocol', protocolId: pid });
      } catch { /* skip */ }
    }
  }
  for (const f of st.findings) if (f.pairId && !st.checklist.some((c) => c.pairId === f.pairId)) st.checklist.push({ pairId: f.pairId, source: 'manual' });
  getList('/catalog/symptoms').then((l) => { symptomsCatalog = l; renderSymptomChips(); }).catch(() => {});

  // ================================================================ layout
  const age = ageFrom(patient.dob);
  const consentP = latestConsent(session.patientId);
  const flagSlot = el('span.scan-flags');
  consentP.then((c) => {
    const rel = c?.contraindications?.relative || []; const abs = c?.contraindications?.absolute || [];
    if (abs.length) flagSlot.append(el('span.chip.tone-rose.chip-flag', icon('alert', { size: 14 }), t('chart.absoluteFlag', { count: abs.length })));
    if (rel.length) flagSlot.append(el('span.chip.tone-amber.chip-flag', { title: t('scan.relativeTip') }, icon('info', { size: 14 }), t('chart.relativeFlag', { count: rel.length })));
  });
  const elapsed = el('span.timer-value', '0:00');
  const startedAt = new Date(session.startedAt).getTime();
  // A live timer only makes sense for a session in progress today; older drafts/finalized show their date.
  const live = !readOnly && Date.now() - startedAt < 12 * 3600 * 1000;
  const tickElapsed = () => { elapsed.textContent = live ? fmtDuration(Date.now() - startedAt) : fmtDate(session.startedAt, { month: 'short', day: 'numeric' }); };
  tickElapsed();
  const tick = setInterval(() => { tickElapsed(); tickTimers(); }, 1000);
  disposers.push(() => clearInterval(tick));

  const leftToggle = el('button.btn.btn-secondary.pane-toggle.pane-toggle-left', { type: 'button', title: t('scan.protocolPane'), aria: { expanded: 'false', controls: 'scan-left', label: t('scan.protocolPane') } }, icon('list', { size: 18 }), el('span', t('scan.protocolPane')));
  const rightToggle = el('button.btn.btn-secondary.pane-toggle.pane-toggle-right', { type: 'button', title: t('scan.sessionPane'), aria: { expanded: 'false', controls: 'scan-right', label: t('scan.sessionPane') } }, icon('clipboard', { size: 18 }), el('span', t('scan.sessionPane')), el('span.badge-count', String(st.findings.length)));
  const finalizeBtn = el('button.btn.btn-primary', { type: 'button', title: t('scan.finalize'), aria: { label: t('scan.finalize') }, onClick: () => finalize() }, icon('shield', { size: 18 }), el('span', t('scan.finalize')));
  const bar = el('header.scan-bar',
    el('a.icon-btn', { href: `#/patients/${session.patientId}/sessions`, aria: { label: t('scan.backToChart') }, title: t('scan.backToChart') }, icon('arrowLeft')),
    el('div.scan-id',
      el('h1.scan-title', { tabindex: '-1' }, fullName(patient)),
      el('p.scan-meta', [age !== null ? t('patient.ageYears', { age }) : null, patient.sex ? t(`sex.${patient.sex}`) : null, methodologyLabel(session.methodology)].filter(Boolean).join(' · '), ' ', statusBadge(session.status), flagSlot)),
    el('div.scan-bar-mid',
      el(`span.session-timer${live ? '' : '.is-date'}`, { title: live ? t('scan.elapsed') : t('session.date') }, icon(live ? 'clock' : 'calendar', { size: 16 }), el('span.sr-only', live ? t('scan.elapsed') : t('session.date')), elapsed),
      readOnly ? null : saveStatus),
    el('div.scan-bar-actions', leftToggle, rightToggle,
      el('button.icon-btn', { type: 'button', aria: { label: t('scan.shortcuts') }, title: t('scan.shortcuts'), onClick: () => showShortcuts() }, icon('keyboard')),
      el('a.btn.btn-ghost', { href: `#/sessions/${session.id}/report`, title: readOnly ? t('chart.viewReport') : t('scan.preview'), aria: { label: readOnly ? t('chart.viewReport') : t('scan.preview') } }, icon('file', { size: 18 }), el('span.hide-md', readOnly ? t('chart.viewReport') : t('scan.preview'))),
      readOnly ? null : finalizeBtn));

  const left = el('aside#scan-left.scan-left', { aria: { label: t('scan.protocolPane') } });
  const center = el('section.scan-center', { aria: { label: t('scan.bodyPane') } });
  const right = el('aside#scan-right.scan-right', { aria: { label: t('scan.sessionPane') } });
  const scrim = el('div.scan-scrim', { hidden: true, onClick: () => { setPane('left', false); setPane('right', false); } });
  const root = el('div.scan', bar,
    readOnly ? el('div.scan-locked', alertBox({ tone: 'info', ic: 'lock', title: session.supersededBy ? t('scan.supersededTitle') : session.status === 'draft' ? t('scan.noPermission') : t('scan.lockedTitle'),
      children: [el('p', session.supersededBy ? t('scan.supersededBody') : session.status === 'draft' ? t('scan.noPermissionBody') : t('scan.lockedBody')),
        el('div.btn-row',
          session.supersededBy ? el('a.btn.btn-sm.btn-secondary', { href: `#/sessions/${session.supersededBy}` }, t('scan.openLatest')) : null,
          session.status !== 'draft' && !session.supersededBy && can.findings() ? el('button.btn.btn-sm.btn-secondary', { type: 'button', onClick: () => amend() }, icon('edit', { size: 16 }), t('scan.amend')) : null)] })) : null,
    el('div.scan-body', left, center, right, scrim));
  mount(main, root);

  function setPane(which, open) {
    const isLeft = which === 'left';
    st[isLeft ? 'leftOpen' : 'rightOpen'] = open;
    (isLeft ? left : right).classList.toggle('is-open', open);
    (isLeft ? leftToggle : rightToggle).setAttribute('aria-expanded', open ? 'true' : 'false');
    scrim.hidden = !(st.leftOpen || st.rightOpen);
    if (open) { const f = (isLeft ? left : right).querySelector('button, input, select, textarea, [tabindex="0"]'); if (f) f.focus(); }
  }
  leftToggle.addEventListener('click', () => { setPane('right', false); setPane('left', !st.leftOpen); });
  rightToggle.addEventListener('click', () => { setPane('left', false); setPane('right', !st.rightOpen); });

  // ================================================================ LEFT: protocol runner + directed scan
  const checklistEl = el('ol.checklist', { aria: { label: t('scan.checklist') } });
  const progressEl = el('div.ck-progress');
  const activeProtoEl = el('div.active-protocols');
  let leftTab = 'protocol';
  const leftTabs = tabs({
    label: t('scan.protocolPane'), active: leftTab, variant: 'pill',
    tabs: [{ id: 'protocol', label: t('scan.tabProtocol'), icon: 'list' }, { id: 'directed', label: t('scan.tabDirected'), icon: 'sparkles' }],
    onChange: (id, panel) => { leftTab = id; clear(panel); if (id === 'protocol') panel.append(protocolPanel()); else panel.append(directedPanel()); },
  });
  mount(left, el('div.pane-head', el('h2.pane-title', t('scan.protocolPane')), el('button.icon-btn.pane-close', { type: 'button', aria: { label: t('common.close') }, onClick: () => setPane('left', false) }, icon('x'))), leftTabs.root, leftTabs.panel);

  function protocolPanel() {
    let kindFilter = '';
    const kinds = PROTOCOL_KINDS.filter((k) => core.protocols.some((p) => p.kind === k));
    const kindSeg = segmented({ name: 'pkind', label: t('scan.protocolKind'), value: '', size: 'xs',
      options: [{ value: '', label: t('common.all') }, ...kinds.map((k) => ({ value: k, label: t(`protocolKindShort.${k}`) }))], onChange: (v) => { kindFilter = v; picker.focus(); } });
    const nrm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const picker = combobox({
      label: t('scan.chooseProtocol'), placeholder: t('scan.searchProtocols', { count: core.protocols.length }), size: 'sm', iconName: 'list', minChars: 0,
      emptyText: () => t('scan.noProtocolMatch'),
      source: async (q) => {
        const n = nrm(q);
        return core.protocols
          .filter((p) => (!kindFilter || p.kind === kindFilter) && (!n || nrm(`${p.name.en || ''} ${p.name.es || ''} ${p.id}`).includes(n)) && !st.activeProtocols.includes(p.id))
          .sort((x, y) => PROTOCOL_KINDS.indexOf(x.kind) - PROTOCOL_KINDS.indexOf(y.kind) || locText(x.name).localeCompare(locText(y.name)))
          .slice(0, 40)
          .map((p) => ({ id: p.id, label: locText(p.name), sublabel: `${t(`protocolKind.${p.kind}`)}${p.count ? ` · ${t('catalog.pairsCount', { count: p.count })}` : ''}` }));
      },
      onSelect: (it) => addProtocol(it.id),
    });
    picker.input.addEventListener('focus', () => { if (!picker.input.value) picker.input.dispatchEvent(new Event('input')); });
    const h2t = el('button.btn.btn-sm.btn-ghost', { type: 'button', disabled: readOnly, onClick: () => addProtocol('__h2t') }, icon('layers', { size: 16 }), t('scan.headToToe', { count: [...core.pairs.values()].filter((p) => p.level === 1 || p.level === 2).length }));
    const wrap = el('div.protocol-panel',
      readOnly ? null : el('div.proto-add', kindSeg, picker.root, h2t),
      activeProtoEl, progressEl, checklistEl,
      el('p.kbd-hint', kbd('J'), '/', kbd('K'), ` ${t('scan.kNav')} · `, kbd('F'), ` ${t('state.found')} · `, kbd('N'), ` ${t('state.not-present')} · `, kbd('I'), ` ${t('state.impacted')} · `, kbd('C'), ` ${t('state.cleared')}`));
    renderLeft();
    return wrap;
  }

  function renderLeft() {
    clear(activeProtoEl);
    for (const pid of st.activeProtocols) {
      const p = core.protocols.find((x) => x.id === pid);
      const name = pid === '__h2t' ? t('scan.headToTooShort') : p ? locText(p.name) : pid;
      activeProtoEl.append(el('span.chip.tone-teal.chip-removable', el('span', name),
        readOnly ? null : el('button.chip-x', { type: 'button', aria: { label: t('scan.removeProtocol', { name }) }, onClick: () => removeProtocol(pid) }, icon('x', { size: 14 }))));
    }
    renderChecklist();
  }

  function renderChecklist() {
    const total = st.checklist.length;
    const checked = st.checklist.filter((c) => stateOf(c.pairId) !== 'candidate').length;
    const found = st.checklist.filter((c) => ['found', 'impacted', 'cleared'].includes(stateOf(c.pairId))).length;
    mount(progressEl,
      el('div.ck-progress-text', el('span', t('scan.progress', { checked, total })), el('span.ck-found-count', t('scan.foundCount', { count: found }))),
      el('div.progress', { role: 'progressbar', aria: { valuemin: 0, valuemax: total || 1, valuenow: checked, label: t('scan.progressLabel') } }, el('span.progress-bar', { style: { width: total ? `${(checked / total) * 100}%` : '0%' } })));
    clear(checklistEl);
    if (!total) {
      checklistEl.append(el('li.ck-empty', emptyState({ icon: 'list', title: t('scan.checklistEmpty'), body: t('scan.checklistEmptyBody'), compact: true })));
      return;
    }
    st.checklist.forEach((c, i) => {
      const pair = pairOf(c.pairId); if (!pair) return;
      const s = stateOf(c.pairId);
      const current = i === st.cursor;
      const li = el(`li.ck-item.state-${s}${current ? '.is-current' : ''}`, { tabindex: current ? '0' : '-1', aria: { current: current ? 'step' : null, label: `${pairNum(pair, { hash: false })}. ${locText(pair.name)} — ${t(`state.${s}`)}` }, data: { idx: i } },
        el('span.ck-num', pairNum(pair, { hash: false })),
        el('span.ck-main', pairPoles(pair, pointsMap, { compact: true, sides: findingFor(c.pairId) ? { tracking: findingFor(c.pairId).trackingSide, impact: findingFor(c.pairId).impactSide } : null }), c.source === 'directed' ? el('span.ck-src', icon('sparkles', { size: 12 }), t('scan.fromDirected')) : null),
        stateBadge(s));
      li.addEventListener('click', (e) => { if (e.target.closest('button')) return; setCursor(i); li.focus(); openPointDrawer(pair.tracking.point, { pairId: pair.id }); });
      if (current && !readOnly) {
        li.append(el('div.ck-actions', { role: 'group', aria: { label: t('scan.markAs') } },
          ckBtn(t('state.found'), 'target', 'found', s, () => setItemState(c.pairId, 'found'), 'F'),
          ckBtn(t('state.not-present'), 'minus', 'not-present', s, () => { setItemState(c.pairId, 'not-present'); setCursor(st.cursor + 1); }, 'N'),
          ckBtn(t('state.impacted'), 'magnet', 'impacted', s, () => setItemState(c.pairId, 'impacted'), 'I'),
          ckBtn(t('state.cleared'), 'check', 'cleared', s, () => setItemState(c.pairId, 'cleared'), 'C')));
      }
      checklistEl.append(li);
    });
  }
  function ckBtn(label, ic, val, cur, fn, key) {
    return el(`button.ck-btn.ck-${val}`, { type: 'button', aria: { pressed: cur === val ? 'true' : 'false', keyshortcuts: key }, onClick: (e) => { e.stopPropagation(); fn(); } }, icon(ic, { size: 16 }), el('span', label), el('kbd.ck-key', key));
  }

  // ---- directed scan
  const directed = { text: '', results: null, loading: false };
  function directedPanel() {
    const chips = el('div.sym-chips');
    const resultsEl = el('div.suggest-results', { aria: { live: 'polite' } });
    const cb = combobox({
      label: t('scan.symptomSearch'), placeholder: t('scan.symptomPlaceholder'), hideLabel: false,
      source: async (q) => items(await api.get('/catalog/symptoms', { q })).filter((s) => !st.symptoms.includes(s.id)).slice(0, 10).map((s) => ({ id: s.id, label: locText(s.name), sublabel: vocab("systems", s.system) })),
      onSelect: (it) => { if (!st.symptoms.includes(it.id)) { st.symptoms.push(it.id); patchSession({ symptoms: st.symptoms }); renderSymptomChips(); } },
      onEnterText: (txt) => { freeText.value = freeText.value ? `${freeText.value}, ${txt}` : txt; directed.text = freeText.value; },
    });
    const freeText = textarea({ rows: 2, id: 'directed-text', placeholder: t('scan.freeTextPlaceholder'), value: directed.text });
    freeText.addEventListener('input', () => { directed.text = freeText.value; });
    const go = el('button.btn.btn-primary.btn-block', { type: 'button' }, icon('sparkles', { size: 18 }), t('scan.suggest'));
    go.addEventListener('click', async () => {
      if (!st.symptoms.length && !freeText.value.trim()) { toast(t('scan.suggestNeedInput'), { tone: 'warn' }); cb.focus(); return; }
      go.disabled = true; mount(resultsEl, skeleton(4));
      try {
        directed.results = items(await api.post('/catalog/suggest', { symptoms: st.symptoms, text: freeText.value.trim() }));
        renderSuggestions(resultsEl);
      } catch (err) { mount(resultsEl, alertBox({ tone: 'danger', children: [el('p', errorMessage(err))] })); }
      finally { go.disabled = false; }
    });
    symChipTargets.add(chips);
    renderSymptomChips();
    const wrap = el('div.directed-panel',
      el('p.pane-intro', t('scan.directedIntro')),
      cb.root, chips,
      field({ label: t('scan.freeText'), input: freeText, optional: true }),
      go, resultsEl);
    if (directed.results) renderSuggestions(resultsEl);
    return wrap;
  }
  function matchedLabel(m) {
    if (typeof m === 'string') return m;
    if (m.type === 'symptom' || m.kind === 'symptom') return locText(m.name || m.label);
    const term = m.token || m.term || '';
    const where = m.field ? t(`scan.matchField.${m.field}`) : '';
    return `“${term}”${where ? ` · ${where}` : ''}`;
  }
  function renderSuggestions(box) {
    const res = directed.results || [];
    const maxScore = Math.max(...res.map((r) => Number(r.score) || 0), 1e-9);
    if (!res.length) { mount(box, emptyState({ icon: 'search', title: t('scan.noSuggestions'), compact: true })); return; }
    const addTop = el('button.btn.btn-sm.btn-secondary', { type: 'button', disabled: readOnly }, icon('plus', { size: 16 }), t('scan.addTop', { n: Math.min(5, res.length) }));
    addTop.addEventListener('click', () => { let n = 0; for (const r of res.slice(0, 5)) if (addToChecklist(r.pairId)) n++; renderLeft(); renderSuggestions(box); syncViewer(); toast(t('scan.addedToScan', { count: n }), { tone: 'success' }); });
    mount(box,
      el('div.suggest-head', el('p.pd-label', t('scan.suggestions', { count: res.length })), addTop),
      el('ol.suggest-list', res.map((r) => {
        const pair = pairOf(r.pairId); if (!pair) return null;
        const inScan = st.checklist.some((c) => c.pairId === r.pairId);
        const pct = Math.round(((Number(r.score) || 0) / maxScore) * 100); // relative to the best match
        return el('li.suggest-item',
          el('div.suggest-top', el('span.pair-num', pairNum(pair)), el('span.suggest-name', locNode(pair.name)), categoryChip(pair.category)),
          el('div.score', { role: 'img', aria: { label: t('scan.score', { pct }) } }, el('span.score-bar', { style: { width: `${Math.max(6, pct)}%` } }), el('span.score-num', `${pct}%`)),
          el('ul.matched', (r.matched || []).map((m) => el(`li.chip.chip-sm.${m.type === 'symptom' ? 'tone-sky' : 'tone-slate'}`, matchedLabel(m)))),
          el('div.suggest-actions',
            el('button.btn.btn-sm.btn-ghost', { type: 'button', onClick: () => openPointDrawer(pair.tracking.point, { pairId: pair.id }) }, icon('eye', { size: 16 }), t('scan.view')),
            el('button.btn.btn-sm.btn-secondary', { type: 'button', disabled: inScan || readOnly, onClick: () => { addToChecklist(pair.id); renderLeft(); renderSuggestions(box); syncViewer(); } }, inScan ? icon('check', { size: 16 }) : icon('plus', { size: 16 }), inScan ? t('scan.inScan') : t('scan.addToScan'))));
      })));
  }

  // ---- symptom chips (shared between directed tab and session panel)
  const symChipTargets = new Set();
  function renderSymptomChips() {
    for (const target of symChipTargets) {
      if (!target.isConnected) { symChipTargets.delete(target); continue; }
      clear(target);
      if (!st.symptoms.length) { target.append(el('p.muted.small', t('scan.noSymptoms'))); continue; }
      for (const sid of st.symptoms) {
        const s = symptomsCatalog.find((x) => x.id === sid);
        const name = s ? locText(s.name) : sid;
        target.append(el('span.chip.tone-sky.chip-removable', el('span', name),
          readOnly ? null : el('button.chip-x', { type: 'button', aria: { label: t('common.removeX', { x: name }) }, onClick: () => { st.symptoms = st.symptoms.filter((x) => x !== sid); patchSession({ symptoms: st.symptoms }); renderSymptomChips(); } }, icon('x', { size: 14 }))));
      }
    }
  }

  // ================================================================ CENTER: viewer
  const stage = el('div.stage');
  const viewerHost = el('div.viewer-host', el('div.viewer-loading', el('span.spinner'), el('span', t('viewer.loading'))));
  const drawer = el('aside.point-drawer', { hidden: true, aria: { label: t('scan.pointDetails') }, tabindex: '-1' });
  const viewSeg = segmented({ name: 'view', label: t('viewer.view'), value: st.view, size: 'sm',
    options: ['anterior', 'posterior', 'left', 'right'].map((v) => ({ value: v, label: t(`viewer.viewsShort.${v}`), title: t(`viewer.views.${v}`) })),
    onChange: (v) => { st.view = v; viewer && viewer.setView(v); } });
  const allToggle = toggleSwitch({ label: t('viewer.allPoints'), checked: st.showAll, onChange: (v) => { st.showAll = v; applyPointFilter(); } });
  const pointSearch = combobox({
    label: t('viewer.findPoint'), placeholder: t('viewer.findPoint'), size: 'sm', iconName: 'target',
    source: async (q) => {
      const n = q.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      return core.pointList.filter((p) => [p.name.en, p.name.es, ...(p.aliases || [])].filter(Boolean).some((s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().includes(n)))
        .slice(0, 10).map((p) => ({ id: p.id, label: locText(p.name), sublabel: p.name.es !== locText(p.name) ? p.name.es : (p.region ? t(`region.${p.region}`) : '') }));
    },
    onSelect: (it) => { const p = pointsMap.get(it.id); if (viewer) { viewer.highlight([it.id], { pulse: true }); viewer.focusPoint(it.id, p?.laterality === 'bilateral' ? 'R' : 'C'); } openPointDrawer(it.id); },
  });
  const listToggle = el('button.btn.btn-sm.btn-ghost', { type: 'button', aria: { expanded: 'false', controls: 'point-list' } }, icon('list', { size: 16 }), t('viewer.pointList'));
  const pointList = el('div#point-list.point-list', { hidden: true });
  listToggle.addEventListener('click', () => { const open = pointList.hidden; pointList.hidden = !open; listToggle.setAttribute('aria-expanded', open ? 'true' : 'false'); if (open) renderPointList(); });
  const legend = el('div.viewer-legend', { aria: { label: t('viewer.legend') }, role: 'group' },
    el('span.legend-item', el('span.mag.mag-neg', '−'), t('polarity.trackingNeg')),
    el('span.legend-item', el('span.mag.mag-pos', '+'), t('polarity.impactPos')));
  const fallbackNote = el('p.viewer-note', { hidden: true });
  mount(center,
    el('div.stage-toolbar', viewSeg, allToggle, el('div.stage-search', pointSearch.root), listToggle),
    el('div.stage-wrap', stage, drawer, pointList),
    el('div.stage-foot', legend, fallbackNote));
  stage.append(viewerHost);

  function renderPointList() {
    const byRegion = new Map();
    for (const p of core.pointList) { const r = p.region || 'other'; if (!byRegion.has(r)) byRegion.set(r, []); byRegion.get(r).push(p); }
    mount(pointList,
      el('div.point-list-head', el('h3', t('viewer.pointList')), el('button.icon-btn', { type: 'button', aria: { label: t('common.close') }, onClick: () => { pointList.hidden = true; listToggle.setAttribute('aria-expanded', 'false'); listToggle.focus(); } }, icon('x'))),
      [...byRegion.entries()].map(([r, ps]) => el('div.pl-group', el('p.pl-region', t(`region.${r}`)),
        el('ul', ps.map((p) => el('li', el('button.pl-btn', { type: 'button', onClick: () => { openPointDrawer(p.id); viewer && viewer.focusPoint(p.id, p.laterality === 'bilateral' ? 'R' : 'C'); } },
          el('span', locText(p.name)), p.laterality === 'bilateral' ? el('span.muted.small', t('point.bilateral')) : null)))))));
  }

  // Pairs with explicit multi-magnet placements (e.g. four-point pancreas) come from the pair detail.
  const pairMagnets = new Map();
  function ensurePairMagnets(pairId) {
    if (!pairId || pairMagnets.has(pairId)) return;
    pairMagnets.set(pairId, null);
    getPair(pairId).then((d) => { if (d && Array.isArray(d.magnets) && d.magnets.length) { pairMagnets.set(pairId, d.magnets); syncViewer(); } }).catch(() => {});
  }
  function magnetsAndPairs() {
    const mags = []; const prs = [];
    st.findings.forEach((f, i) => {
      const label = String(i + 1);
      const done = f.status === 'cleared' ? 'done' : 'active';
      ensurePairMagnets(f.pairId);
      const multi = pairMagnets.get(f.pairId);
      if (multi) {
        const seq = [...multi].sort((a, b) => (a.order || 0) - (b.order || 0));
        seq.forEach((m, k) => mags.push({ id: `${f.id}-m${k}`, pointId: m.point, side: m.side || 'C', polarity: m.polarity, label, state: done }));
        for (let k = 0; k + 1 < seq.length; k += 2) prs.push({ id: `${f.id}-p${k}`, a: { pointId: seq[k].point, side: seq[k].side || 'C' }, b: { pointId: seq[k + 1].point, side: seq[k + 1].side || 'C' }, state: f.status });
        return;
      }
      mags.push({ id: `${f.id}-n`, pointId: f.trackingPoint, side: f.trackingSide, polarity: 'negative', label, state: done });
      mags.push({ id: `${f.id}-p`, pointId: f.impactPoint, side: f.impactSide, polarity: 'positive', label, state: done });
      prs.push({ id: f.id, a: { pointId: f.trackingPoint, side: f.trackingSide }, b: { pointId: f.impactPoint, side: f.impactSide }, state: f.status });
    });
    const cur = st.checklist[st.cursor];
    if (cur && !findingFor(cur.pairId)) {
      const pair = pairOf(cur.pairId);
      if (pair) { const sd = defaultSides(pair); prs.push({ id: `cand-${pair.id}`, a: { pointId: pair.tracking.point, side: sd.trackingSide }, b: { pointId: pair.impact.point, side: sd.impactSide }, state: 'candidate' }); }
    }
    return { mags, prs };
  }
  function scanPointIds() {
    const ids = new Set();
    for (const c of st.checklist) { const p = pairOf(c.pairId); if (p) { ids.add(p.tracking.point); ids.add(p.impact.point); } }
    for (const f of st.findings) { ids.add(f.trackingPoint); ids.add(f.impactPoint); const mm = pairMagnets.get(f.pairId); if (mm) for (const m of mm) ids.add(m.point); }
    return [...ids].filter(Boolean);
  }
  let lastFilter = null;
  function applyPointFilter() {
    if (!viewer) return;
    try {
      viewer.setShowAllPoints(true);
      if (st.showAll) { lastFilter = null; viewer.setPointFilter(null); return; }
      const ids = scanPointIds(); const key = ids.sort().join('|');
      if (key !== lastFilter) { lastFilter = key; viewer.setPointFilter(ids); }
    } catch (e) { console.warn(e); }
  }
  function syncViewer() {
    if (!viewer) return;
    applyPointFilter();
    const { mags, prs } = magnetsAndPairs();
    try { viewer.setMagnets(mags); viewer.setPairs(prs); } catch (e) { console.warn(e); }
  }

  createViewer(viewerHost, {
    points: core.pointList, regions: core.regions, locale: getLocale(), polarity: polarity(), sex: patient.sex === 'female' || patient.sex === 'male' ? patient.sex : 'neutral',
    onPointClick: ({ pointId, side }) => openPointDrawer(pointId, { side }),
    onRegionClick: () => {},
    onHover: () => {},
  }).then(({ viewer: v, kind }) => {
    if (!root.isConnected) { v.dispose(); return; }
    viewer = v; viewerKind = kind;
    const ld = viewerHost.querySelector('.viewer-loading'); if (ld) ld.remove();
    viewer.setView(st.view); applyPointFilter();
    const notes = [];
    if (kind === '2d') notes.push(t('viewer.fallbackNote'));
    if (core.positioned < core.pointList.length) notes.push(t('viewer.missingAnatomy', { n: core.pointList.length - core.positioned }));
    if (notes.length) { fallbackNote.hidden = false; fallbackNote.textContent = notes.join(' '); }
    syncViewer();
    const cur = st.checklist[st.cursor]; if (cur) { const p = pairOf(cur.pairId); if (p) viewer.highlight([p.tracking.point, p.impact.point], { pulse: true }); }
    const ro = new ResizeObserver(() => { try { viewer.resize(); } catch { /* ignore */ } });
    ro.observe(stage);
    disposers.push(() => ro.disconnect());
  });
  disposers.push(() => { try { viewer && viewer.dispose(); } catch { /* ignore */ } });

  // ---- point drawer
  async function openPointDrawer(pointId, { pairId = null, side = null } = {}) {
    const p = pointsMap.get(pointId); if (!p) return;
    st.drawerPoint = pointId;
    drawer.hidden = false; drawer.classList.add('is-open');
    if (!pointList.hidden && stage.clientWidth < 760) { pointList.hidden = true; listToggle.setAttribute('aria-expanded', 'false'); }
    const altName = getLocale() === 'es' ? p.name.en : p.name.es;
    const body = el('div.drawer-body', skeleton(5));
    mount(drawer,
      el('div.drawer-head',
        el('div',
          el('p.eyebrow', [p.region ? t(`region.${p.region}`) : null, t(`point.${p.laterality || 'central'}`), side && side !== 'C' ? t(`side.${side}`) : null].filter(Boolean).join(' · ')),
          el('h2.drawer-title', locText(p.name)),
          altName && altName !== locText(p.name) ? el('p.drawer-alt', { lang: getLocale() === 'es' ? 'en' : 'es' }, altName) : null),
        el('button.icon-btn', { type: 'button', aria: { label: t('common.close') }, onClick: closeDrawer }, icon('x'))),
      body);
    drawer.focus({ preventScroll: true });
    if (viewer) viewer.highlight([pointId], { pulse: true });
    let list;
    try { list = await getPointPairs(pointId); } catch (err) { mount(body, alertBox({ tone: 'danger', children: [el('p', errorMessage(err))] })); return; }
    if (st.drawerPoint !== pointId) return;
    if (!list.length) { mount(body, emptyState({ icon: 'target', title: t('scan.noPairsAtPoint'), compact: true })); return; }
    const sorted = [...list].sort((a, b) => (b.id === pairId) - (a.id === pairId) || (a.number ?? 1e9) - (b.number ?? 1e9));
    mount(body,
      el('p.pd-label', t('scan.pairsAtPoint', { count: list.length })),
      el('ul.drawer-pairs', sorted.map((summary) => pairAccordion(summary, pointId, summary.id === pairId))));
  }
  function closeDrawer() {
    drawer.classList.remove('is-open'); drawer.hidden = true; st.drawerPoint = null;
    const cur = st.checklist[st.cursor]; const p = cur && pairOf(cur.pairId);
    if (viewer) viewer.highlight(p ? [p.tracking.point, p.impact.point] : [], { pulse: false });
  }
  function pairAccordion(summary, pointId, expanded) {
    const role = summary.role || (summary.tracking?.point === pointId && summary.impact?.point === pointId ? 'both' : summary.tracking?.point === pointId ? 'tracking' : 'impact');
    const s = stateOf(summary.id);
    const panelId = nextId('pa');
    const btn = el('button.pa-toggle', { type: 'button', aria: { expanded: expanded ? 'true' : 'false', controls: panelId } },
      el('span.pa-left', el('span.pair-num', pairNum(summary)), el('span.pa-name', locNode(summary.name)),
        el(`span.role-tag.role-${role}`, role === 'tracking' ? t('pair.roleTrackingShort') : role === 'impact' ? t('pair.roleImpactShort') : t('pair.roleBoth'))),
      el('span.pa-right', categoryChip(summary.category), s !== 'candidate' ? stateBadge(s) : null, icon('chevronDown', { size: 18, cls: 'pa-chev' })));
    const panel = el('div.pa-panel', { id: panelId, hidden: !expanded });
    const li = el('li.pa', btn, panel);
    const load = async () => {
      mount(panel, skeleton(4));
      try {
        const full = await getPair(summary.id);
        const inScan = st.checklist.some((c) => c.pairId === summary.id);
        const f = findingFor(summary.id);
        mount(panel, pairDetailBody(full, core, { role, onOpenPair: (pid) => { const q = pairOf(pid); if (q) openPointDrawer(q.tracking.point, { pairId: pid }); } }),
          readOnly ? null : el('div.pa-actions',
            el('button.btn.btn-primary', { type: 'button', disabled: !!f, onClick: () => { addFinding(summary.id, 'found'); setCursor(st.checklist.findIndex((c) => c.pairId === summary.id), { focus: false }); load(); } }, icon('target', { size: 18 }), f ? t('scan.alreadyFound') : t('scan.markFound')),
            el('button.btn.btn-secondary', { type: 'button', disabled: inScan, onClick: () => { addToChecklist(summary.id, 'manual'); renderLeft(); syncViewer(); load(); toast(t('scan.addedToScan', { count: 1 }), { tone: 'success' }); } }, icon('plus', { size: 18 }), inScan ? t('scan.inScan') : t('scan.addToScan'))));
      } catch (err) { mount(panel, alertBox({ tone: 'danger', children: [el('p', errorMessage(err))] })); }
    };
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false'); panel.hidden = !open;
      if (open) { load(); if (viewer) { const sd = summary.tracking ? defaultSides(summary) : null; viewer.highlight([summary.tracking?.point, summary.impact?.point].filter(Boolean), { pulse: true }); if (sd) viewer.setPairs([...magnetsAndPairs().prs, { id: 'preview', a: { pointId: summary.tracking.point, side: sd.trackingSide }, b: { pointId: summary.impact.point, side: sd.impactSide }, state: 'candidate' }]); } }
    });
    if (expanded) queueMicrotask(load);
    return li;
  }

  // ================================================================ RIGHT: session panel
  const chief = textarea({ rows: 2, id: 'chief', value: session.chiefComplaint || '', readOnly, placeholder: t('scan.chiefPlaceholder') });
  chief.addEventListener('input', debounce(() => patchSession({ chiefComplaint: chief.value.trim() || null }), 700));
  const symChipsRight = el('div.sym-chips');
  symChipTargets.add(symChipsRight);
  const symCb = readOnly ? null : combobox({
    label: t('scan.addSymptom'), placeholder: t('scan.addSymptom'), size: 'sm',
    source: async (q) => items(await api.get('/catalog/symptoms', { q })).filter((s) => !st.symptoms.includes(s.id)).slice(0, 8).map((s) => ({ id: s.id, label: locText(s.name), sublabel: vocab("systems", s.system) })),
    onSelect: (it) => { if (!st.symptoms.includes(it.id)) { st.symptoms.push(it.id); patchSession({ symptoms: st.symptoms }); renderSymptomChips(); } },
  });
  const findingsEl = el('ol.findings');
  const findingsCount = el('span.count-pill');
  const followInput = input({ type: 'date', id: 'follow-up', value: session.followUpDate || addDaysISO(session.startedAt, 7), readOnly });
  followInput.addEventListener('change', () => patchSession({ followUpDate: followInput.value || null }));
  if (!session.followUpDate && !readOnly) patchSession({ followUpDate: followInput.value });
  const notes = textarea({ rows: 3, id: 'session-notes', value: session.notes || '', readOnly, placeholder: t('scan.sessionNotesPlaceholder') });
  notes.addEventListener('input', debounce(() => patchSession({ notes: notes.value || null }), 900));

  mount(right,
    el('div.pane-head', el('h2.pane-title', t('scan.sessionPane')), el('button.icon-btn.pane-close', { type: 'button', aria: { label: t('common.close') }, onClick: () => setPane('right', false) }, icon('x'))),
    el('div.pane-scroll',
      el('section.sp-section', el('label.sp-label', { for: 'chief' }, t('session.chiefComplaint')), chief),
      el('section.sp-section', el('p.sp-label', t('scan.reportedSymptoms')), symChipsRight, symCb ? symCb.root : null),
      el('section.sp-section.sp-findings', el('div.sp-head', el('h3.sp-label', t('session.findings')), findingsCount), findingsEl),
      el('section.sp-section.grid-2',
        el('div.field', el('label.sp-label', { for: 'follow-up' }, t('scan.followUp')), followInput, el('p.field-hint', t('scan.followUpHint'))),
        live ? el('div.field', el('span.sp-label', t('scan.elapsed')), el('p.static.big-timer', elapsed.cloneNode(true))) : null),
      el('section.sp-section', el('label.sp-label', { for: 'session-notes' }, t('scan.sessionNotes')), notes)),
    readOnly ? null : el('div.pane-foot', el('button.btn.btn-primary.btn-lg.btn-block', { type: 'button', onClick: () => finalize() }, icon('shield', { size: 20 }), t('scan.finalize'))));
  const bigTimer = right.querySelector('.big-timer .timer-value');
  const syncBig = setInterval(() => { if (bigTimer) bigTimer.textContent = elapsed.textContent; }, 1000);
  disposers.push(() => clearInterval(syncBig));
  renderSymptomChips();

  function renderFindings() {
    findingsCount.textContent = String(st.findings.length);
    const badge = rightToggle.querySelector('.badge-count'); if (badge) badge.textContent = String(st.findings.length);
    clear(findingsEl);
    if (!st.findings.length) { findingsEl.append(el('li', emptyState({ icon: 'target', title: t('scan.noFindings'), body: readOnly ? null : t('scan.noFindingsBody'), compact: true }))); return; }
    st.findings.forEach((f, i) => findingsEl.append(findingCard(f, i)));
  }

  function findingCard(f, i) {
    const pair = f.pairId ? pairOf(f.pairId) : null;
    const open = st.expandedFinding === f.id;
    const detailsId = `fd-${i}`;
    const statusSeg = segmented({ name: `st-${f.id}`, label: t('session.status'), value: f.status, size: 'xs',
      options: FINDING_STATES.map((s) => ({ value: s, label: t(`state.${s}`) })), onChange: (v) => updateFinding(f.id, { status: v }) });
    if (readOnly) statusSeg.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    const timer = timers.get(f.id);
    const timerBtn = readOnly ? null : el(`button.btn.btn-sm.timer-btn${timer ? '.is-running' : ''}`, { type: 'button', data: { timer: f.id }, aria: { label: timer ? t('scan.stopTimer') : t('scan.startTimer', { min: f.dwellMinutes || 15 }) } },
      icon(timer ? 'pause' : 'timer', { size: 16 }), el('span.timer-text', timer ? fmtDuration(timer.endsAt - Date.now()) : t('scan.timerMin', { min: f.dwellMinutes || 15 })));
    if (timerBtn) timerBtn.addEventListener('click', () => toggleTimer(f));
    const card = el(`li.finding.state-${f.status}${open ? '.is-open' : ''}${f._pending ? '.is-pending' : ''}`,
      el('div.finding-top',
        el('span.finding-idx', { aria: { hidden: 'true' } }, String(i + 1)),
        el('div.finding-main',
          el('p.finding-name', pair ? el('span.pair-num', pairNum(pair)) : null, pair ? locNode(pair.name) : `${f.trackingPoint} – ${f.impactPoint}`),
          pairPoles(pair || { tracking: { point: f.trackingPoint }, impact: { point: f.impactPoint } }, pointsMap, { compact: true, sides: { tracking: f.trackingSide, impact: f.impactSide } }),
          pair ? el('div.finding-chips', categoryChip(pair.category), (f.phenomena || []).map((p) => chip(t(`phenomena.${p}`), 'violet', 'chip-sm'))) : null),
        el('button.icon-btn.finding-expand', { type: 'button', aria: { expanded: open ? 'true' : 'false', controls: detailsId, label: t('scan.findingDetails', { n: i + 1 }) } }, icon('chevronDown', { size: 18 }))),
      el('div.finding-row', statusSeg, timerBtn),
    );
    card.querySelector('.finding-expand').addEventListener('click', () => { st.expandedFinding = open ? null : f.id; renderFindings(); const b = findingsEl.querySelectorAll('.finding-expand')[i]; if (b) b.focus(); });
    if (open) card.append(findingDetails(f, detailsId));
    return card;
  }

  function sideSeg(label, val, onChange) {
    const s = segmented({ name: nextId('side'), label, value: val, size: 'xs', options: SIDES.map((x) => ({ value: x, label: t(`side.${x}short`), title: t(`side.${x}`) })), onChange });
    if (readOnly) s.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    return el('div.field', el('span.sp-label', label), s);
  }
  function toggleChips(label, all, selected, labelFn, onChange) {
    const sel = new Set(selected || []);
    return el('fieldset.chip-field', el('legend.sp-label', label), el('div.chip-toggles', all.map((v) => {
      const b = el('button.chip-toggle', { type: 'button', aria: { pressed: sel.has(v) ? 'true' : 'false' }, disabled: readOnly }, labelFn(v));
      b.addEventListener('click', () => { if (sel.has(v)) sel.delete(v); else sel.add(v); b.setAttribute('aria-pressed', sel.has(v) ? 'true' : 'false'); onChange([...sel]); });
      return b;
    })));
  }
  function findingDetails(f, idv) {
    const dwell = input({ type: 'number', min: 0, max: 240, step: 1, value: f.dwellMinutes ?? '', inputmode: 'numeric', class: 'input-num', readOnly, id: `${idv}-dwell` });
    dwell.addEventListener('change', () => { const v = dwell.value === '' ? null : Math.max(0, Math.min(240, Number(dwell.value))); updateFinding(f.id, { dwellMinutes: v }); });
    const step = (d) => { const v = Math.max(0, Math.min(240, (Number(dwell.value) || 0) + d)); dwell.value = v; updateFinding(f.id, { dwellMinutes: v }); };
    const fnotes = textarea({ rows: 2, value: f.notes || '', readOnly, id: `${idv}-notes`, placeholder: t('scan.findingNotesPlaceholder') });
    fnotes.addEventListener('input', debounce(() => updateFinding(f.id, { notes: fnotes.value || null }), 700));
    return el('div.finding-details', { id: idv },
      el('div.grid-2', sideSeg(t('scan.trackingSide'), f.trackingSide, (v) => updateFinding(f.id, { trackingSide: v })), sideSeg(t('scan.impactSide'), f.impactSide, (v) => updateFinding(f.id, { impactSide: v }))),
      el('div.grid-2',
        toggleChips(t('scan.qualTracking'), QUALIFIERS, f.qualifiers.tracking, (q) => t(`qualifier.${q}`), (v) => updateFinding(f.id, { qualifiers: { ...f.qualifiers, tracking: v } })),
        toggleChips(t('scan.qualImpact'), QUALIFIERS, f.qualifiers.impact, (q) => t(`qualifier.${q}`), (v) => updateFinding(f.id, { qualifiers: { ...f.qualifiers, impact: v } }))),
      toggleChips(t('scan.phenomena'), PHENOMENA, f.phenomena, (p) => t(`phenomena.${p}`), (v) => { updateFinding(f.id, { phenomena: v }); }),
      el('div.field', el('label.sp-label', { for: `${idv}-dwell` }, t('scan.dwell')),
        el('div.stepper-input', el('button.icon-btn', { type: 'button', aria: { label: t('scan.dwellLess') }, disabled: readOnly, onClick: () => step(-5) }, icon('minus', { size: 18 })), dwell, el('span.unit', t('scan.minutes')),
          el('button.icon-btn', { type: 'button', aria: { label: t('scan.dwellMore') }, disabled: readOnly, onClick: () => step(5) }, icon('plus', { size: 18 })))),
      el('div.field', el('label.sp-label', { for: `${idv}-notes` }, t('scan.findingNotes')), fnotes),
      readOnly ? null : el('div.btn-row.end',
        f.pairId ? el('button.btn.btn-sm.btn-ghost', { type: 'button', onClick: () => openPointDrawer(f.trackingPoint, { pairId: f.pairId }) }, icon('eye', { size: 16 }), t('scan.viewPair')) : null,
        el('button.btn.btn-sm.btn-ghost.danger', { type: 'button', onClick: () => removeFinding(f.id) }, icon('trash', { size: 16 }), t('common.remove'))));
  }

  // ---- per-finding dwell timers
  let audioCtx = null;
  function chime() {
    try {
      audioCtx = audioCtx || new AudioContext();
      const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = 528; g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.2, audioCtx.currentTime + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 1.4);
      o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 1.5);
    } catch { /* audio unavailable */ }
  }
  function toggleTimer(f) {
    if (timers.has(f.id)) { timers.delete(f.id); renderFindings(); return; }
    const mins = Number(f.dwellMinutes) || 15;
    timers.set(f.id, { endsAt: Date.now() + mins * 60000, total: mins });
    if (f.status === 'found') updateFinding(f.id, { status: 'impacted' }); else renderFindings();
    toast(t('scan.timerStarted', { min: mins }), { tone: 'info', timeout: 2500 });
  }
  function tickTimers() {
    for (const [fid, tm] of timers) {
      const left2 = tm.endsAt - Date.now();
      const b = findingsEl.querySelector(`[data-timer="${CSS.escape(fid)}"] .timer-text`);
      if (b) b.textContent = fmtDuration(left2);
      if (left2 <= 0) {
        timers.delete(fid);
        const f = st.findings.find((x) => x.id === fid); const pair = f && pairOf(f.pairId);
        chime();
        toast(t('scan.timerDone', { pair: pair ? locText(pair.name) : '' }), { tone: 'success', timeout: 12000, action: f ? { label: t('scan.markCleared'), onClick: () => updateFinding(fid, { status: 'cleared' }) } : null });
        renderFindings();
      }
    }
  }

  // ================================================================ finalize / amend
  async function finalize() {
    if (readOnly) return;
    const ok = await queue.flush();
    if (!ok) { toast(t('scan.cannotFinalizeUnsaved'), { tone: 'error' }); return; }
    const counts = Object.fromEntries(FINDING_STATES.map((s) => [s, st.findings.filter((f) => f.status === s).length]));
    const expected = (state.user && state.user.name) || '';
    const sig = input({ autocomplete: 'off', id: 'sig-name', placeholder: expected });
    const fSig = field({ label: t('scan.signatureName'), input: sig, hint: t('scan.signatureHint', { name: expected }), required: true });
    const attest = el('input', { type: 'checkbox', id: 'attest' });
    const errSlot = el('div', { aria: { live: 'assertive' } });
    const m = openModal({
      title: t('scan.finalizeTitle'), icon: 'shield', size: 'md',
      body: el('div.stack',
        el('dl.dl.dl-inline.finalize-summary',
          el('dt', t('patient.name')), el('dd', fullName(patient)),
          el('dt', t('session.findings')), el('dd', t('scan.finalizeCounts', { found: counts.found, impacted: counts.impacted, cleared: counts.cleared })),
          el('dt', t('scan.followUp')), el('dd', followInput.value ? fmtDate(followInput.value) : '—')),
        !st.findings.length ? alertBox({ tone: 'warn', children: [el('p', t('scan.finalizeNoFindings'))] }) : null,
        el('label.check.attest', attest, el('span', t('scan.attestation'))),
        fSig, errSlot,
        el('p.muted.small', t('scan.finalizeLock'))),
      actions: [
        { label: t('common.cancel'), value: null, variant: 'ghost' },
        { label: t('scan.signFinalize'), value: 'ok', variant: 'primary', icon: 'shield', onClick: async () => {
          fSig.setError(null); clear(errSlot);
          if (!attest.checked) { errSlot.append(alertBox({ tone: 'danger', children: [el('p', t('scan.attestRequired'))] })); attest.focus(); return false; }
          const typed = sig.value.trim();
          if (!typed) { fSig.setError(t('validation.required')); sig.focus(); return false; }
          if (expected && typed.toLowerCase().replace(/\s+/g, ' ') !== expected.toLowerCase().replace(/\s+/g, ' ')) { fSig.setError(t('scan.signatureMismatch', { name: expected })); sig.focus(); return false; }
          try {
            // Body-map images become part of the immutable report snapshot, so upload them while still a draft.
            await uploadBodyMaps().catch((e) => console.warn('body map upload failed', e));
            const res = await api.post(`/sessions/${session.id}/finalize`, { signatureName: typed });
            m.hashShort = res && (res.hashShort || (res.sha256 || '').slice(0, 16));
            return true;
          } catch (err) { errSlot.append(alertBox({ tone: 'danger', children: [el('p', errorMessage(err))] })); return false; }
        } },
      ],
    });
    if ((await m.result) === 'ok') {
      toast(m.hashShort ? t('scan.finalizedHash', { hash: m.hashShort }) : t('scan.finalized'), { tone: 'success', timeout: 7000 });
      runnerMemory.delete(session.id);
      setLeaveGuard(null);
      navigate(`/sessions/${session.id}/report`);
    }
  }
  async function uploadBodyMaps() {
    const mags = magnetsAndPairs().mags.map((x) => ({ ...x, state: x.state }));
    const snaps = await renderSnapshots({ points: core.pointList, regions: core.regions, polarity: polarity(), locale: getLocale(), magnets: mags, width: 800, height: 1100 });
    if (!snaps || !snaps.anterior || !snaps.posterior) return;
    await api.put(`/sessions/${session.id}/report/images`, { front: snaps.anterior, back: snaps.posterior });
  }
  async function amend() {
    const reason = textarea({ rows: 3, id: 'amend-reason' });
    const fR = field({ label: t('scan.amendReason'), input: reason, required: true, hint: t('scan.amendHint') });
    const m = openModal({ title: t('scan.amendTitle'), icon: 'edit', body: fR, actions: [
      { label: t('common.cancel'), value: null, variant: 'ghost' },
      { label: t('scan.amendCreate'), value: 'ok', variant: 'primary', onClick: async () => {
        if (!reason.value.trim()) { fR.setError(t('validation.required')); return false; }
        try { m.created = await api.post(`/sessions/${session.id}/amend`, { reason: reason.value.trim() }); return true; } catch (err) {
          if (err.code === 'AMENDMENT_IN_PROGRESS' && err.fields && err.fields.draftId) { m.created = { id: err.fields.draftId }; toast(t('scan.amendExisting'), { tone: 'info' }); return true; }
          if (err.code === 'ALREADY_SUPERSEDED' && session.supersededBy) { m.created = { id: session.supersededBy }; toast(t('scan.amendSuperseded'), { tone: 'info' }); return true; }
          fR.setError(errorMessage(err)); return false;
        }
      } }] });
    if ((await m.result) === 'ok' && m.created) navigate(`/sessions/${m.created.id}`);
  }

  // ================================================================ keyboard
  function showShortcuts() {
    const rows = [['J', t('scan.kNext')], ['K', t('scan.kPrev')], ['F', t('scan.kFound')], ['N', t('scan.kNotPresent')], ['I', t('scan.kImpacted')], ['C', t('scan.kCleared')], ['Enter', t('scan.kOpen')], ['/', t('scan.kSearch')], ['1–4', t('scan.kViews')], ['Esc', t('scan.kClose')]];
    openModal({ title: t('scan.shortcuts'), icon: 'keyboard', body: el('dl.shortcuts', rows.map(([k, d]) => [el('dt', kbd(k)), el('dd', d)])), actions: [{ label: t('common.close'), value: null, variant: 'primary', autofocus: true }] });
  }
  const onKey = (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') { if (!drawer.hidden) { closeDrawer(); e.preventDefault(); } else if (st.leftOpen || st.rightOpen) { setPane('left', false); setPane('right', false); } return; }
    if (isTypingTarget(e.target)) return;
    const k = e.key.toLowerCase();
    const cur = st.checklist[st.cursor];
    if (k === 'j' || e.key === 'ArrowDown' && checklistEl.contains(e.target)) { e.preventDefault(); setCursor(st.cursor + 1); }
    else if (k === 'k' || e.key === 'ArrowUp' && checklistEl.contains(e.target)) { e.preventDefault(); setCursor(st.cursor - 1); }
    else if (k === 'f' && cur) { e.preventDefault(); setItemState(cur.pairId, 'found'); }
    else if (k === 'n' && cur) { e.preventDefault(); setItemState(cur.pairId, 'not-present'); setCursor(st.cursor + 1); }
    else if (k === 'i' && cur) { e.preventDefault(); setItemState(cur.pairId, 'impacted'); }
    else if (k === 'c' && cur) { e.preventDefault(); setItemState(cur.pairId, 'cleared'); }
    else if (e.key === 'Enter' && cur && checklistEl.contains(e.target)) { e.preventDefault(); const p = pairOf(cur.pairId); if (p) openPointDrawer(p.tracking.point, { pairId: p.id }); }
    else if (e.key === '/') { e.preventDefault(); pointSearch.focus(); }
    else if (e.key === '?') { e.preventDefault(); showShortcuts(); }
    else if (['1', '2', '3', '4'].includes(e.key)) { const v = ['anterior', 'posterior', 'left', 'right'][Number(e.key) - 1]; st.view = v; viewSeg.setValue(v); viewer && viewer.setView(v); }
  };
  document.addEventListener('keydown', onKey);
  disposers.push(() => document.removeEventListener('keydown', onKey));

  setLeaveGuard(async () => {
    if (queue.pending) { const ok = await queue.flush(5000); if (!ok) return confirmDialog({ title: t('scan.unsavedTitle'), message: t('scan.unsavedBody'), confirmLabel: t('common.leave'), danger: true }); }
    return true;
  });
  const beforeUnload = (e) => { if (queue.pending) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  disposers.push(() => window.removeEventListener('beforeunload', beforeUnload));

  function renderAll() { renderChecklist(); renderFindings(); syncViewer(); if (st.drawerPoint && !drawer.hidden) { /* keep drawer as is */ } }
  renderAll();
  void viewerKind; void ratingsRow;
  return () => { for (const d of disposers) { try { d(); } catch { /* ignore */ } } };
}
