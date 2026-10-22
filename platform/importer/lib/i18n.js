// English names for UI-facing catalog labels (CONTRACT §4: point names, categories, systems,
// protocol names and UI labels MUST have `en`). Prose stays Spanish-only.
import { slug, slugKeep } from './slug.js';
import { ENTITY_EN } from './i18n-entities.js';
import { SYMPTOM_EN } from './i18n-symptoms.js';
import { CONTRA_EN } from './i18n-contra.js';

export const CATEGORIES = [
  ['virus', 'Virus', 'Virus'], ['bacteria', 'Bacteria', 'Bacteria'], ['fungus', 'Hongo', 'Fungus'], ['parasite', 'Parásito', 'Parasite'],
  ['dysfunctional', 'Disfuncional', 'Dysfunctional'], ['psychoemotional', 'Psicoemocional', 'Psycho-emotional'], ['reservoir', 'Reservorio', 'Reservoir'],
  ['complex', 'Complejo', 'Complex'], ['special', 'Especial', 'Special'], ['prion', 'Prión', 'Prion'], ['temporary', 'Temporal', 'Temporary'],
  ['glandular-dysfunction', 'Disfunción glandular', 'Glandular dysfunction'],
].map(([id, es, en]) => ({ id, name: { es, en } }));

export const SYSTEMS = [
  ['general', 'Generales', 'General'], ['respiratory', 'Respiratorios', 'Respiratory'], ['gastrointestinal', 'Gastrointestinales', 'Gastrointestinal'],
  ['neurological', 'Neurológicos', 'Neurological'], ['musculoskeletal', 'Osteomusculares', 'Musculoskeletal'], ['urological', 'Urológicos', 'Urological'],
  ['cardiological', 'Cardiológicos', 'Cardiological'], ['gynecological', 'Ginecológicos', 'Gynecological'], ['endocrine', 'Endocrinológicos', 'Endocrine'],
  ['hematological', 'Hematológicos', 'Hematological'], ['dermatological', 'Dermatológicos', 'Dermatological'], ['ophthalmological', 'Oftalmológicos', 'Ophthalmological'],
  ['auditory', 'Auditivos', 'Auditory'], ['immunological', 'Inmunológicos', 'Immunological'], ['psychiatric', 'Psiquiátricos', 'Psychiatric'],
  ['oncological', 'Oncológicos', 'Oncological'], ['dental', 'Odontológicos', 'Dental'], ['tropical', 'Tropicales', 'Tropical'], ['toxicological', 'Toxicológicos', 'Toxicological'],
].map(([id, es, en]) => ({ id, name: { es, en } }));
export const SYSTEM_ES = Object.fromEntries(SYSTEMS.map(s => [s.id, s.name.es]));
const SYSTEM_EN = Object.fromEntries(SYSTEMS.map(s => [s.id, s.name.en]));

export const SIDES = [
  { id: 'R', source: 'D', name: { es: 'Derecho', en: 'Right' } }, { id: 'L', source: 'I', name: { es: 'Izquierdo', en: 'Left' } },
  { id: 'C', source: 'C', name: { es: 'Central / sin especificar', en: 'Central / unspecified' } }, { id: 'RL', source: 'D/I', name: { es: 'Derecho y/o izquierdo', en: 'Right and/or left' } },
];
export const QUALIFIERS = [
  { id: 'S', source: 'S', name: { es: 'Superior', en: 'Superior' } }, { id: 'INF', source: 'Inf', name: { es: 'Inferior', en: 'Inferior' } },
  { id: 'A', source: 'A', name: { es: 'Anterior', en: 'Anterior' } }, { id: 'P', source: 'P', name: { es: 'Posterior', en: 'Posterior' } },
  { id: 'LAT', source: 'Lat', name: { es: 'Lateral', en: 'Lateral' } },
];

// ------------------------------------------------------------------ protocols
const PROTO_WORDS = {
  'cardiologico': 'Cardiology', 'dermatologico': 'Dermatology', 'disfuncional': 'Dysfunctional', 'disnea': 'Dyspnea',
  'endocrinologico': 'Endocrinology', 'gastrointestinal': 'Gastrointestinal', 'ginecologico': 'Gynecology', 'hematologico': 'Hematology',
  'hepatobiliar': 'Hepatobiliary', 'inmunologico-enfermedades-autoinmunes': 'Immunology (autoimmune diseases)',
  'inmunologico-inmunodeficiencia': 'Immunology (immunodeficiency)', 'neurologico-adultos': 'Neurology (adults)', 'neurologico-ninos': 'Neurology (children)',
  'oncogenico': 'Oncogenic', 'osteomuscular': 'Musculoskeletal', 'patogenico': 'Pathogenic', 'reservorios': 'Reservoirs', 'respiratorio': 'Respiratory',
  'tropical': 'Tropical', 'urologico': 'Urology', 'animales-en-casa': 'Pets at home', 'cervicalgia': 'Neck pain (cervicalgia)', 'conjuntivitis': 'Conjunctivitis',
  'desintoxicacion': 'Detoxification', 'desparasitacion': 'Deworming (antiparasitic)', 'infeccion-de-vias-urinarias': 'Urinary tract infection',
  'odontologico': 'Dental', 'postquirurgico': 'Post-surgical', 'top': 'Top of the Top 10 lists', 'columna': 'Spine', 'gastritis': 'Gastritis',
  'intrahospitalario': 'In-hospital', 'lesiones-deportivas': 'Sports injuries', 'nutricional': 'Nutritional', 'oftalmologico': 'Ophthalmology',
  'psicoemocional': 'Psycho-emotional', 'psiquiatrico': 'Psychiatric', 'regularizacion-intestinal': 'Bowel regulation', 'perdida-de-la-memoria': 'Memory loss',
};
const BASIC_EN = {
  'basic-detox': 'Basic Detox', 'basic-columna': 'Basic Spine', 'basic-pb': 'Basic BP (Biomagnetic Pair)', 'basic-reservorios': 'Basic Reservoirs',
  'basic-disfuncional': 'Basic Dysfunctional', 'basic-short': 'Basic Protocol (short)', 'basic-extended': 'Basic Protocol (extended)',
  'basic-pb-diabetogenicos': 'Diabetogenic pairs', 'basic-pb-hiperglicemicos': 'Hyperglycemic pairs',
};
import { DISEASE_EN } from './i18n-diseases.js';
export function protocolEn(pr) {
  if (BASIC_EN[pr.id]) return BASIC_EN[pr.id];
  let m;
  if ((m = pr.id.match(/^top(10|5)-(.+)$/))) {
    if (pr.id === 'top10-top') return 'Top Top 10';
    return PROTO_WORDS[m[2]] ? `Top ${m[1]} ${PROTO_WORDS[m[2]]}` : null;
  }
  if (pr.kind === 'disease') return DISEASE_EN[pr.id.replace(/^disease-/, '')] || null;
  return null;
}

// ------------------------------------------------------------------ entities
// Latin binomials (Genus species) keep their Latin name in English, with conventional capitalisation.
const LATIN_GENERA = /^(Acinetobacter|Actinomyces|Aerobacter|Aeromonas|Anisakis|Ascaris|Aspergillus|Babesia|Bacillus|Bacteroides|Balantidium|Balatidium|Bartonella|Blastocystis|Blastomyces|Bordetella|Borrelia|Brucella|Burkholderia|Campylobacter|Candida|Chlamydia|Chlamydophila|Citrobacter|Clostridium|Corynebacterium|Coxiella|Cryptococcus|Cryptosporidium|Cryptocides|Criptoceles|Echinococcus|Endolimax|Equinococcus|Entamoeba|Enterobacter|Enterobius|Enterococcus|Epidermophyton|Escherichia|Fasciola|Fasciolopsis|Francisella|Gardnerella|Garnerella|Giardia|Haemophilus|Helicobacter|Histoplasma|Klebsiella|Legionella|Leishmania|Leptospira|Listeria|Malassezia|Microsporum|Moraxella|Morganella|Mycobacterium|Mycoplasma|Necator|Neisseria|Nocardia|Neocardia|Onchocerca|Pasteurella|Plasmodium|Pneumocystis|Proteus|Pseudomona|Pseudomonas|Rickettsia|Ricketssia|Salmonella|Sarcoptes|Schistosoma|Serratia|Shigella|Spirochaetes|Staphylococcus|Streptococcus|Strongyloides|Taenia|Toxocara|Toxoplasma|Treponema|Trichinella|Trichomonas|Trichophyton|Trichuris|Trypanosoma|Ureaplasma|Veillonella|Veillonela|Vibrio|Yersinia)\b/;
export function entityEn(ent) {
  const es = ent.name.es;
  const id = ent.id;
  if (ENTITY_EN[id]) return ENTITY_EN[id];
  if (LATIN_GENERA.test(es)) {
    const w = es.split(/\s+/);
    return [w[0], ...w.slice(1).map(x => (/^[A-ZÁÉÍÓÚ][a-záéíóú]+$/.test(x) && !/^(Coli)$/.test(x) ? x.toLowerCase() : x === 'Coli' ? 'coli' : x))].join(' ');
  }
  if (ent.kind === 'named-pair' && /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(\s[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*$/.test(es) && !/\s(de|del|la|el)\s/i.test(es)) return es; // personal names
  return null;
}

export function symptomEn(id, es) {
  if (SYMPTOM_EN[id]) return SYMPTOM_EN[id];
  let m;
  if ((m = id.match(/^sintomas-(.+)$/)) && SYSTEM_EN[m[1]]) return `${SYSTEM_EN[m[1]]} symptoms`;
  return null;
}
export const contraEn = text => CONTRA_EN[slugKeep(text)] || CONTRA_EN[slug(text)] || null;

// ------------------------------------------------------------ recommendations
export const REC_IDS = {
  'Tipos de Recomendación': 'recommendation-types',
  'Recomendaciones Generales (Versión Completa)': 'general-full', 'Recomendaciones Generales (Versión Corta)': 'general-short',
  'Recomendaciones para Enfermedades Parasitarias': 'parasitic', 'Recomendaciones para Enfermedades Tropicales': 'tropical',
  'Recomendaciones para Infecciones de Transmisión Sexual (ITS)': 'sti', 'Recomendaciones Legales': 'legal',
  'Recomendaciones para Crisis Curativa': 'healing-crisis', 'Recomendaciones del buen comer': 'good-eating', 'Recomendaciones del buen dormir': 'good-sleep',
  'Recomendaciones del buen ir al baño': 'good-toileting', 'Recomendaciones para la realización de Ejercicio Terapéutico': 'therapeutic-exercise',
  'Recomendaciones para manejo del estrés': 'stress-management',
};
export const REC_EN = {
  'recommendation-types': 'Types of recommendations', 'general-full': 'General recommendations (full version)', 'general-short': 'General recommendations (short version)',
  parasitic: 'Recommendations for parasitic diseases', tropical: 'Recommendations for tropical diseases', sti: 'Recommendations for sexually transmitted infections (STI)',
  legal: 'Legal recommendations', 'healing-crisis': 'Recommendations for a healing crisis', 'good-eating': 'Healthy eating recommendations',
  'good-sleep': 'Healthy sleep recommendations', 'good-toileting': 'Healthy bathroom-habit recommendations', 'therapeutic-exercise': 'Therapeutic exercise recommendations',
  'stress-management': 'Stress management recommendations', 'intake-form': 'Registration (intake) form',
};

const FIELD_EN = {
  Ciudad: ['city', 'City'], Dia: ['day', 'Day'], Mes: ['month', 'Month'], Año: ['year', 'Year'], Nombre: ['name', 'Name'], Edad: ['age', 'Age'],
  Dirección: ['address', 'Address'], Ocupación: ['occupation', 'Occupation'], Teléfono: ['phone', 'Phone'], 'e-mail': ['email', 'E-mail'],
};
const QUESTION_EN = {
  'ha-recibido-cirugias-cuales-hace-cuanto': ['surgeries', 'Have you had surgery? Which? How long ago?'],
  'ha-recibido-transfusiones-o-trasplantes-cuales-hace-cuanto': ['transfusions-transplants', 'Have you received transfusions or transplants? Which? How long ago?'],
  'esta-embarazada-esta-planeando-embarazarse-esta-en-tratamiento-de-fertilidad': ['pregnancy', 'Are you pregnant? Are you planning a pregnancy? Are you in fertility treatment?'],
  'tiene-marcapasos-o-algun-aparato-que-utilice-baterias-en-el-cuerpo': ['implanted-devices', 'Do you have a pacemaker or any battery-powered device in your body?'],
  'ha-recibido-quimioterapia-radioterapia-o-tratamiento-para-cancer-hace-cuanto': ['cancer-treatment', 'Have you received chemotherapy, radiotherapy or cancer treatment? How long ago?'],
  'escriba-sus-sintomas-diagnosticos-y-o-motivo-de-consulta': ['chief-complaint', 'Describe your symptoms, diagnoses and/or reason for the visit:'],
};
const RECORD_EN = [
  ['date', 'Date (day/month/year/time)'], ['tracking-point', 'Tracking point (position: R, L, S, Inf, A, P, Lat, C)'],
  ['impact-point', 'Impact point (position: R, L, S, Inf, A, P, Lat, C)'], ['phenomena', 'Associated phenomena (infiltrate, exudate, cyst, abscess, neoplasia, etc.)'],
  ['methodology', 'Scanning methodology (Biomagnetism, Bioenergetics or Telebioenergetics)'],
  ['notes', 'Notes (symptoms after the scan, prior preparation, scan duration, study protocol, etc.)'],
];
export function intakeRecord(intake, source) {
  const fields = intake.fields.filter(f => FIELD_EN[f]).map(f => ({ id: FIELD_EN[f][0], label: { es: f, en: FIELD_EN[f][1] } }));
  const questions = intake.questions.map(q => { const k = QUESTION_EN[slug(q)]; return { id: k ? k[0] : slug(q), text: k ? { es: q, en: k[1] } : { es: q } }; });
  const recordColumns = intake.recordSpec.map((r, i) => ({ id: RECORD_EN[i]?.[0] || `col-${i + 1}`, label: { es: r, ...(RECORD_EN[i] ? { en: RECORD_EN[i][1] } : {}) } }));
  return {
    id: 'intake-form',
    title: { es: 'Hoja de Registro', en: REC_EN['intake-form'] },
    body: { es: intake.intro },
    form: {
      sections: [
        { id: 'header', title: { es: 'Encabezado', en: 'Header' }, fields: fields.filter(f => ['city', 'day', 'month', 'year'].includes(f.id)) },
        { id: 'demographics', title: { es: 'Datos personales', en: 'Personal data' }, fields: fields.filter(f => !['city', 'day', 'month', 'year'].includes(f.id)) },
        { id: 'authorization', title: { es: 'Autorización para realización de rastreo con Par Biomagnético', en: 'Authorization for a Biomagnetic Pair scan' }, text: { es: intake.consent } },
        { id: 'explanation', title: { es: '¿Qué es el Par Biomagnético?', en: 'What is the Biomagnetic Pair?' }, text: { es: intake.explanation } },
        { id: 'screening', title: { es: 'Preguntas de alcance', en: 'Scope questions' }, questions },
        { id: 'contraindication-screening', title: { es: 'Contraindicaciones (relativas y absolutas)', en: 'Contraindications (relative and absolute)' },
          ref: 'contraindications.json', kinds: ['relative', 'absolute'],
          text: { es: 'Las contraindicaciones relativas permiten el rastreo a distancia (segundo nivel); las absolutas no permiten ningún rastreo.', en: 'Relative contraindications still allow remote scanning (level 2); absolute contraindications allow no scanning at all.' } },
        { id: 'signature', title: { es: 'Consentimiento', en: 'Consent' }, text: { es: intake.legal }, fields: [{ id: 'signature-name', label: { es: 'Nombre y firma del cliente', en: 'Client name and signature' } }] },
        { id: 'scan-record', title: { es: 'Registro del rastreo', en: 'Scan record' }, columns: recordColumns,
          methodologies: [{ id: 'biomagnetism', abbr: 'BM', label: { es: 'Biomagnetismo', en: 'Biomagnetism' } }, { id: 'bioenergetics', abbr: 'BE', label: { es: 'Bioenergética', en: 'Bioenergetics' } }, { id: 'telebioenergetics', abbr: 'TB', label: { es: 'Telebioenergética', en: 'Telebioenergetics' } }] },
      ],
    },
    source,
  };
}

const ABBR_EN = {
  BRI: 'Biomagnetism Research Institute', PB: 'Biomagnetic Pair (BP)', 'PB´s': 'Biomagnetic Pairs', pH: 'Potential of hydrogen (pH)', DMP: 'Pelvic limb length discrepancy',
  D: 'Right', I: 'Left', C: 'Central', S: 'Superior', Inf: 'Inferior', Lat: 'Lateral', A: 'Anterior', P: 'Posterior', IVU: 'Urinary tract infection (UTI)',
  IRA: 'Acute respiratory infection', SIDA: 'Acquired immunodeficiency syndrome (AIDS)', VIH: 'Human immunodeficiency virus (HIV)', 'E. Coli': 'Escherichia coli',
  HTLV: 'Human T-lymphotropic virus', EM: 'Multiple sclerosis', MT: 'Upper (thoracic) limbs', MP: 'Lower (pelvic) limbs', 'Enf.': 'Disease', Pb: 'Probable',
  ITS: 'Sexually transmitted infection (STI)', AH1N1: 'Influenza A (H1N1)', EP: 'Pulmonary edema', EPOC: 'Chronic obstructive pulmonary disease (COPD)',
  CUCI: 'Chronic non-specific ulcerative colitis', EPI: 'Pelvic inflammatory disease (PID)', TB: 'Tuberculosis', DM: 'Diabetes mellitus', Temp: 'Temperature',
  FC: 'Heart rate', FR: 'Respiratory rate', TA: 'Blood pressure', EVC: 'Cerebrovascular event (stroke)', lpm: 'beats per minute', rpm: 'breaths per minute',
  mmHg: 'millimetres of mercury', mg: 'milligrams', dl: 'decilitres', 'º C': 'degrees Celsius', TDAH: 'Attention-deficit/hyperactivity disorder (ADHD)',
  Pt: 'Pathogen', Pr: 'Named pair', Pd: 'Condition (disease)', Vi: 'Virus', Ba: 'Bacterium', Ho: 'Fungus', Pa: 'Parasite', Pn: 'Prion', Re: 'Reservoir',
  Co: 'Complex', DG: 'Glandular dysfunction', Es: 'Special', Em: 'Psycho-emotional', Te: 'Temporary', RV: 'Virus reservoir', RB: 'Bacteria reservoir',
  RH: 'Fungus reservoir', RP: 'Parasite reservoir', RR: 'Prion reservoir', RU: 'Universal reservoir',
};
export const abbrEn = (abbr) => ABBR_EN[abbr] || null;
