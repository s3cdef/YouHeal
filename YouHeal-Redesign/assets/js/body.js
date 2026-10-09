/* ==========================================================================
   YOU HEAL — body silhouette + anatomical landmarks (viewBox 0 0 400 900)
   Patient's RIGHT side is drawn on the viewer's LEFT (x < 200), as in a
   front-facing atlas. Posterior points are drawn as rings.
   ========================================================================== */
(function(){
  'use strict';
  const YH = window.YH = window.YH || {};

  /* right-hand outline as offsets from the midline (x-200, y) */
  const R = [
    [16,122],[18,142],[58,150],[90,160],[104,186],[112,240],[118,300],[126,370],[131,430],
    [134,470],[131,500],[118,520],[100,522],[91,505],[91,472],[90,430],[84,370],[80,305],[76,250],[70,205],
    [66,240],[58,320],[66,380],[76,430],[78,470],[74,530],[66,620],[62,700],[56,800],[56,850],
    [62,878],[44,886],[22,882],[18,860],[14,790],[12,700],[10,620],[8,540],[0,478]
  ];
  function outline(){
    const right = R.map(([dx,y])=>[200+dx,y]);
    const left  = R.slice(0,-1).reverse().map(([dx,y])=>[200-dx,y]);
    return right.concat(left);
  }
  /* Catmull-Rom -> cubic Bézier, closed */
  function smooth(pts, tension){
    tension = tension ?? 0.5; const n = pts.length; let d = `M${pts[0][0]},${pts[0][1]}`;
    for(let i=0;i<n;i++){
      const p0=pts[(i-1+n)%n], p1=pts[i], p2=pts[(i+1)%n], p3=pts[(i+2)%n];
      const c1x=p1[0]+(p2[0]-p0[0])*tension/3, c1y=p1[1]+(p2[1]-p0[1])*tension/3;
      const c2x=p2[0]-(p3[0]-p1[0])*tension/3, c2y=p2[1]-(p3[1]-p1[1])*tension/3;
      d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0]},${p2[1]}`;
    }
    return d+' Z';
  }
  YH.bodyPath = () => smooth(outline(), .55);

  YH.skeleton = function(){
    let s = `<path class="skeleton spine" d="M200,145 V472"/>`;
    s += `<path class="skeleton" d="M200,152 C222,146 246,150 262,160 M200,152 C178,146 154,150 138,160"/>`;
    for(let i=0;i<6;i++){
      const y=186+i*24, w=36+i*5-(i>3?i*4:0);
      s += `<path class="skeleton" d="M200,${y} C${200-w*.55},${y+2} ${200-w},${y+10} ${200-w},${y+22} M200,${y} C${200+w*.55},${y+2} ${200+w},${y+10} ${200+w},${y+22}"/>`;
    }
    s += `<path class="skeleton" d="M154,418 C146,470 178,484 200,474 C222,484 254,470 246,418"/>`;
    s += `<path class="skeleton" d="M160,418 C170,440 190,448 200,446 C210,448 230,440 240,418"/>`;
    s += `<circle class="skeleton" cx="178" cy="632" r="7"/><circle class="skeleton" cx="222" cy="632" r="7"/>`;
    s += `<path class="skeleton" d="M178,640 V840 M222,640 V840 M178,478 V625 M222,478 V625"/>`;
    s += `<path class="skeleton" d="M262,162 C292,220 300,300 302,302 C306,380 310,420 310,445 M138,162 C108,220 100,300 98,302 C94,380 90,420 90,445"/>`;
    s += `<ellipse class="skeleton" cx="200" cy="66" rx="30" ry="36"/>`;
    return s;
  };

  /* Landmarks with bilingual labels. posterior = drawn as a ring. */
  YH.POINTS = {
    crown:        {x:200,y:22,  en:'Crown',             es:'Coronilla'},
    brow:         {x:200,y:58,  en:'Brow',              es:'Entrecejo'},
    hypothalamus: {x:200,y:66,  en:'Hypothalamus',      es:'Hipotálamo'},
    pituitary:    {x:200,y:80,  en:'Pituitary',         es:'Hipófisis'},
    pineal:       {x:200,y:72,  en:'Pineal',            es:'Pineal', posterior:true},
    templeR:      {x:166,y:66,  en:'Right temple',      es:'Sien derecha'},
    templeL:      {x:234,y:66,  en:'Left temple',       es:'Sien izquierda'},
    cerebellum:   {x:200,y:102, en:'Cerebellum',        es:'Cerebelo', posterior:true},
    medulla:      {x:200,y:126, en:'Medulla (bulb)',    es:'Bulbo raquídeo', posterior:true},
    thyroid:      {x:200,y:142, en:'Thyroid',           es:'Tiroides'},
    thymus:       {x:200,y:178, en:'Thymus',            es:'Timo'},
    shoulderR:    {x:140,y:164, en:'Right shoulder',    es:'Hombro derecho'},
    shoulderL:    {x:260,y:164, en:'Left shoulder',     es:'Hombro izquierdo'},
    lungR:        {x:168,y:206, en:'Right lung',        es:'Pulmón derecho'},
    lungL:        {x:232,y:206, en:'Left lung',         es:'Pulmón izquierdo'},
    heart:        {x:214,y:220, en:'Heart',             es:'Corazón'},
    heartCenter:  {x:200,y:222, en:'Heart center',      es:'Centro del corazón'},
    solarPlexus:  {x:200,y:258, en:'Solar plexus',      es:'Plexo solar'},
    liver:        {x:166,y:272, en:'Liver',             es:'Hígado'},
    liverP:       {x:160,y:290, en:'Liver (posterior)', es:'Hígado (posterior)', posterior:true},
    spleenP:      {x:246,y:312, en:'Spleen (posterior)',es:'Bazo (posterior)', posterior:true},
    stomach:      {x:226,y:262, en:'Stomach',           es:'Estómago'},
    pylorus:      {x:212,y:280, en:'Pylorus',           es:'Píloro'},
    spleen:       {x:240,y:296, en:'Spleen',            es:'Bazo'},
    pancreas:     {x:208,y:294, en:'Pancreas',          es:'Páncreas'},
    adrenalR:     {x:170,y:306, en:'Right adrenal',     es:'Suprarrenal derecha', posterior:true},
    adrenalL:     {x:230,y:306, en:'Left adrenal',      es:'Suprarrenal izquierda', posterior:true},
    kidneyR:      {x:166,y:330, en:'Right kidney',      es:'Riñón derecho', posterior:true},
    kidneyL:      {x:234,y:330, en:'Left kidney',       es:'Riñón izquierdo', posterior:true},
    navel:        {x:200,y:342, en:'Navel',             es:'Ombligo'},
    colonR:       {x:160,y:376, en:'Ascending colon',   es:'Colon ascendente'},
    colonL:       {x:240,y:376, en:'Descending colon',  es:'Colon descendente'},
    appendix:     {x:166,y:402, en:'Appendix',          es:'Apéndice'},
    ovaryR:       {x:180,y:418, en:'Right ovary / testis', es:'Ovario / testículo derecho'},
    ovaryL:       {x:220,y:418, en:'Left ovary / testis',  es:'Ovario / testículo izquierdo'},
    bladder:      {x:200,y:434, en:'Bladder',           es:'Vejiga'},
    sacrum:       {x:200,y:446, en:'Sacrum',            es:'Sacro', posterior:true},
    prostate:     {x:200,y:458, en:'Prostate / uterus', es:'Próstata / útero'},
    rectum:       {x:200,y:472, en:'Rectum',            es:'Recto', posterior:true},
    coccyx:       {x:200,y:480, en:'Coccyx',            es:'Cóccix', posterior:true},
    root:         {x:200,y:470, en:'Root center',       es:'Centro raíz'},
    hipR:         {x:142,y:436, en:'Right hip',         es:'Cadera derecha'},
    hipL:         {x:258,y:436, en:'Left hip',          es:'Cadera izquierda'},
    elbowR:       {x:98, y:302, en:'Right elbow',       es:'Codo derecho'},
    elbowL:       {x:302,y:302, en:'Left elbow',        es:'Codo izquierdo'},
    wristR:       {x:90, y:446, en:'Right wrist',       es:'Muñeca derecha'},
    wristL:       {x:310,y:446, en:'Left wrist',        es:'Muñeca izquierda'},
    kneeR:        {x:178,y:632, en:'Right knee',        es:'Rodilla derecha'},
    kneeL:        {x:222,y:632, en:'Left knee',         es:'Rodilla izquierda'},
    ankleR:       {x:180,y:846, en:'Right ankle',       es:'Tobillo derecho'},
    ankleL:       {x:220,y:846, en:'Left ankle',        es:'Tobillo izquierdo'}
  };

  /* Build the full SVG markup. opts: {id, quantum, labels} */
  YH.bodySVG = function(opts){
    opts = opts || {};
    const rings = opts.quantum ? [60,110,160,215,275].map(r=>`<ellipse class="qring" cx="200" cy="440" rx="${r}" ry="${r*1.6}"/>`).join('') : '';
    return `<svg class="body-svg ${opts.quantum?'quantum':''}" id="${opts.id||'body'}" viewBox="0 0 400 900" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Body atlas">
      <defs>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <radialGradient id="skin" cx="50%" cy="40%" r="70%"><stop offset="0" stop-color="#F3EEE3" stop-opacity=".07"/><stop offset="1" stop-color="#F3EEE3" stop-opacity=".02"/></radialGradient>
      </defs>
      <g class="rings">${rings}</g>
      <ellipse class="silhouette" cx="200" cy="70" rx="40" ry="50" fill="url(#skin)"/>
      <path class="silhouette" d="${YH.bodyPath()}" fill="url(#skin)"/>
      <g class="bones">${YH.skeleton()}</g>
      <g class="pairs"></g>
      <g class="points"></g>
    </svg>`;
  };

  /* Render a set of pairs on an existing body svg. pairs: [{a,b,active}] */
  YH.renderPairs = function(svg, pairs, opts){
    opts = opts || {};
    const P = YH.POINTS, gp = svg.querySelector('.pairs'), gt = svg.querySelector('.points');
    let lines='', pts='';
    const seen = new Set();
    pairs.forEach(pr => {
      const A=P[pr.a], B=P[pr.b]; if(!A||!B) return;
      const mx=(A.x+B.x)/2, my=(A.y+B.y)/2, dx=B.x-A.x, dy=B.y-A.y, len=Math.hypot(dx,dy)||1;
      const bow = Math.min(90, 18+len*0.22) * (A.x<=200 && B.x<=200 ? -1 : 1) * (pr.flip?-1:1);
      const cx = mx + (-dy/len)*bow, cy = my + (dx/len)*bow;
      lines += `<path class="pair-line" data-pair="${pr.id}" d="M${A.x},${A.y} Q${cx.toFixed(1)},${cy.toFixed(1)} ${B.x},${B.y}" ${pr.active?'style="stroke-opacity:1;stroke-width:1.6"':''}/>`;
      [[pr.a,'n',A],[pr.b,'s',B]].forEach(([k,pol,pt])=>{
        if(seen.has(k+pol)) return; seen.add(k+pol);
        const label = opts.labels ? `<text x="${pt.x + (pt.x<200?-14:14)}" y="${pt.y+3}" text-anchor="${pt.x<200?'end':'start'}">${YH.L({en:pt.en,es:pt.es})}</text>` : '';
        pts += `<g class="pt ${pol} ${pt.posterior?'posterior':''} ${pr.active?'active':''}" data-point="${k}" data-pair="${pr.id}" tabindex="0" role="button" aria-label="${YH.L({en:pt.en,es:pt.es})}">
          <circle class="halo" cx="${pt.x}" cy="${pt.y}" r="12"/><circle class="core" cx="${pt.x}" cy="${pt.y}" r="6" filter="url(#glow)"/>${label}</g>`;
      });
    });
    gp.innerHTML = lines; gt.innerHTML = pts;
  };
})();
