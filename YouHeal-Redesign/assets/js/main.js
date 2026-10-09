/* ==========================================================================
   YOU HEAL — shared engine
   - bilingual dictionary + DOM binding (EN / ES, Colombian Spanish)
   - header / footer injection
   - dipole field-line canvas (used on gate, hero, atlas, CTA)
   - optional 528 Hz ambient tone (Web Audio, opt-in)
   ========================================================================== */
(function(){
  'use strict';
  const YH = window.YH = window.YH || {};

  /* ---------- Language ---------- */
  const LANGS = ['en','es'];
  function readLang(){
    const q = new URLSearchParams(location.search).get('lang');
    if(q && LANGS.includes(q)){ try{localStorage.setItem('yh_lang',q)}catch(e){} return q; }
    try{ const s = localStorage.getItem('yh_lang'); if(s && LANGS.includes(s)) return s; }catch(e){}
    return null;
  }
  YH.lang = readLang() || 'en';
  YH.hasLang = !!readLang();
  YH.idx = () => YH.lang === 'es' ? 1 : 0;

  /* dictionary: key -> [en, es] */
  const DICT = window.YH_DICT = Object.assign({
    'nav.home':        ['Home','Inicio'],
    'nav.atlas':       ['Atlas','Atlas'],
    'nav.history':     ['History','Historia'],
    'nav.science':     ['Science','Ciencia'],
    'nav.pathways':    ['Pathways','Modalidades'],
    'nav.lab':         ['Lab','Lab'],
    'nav.shop':        ['Magnets','Imanes'],
    'nav.stories':     ['Stories','Historias'],
    'nav.about':       ['Sandra','Sandra'],
    'nav.book':        ['Book a session','Agenda tu sesión'],
    'nav.menu':        ['Menu','Menú'],
    'brand.tag':       ['Biomagnetic pair therapy · Queens, NY','Par biomagnético · Queens, NY'],

    'foot.about':      ['YOU HEAL is the practice of Sandra Villafane, certified in Medical Biomagnetism in the lineage of Dr. Isaac Goiz Durán, with continuing training in Quantum Biomagnetism (Dr. Avelino Hervás). Sessions in Astoria, Queens and remotely.',
                        'YOU HEAL es la práctica de Sandra Villafane, certificada en Biomagnetismo Médico en el linaje del Dr. Isaac Goiz Durán, con formación continua en Biomagnetismo Cuántico (Dr. Avelino Hervás). Sesiones en Astoria, Queens y a distancia.'],
    'foot.disclaimer': ['Sandra Villafane is not a medical doctor and does not diagnose, treat, cure or prevent disease. Biomagnetic pair therapy is a complementary practice and is not a substitute for medical care. Keep taking the care your physician prescribes.',
                        'Sandra Villafane no es médica y no diagnostica, trata, cura ni previene enfermedades. La terapia del par biomagnético es una práctica complementaria y no reemplaza la atención médica. Continúa con los cuidados que te indique tu médico.'],
    'foot.explore':    ['Explore','Explora'],
    'foot.sessions':   ['Sessions','Sesiones'],
    'foot.contact':    ['Contact','Contacto'],
    'foot.inperson':   ['In person · Astoria, Queens','Presencial · Astoria, Queens'],
    'foot.remote':     ['Remote session','Sesión a distancia'],
    'foot.kits':       ['Magnet kits','Kits de imanes'],
    'foot.tone.title': ['528 Hz ambient tone','Tono ambiente de 528 Hz'],
    'foot.tone.sub':   ['Optional. Soft, low volume. Tap to start or stop.','Opcional. Suave y a bajo volumen. Toca para iniciar o detener.'],
    'foot.tone.btn':   ['Toggle 528 Hz tone','Activar o desactivar el tono de 528 Hz'],
    'foot.rights':     ['© 2026 YOU HEAL · Sandra Villafane · Astoria, Queens, NY 11103','© 2026 YOU HEAL · Sandra Villafane · Astoria, Queens, NY 11103'],
    'foot.proto':      ['Redesign prototype v1.0','Prototipo de rediseño v1.0'],
    'foot.lang':       ['Language','Idioma'],

    'common.learn':    ['Learn more','Conoce más'],
    'common.book':     ['Book a session','Agenda tu sesión'],
    'common.call':     ['Call 888-926-8114','Llama al 888-926-8114'],
    'common.explore':  ['Explore the atlas','Explora el atlas'],
    'common.north':    ['North pole (+)','Polo norte (+)'],
    'common.south':    ['South pole (−)','Polo sur (−)'],
    'common.northsub': ['Expansive · alkaline side of the pair','Expansivo · lado alcalino del par'],
    'common.southsub': ['Contractive · acidic side of the pair','Contractivo · lado ácido del par'],
    'common.fieldline':['Biomagnetic field line','Línea de campo biomagnético'],
    'common.posterior':['Posterior point (back of the body)','Punto posterior (espalda)'],
    'common.sample':   ['Sample content for the prototype. Replace before launch.','Contenido de muestra para el prototipo. Reemplázalo antes del lanzamiento.'],
    'common.added':    ['Added to your kit','Agregado a tu kit'],
    'common.cart':     ['Your kit','Tu kit'],
    'common.checkout': ['Request an order','Solicitar pedido'],
    'common.home':     ['Home','Inicio']
  }, window.YH_DICT || {});

  YH.t = (key) => { const v = DICT[key]; if(!v) return key; return v[YH.idx()] ?? v[0]; };

  function applyLang(root){
    root = root || document;
    document.documentElement.lang = YH.lang;
    root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = YH.t(el.getAttribute('data-i18n')); });
    root.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = YH.t(el.getAttribute('data-i18n-html')); });
    root.querySelectorAll('[data-i18n-attr]').forEach(el => {
      el.getAttribute('data-i18n-attr').split('|').forEach(pair => {
        const [attr,key] = pair.split(':'); if(attr && key) el.setAttribute(attr.trim(), YH.t(key.trim()));
      });
    });
    document.querySelectorAll('.lang-switch button').forEach(b => b.setAttribute('aria-pressed', b.dataset.lang === YH.lang ? 'true':'false'));
    const tKey = document.body && document.body.getAttribute('data-title');
    if(tKey && DICT[tKey]) document.title = YH.t(tKey) + ' · YOU HEAL';
  }
  YH.setLang = function(l){
    if(!LANGS.includes(l)) return;
    YH.lang = l; YH.hasLang = true;
    try{ localStorage.setItem('yh_lang', l); }catch(e){}
    applyLang();
    document.dispatchEvent(new CustomEvent('yh:lang', {detail:{lang:l}}));
  };
  YH.apply = applyLang;
  /* bilingual helper for data objects {en,es} */
  YH.L = (obj) => (obj && typeof obj === 'object') ? (obj[YH.lang] ?? obj.en) : obj;

  /* ---------- Brand mark ---------- */
  YH.mark = function(size){
    size = size || 40;
    return `<svg class="mark" viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true">
      <g fill="none" stroke="#D4AF6A" stroke-width="1.2">
        <ellipse cx="24" cy="24" rx="20" ry="9"/>
        <ellipse cx="24" cy="24" rx="20" ry="9" transform="rotate(60 24 24)"/>
        <ellipse cx="24" cy="24" rx="20" ry="9" transform="rotate(-60 24 24)"/>
      </g>
      <circle cx="24" cy="9" r="3.2" fill="#F0715A"/>
      <circle cx="24" cy="39" r="3.2" fill="#5B8DEF"/>
      <circle cx="24" cy="24" r="2.2" fill="#F1D9A3"/>
    </svg>`;
  };
  YH.arc = () => `<svg viewBox="0 0 34 18" aria-hidden="true"><path d="M2 16 C 8 2, 26 2, 32 16" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="2" cy="16" r="2" fill="#F0715A"/><circle cx="32" cy="16" r="2" fill="#5B8DEF"/></svg>`;

  /* ---------- Header / footer ---------- */
  const PAGES = [
    ['home.html','nav.home'],['atlas.html','nav.atlas'],['history.html','nav.history'],['science.html','nav.science'],
    ['pathways.html','nav.pathways'],['lab.html','nav.lab'],['shop.html','nav.shop'],['stories.html','nav.stories'],['about.html','nav.about']
  ];
  function current(){ const p = location.pathname.split('/').pop() || 'index.html'; return p; }

  function header(){
    const cur = current();
    const links = PAGES.map(([href,key]) => `<a href="${href}" ${cur===href?'aria-current="page"':''} data-i18n="${key}"></a>`).join('');
    return `
    <div class="wrap">
      <a class="brand" href="home.html" aria-label="YOU HEAL home">
        ${YH.mark(40)}
        <span><span class="word">YOU HEAL</span><span class="tag" data-i18n="brand.tag"></span></span>
      </a>
      <nav class="nav" aria-label="Primary">${links}</nav>
      <div class="header-actions">
        <div class="lang-switch" role="group" aria-label="Language">
          <button type="button" data-lang="en" aria-pressed="false">EN</button>
          <button type="button" data-lang="es" aria-pressed="false">ES</button>
        </div>
        <a class="btn btn-primary btn-sm book-btn" href="about.html#book" data-i18n="nav.book"></a>
        <button class="menu-btn" type="button" aria-expanded="false" aria-controls="drawer" data-i18n-attr="aria-label:nav.menu">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6h14M3 10h14M3 14h14"/></svg>
        </button>
      </div>
    </div>
    <div class="drawer" id="drawer">
      ${links}
      <a class="btn btn-primary book-btn" href="about.html#book" data-i18n="nav.book"></a>
    </div>`;
  }
  function footer(){
    return `
    <div class="wrap">
      <div class="cols">
        <div>
          <a class="brand" href="home.html">${YH.mark(34)}<span><span class="word">YOU HEAL</span></span></a>
          <p class="muted" style="margin:16px 0 12px;font-size:var(--fs-1)" data-i18n="foot.about"></p>
          <p class="disclaimer" data-i18n="foot.disclaimer"></p>
        </div>
        <div>
          <h4 data-i18n="foot.explore"></h4>
          <ul>
            <li><a href="atlas.html" data-i18n="nav.atlas"></a></li>
            <li><a href="history.html" data-i18n="nav.history"></a></li>
            <li><a href="science.html" data-i18n="nav.science"></a></li>
            <li><a href="lab.html" data-i18n="nav.lab"></a></li>
            <li><a href="stories.html" data-i18n="nav.stories"></a></li>
          </ul>
        </div>
        <div>
          <h4 data-i18n="foot.sessions"></h4>
          <ul>
            <li><a href="pathways.html#inperson" data-i18n="foot.inperson"></a></li>
            <li><a href="pathways.html#remote" data-i18n="foot.remote"></a></li>
            <li><a href="shop.html" data-i18n="foot.kits"></a></li>
            <li><a href="about.html#book" data-i18n="nav.book"></a></li>
          </ul>
        </div>
        <div>
          <h4 data-i18n="foot.contact"></h4>
          <ul>
            <li><a href="tel:+18889268114">888-926-8114</a></li>
            <li><a href="mailto:youheal.us@gmail.com">youheal.us@gmail.com</a></li>
            <li><a href="https://instagram.com/youheal.us" rel="noopener" target="_blank">Instagram @youheal.us</a></li>
            <li><a href="https://tiktok.com/@youheal" rel="noopener" target="_blank">TikTok @youheal</a></li>
          </ul>
          <div class="tone" style="margin-top:18px">
            <button type="button" id="tone-btn" aria-pressed="false" data-i18n-attr="aria-label:foot.tone.btn">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 12h3l2-7 4 14 3-9 2 4h4"/></svg>
            </button>
            <div><b data-i18n="foot.tone.title"></b><span data-i18n="foot.tone.sub"></span></div>
          </div>
          <div class="freq-ruler" aria-hidden="true"></div>
        </div>
      </div>
      <div class="bottom">
        <span data-i18n="foot.rights"></span>
        <span data-i18n="foot.proto"></span>
      </div>
    </div>`;
  }

  /* ---------- Toast ---------- */
  let toastEl, toastT;
  YH.toast = function(msg){
    if(!toastEl){ toastEl = document.createElement('div'); toastEl.className='toast'; toastEl.setAttribute('role','status'); document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(()=>toastEl.classList.remove('show'), 2200);
  };

  /* ---------- Field-line canvas ---------- */
  YH.field = function(canvas, o){
    o = o || {};
    const ctx = canvas.getContext('2d');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const color = o.color || '#D4AF6A', pc = o.particleColor || '#F1D9A3';
    let W=0,H=0,dpr=1,off,lines=[],parts=[],raf=null,visible=true;

    function build(){
      lines = [];
      const dips = o.dipoles || [{x:.5,y:.5,scale:1,lines:12}];
      for(const d of dips){
        const cx=d.x*W, cy=d.y*H, base=(d.scale||1)*Math.min(W,H)*0.55, N=d.lines||12, sq=d.squash||1;
        for(let i=1;i<=N;i++){
          const L = base*(0.1+1.3*Math.pow(i/N,1.6));
          for(const s of [1,-1]){
            const pts=[];
            for(let t=0.03;t<=Math.PI-0.03;t+=0.015){ const r=L*Math.sin(t)*Math.sin(t); pts.push([cx+s*r*Math.sin(t)*sq, cy-r*Math.cos(t)]); }
            lines.push(pts);
          }
        }
      }
      off = document.createElement('canvas'); off.width=W*dpr; off.height=H*dpr;
      const oc = off.getContext('2d'); oc.setTransform(dpr,0,0,dpr,0,0);
      oc.lineWidth = o.lineWidth || 1; oc.strokeStyle=color; oc.globalAlpha = o.alpha ?? .2;
      for(const pts of lines){ oc.beginPath(); pts.forEach((p,j)=> j?oc.lineTo(p[0],p[1]):oc.moveTo(p[0],p[1])); oc.stroke(); }
      parts=[]; const n = reduced ? 0 : (o.particles ?? 60);
      for(let i=0;i<n;i++) parts.push({l:(Math.random()*lines.length)|0, t:Math.random(), v:(0.0006+Math.random()*0.0014)*(o.speed||1)});
    }
    function resize(){
      dpr = Math.min(window.devicePixelRatio||1, 2);
      W = canvas.clientWidth || 300; H = canvas.clientHeight || 300;
      canvas.width = W*dpr; canvas.height = H*dpr; ctx.setTransform(dpr,0,0,dpr,0,0);
      build(); draw();
    }
    function draw(){
      ctx.clearRect(0,0,W,H); ctx.drawImage(off,0,0,W,H);
      for(const p of parts){
        p.t += p.v; if(p.t>=1){ p.t=0; p.l=(Math.random()*lines.length)|0; }
        const pts = lines[p.l]; const [x,y] = pts[(p.t*(pts.length-1))|0];
        ctx.globalAlpha=.14; ctx.fillStyle=pc; ctx.beginPath(); ctx.arc(x,y,5,0,6.2832); ctx.fill();
        ctx.globalAlpha=.95; ctx.beginPath(); ctx.arc(x,y,1.5,0,6.2832); ctx.fill();
      }
      ctx.globalAlpha=1;
    }
    function loop(){ if(!visible || reduced || !parts.length){ raf=null; return; } draw(); raf=requestAnimationFrame(loop); }
    function start(){ if(!raf) raf=requestAnimationFrame(loop); }
    new ResizeObserver(resize).observe(canvas);
    if('IntersectionObserver' in window){
      new IntersectionObserver(es=>{ visible = es[0].isIntersecting; if(visible) start(); }).observe(canvas);
    }
    resize(); start();
    return { restyle(opts){ Object.assign(o, opts); build(); draw(); } };
  };

  /* ---------- 528 Hz ambient tone ---------- */
  let actx, gainNode, oscs=[], toneOn=false;
  function toneStart(){
    const AC = window.AudioContext || window.webkitAudioContext; if(!AC) return false;
    actx = actx || new AC(); if(actx.state==='suspended') actx.resume();
    gainNode = actx.createGain(); gainNode.gain.value = 0; gainNode.connect(actx.destination);
    const make = (f, g, type) => { const o=actx.createOscillator(), gg=actx.createGain(); o.type=type||'sine'; o.frequency.value=f; gg.gain.value=g; o.connect(gg); gg.connect(gainNode); o.start(); oscs.push(o); };
    make(528, .55); make(264, .18); make(792, .08);           // fundamental, octave below, fifth above
    const lfo = actx.createOscillator(), lg = actx.createGain(); lfo.frequency.value=.08; lg.gain.value=.12; lfo.connect(lg); lg.connect(gainNode.gain); lfo.start(); oscs.push(lfo);
    gainNode.gain.linearRampToValueAtTime(.06, actx.currentTime+2);
    return true;
  }
  function toneStop(){
    if(!gainNode) return;
    const g = gainNode, os = oscs; oscs=[];
    g.gain.cancelScheduledValues(actx.currentTime); g.gain.linearRampToValueAtTime(0, actx.currentTime+1.2);
    setTimeout(()=>{ os.forEach(o=>{ try{o.stop()}catch(e){} }); g.disconnect(); }, 1400);
  }
  YH.toggleTone = function(btn){
    toneOn = !toneOn;
    if(toneOn){ if(!toneStart()) { toneOn=false; return; } } else toneStop();
    document.querySelectorAll('#tone-btn').forEach(b=>b.setAttribute('aria-pressed', toneOn?'true':'false'));
  };

  /* ---------- Boot ---------- */
  function boot(){
    const h = document.getElementById('site-header'); if(h){ h.className='site-header'; h.innerHTML = header(); }
    const f = document.getElementById('site-footer'); if(f){ f.className='site-footer'; f.innerHTML = footer(); }
    document.querySelectorAll('.field-rule').forEach(r => { if(!r.innerHTML.trim()) r.innerHTML = YH.arc(); });
    applyLang();
    document.addEventListener('click', e => {
      const lb = e.target.closest('.lang-switch button'); if(lb){ YH.setLang(lb.dataset.lang); return; }
      const mb = e.target.closest('.menu-btn'); if(mb){ const d=document.getElementById('drawer'); const open=!d.classList.contains('open'); d.classList.toggle('open',open); mb.setAttribute('aria-expanded',open); return; }
      const tb = e.target.closest('#tone-btn'); if(tb){ YH.toggleTone(tb); return; }
    });
    document.dispatchEvent(new CustomEvent('yh:ready'));
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
