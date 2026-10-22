// Sample catalog for the mock server. Illustrative test fixtures only — NOT clinical reference data.
// Point positions follow CONTRACT §4.3 (meters; feet y=0; vertex ≈1.75; faces +z; +x = patient's LEFT;
// bilateral pos = patient-RIGHT instance, x<0).

export const sources = [
  { id: 'goiz-n1', title: 'Guía de Pares Biomagnéticos — 1er Nivel (2017)', author: 'David Goiz Martínez / BRI', license_status: 'internal-use', notice: 'GOIZ ™ Intellectual Property © All rights reserved' },
  { id: 'goiz-n2', title: 'Guía de Pares Biomagnéticos — 2do Nivel', author: 'David Goiz Martínez / BRI', license_status: 'internal-use', notice: 'GOIZ ™ Intellectual Property © All rights reserved' },
  { id: 'leal-2018', title: 'Padecimientos y Patógenos (2018)', author: 'Leal', license_status: 'internal-use', notice: 'All rights reserved' },
  { id: 'youheal', title: 'YOU HEAL original content', author: 'YOU HEAL', license_status: 'original', notice: '' },
];

export const regions = [
  ['head', 'Cabeza', 'Head'], ['face', 'Cara', 'Face'], ['neck', 'Cuello', 'Neck'], ['thorax', 'Tórax', 'Thorax'],
  ['abdomen', 'Abdomen', 'Abdomen'], ['pelvis', 'Pelvis', 'Pelvis'], ['upper-back', 'Espalda alta', 'Upper back'],
  ['lower-back', 'Espalda baja', 'Lower back'], ['arm', 'Brazo', 'Arm'], ['forearm', 'Antebrazo', 'Forearm'], ['hand', 'Mano', 'Hand'],
  ['thigh', 'Muslo', 'Thigh'], ['knee', 'Rodilla', 'Knee'], ['leg', 'Pierna', 'Leg'], ['foot', 'Pie', 'Foot'],
].map(([id, es, en]) => ({ id, name: { es, en }, parent: null }));

const P = (id, es, en, laterality, region, view, x, y, z) => ({ id, name: { es, en }, aliases: [es], laterality, region, view, pos: { x, y, z } });
export const points = [
  P('hipofisis', 'Hipófisis', 'Pituitary', 'central', 'head', 'anterior', 0, 1.66, 0.09),
  P('timo', 'Timo', 'Thymus', 'central', 'thorax', 'anterior', 0, 1.33, 0.10),
  P('pulmon', 'Pulmón', 'Lung', 'bilateral', 'thorax', 'anterior', -0.09, 1.29, 0.11),
  P('axila', 'Axila', 'Armpit', 'bilateral', 'thorax', 'lateral', -0.165, 1.25, 0.0),
  P('higado', 'Hígado', 'Liver', 'central', 'abdomen', 'anterior', -0.09, 1.135, 0.11),
  P('vesicula', 'Vesícula biliar', 'Gallbladder', 'central', 'abdomen', 'anterior', -0.06, 1.095, 0.12),
  P('estomago', 'Estómago', 'Stomach', 'central', 'abdomen', 'anterior', 0.06, 1.15, 0.12),
  P('bazo', 'Bazo', 'Spleen', 'central', 'abdomen', 'anterior', 0.12, 1.12, 0.08),
  P('pancreas', 'Páncreas', 'Pancreas', 'central', 'abdomen', 'anterior', 0.02, 1.08, 0.12),
  P('duodeno', 'Duodeno', 'Duodenum', 'central', 'abdomen', 'anterior', -0.03, 1.04, 0.12),
  P('vejiga', 'Vejiga', 'Bladder', 'central', 'pelvis', 'anterior', 0, 0.91, 0.09),
  P('ingle', 'Ingle', 'Groin', 'bilateral', 'pelvis', 'anterior', -0.095, 0.86, 0.08),
  P('suprarrenal', 'Suprarrenal', 'Adrenal', 'bilateral', 'lower-back', 'posterior', -0.06, 1.14, -0.11),
  P('rinon', 'Riñón', 'Kidney', 'bilateral', 'lower-back', 'posterior', -0.075, 1.06, -0.11),
  P('recto', 'Recto', 'Rectum', 'central', 'pelvis', 'posterior', 0, 0.9, -0.10),
  P('ciatico', 'Ciático', 'Sciatic', 'bilateral', 'pelvis', 'posterior', -0.095, 0.82, -0.10),
  P('popliteo', 'Poplíteo', 'Popliteal', 'bilateral', 'knee', 'posterior', -0.092, 0.5, -0.05),
  P('gastrocnemio', 'Gastrocnemio', 'Gastrocnemius', 'bilateral', 'leg', 'posterior', -0.09, 0.36, -0.06),
];

export const entities = [
  { id: 'vih', name: { es: 'VIH', en: 'HIV' }, kind: 'pathogen', classification: 'virus', description: { es: 'Virus de inmunodeficiencia humana.' }, source: { doc: 'leal-2018', page: 456 } },
  { id: 'e-coli', name: { es: 'Escherichia coli', en: 'Escherichia coli' }, kind: 'pathogen', classification: 'bacteria', description: { es: 'Bacteria entérica.' }, source: { doc: 'leal-2018', page: 210 } },
  { id: 'staphylococcus-aureus', name: { es: 'Staphylococcus aureus', en: 'Staphylococcus aureus' }, kind: 'pathogen', classification: 'bacteria', source: { doc: 'leal-2018', page: 612 } },
  { id: 'streptococcus-pneumoniae', name: { es: 'Streptococcus pneumoniae', en: 'Streptococcus pneumoniae' }, kind: 'pathogen', classification: 'bacteria', source: { doc: 'leal-2018', page: 620 } },
  { id: 'helicobacter-pylori', name: { es: 'Helicobacter pylori', en: 'Helicobacter pylori' }, kind: 'pathogen', classification: 'bacteria', source: { doc: 'leal-2018', page: 330 } },
  { id: 'candida-albicans', name: { es: 'Candida albicans', en: 'Candida albicans' }, kind: 'pathogen', classification: 'fungus', source: { doc: 'leal-2018', page: 140 } },
  { id: 'giardia-lamblia', name: { es: 'Giardia lamblia', en: 'Giardia lamblia' }, kind: 'pathogen', classification: 'parasite', source: { doc: 'leal-2018', page: 300 } },
  { id: 'desintoxicacion', name: { es: 'Desintoxicación', en: 'Detoxification' }, kind: 'condition', classification: 'dysfunctional', source: { doc: 'goiz-n2', page: 88 } },
  { id: 'balance-hormonal', name: { es: 'Balance hormonal (cortisol)', en: 'Hormonal balance (cortisol)' }, kind: 'condition', classification: 'dysfunctional', source: { doc: 'goiz-n2', page: 88 } },
  { id: 'circulacion-mp', name: { es: 'Circulación de miembros pélvicos', en: 'Lower-limb circulation' }, kind: 'condition', classification: 'dysfunctional', source: { doc: 'goiz-n2', page: 88 } },
  { id: 'lumbociatica', name: { es: 'Lumbociática', en: 'Lumbosciatica' }, kind: 'condition', classification: 'dysfunctional', source: { doc: 'leal-2018', page: 402 } },
  { id: 'ansiedad', name: { es: 'Ansiedad', en: 'Anxiety' }, kind: 'condition', classification: 'psychoemotional', source: { doc: 'leal-2018', page: 60 } },
  { id: 'abraham', name: { es: 'Abraham', en: 'Abraham' }, kind: 'named-pair', classification: 'special', description: { es: 'Par con nombre propio (ejemplo de prueba).' }, source: { doc: 'leal-2018', page: 12 } },
];

const S = (system, es, en) => ({ system, text: en ? { es, en } : { es } });
const pair = (id, number, level, tPoint, tSide, iPoint, iSide, category, relations, ratings, symptoms, recommendations, page, doc = 'goiz-n1') => ({
  id, number, level, tracking: { point: tPoint, side: tSide, qualifiers: [] }, impact: { point: iPoint, side: iSide, qualifiers: [] },
  category, relations: relations.map(([entity, ordinal]) => ({ entity, ordinal })), ratings, symptoms, recommendations, notes: [], source: { doc, page },
});

export const pairs = [
  pair('pb-001', 1, 1, 'timo', 'C', 'recto', 'C', 'virus', [['vih', 1], ['e-coli', 1]], { F: 3, P: 2, R: 1 },
    [S('immunological', 'Disminución de la respuesta inmunitaria', 'Decreased immune response'), S('general', 'Fatiga persistente', 'Persistent fatigue'), S('gastrointestinal', 'Diarrea crónica', 'Chronic diarrhea')],
    [{ es: 'Rastreo dirigido con el imán e impactación profiláctica en: Inmunodeficiencia (SIDA)', en: 'Directed scan with the magnet and prophylactic impact for: Immunodeficiency (AIDS)' }], 25),
  pair('pb-014', 14, 1, 'axila', 'R', 'axila', 'L', 'bacteria', [['staphylococcus-aureus', 1]], { F: 2, P: 2, R: 2 },
    [S('dermatological', 'Abscesos axilares', 'Axillary abscesses'), S('immunological', 'Inflamación de ganglios', 'Swollen lymph nodes')],
    [{ es: 'Revisar higiene y ropa ajustada; repetir rastreo en 7 días.' }], 31),
  pair('pb-022', 22, 1, 'pulmon', 'R', 'pulmon', 'L', 'bacteria', [['streptococcus-pneumoniae', 1]], { F: 2, P: 3, R: 2 },
    [S('respiratory', 'Tos productiva', 'Productive cough'), S('general', 'Fiebre', 'Fever')],
    [{ es: 'Valoración médica si hay fiebre persistente o dificultad respiratoria.', en: 'Medical evaluation if fever persists or breathing becomes difficult.' }], 36),
  pair('pb-047', 47, 1, 'estomago', 'C', 'pancreas', 'C', 'bacteria', [['helicobacter-pylori', 1]], { F: 3, P: 2, R: 2 },
    [S('gastrointestinal', 'Gastritis', 'Gastritis'), S('gastrointestinal', 'Distensión abdominal', 'Abdominal bloating')],
    [{ es: 'Dieta blanda durante la semana posterior al tratamiento.' }], 48),
  pair('pb-063', 63, 1, 'vesicula', 'C', 'duodeno', 'C', 'fungus', [['candida-albicans', 2]], { F: 2, P: 1, R: 2 },
    [S('gastrointestinal', 'Distensión abdominal', 'Abdominal bloating'), S('dermatological', 'Prurito', 'Itching')],
    [{ es: 'Reducir azúcares refinados.', en: 'Reduce refined sugars.' }], 55),
  pair('pb-088', 88, 1, 'bazo', 'C', 'pancreas', 'C', 'parasite', [['giardia-lamblia', 1]], { F: 1, P: 2, R: 3 },
    [S('gastrointestinal', 'Diarrea', 'Diarrhea'), S('general', 'Pérdida de peso', 'Weight loss')],
    [{ es: 'Hidratación oral abundante.', en: 'Plenty of oral hydration.' }], 63),
  pair('pb-112', 112, 1, 'hipofisis', 'C', 'vejiga', 'C', 'psychoemotional', [['ansiedad', 1]], { F: 2, P: 1, R: 2 },
    [S('psychiatric', 'Ansiedad', 'Anxiety'), S('psychiatric', 'Insomnio', 'Insomnia'), S('neurological', 'Cefalea tensional', 'Tension headache')],
    [{ es: 'Acompañar con higiene del sueño.', en: 'Pair with sleep-hygiene guidance.' }], 72),
  pair('pb-231', 231, 2, 'higado', 'C', 'higado', 'C', 'dysfunctional', [['desintoxicacion', 1]], { F: 3, P: 1, R: 3 },
    [S('gastrointestinal', 'Digestión lenta', 'Sluggish digestion'), S('general', 'Fatiga', 'Fatigue'), S('dermatological', 'Piel opaca', 'Dull skin')],
    [{ es: 'Aplicar 30 a 45 min; aumentar consumo de agua.', en: 'Apply 30–45 min; increase water intake.' }], 88, 'goiz-n2'),
  pair('pb-232', 232, 2, 'rinon', 'R', 'rinon', 'L', 'dysfunctional', [['desintoxicacion', 1]], { F: 3, P: 1, R: 3 },
    [S('urological', 'Retención de líquidos', 'Fluid retention'), S('musculoskeletal', 'Dolor lumbar', 'Low-back pain')],
    [{ es: 'Aplicar 30 a 45 min.', en: 'Apply 30–45 min.' }], 88, 'goiz-n2'),
  pair('pb-233', 233, 2, 'suprarrenal', 'R', 'suprarrenal', 'L', 'dysfunctional', [['balance-hormonal', 1]], { F: 2, P: 1, R: 3 },
    [S('endocrine', 'Estrés crónico', 'Chronic stress'), S('general', 'Cansancio matutino', 'Morning tiredness')],
    [{ es: 'Balance hormonal (cortisol).', en: 'Hormonal balance (cortisol).' }], 88, 'goiz-n2'),
  pair('pb-234', 234, 2, 'ingle', 'R', 'ingle', 'L', 'dysfunctional', [['circulacion-mp', 1]], { F: 2, P: 1, R: 3 },
    [S('cardiological', 'Piernas pesadas', 'Heavy legs'), S('cardiological', 'Várices', 'Varicose veins')],
    [{ es: 'En caso de síntomas agudos aplicar 30 a 45 min 2 a 3 veces al día.' }], 88, 'goiz-n2'),
  pair('pb-235', 235, 2, 'ciatico', 'R', 'ciatico', 'L', 'dysfunctional', [['lumbociatica', 1], ['circulacion-mp', 2]], { F: 2, P: 2, R: 2 },
    [S('musculoskeletal', 'Dolor lumbar irradiado a la pierna', 'Low-back pain radiating to the leg'), S('neurological', 'Hormigueo en piernas', 'Tingling in the legs')],
    [{ es: 'Evitar cargar peso durante 48 h.', en: 'Avoid heavy lifting for 48 h.' }], 88, 'goiz-n2'),
  pair('pb-236', 236, 2, 'popliteo', 'R', 'popliteo', 'L', 'dysfunctional', [['circulacion-mp', 1]], { F: 2, P: 1, R: 3 },
    [S('cardiological', 'Piernas pesadas', 'Heavy legs'), S('musculoskeletal', 'Calambres', 'Cramps')],
    [{ es: 'Circulación MP.', en: 'Lower-limb circulation.' }], 88, 'goiz-n2'),
  pair('pb-237', 237, 2, 'gastrocnemio', 'R', 'gastrocnemio', 'L', 'dysfunctional', [['circulacion-mp', 1]], { F: 2, P: 1, R: 3 },
    [S('musculoskeletal', 'Calambres nocturnos', 'Night cramps'), S('cardiological', 'Edema de tobillos', 'Ankle swelling')],
    [{ es: 'Circulación MP.', en: 'Lower-limb circulation.' }], 88, 'goiz-n2'),
];

const pid = (n) => pairs.find((p) => p.number === n).id;
pairs.forEach((p) => {
  const t = points.find((x) => x.id === p.tracking.point); const i = points.find((x) => x.id === p.impact.point);
  p.name = { es: `${t.name.es} – ${i.name.es}`, en: `${t.name.en} – ${i.name.en}` };
});

export const protocols = [
  { id: 'app-19-circulacion-de-piernas', kind: 'application', number: 19, name: { es: '19. Circulación de Piernas', en: '19. Leg Circulation' },
    items: [[231, 'Desintoxicación', 'Detoxification'], [233, 'Balance hormonal (cortisol)', 'Hormonal balance (cortisol)'], [232, 'Desintoxicación', 'Detoxification'],
      [234, 'Circulación MP', 'Lower-limb circulation'], [235, 'Circulación MP', 'Lower-limb circulation'], [236, 'Circulación MP', 'Lower-limb circulation'], [237, 'Circulación MP', 'Lower-limb circulation']]
      .map(([n, es, en]) => ({ pair: pid(n), label: { es, en } })),
    dosage: { acute: { minutes: [30, 45], frequency: { es: '2 a 3 veces al día', en: '2–3 times per day' } }, chronic: { minutes: [30, 45], frequency: { es: '2 a 3 veces por semana', en: '2–3 times per week' } } },
    notes: [{ es: 'Sigue las indicaciones médicas. Visita a tu médico y biomagnetista.', en: 'Follow medical advice. See your physician and biomagnetist.' }],
    source: { doc: 'youheal', page: 19 } },
  { id: 'basic-detox', kind: 'basic', name: { es: 'Básico — Desintoxicación', en: 'Basic — Detoxification' }, items: [{ pair: 'pb-231' }, { pair: 'pb-232' }], source: { doc: 'goiz-n2', page: 86 } },
  { id: 'top10-gastrointestinal', kind: 'top10', name: { es: 'Top 10 Gastrointestinal', en: 'Top 10 Gastrointestinal' },
    items: [{ pair: 'pb-047' }, { pair: 'pb-063' }, { pair: 'pb-088' }, { pair: 'pb-001' }, { protocol: 'basic-detox' }], source: { doc: 'goiz-n1', page: 107 } },
  { id: 'top5-inmunologico', kind: 'top5', name: { es: 'Top 5 Inmunológico', en: 'Top 5 Immunological' }, items: [{ pair: 'pb-001' }, { pair: 'pb-014' }, { pair: 'pb-022' }], source: { doc: 'goiz-n1', page: 110 } },
  { id: 'disease-varices', kind: 'disease', name: { es: 'Várices', en: 'Varicose veins' }, items: [{ protocol: 'app-19-circulacion-de-piernas' }, { pair: 'pb-233' }], source: { doc: 'goiz-n2', page: 140 } },
];

const sym = (id, system, es, en, pairIds) => ({ id, system, name: { es, en }, pairs: pairIds });
export const symptoms = [
  sym('cefalea', 'neurological', 'Cefalea', 'Headache', ['pb-112']),
  sym('fatiga', 'general', 'Fatiga', 'Fatigue', ['pb-001', 'pb-231', 'pb-233']),
  sym('dolor-lumbar', 'musculoskeletal', 'Dolor lumbar', 'Low-back pain', ['pb-232', 'pb-235']),
  sym('piernas-pesadas', 'cardiological', 'Piernas pesadas', 'Heavy legs', ['pb-234', 'pb-236', 'pb-237']),
  sym('varices', 'cardiological', 'Várices', 'Varicose veins', ['pb-234', 'pb-236']),
  sym('calambres', 'musculoskeletal', 'Calambres', 'Cramps', ['pb-236', 'pb-237']),
  sym('gastritis', 'gastrointestinal', 'Gastritis', 'Gastritis', ['pb-047']),
  sym('distension-abdominal', 'gastrointestinal', 'Distensión abdominal', 'Abdominal bloating', ['pb-047', 'pb-063']),
  sym('diarrea', 'gastrointestinal', 'Diarrea', 'Diarrhea', ['pb-001', 'pb-088']),
  sym('tos', 'respiratory', 'Tos', 'Cough', ['pb-022']),
  sym('fiebre', 'general', 'Fiebre', 'Fever', ['pb-022']),
  sym('ansiedad', 'psychiatric', 'Ansiedad', 'Anxiety', ['pb-112']),
  sym('insomnio', 'psychiatric', 'Insomnio', 'Insomnia', ['pb-112']),
  sym('abscesos', 'dermatological', 'Abscesos', 'Abscesses', ['pb-014']),
  sym('infecciones-recurrentes', 'immunological', 'Infecciones recurrentes', 'Recurrent infections', ['pb-001', 'pb-014']),
  sym('retencion-liquidos', 'urological', 'Retención de líquidos', 'Fluid retention', ['pb-232']),
];

export const contraindications = [
  { id: 'abs-01', kind: 'absolute', text: { es: 'Marcapasos o desfibrilador implantado', en: 'Pacemaker or implanted defibrillator' }, source: { doc: 'goiz-n1', page: 9 } },
  { id: 'abs-02', kind: 'absolute', text: { es: 'Bomba de insulina u otro dispositivo electrónico activo implantado', en: 'Insulin pump or other active implanted electronic device' }, source: { doc: 'goiz-n1', page: 9 } },
  { id: 'abs-03', kind: 'absolute', text: { es: 'Hemorragia activa', en: 'Active bleeding' }, source: { doc: 'goiz-n1', page: 9 } },
  { id: 'rel-01', kind: 'relative', text: { es: 'Embarazo (no colocar imanes sobre el abdomen)', en: 'Pregnancy (do not place magnets over the abdomen)' }, source: { doc: 'goiz-n1', page: 9 } },
  { id: 'rel-02', kind: 'relative', text: { es: 'Cirugía reciente (menos de 6 semanas)', en: 'Recent surgery (less than 6 weeks)' }, source: { doc: 'goiz-n1', page: 9 } },
  { id: 'rel-03', kind: 'relative', text: { es: 'Implantes metálicos en la zona de aplicación', en: 'Metal implants at the application site' }, source: { doc: 'goiz-n1', page: 9 } },
  { id: 'rel-04', kind: 'relative', text: { es: 'Tratamiento anticoagulante', en: 'Anticoagulant therapy' }, source: { doc: 'goiz-n1', page: 9 } },
  { id: 'rel-05', kind: 'relative', text: { es: 'Epilepsia', en: 'Epilepsy' }, source: { doc: 'goiz-n1', page: 9 } },
  { id: 'rel-06', kind: 'relative', text: { es: 'Menores de 3 años: sesiones breves y supervisadas' }, source: { doc: 'goiz-n1', page: 10 } },
];

export const recommendations = [
  { id: 'rec-hydration', title: { es: 'Hidratación', en: 'Hydration' }, body: { es: 'Beber al menos 2 litros de agua al día durante la semana posterior a la sesión.', en: 'Drink at least 2 liters of water per day during the week after the session.' } },
  { id: 'rec-followup', title: { es: 'Seguimiento', en: 'Follow-up' }, body: { es: 'Se recomienda un rastreo de control a los 7 días para liberar reservorios.', en: 'A follow-up scan is recommended after 7 days to release reservoirs.' } },
  { id: 'rec-medical', title: { es: 'Indicaciones médicas', en: 'Medical guidance' }, body: { es: 'Continúe todas las indicaciones de su médico tratante.', en: 'Continue all instructions from your treating physician.' } },
];

export const glossary = [
  { abbr: 'PB', meaning: { es: 'Par Biomagnético', en: 'Biomagnetic Pair' } },
  { abbr: 'F/P/R', meaning: { es: 'Frecuencia / Patogenicidad / Resolución', en: 'Frequency / Pathogenicity / Resolution' } },
  { abbr: 'D / I', meaning: { es: 'Derecho / Izquierdo', en: 'Right / Left' } },
  { abbr: 'MP', meaning: { es: 'Miembros pélvicos', en: 'Lower limbs (pelvic members)' } },
  { abbr: 'S / INF', meaning: { es: 'Superior / Inferior', en: 'Superior / Inferior' } },
  { abbr: 'Rastreo', meaning: { es: 'Exploración con imanes para encontrar pares en resonancia', en: 'Magnet scan to find pairs in resonance' } },
];
