// Builds data/catalog/point-anatomy.json (CONTRACT §4.3) and the demo name list
// web/js/viewer3d/demo-points.json from the authored table below.
//
// Each row gives the clinical placement used by biomagnetists (where the magnet
// goes), as an approximate position in the CONTRACT frame plus the `view` used
// to snap it to the skin. Positions are snapped onto the NEUTRAL procedural
// mannequin here, so the committed `pos` lies on the skin (±1 mm); the viewer
// re-snaps at runtime for other body presets / a licensed GLB.
//
// Point inventory: pair indices of the Goiz Level 1 & 2 guides (pp. 5–15) plus
// common compendium points. Ids use the CONTRACT §4 slug(); aliases cover
// spelling variants seen in the sources (typos are normalised to the canonical id).
//
// Usage: node tests/viewer3d/build-anatomy.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBody, snapPoint } from '../../web/js/viewer3d/body-sdf.js';

export const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const body = buildBody({ sex: 'neutral' });
const SK = body.skeleton;
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
// limb helpers (patient LEFT side); rows are authored for the RIGHT side (x<0) → mirror x
const R = (p) => [-Math.abs(p[0]), p[1], p[2]];
const arm = (t, dx = 0, dz = 0) => { const p = lerp(SK.shoulderJ, SK.elbow, t); return R([p[0] + dx, p[1], p[2] + dz]); };
const fore = (t, dx = 0, dz = 0) => { const p = lerp(SK.elbow, SK.wrist, t); return R([p[0] + dx, p[1], p[2] + dz]); };
const hand = (t, dx = 0, dz = 0) => { const p = lerp(SK.wrist, SK.fingertip, t); return R([p[0] + dx, p[1], p[2] + dz]); };
const thigh = (t, dx = 0, dz = 0) => { const p = lerp(SK.hipJ, SK.knee, t); return R([p[0] + dx, p[1], p[2] + dz]); };
const leg = (t, dx = 0, dz = 0) => { const p = lerp(SK.knee, SK.ankle, t); return R([p[0] + dx, p[1], p[2] + dz]); };
const knee = (dx = 0, dy = 0, dz = 0) => R([SK.knee[0] + dx, SK.knee[1] + dy, SK.knee[2] + dz]);
// medial direction for the right limb in x is +x (towards the midline): use dx>0 for medial, dx<0 for lateral

// [id, es, en, laterality C|B, region, view, [x,y,z], aliases?]
const P = [
  // ---------------- head (cranium / brain approaches) ----------------
  ['pineal', 'Pineal', 'Pineal', 'C', 'head', 'superior', [0, 1.70, 0.0]],
  ['prepineal', 'Prepineal', 'Prepineal', 'C', 'head', 'superior', [0, 1.70, 0.04]],
  ['pospineal', 'Pospineal', 'Postpineal', 'C', 'head', 'superior', [0, 1.70, -0.045], ['postpineal']],
  ['coronilla', 'Coronilla', 'Crown (vertex)', 'C', 'head', 'superior', [0, 1.70, -0.075]],
  ['cuerpo-calloso', 'Cuerpo Calloso', 'Corpus callosum', 'C', 'head', 'superior', [0, 1.70, 0.018]],
  ['cisura-media', 'Cisura Media', 'Medial fissure', 'C', 'head', 'superior', [0, 1.70, -0.022]],
  ['borde-calloso', 'Borde Calloso', 'Callosal border', 'B', 'head', 'superior', [-0.045, 1.70, -0.02]],
  ['craneal', 'Craneal', 'Cranial', 'B', 'head', 'superior', [-0.042, 1.70, 0.035]],
  ['cisura-de-rolando', 'Cisura de Rolando', 'Rolandic fissure', 'B', 'head', 'superior', [-0.055, 1.70, 0.008], ['fronto-parietal']],
  ['parietal', 'Parietal', 'Parietal', 'B', 'head', 'lateral', [-0.06, 1.705, -0.025]],
  ['temporal', 'Temporal', 'Temporal', 'B', 'head', 'lateral', [-0.06, 1.668, -0.002]],
  ['cisura-de-silvio', 'Cisura de Silvio', 'Sylvian fissure', 'B', 'head', 'lateral', [-0.06, 1.678, 0.025], ['cisura-silvio']],
  ['talamo', 'Tálamo', 'Thalamus', 'B', 'head', 'lateral', [-0.06, 1.655, -0.03]],
  ['hipocampo', 'Hipocampo', 'Hippocampus', 'B', 'head', 'lateral', [-0.06, 1.643, -0.012]],
  ['poligono-de-willis', 'Polígono de Willis', 'Circle of Willis', 'B', 'head', 'lateral', [-0.06, 1.652, 0.022]],
  ['amigdala-cerebral', 'Amígdala Cerebral', 'Amygdala (brain)', 'B', 'head', 'lateral', [-0.06, 1.636, 0.028]],
  ['temporoccipital', 'Temporoccipital', 'Temporo-occipital', 'B', 'head', 'lateral', [-0.05, 1.655, -0.065], ['tempor-occipital']],
  ['hipotalamo', 'Hipotálamo', 'Hypothalamus', 'C', 'head', 'internal', [0, 1.632, 0.012]],
  ['occipital', 'Occipital', 'Occipital', 'B', 'head', 'posterior', [-0.035, 1.66, -0.05]],
  ['cerebelo', 'Cerebelo', 'Cerebellum', 'B', 'head', 'posterior', [-0.032, 1.607, -0.05]],
  ['retromastoides', 'Retromastoides', 'Retromastoid', 'B', 'head', 'posterior', [-0.055, 1.603, -0.04]],
  ['mastoides', 'Mastoides', 'Mastoid', 'B', 'head', 'lateral', [-0.05, 1.598, -0.035]],
  ['oreja', 'Oreja', 'Ear (auricle)', 'B', 'head', 'lateral', [-0.06, 1.638, -0.018]],
  ['oido', 'Oído', 'Ear canal', 'B', 'head', 'lateral', [-0.06, 1.615, -0.004]],
  // ---------------- face ----------------
  ['polo', 'Polo', 'Frontal pole (hairline)', 'B', 'face', 'anterior', [-0.034, 1.712, 0]],
  ['frontal', 'Frontal', 'Frontal', 'B', 'face', 'anterior', [-0.03, 1.695, 0]],
  ['seno-frontal', 'Seno Frontal', 'Frontal sinus', 'B', 'face', 'anterior', [-0.02, 1.68, 0]],
  ['hipofisis', 'Hipófisis', 'Pituitary', 'C', 'face', 'anterior', [0, 1.664, 0]],
  ['interciliar', 'Interciliar', 'Glabella', 'C', 'face', 'anterior', [0, 1.652, 0]],
  ['supraciliar', 'Supraciliar', 'Supraciliary', 'C', 'face', 'anterior', [0, 1.678, 0]],
  ['ceja', 'Ceja', 'Eyebrow', 'B', 'face', 'anterior', [-0.04, 1.658, 0]],
  ['fronto-orbital', 'Frontoorbital', 'Fronto-orbital', 'B', 'face', 'anterior', [-0.052, 1.655, 0]],
  ['parpado', 'Párpado', 'Eyelid', 'B', 'face', 'anterior', [-0.032, 1.645, 0]],
  ['ojo', 'Ojo', 'Eye', 'B', 'face', 'anterior', [-0.032, 1.637, 0]],
  ['macula', 'Mácula', 'Macula', 'B', 'face', 'anterior', [-0.026, 1.633, 0]],
  ['lacrimal', 'Lacrimal', 'Lacrimal', 'B', 'face', 'anterior', [-0.015, 1.634, 0]],
  ['canto', 'Canto', 'Outer canthus', 'B', 'face', 'anterior', [-0.05, 1.637, 0], ['canto-externo']],
  ['piso-orbital', 'Piso Orbital', 'Orbital floor', 'B', 'face', 'anterior', [-0.033, 1.624, 0]],
  ['malar', 'Malar', 'Malar', 'B', 'face', 'anterior', [-0.05, 1.618, 0], ['hueso-cigomatico']],
  ['pomulo', 'Pómulo', 'Cheek', 'B', 'face', 'anterior', [-0.045, 1.6, 0]],
  ['seno-paranasal', 'Seno Paranasal', 'Paranasal sinus', 'B', 'face', 'anterior', [-0.025, 1.607, 0], ['seno-nasal']],
  ['sien', 'Sien', 'Temple', 'B', 'face', 'lateral', [-0.06, 1.66, 0.05]],
  ['quiasma', 'Quiasma', 'Optic chiasm', 'B', 'face', 'lateral', [-0.06, 1.645, 0.058], ['quiasma-optico']],
  ['esfenoides', 'Esfenoides', 'Sphenoid', 'B', 'face', 'lateral', [-0.06, 1.628, 0.045]],
  ['arco-cigomatico', 'Arco Cigomático', 'Zygomatic arch', 'B', 'face', 'lateral', [-0.06, 1.62, 0.025]],
  ['preauricular', 'Preauricular', 'Preauricular', 'B', 'face', 'lateral', [-0.06, 1.615, 0.012]],
  ['articulacion-temporomandibular', 'Articulación Temporomandibular', 'Temporomandibular joint', 'B', 'face', 'lateral', [-0.06, 1.603, 0.01]],
  ['parotida', 'Parótida', 'Parotid', 'B', 'face', 'lateral', [-0.05, 1.585, 0.005]],
  
  ['rama-mandibular', 'Rama Mandibular', 'Mandibular ramus', 'B', 'face', 'lateral', [-0.045, 1.565, 0.012]],
  ['angulo', 'Ángulo (mandibular)', 'Angle of the mandible', 'B', 'face', 'lateral', [-0.045, 1.548, -0.004], ['angulo-mandibular']],
  ['nariz', 'Nariz', 'Nose', 'B', 'face', 'anterior', [-0.011, 1.612, 0]],
  ['maxilar-superior', 'Maxilar Superior', 'Maxilla', 'B', 'face', 'anterior', [-0.03, 1.588, 0], ],
  ['labio-superior', 'Labio Superior', 'Upper lip', 'C', 'face', 'anterior', [0, 1.578, 0]],
  ['diente', 'Diente', 'Tooth', 'C', 'face', 'anterior', [0.012, 1.572, 0]],
  ['caries', 'Caries', 'Dental caries (affected tooth)', 'C', 'face', 'anterior', [-0.014, 1.572, 0]],
  ['comisura', 'Comisura', 'Mouth corner', 'B', 'face', 'anterior', [-0.022, 1.565, 0]],
  ['lengua', 'Lengua', 'Tongue', 'B', 'face', 'anterior', [-0.012, 1.556, 0]],
  ['mandibula', 'Mandíbula', 'Mandible', 'B', 'face', 'anterior', [-0.036, 1.542, 0], ['maxilar-inferior']],
  ['menton', 'Mentón', 'Chin', 'C', 'face', 'anterior', [0, 1.532, 0]],
  // ---------------- neck ----------------
  ['bulbo-raquideo', 'Bulbo Raquídeo', 'Medulla oblongata', 'C', 'neck', 'posterior', [0, 1.586, -0.04], ['bulbo-raquideno']],
  ['agujero', 'Agujero (occipital)', 'Foramen (occipital)', 'B', 'neck', 'posterior', [-0.026, 1.58, -0.04]],
  ['atlas', 'Atlas', 'Atlas (C1)', 'C', 'neck', 'posterior', [0, 1.565, -0.04], ['cervical-1']],
  ['axis', 'Axis', 'Axis (C2)', 'C', 'neck', 'posterior', [0, 1.548, -0.04], ['cervical-2']],
  ['cervical-3', 'Cervical 3', 'Cervical 3 (C3)', 'C', 'neck', 'posterior', [0, 1.532, -0.04]],
  ['cervical', 'Cervical', 'Cervical spine', 'C', 'neck', 'posterior', [0, 1.505, -0.04]],
  ['cervical-4', 'Cervical 4', 'Cervical 4 (C4)', 'C', 'neck', 'posterior', [0, 1.518, -0.04]],
      ['cervical-7', 'Cervical 7', 'Cervical 7 (C7)', 'C', 'neck', 'posterior', [0, 1.466, -0.04]],
  ['glandula-salival', 'Glándula Salival', 'Salivary gland', 'B', 'neck', 'anterior', [-0.038, 1.526, 0]],
  ['amigdala-palatina', 'Amígdala Palatina', 'Palatine tonsil', 'B', 'neck', 'lateral', [-0.04, 1.533, 0.018]],
  ['hueso-hioides', 'Hueso Hioides', 'Hyoid', 'C', 'neck', 'anterior', [0, 1.517, 0]],
  ['garganta', 'Garganta', 'Throat', 'C', 'neck', 'anterior', [0, 1.505, 0]],
  ['laringe', 'Laringe', 'Larynx', 'C', 'neck', 'anterior', [0, 1.494, 0]],
  ['tiroides', 'Tiroides', 'Thyroid', 'B', 'neck', 'anterior', [-0.017, 1.476, 0]],
  ['paratiroides', 'Paratiroides', 'Parathyroid', 'B', 'neck', 'anterior', [-0.028, 1.468, 0]],
  ['traquea', 'Tráquea', 'Trachea', 'B', 'neck', 'anterior', [-0.013, 1.458, 0]],
  ['cuello', 'Cuello', 'Neck', 'B', 'neck', 'anterior', [-0.036, 1.497, 0]],
  ['esternocleidomastoideo', 'Esternocleidomastoideo', 'Sternocleidomastoid', 'B', 'neck', 'anterior', [-0.044, 1.515, 0]],
  ['carotida', 'Carótida', 'Carotid', 'B', 'neck', 'anterior', [-0.03, 1.523, 0]],
  ['plexo-cervical', 'Plexo Cervical', 'Cervical plexus', 'B', 'neck', 'lateral', [-0.04, 1.508, -0.012]],
  ['vago', 'Vago', 'Vagus nerve', 'B', 'neck', 'lateral', [-0.04, 1.53, 0.002]],
  ['nudo-braquial', 'Nudo Braquial', 'Brachial plexus knot', 'B', 'neck', 'anterior', [-0.062, 1.462, 0]],
  ['clavicula', 'Clavícula', 'Clavicle', 'B', 'thorax', 'anterior', [-0.1, 1.442, 0]],
  // ---------------- thorax (anterior) ----------------
  ['hueco-de-la-garganta', 'Hueco de la Garganta', 'Suprasternal notch', 'C', 'neck', 'anterior', [0, 1.447, 0]],
  ['esofago', 'Esófago', 'Esophagus', 'B', 'thorax', 'anterior', [-0.012, 1.428, 0]],
  ['primera-costilla', 'Primera Costilla', 'First rib', 'B', 'thorax', 'anterior', [-0.05, 1.432, 0], ['costilla-1']],
  ['subclavia', 'Subclavia', 'Subclavian', 'B', 'thorax', 'anterior', [-0.085, 1.418, 0]],
  ['manubrio-del-esternon', 'Manubrio del Esternón', 'Sternal manubrium', 'B', 'thorax', 'anterior', [-0.016, 1.415, 0], ['manubrio']],
  ['timo', 'Timo', 'Thymus', 'C', 'thorax', 'anterior', [0, 1.39, 0]],
  ['carina', 'Carina', 'Carina', 'B', 'thorax', 'anterior', [-0.026, 1.372, 0]],
  ['boton-aortico', 'Botón Aórtico', 'Aortic knob', 'C', 'thorax', 'anterior', [0.034, 1.37, 0]],
  ['cava', 'Cava', 'Vena cava', 'B', 'thorax', 'anterior', [-0.036, 1.352, 0]],
  ['bronquio', 'Bronquio', 'Bronchus', 'B', 'thorax', 'anterior', [-0.05, 1.37, 0]],
  ['pulmon', 'Pulmón', 'Lung', 'B', 'thorax', 'anterior', [-0.085, 1.355, 0]],
  ['costilla-3', 'Tercera Costilla', 'Third rib', 'B', 'thorax', 'anterior', [-0.065, 1.335, 0]],
  ['mediastino', 'Mediastino', 'Mediastinum', 'C', 'thorax', 'anterior', [0, 1.348, 0]],
  ['esternon', 'Esternón', 'Sternum', 'C', 'thorax', 'anterior', [0, 1.33, 0]],
  ['pectoral', 'Pectoral', 'Pectoral', 'B', 'thorax', 'anterior', [-0.11, 1.32, 0]],
  ['coronarias', 'Coronarias', 'Coronary arteries', 'C', 'thorax', 'anterior', [0.03, 1.305, 0]],
  ['pericardio', 'Pericardio', 'Pericardium', 'C', 'thorax', 'anterior', [0.032, 1.285, 0]],
  ['punta-del-corazon', 'Punta del Corazón', 'Cardiac apex', 'C', 'thorax', 'anterior', [0.088, 1.245, 0]],
  ['vena-pulmonar', 'Vena Pulmonar', 'Pulmonary vein', 'C', 'thorax', 'anterior', [0.022, 1.325, 0]],
  ['aorta', 'Aorta', 'Aorta', 'C', 'thorax', 'anterior', [0.024, 1.35, 0]],
  ['corazon', 'Corazón', 'Heart', 'C', 'thorax', 'anterior', [0.062, 1.275, 0]],
  ['seno-auriculoventricular', 'Seno Auriculoventricular', 'Atrioventricular node', 'C', 'thorax', 'anterior', [0.012, 1.268, 0], ['seno-auriculo-ventricular']],
  ['mama', 'Mama', 'Breast', 'B', 'thorax', 'anterior', [-0.085, 1.272, 0]],
  ['pleura', 'Pleura', 'Pleura', 'B', 'thorax', 'anterior', [-0.13, 1.25, 0]],
  ['condral', 'Condral', 'Costochondral', 'B', 'thorax', 'anterior', [-0.055, 1.225, 0]],
  ['apendice-xifoides', 'Apéndice Xifoides', 'Xiphoid process', 'C', 'thorax', 'anterior', [0, 1.222, 0]],
  ['costilla-7', 'Séptima Costilla', 'Seventh rib', 'B', 'thorax', 'anterior', [-0.09, 1.215, 0]],
  ['suprahepatico', 'Suprahepático', 'Suprahepatic', 'C', 'thorax', 'anterior', [-0.075, 1.205, 0]],
  ['hiato-esofagico', 'Hiato Esofágico', 'Esophageal hiatus', 'C', 'abdomen', 'anterior', [0.014, 1.198, 0]],
  ['costal-anterior', 'Costal Anterior', 'Anterior costal', 'B', 'thorax', 'anterior', [-0.105, 1.188, 0], ['parrilla-costal-anterior']],
  ['costal', 'Costal', 'Costal (lateral ribs)', 'B', 'thorax', 'lateral', [-0.12, 1.2, 0.005]],
  ['costilla', 'Costilla', 'Rib', 'B', 'thorax', 'lateral', [-0.12, 1.17, 0.02]],
  ['infraaxilar', 'Infraaxilar', 'Infra-axillary', 'B', 'thorax', 'lateral', [-0.13, 1.235, 0.0], ['infra-axilar']],
  ['axila', 'Axila', 'Axilla (armpit)', 'B', 'thorax', 'inferior', [-0.182, 1.275, 0.0]],
  ['costodiafragmatico', 'Costodiafragmático', 'Costodiaphragmatic', 'B', 'thorax', 'lateral', [-0.12, 1.135, 0.015], ['costo-diafragmatico']],
  // ---------------- abdomen ----------------
  ['higado', 'Hígado', 'Liver', 'C', 'abdomen', 'anterior', [-0.095, 1.17, 0]],
  ['diafragma', 'Diafragma', 'Diaphragm', 'B', 'abdomen', 'anterior', [-0.068, 1.168, 0]],
  ['subdiafragma', 'Subdiafragma', 'Subdiaphragm', 'B', 'abdomen', 'anterior', [-0.058, 1.15, 0]],
  ['epigastrio', 'Epigastrio', 'Epigastrium', 'C', 'abdomen', 'anterior', [0, 1.17, 0]],
  ['cardias', 'Cardias', 'Cardia', 'C', 'abdomen', 'anterior', [0.03, 1.185, 0]],
  ['estomago', 'Estómago', 'Stomach', 'C', 'abdomen', 'anterior', [0.07, 1.15, 0]],
  ['ligamento-pancreatico', 'Ligamento Pancreático', 'Pancreatic ligament', 'C', 'abdomen', 'anterior', [0.05, 1.135, 0], ['ligamento-panreatico']],
  ['ligamento-hepatico', 'Ligamento Hepático', 'Hepatic ligament', 'C', 'abdomen', 'anterior', [-0.055, 1.16, 0]],
  ['costohepatico', 'Costohepático', 'Costohepatic', 'C', 'abdomen', 'anterior', [-0.122, 1.14, 0]],
  ['perihepatico', 'Perihepático', 'Perihepatic', 'C', 'abdomen', 'anterior', [-0.13, 1.165, 0]],
  ['piloro', 'Píloro', 'Pylorus', 'C', 'abdomen', 'anterior', [-0.025, 1.135, 0]],
  ['vesicula', 'Vesícula', 'Gallbladder', 'C', 'abdomen', 'anterior', [-0.082, 1.128, 0], ['vesicula-biliar']],
  ['conducto-de-la-vesicula', 'Conducto de la Vesícula', 'Cystic duct', 'C', 'abdomen', 'anterior', [-0.064, 1.118, 0]],
  ['duodeno', 'Duodeno', 'Duodenum', 'C', 'abdomen', 'anterior', [-0.048, 1.112, 0]],
  ['ampolla-hepatopancreatica', 'Ampolla Hepatopancreática', 'Hepatopancreatic ampulla', 'C', 'abdomen', 'anterior', [-0.035, 1.098, 0]],
  ['cabeza-de-pancreas', 'Cabeza de Páncreas', 'Pancreatic head', 'C', 'abdomen', 'anterior', [-0.018, 1.112, 0]],
  ['pancreas', 'Páncreas', 'Pancreas', 'C', 'abdomen', 'anterior', [0.008, 1.115, 0]],
  ['cuerpo-de-pancreas', 'Cuerpo de Páncreas', 'Pancreatic body', 'C', 'abdomen', 'anterior', [0.03, 1.118, 0]],
  ['cola-de-pancreas', 'Cola de Páncreas', 'Pancreatic tail', 'C', 'abdomen', 'anterior', [0.066, 1.125, 0]],
  ['punta-de-pancreas', 'Punta de Páncreas', 'Pancreatic tip', 'C', 'abdomen', 'anterior', [0.095, 1.13, 0]],
  ['conducto-del-pancreas', 'Conducto del Páncreas', 'Pancreatic duct', 'C', 'abdomen', 'anterior', [0.008, 1.098, 0]],
  ['peripancreatico', 'Peripancreático', 'Peripancreatic', 'C', 'abdomen', 'anterior', [0.03, 1.098, 0]],
  ['vena-porta', 'Vena Porta', 'Portal vein', 'C', 'abdomen', 'anterior', [-0.035, 1.15, 0]],
  ['yeyuno', 'Yeyuno', 'Jejunum', 'C', 'abdomen', 'anterior', [0.055, 1.07, 0]],
  ['bazo', 'Bazo', 'Spleen', 'C', 'abdomen', 'lateral', [0.12, 1.16, 0.0]],
    ['colon-transverso', 'Colon Transverso', 'Transverse colon', 'C', 'abdomen', 'anterior', [0, 1.077, 0], ['colon-trasnverso']],
  ['mesenterio', 'Mesenterio', 'Mesentery', 'B', 'abdomen', 'anterior', [-0.03, 1.062, 0]],
  ['epiplon', 'Epiplón', 'Omentum', 'B', 'abdomen', 'anterior', [-0.068, 1.068, 0]],
  ['ombligo', 'Ombligo', 'Navel', 'C', 'abdomen', 'anterior', [0, 1.045, 0]],
  ['colon-ascendente', 'Colon Ascendente', 'Ascending colon', 'C', 'abdomen', 'anterior', [-0.108, 1.035, 0]],
  ['colon-descendente', 'Colon Descendente', 'Descending colon', 'C', 'abdomen', 'anterior', [0.108, 1.035, 0]],
  ['flanco', 'Flanco', 'Flank', 'B', 'abdomen', 'lateral', [-0.12, 1.05, 0.0]],
  ['peritoneo', 'Peritoneo', 'Peritoneum', 'B', 'abdomen', 'anterior', [-0.08, 1.015, 0]],
  ['valvula-ileocecal', 'Válvula Ileocecal', 'Ileocecal valve', 'C', 'abdomen', 'anterior', [-0.085, 0.99, 0]],
  ['uretero', 'Uréter', 'Ureter', 'B', 'abdomen', 'anterior', [-0.052, 0.99, 0], ['ureter']],
  // ---------------- pelvis (anterior) ----------------
  ['ciego', 'Ciego', 'Cecum', 'C', 'pelvis', 'anterior', [-0.102, 0.975, 0]],
  ['contraciego', 'Contraciego', 'Counter-cecum', 'C', 'pelvis', 'anterior', [0.102, 0.975, 0]],
  ['apendice', 'Apéndice', 'Appendix', 'C', 'pelvis', 'anterior', [-0.078, 0.958, 0]],
  ['colon-sigmoides', 'Colon Sigmoides', 'Sigmoid colon', 'C', 'pelvis', 'anterior', [0.078, 0.958, 0], ['sigmoides', 'colon-sigmoide']],
  ['iliaco', 'Ilíaco', 'Iliac fossa', 'B', 'pelvis', 'anterior', [-0.112, 0.948, 0]],
  ['trompa-de-falopio', 'Trompa de Falopio', 'Fallopian tube', 'B', 'pelvis', 'anterior', [-0.088, 0.935, 0]],
  ['utero', 'Útero', 'Uterus', 'C', 'pelvis', 'anterior', [0, 0.93, 0]],
  ['ovario', 'Ovario', 'Ovary', 'B', 'pelvis', 'anterior', [-0.068, 0.922, 0]],
  ['anexo', 'Anexo', 'Adnexa', 'B', 'pelvis', 'anterior', [-0.082, 0.908, 0]],
  ['vejiga', 'Vejiga', 'Bladder', 'B', 'pelvis', 'anterior', [-0.022, 0.91, 0], ['vejiga-urinaria']],
  ['nervio-inguinal', 'Nervio Inguinal', 'Inguinal nerve', 'B', 'pelvis', 'anterior', [-0.072, 0.898, 0], ['inguinal']],
  ['suprapubico', 'Suprapúbico', 'Suprapubic', 'B', 'pelvis', 'anterior', [-0.034, 0.893, 0]],
  ['saco-de-douglas', 'Saco de Douglas', 'Pouch of Douglas', 'B', 'pelvis', 'anterior', [-0.02, 0.885, 0]],
  ['ingle', 'Ingle', 'Groin', 'B', 'pelvis', 'anterior', [-0.1, 0.88, 0]],
  ['conducto-espermatico', 'Conducto Espermático', 'Spermatic cord', 'B', 'pelvis', 'anterior', [-0.058, 0.875, 0]],
    ['prostata', 'Próstata', 'Prostate', 'C', 'pelvis', 'anterior', [0, 0.862, 0]],
  ['conducto-deferente', 'Conducto Deferente', 'Vas deferens', 'B', 'pelvis', 'anterior', [-0.042, 0.86, 0]],
  ['uretra', 'Uretra', 'Urethra', 'C', 'pelvis', 'anterior', [0, 0.855, 0]],
  ['clitoris', 'Clítoris', 'Clitoris', 'C', 'pelvis', 'anterior', [0, 0.85, 0]],
  ['pene', 'Pene', 'Penis', 'C', 'pelvis', 'anterior', [0, 0.842, 0]],
  ['esfinter-uretral', 'Esfínter Uretral', 'Urethral sphincter', 'B', 'pelvis', 'anterior', [-0.014, 0.84, 0], ['esfintar-uretral']],
  ['pudendo', 'Pudendo', 'Pudendal', 'B', 'pelvis', 'anterior', [-0.042, 0.838, 0]],
  ['vagina', 'Vagina', 'Vagina', 'B', 'pelvis', 'anterior', [-0.012, 0.83, 0]],
  ['testiculo', 'Testículo', 'Testicle', 'B', 'pelvis', 'anterior', [-0.03, 0.818, 0]],
  ['suelo-pelvico', 'Suelo Pélvico', 'Pelvic floor', 'B', 'pelvis', 'inferior', [-0.006, 0.84, -0.025]],
  ['cresta-iliaca', 'Cresta Ilíaca', 'Iliac crest', 'B', 'pelvis', 'lateral', [-0.12, 1.0, -0.01]],
  ['cadera', 'Cadera', 'Hip', 'B', 'pelvis', 'lateral', [-0.13, 0.94, 0.02]],
  // ---------------- back (posterior) ----------------
  ['trapecio', 'Trapecio', 'Trapezius', 'B', 'upper-back', 'posterior', [-0.07, 1.452, 0]],
  ['supraespinoso', 'Supraespinoso', 'Supraspinatus', 'B', 'upper-back', 'posterior', [-0.1, 1.405, 0]],
  ['escapula', 'Escápula', 'Scapula', 'B', 'upper-back', 'posterior', [-0.09, 1.3, 0]],
  ['retroaxilar', 'Retroaxilar', 'Posterior axillary fold', 'B', 'upper-back', 'posterior', [-0.145, 1.31, 0], ['retro-axilar']],
  ['latissimus-dorsi', 'Latissimus Dorsi', 'Latissimus dorsi', 'B', 'upper-back', 'posterior', [-0.125, 1.2, 0], ['latisimus']],
  ['paravertebral', 'Paravertebral', 'Paravertebral', 'B', 'upper-back', 'posterior', [-0.03, 1.22, 0]],
  ['dorsal-1', 'Dorsal 1', 'Thoracic 1 (T1)', 'C', 'upper-back', 'posterior', [0, 1.442, 0]],
  ['dorsal-2', 'Dorsal 2', 'Thoracic 2 (T2)', 'B', 'upper-back', 'posterior', [-0.018, 1.416, 0]],
  ['dorsal-3', 'Dorsal 3', 'Thoracic 3 (T3)', 'C', 'upper-back', 'posterior', [0, 1.39, 0]],
  ['dorsal-5', 'Dorsal 5', 'Thoracic 5 (T5)', 'C', 'upper-back', 'posterior', [0, 1.337, 0]],
  ['dorsal', 'Dorsal', 'Thoracic spine', 'C', 'upper-back', 'posterior', [0, 1.325, 0]],
  ['dorsal-6', 'Dorsal 6', 'Thoracic 6 (T6)', 'C', 'upper-back', 'posterior', [0, 1.31, 0]],
  ['dorsal-7', 'Dorsal 7', 'Thoracic 7 (T7)', 'C', 'upper-back', 'posterior', [0, 1.284, 0]],
  ['dorso', 'Dorso', 'Upper back', 'C', 'upper-back', 'posterior', [0, 1.27, 0]],
  ['dorsal-12', 'Dorsal 12', 'Thoracic 12 (T12)', 'C', 'upper-back', 'posterior', [0, 1.152, 0]],
  ['retrohepatico', 'Retrohepático', 'Retrohepatic', 'C', 'upper-back', 'posterior', [-0.095, 1.17, 0]],
  ['suprarrenal', 'Suprarrenal', 'Adrenal gland', 'B', 'upper-back', 'posterior', [-0.06, 1.148, 0], ['suprarrenales']],
  ['lumbar-1', 'Primera Lumbar', 'Lumbar 1 (L1)', 'C', 'lower-back', 'posterior', [0, 1.124, 0], ['primera-lumbar']],
  ['capsula-renal', 'Cápsula Renal', 'Renal capsule', 'B', 'lower-back', 'posterior', [-0.08, 1.115, 0]],
  ['rinon', 'Riñón', 'Kidney', 'B', 'lower-back', 'posterior', [-0.06, 1.1, 0]],
  ['caliz-renal', 'Cáliz Renal', 'Renal calyx', 'B', 'lower-back', 'posterior', [-0.042, 1.092, 0]],
    ['perirrenal', 'Perirrenal', 'Perirenal', 'B', 'lower-back', 'posterior', [-0.085, 1.082, 0]],
  ['lumbar', 'Lumbar', 'Lumbar spine', 'C', 'lower-back', 'posterior', [0, 1.075, 0]],
  ['lumbar-3', 'Tercera Lumbar', 'Lumbar 3 (L3)', 'C', 'lower-back', 'posterior', [0, 1.068, 0], ['tercera-lumbar']],
  ['plexo-lumbar', 'Plexo Lumbar', 'Lumbar plexus', 'B', 'lower-back', 'posterior', [-0.038, 1.055, 0]],
  ['cuadrado-lumbar', 'Cuadrado Lumbar', 'Quadratus lumborum', 'B', 'lower-back', 'posterior', [-0.078, 1.045, 0]],
  ['cuarta-lumbar', 'Cuarta Lumbar', 'Lumbar 4 (L4)', 'B', 'lower-back', 'posterior', [-0.02, 1.04, 0], ['lumbar-4']],
  ['quinta-lumbar', 'Quinta Lumbar', 'Lumbar 5 (L5)', 'B', 'lower-back', 'posterior', [-0.02, 1.012, 0], ['lumbar-5']],
  ['cola-de-caballo', 'Cola de Caballo', 'Cauda equina', 'C', 'lower-back', 'posterior', [0, 0.975, 0]],
  ['interiliaco', 'Interilíaco', 'Interiliac', 'C', 'lower-back', 'posterior', [0, 0.99, 0]],
  ['sacro', 'Sacro', 'Sacrum', 'C', 'lower-back', 'posterior', [0, 0.955, 0]],
  ['escotadura-ciatica', 'Escotadura Ciática', 'Sciatic notch', 'B', 'gluteal', 'posterior', [-0.075, 0.93, 0]],
  ['coxis', 'Coxis', 'Coccyx', 'C', 'gluteal', 'posterior', [0, 0.905, 0], ['coxigeo']],
  ['gluteo', 'Glúteo', 'Gluteus', 'B', 'gluteal', 'posterior', [-0.088, 0.885, 0]],
  ['recto', 'Recto', 'Rectum', 'C', 'gluteal', 'posterior', [0, 0.878, 0]],
  ['ano', 'Ano', 'Anus', 'C', 'gluteal', 'posterior', [0, 0.852, 0]],
  ['cresta-isquiatica', 'Cresta Isquiática', 'Ischial crest', 'B', 'gluteal', 'posterior', [-0.07, 0.848, 0]],
  ['isquion', 'Isquión', 'Ischium', 'B', 'gluteal', 'posterior', [-0.062, 0.826, 0]],
  ['rama-isquiatica', 'Rama Isquiática', 'Ischial ramus', 'B', 'gluteal', 'posterior', [-0.038, 0.815, 0]],
  // ---------------- shoulder & upper limb ----------------
  ['acromion', 'Acromion', 'Acromion', 'B', 'shoulder', 'superior', [-0.165, 1.40, -0.012]],
  
  ['hombro', 'Hombro', 'Shoulder', 'B', 'shoulder', 'anterior', [-0.185, 1.385, 0]],
  ['bursa', 'Bursa', 'Bursa (axilla–arm junction)', 'B', 'shoulder', 'anterior', [-0.172, 1.30, 0]],
  ['deltoides', 'Deltoides', 'Deltoid', 'B', 'arm', 'lateral', arm(0.22), ['deltoides-medio']],
  ['vacuna', 'Vacuna', 'Vaccination site (left deltoid)', 'C', 'arm', 'lateral', arm(0.38).map((v, i) => (i === 0 ? -v : v))],
  ['humero', 'Húmero', 'Humerus', 'B', 'arm', 'lateral', arm(0.62)],
  ['braquial', 'Braquial', 'Brachial', 'B', 'arm', 'anterior', arm(0.42, -0.008)],
  ['biceps', 'Bíceps', 'Biceps', 'B', 'arm', 'anterior', arm(0.62)],
  ['codo', 'Codo', 'Elbow', 'B', 'forearm', 'lateral', fore(0.02)],
  ['radio', 'Radio', 'Radius', 'B', 'forearm', 'anterior', fore(0.45, 0.014)],
  ['cubito', 'Cúbito', 'Ulna', 'B', 'forearm', 'anterior', fore(0.45, -0.016)],
  ['muneca', 'Muñeca', 'Wrist', 'B', 'forearm', 'anterior', fore(0.96)],
  
  ['tunel-carpiano', 'Túnel Carpiano', 'Carpal tunnel', 'B', 'hand', 'anterior', hand(0.1)],
  ['palma', 'Palma', 'Palm', 'B', 'hand', 'anterior', hand(0.32)],
    ['dorso-de-la-mano', 'Dorso de la Mano', 'Back of the hand', 'B', 'hand', 'posterior', hand(0.32)],
  ['indice', 'Índice', 'Index finger', 'B', 'hand', 'anterior', hand(0.78, 0.011), ['dedo-indice']],
  // ---------------- lower limb ----------------
  ['trocanter-mayor', 'Trocánter Mayor', 'Greater trochanter', 'B', 'thigh', 'lateral', [-0.15, 0.87, -0.012]],
  ['tensor-de-la-fascia-lata', 'Tensor de la Fascia Lata', 'Tensor fasciae latae', 'B', 'thigh', 'lateral', [-0.15, 0.835, 0.03], ['tensor-de-las-fascia-lata']],
  ['retrotensor-de-la-fascia-lata', 'Retrotensor de la Fascia Lata', 'Posterior tensor fasciae latae', 'B', 'thigh', 'posterior', [-0.14, 0.81, 0], ['retrotensor-de-las-fascia-lata', 'retro-tensor-de-la-fascia-lata']],
  ['vena-femoral', 'Vena Femoral', 'Femoral vein', 'B', 'thigh', 'anterior', thigh(0.14, 0.022)],
  ['trocanter-menor', 'Trocánter Menor', 'Lesser trochanter', 'B', 'thigh', 'anterior', thigh(0.2, 0.034)],
  ['aductor', 'Aductor', 'Adductor', 'B', 'thigh', 'anterior', thigh(0.34, 0.045)],
  ['aductor-menor', 'Aductor Menor', 'Adductor brevis', 'B', 'thigh', 'anterior', thigh(0.22, 0.05)],
  ['cuadriceps', 'Cuádriceps', 'Quadriceps', 'B', 'thigh', 'anterior', thigh(0.48, -0.005)],
  ['cuello-de-femur', 'Cuello de Fémur', 'Neck of the femur', 'B', 'thigh', 'anterior', [-0.125, 0.86, 0]],
  ['ciatico', 'Ciático', 'Sciatic', 'B', 'thigh', 'posterior', thigh(0.24)],
  ['rodilla', 'Rodilla', 'Knee', 'B', 'knee', 'lateral', knee(0, 0.005, 0.01)],
  ['ligamento-externo-de-la-rodilla', 'Ligamento Externo de la Rodilla', 'Lateral knee ligament', 'B', 'knee', 'lateral', knee(0, -0.01, -0.006), ['lig-ext-de-la-rodilla']],
  ['ligamento-interno-de-la-rodilla', 'Ligamento Interno de la Rodilla', 'Medial knee ligament', 'B', 'knee', 'anterior', knee(0.036, -0.012), ['lig-int-de-la-rodilla']],
  ['rotula', 'Rótula', 'Kneecap', 'B', 'knee', 'anterior', knee(0, 0.014)],
  ['articulacion', 'Articulación', 'Joint (generic)', 'B', 'knee', 'anterior', knee(-0.028, -0.004)],
  ['popliteo', 'Poplíteo', 'Popliteal', 'B', 'knee', 'posterior', knee(0, 0.0)],
  ['gastrocnemio', 'Gastrocnemio', 'Gastrocnemius', 'B', 'leg', 'posterior', leg(0.3)],
  ['nutricia', 'Nutricia', 'Nutrient foramen (tibia)', 'B', 'leg', 'anterior', leg(0.32, 0.02)],
  ['tibia', 'Tibia', 'Tibia', 'B', 'leg', 'anterior', leg(0.45, 0.008)],
  ['perone', 'Peroné', 'Fibula', 'B', 'leg', 'lateral', leg(0.42)],
    ['aquiles', 'Aquiles', 'Achilles tendon', 'B', 'leg', 'posterior', leg(0.88)],
  ['maleolo-interno', 'Maléolo Interno', 'Medial malleolus', 'B', 'foot', 'anterior', [-0.088, 0.078, 0], ['maleolo-int']],
  ['maleolo-externo', 'Maléolo Externo', 'Lateral malleolus', 'B', 'foot', 'lateral', [-0.12, 0.07, -0.03], ['maleolo-ext']],
  ['tobillo', 'Tobillo', 'Ankle', 'B', 'foot', 'anterior', [-0.113, 0.085, 0]],
  ['empeine', 'Empeine', 'Instep', 'B', 'foot', 'superior', [-0.122, 0.05, 0.065]],
  ['tarso', 'Tarso', 'Tarsus', 'B', 'foot', 'superior', [-0.118, 0.05, 0.025]],
    ['dedo-gordo-del-pie', 'Dedo Gordo del Pie', 'Big toe', 'B', 'foot', 'superior', [-0.128, 0.03, 0.172]],
  ['talon', 'Talón', 'Heel', 'B', 'foot', 'posterior', [-0.114, 0.035, 0]],
  ['calcaneo', 'Calcáneo', 'Calcaneus', 'B', 'foot', 'lateral', [-0.12, 0.038, -0.045]],
  ['retroplantar', 'Retroplantar', 'Rear sole', 'B', 'foot', 'inferior', [-0.116, 0.02, -0.035]],
  ['planta-del-pie', 'Planta del Pie', 'Sole of the foot', 'B', 'foot', 'inferior', [-0.128, 0.02, 0.08]],
  ['arco-del-pie', 'Arco del Pie', 'Arch of the foot', 'B', 'foot', 'inferior', [-0.1, 0.02, 0.045]],
  ['antecuerno', 'Antecuerno', 'Antecuerno (anterior horn point)', 'B', 'face', 'anterior', [-0.048, 1.703, 0]],
  ['suprasensorial', 'Suprasensorial', 'Suprasensorial point', 'C', 'face', 'anterior', [0, 1.705, 0]],
  ['nucleos-basales', 'Núcleos Basales', 'Basal ganglia', 'B', 'head', 'lateral', [-0.06, 1.664, 0.01]],
  ['nervio-trigemino', 'Nervio Trigémino', 'Trigeminal nerve', 'B', 'face', 'lateral', [-0.055, 1.6, 0.045]],
  ['tallo-cerebral', 'Tallo Cerebral', 'Brainstem', 'C', 'head', 'internal', [0, 1.6, -0.03]],
  ['lobulo-posterior-del-higado', 'Lóbulo Posterior del Hígado', 'Posterior lobe of the liver', 'C', 'upper-back', 'posterior', [-0.105, 1.2, 0]],
  ['arteria-femoral', 'Arteria Femoral', 'Femoral artery', 'B', 'thigh', 'anterior', thigh(0.1, 0.012)],
  ['nervio-femoral', 'Nervio Femoral', 'Femoral nerve', 'B', 'thigh', 'anterior', thigh(0.1, -0.008)],
  ['pliegue-inguinal', 'Pliegue Inguinal', 'Inguinal fold', 'B', 'pelvis', 'anterior', [-0.082, 0.855, 0]],
  ['hernia', 'Hernia', 'Hernia site (inguinal default)', 'B', 'pelvis', 'anterior', [-0.06, 0.888, 0]],
  ['cabeza-de-perone', 'Cabeza de Peroné', 'Head of the fibula', 'B', 'leg', 'lateral', leg(0.08)],
  ['tendon-del-cuadriceps', 'Tendón del Cuádriceps', 'Quadriceps tendon', 'B', 'knee', 'anterior', knee(0, 0.065)],
  ['tendon-del-triceps', 'Tendón del Tríceps', 'Triceps tendon', 'B', 'arm', 'posterior', arm(0.9)],
  ['tendon', 'Tendón', 'Tendon (default: common extensor, elbow)', 'B', 'forearm', 'lateral', fore(0.1)],
  // generic "affected site" points: placed at a neutral default; the practitioner positions the magnet on the actual lesion
  ['cicatriz', 'Cicatriz', 'Scar (default site)', 'C', 'abdomen', 'anterior', [0.06, 0.985, 0]],
  ['quemadura', 'Quemadura', 'Burn (default site)', 'C', 'forearm', 'anterior', fore(0.55)],
  ['verruga', 'Verruga', 'Wart (default site)', 'C', 'hand', 'posterior', hand(0.2)],
  ['lunar', 'Lunar', 'Mole (default site)', 'C', 'upper-back', 'posterior', [-0.06, 1.34, 0]],
  ['munon', 'Muñón', 'Stump / scar-tissue knot (default site)', 'C', 'thigh', 'lateral', thigh(0.72)],
  ['mordida', 'Mordida', 'Animal-bite site (default)', 'C', 'leg', 'lateral', leg(0.35)],
  ['variable', 'Variable', 'Variable (affected tissue/organ)', 'C', 'abdomen', 'internal', [0, 1.1, 0]],
  // ---------------- whole-region pseudo points used by some pairs ----------------
  ['todo-el-frente', 'Todo el Frente', 'Whole front', 'C', 'thorax', 'anterior', [0, 1.21, 0]],
];

// Authoritative point list from the Data team, when present: ids, laterality, names.
let catalog = null;
try { catalog = JSON.parse(await readFile(join(root, 'data', 'catalog', 'points.json'), 'utf8')); } catch { /* not yet produced */ }
const catIds = catalog ? new Map(catalog.map((p) => [p.id, p])) : null;
const catAlias = new Map();
if (catalog) for (const p of catalog) for (const a of p.aliases || []) catAlias.set(slug(a), p.id);
// Points used by the reference protocol card that points.json does not list (reported as a data gap).
const KEEP_EXTRA = new Set(['ingle', 'gastrocnemio']);

const REGIONS = new Set();
const anatomy = {};
const demo = [];
const problems = [];
const round = (v) => Math.round(v * 1000) / 1000;
let maxDev = 0;
for (const [id, es, en, lat, region, view, p, aliases = []] of P) {
  if (id !== slug(id)) throw new Error(`id not a slug: ${id}`);
  if (anatomy[id]) throw new Error(`duplicate id: ${id}`);
  const cat = catIds?.get(id);
  if (catIds && !cat && !KEEP_EXTRA.has(id)) { problems.push(`dropped (not in points.json): ${id}`); continue; }
  if (cat && (cat.laterality === 'bilateral') !== (lat === 'B')) problems.push(`laterality differs from points.json: ${id}`);
  REGIONS.add(region);
  const pos = p.slice();
  if (lat === 'B' && pos[0] >= 0) throw new Error(`${id}: bilateral pos must be patient-RIGHT (x<0)`);
  let snapped;
  if (view === 'internal') snapped = { pos };
  else {
    snapped = snapPoint(body.sdf, pos, view);
    const d = Math.hypot(snapped.pos[0] - pos[0], snapped.pos[1] - pos[1]);
    if (['anterior', 'posterior'].includes(view)) maxDev = Math.max(maxDev, d);
  }
  const rec = { region, view, pos: { x: round(snapped.pos[0]), y: round(snapped.pos[1]), z: round(snapped.pos[2]) } };
  anatomy[id] = rec;
  for (const a of aliases) {
    // keep alias keys only when they resolve to this id in points.json (or no points.json yet)
    if (catIds && (catIds.has(a) || catAlias.get(a) !== id)) continue;
    if (anatomy[a]) throw new Error(`duplicate alias: ${a}`);
    anatomy[a] = { ...rec, pos: { ...rec.pos } };
  }
  demo.push({ id, name: cat ? cat.name : { es, en }, laterality: cat ? cat.laterality : (lat === 'B' ? 'bilateral' : 'central') });
}
if (catIds) for (const id of catIds.keys()) if (!anatomy[id]) problems.push(`MISSING anatomy for points.json id: ${id}`);

// Four-magnet pancreas pair (pb-282): head −, body +, tail −, tip +.
const sub = (id) => ({ ...anatomy[id], pos: { ...anatomy[id].pos }, of: 'pancreas' });
const subpoints = {
  'pancreas#head': sub('cabeza-de-pancreas'),
  'pancreas#body': sub('cuerpo-de-pancreas'),
  'pancreas#tail': sub('cola-de-pancreas'),
  'pancreas#tip': sub('punta-de-pancreas'),
};
const sorted = Object.fromEntries(Object.keys(anatomy).sort().map((k) => [k, anatomy[k]]));
sorted.subpoints = subpoints;
await writeFile(join(root, 'data', 'catalog', 'point-anatomy.json'), JSON.stringify(sorted, null, 1) + '\n');
await writeFile(join(root, 'web', 'js', 'viewer3d', 'demo-points.json'), JSON.stringify(demo, null, 1) + '\n');
console.log(`points: ${demo.length} with anatomy, ${Object.keys(anatomy).length} keys incl. aliases; regions used: ${[...REGIONS].join(', ')}`);
console.log(`max in-plane snap deviation (anterior/posterior): ${(maxDev * 1000).toFixed(1)} mm`);
for (const pr of problems) console.log('  ' + pr);
