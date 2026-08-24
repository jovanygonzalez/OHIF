#!/usr/bin/env node
//
// Verifica el sellado de los DICOM SR que escribe el visor — el hook
// `onBeforeDicomStore` de config/genx-base.js (F2 de docs/annotations.md).
//
//   node scripts/check-sr-stamp.js
//
// POR QUÉ EXISTE: el hook corrige defaults que pone dcmjs, no GenX
// (`ContentQualification: RESEARCH`, `ImageComments: NOT FOR CLINICAL USE`,
// `Manufacturer: Unspecified`, `PersonObserverName: unknown^unknown`). Son
// internos de una dependencia: un bump de dcmjs puede renombrarlos o moverlos
// y el hook seguiría "funcionando" mientras vuelve a emitir objetos marcados
// como no clínicos. En DICOM no existe borrar, así que esa regresión sería
// permanente estudio por estudio. Esta prueba carga dcmjs REAL —no un mock— y
// falla si los defaults dejan de ser los que el hook sabe corregir.
//
// Correrlo antes de publicar (scripts/build.sh) y después de tocar dcmjs,
// @cornerstonejs/adapters o el propio genx-base.js.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'platform/app/public/config/genx-base.js');

const dcmjs = require(path.join(ROOT, 'node_modules/dcmjs'));
const { DicomDict, DicomMetaDictionary, DicomMessage } = dcmjs.data;
const { StructuredReport } = dcmjs.derivations;

const AUTHORITY = 'https://auth.genx.mx/realms/genx';
const USER_KEY = 'oidc.user:' + AUTHORITY + ':genx-viewer';

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (detail === undefined ? '' : ' -> ' + JSON.stringify(detail)));
  }
}

// ── genx-base.js en un navegador de mentira ────────────────────────────────
// El archivo es config plana que se evalúa en el navegador; no exporta nada, se
// asigna a window.config. Por eso se carga en un contexto de vm en vez de
// require().
const storage = new Map();
function loadHook() {
  const sandbox = {
    console: { warn: () => {}, error: () => {}, log: () => {} },
    setTimeout,
    window: {
      PUBLIC_URL: '/v4/',
      localStorage: { getItem: k => (storage.has(k) ? storage.get(k) : null) },
    },
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CONFIG, 'utf8'), sandbox);
  const config = sandbox.window.config;
  // La authority la aporta el delta de cliente en producción.
  config.oidc[0].authority = AUTHORITY;
  return config.customizationService && config.customizationService.onBeforeDicomStore;
}

const REFERENCED = {
  SOPInstanceUID: '1.2.3.4.5',
  SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
  StudyInstanceUID: '2.25.145564919380729858854734912248359972698',
  AccessionNumber: 'FAA-45587',
  StudyID: '1',
  StudyDate: '20260320',
  StudyTime: '101500',
  PatientID: '26046433',
  PatientName: 'GALVAN^JUAN',
  PatientBirthDate: '19800101',
  PatientSex: 'M',
  ReferringPhysicianName: '',
  _vrMap: {},
  _meta: {},
};

// Un SR como el que arma @cornerstonejs/adapters: StructuredReport de dcmjs
// (que aporta los defaults a corregir) + el ítem de autoría de TID 1002.
function buildReport(options) {
  const dataset = new StructuredReport([REFERENCED], options || {}).dataset;
  dataset.SpecificCharacterSet = 'ISO_IR 192';
  dataset.ContentTemplateSequence = { MappingResource: 'DCMR', TemplateIdentifier: '1500' };
  dataset.ConceptNameCodeSequence = {
    CodeValue: '126000',
    CodingSchemeDesignator: 'DCM',
    CodeMeaning: 'Imaging Measurement Report',
  };
  dataset.ContinuityOfContent = 'SEPARATE';
  dataset.CompletionFlag = 'COMPLETE';
  dataset.VerificationFlag = 'UNVERIFIED';
  dataset.InstanceNumber = 1;
  dataset.ContentSequence = [
    { RelationshipType: 'HAS CONCEPT MOD', ValueType: 'CODE' },
    {
      RelationshipType: 'HAS OBS CONTEXT',
      ValueType: 'PNAME',
      ConceptNameCodeSequence: {
        CodeValue: '121008',
        CodingSchemeDesignator: 'DCM',
        CodeMeaning: 'Person Observer Name',
      },
      PersonName: 'unknown^unknown',
    },
  ];
  return dataset;
}

// Lo mismo que hace DicomWebDataSource.store.dicom cuando dicomDict es
// undefined (extensions/default/src/DicomWebDataSource/index.ts:411-428).
function toPart10(dataset) {
  const meta = {
    MediaStorageSOPClassUID: dataset.SOPClassUID,
    MediaStorageSOPInstanceUID: dataset.SOPInstanceUID,
    TransferSyntaxUID: '1.2.840.10008.1.2.1',
    ImplementationClassUID: DicomMetaDictionary.uid(),
    ImplementationVersionName: 'OHIF-3.11.0',
  };
  const dict = new DicomDict(DicomMetaDictionary.denaturalizeDataset(meta));
  dict.dict = DicomMetaDictionary.denaturalizeDataset(dataset);
  return Buffer.from(dict.write());
}

const hook = loadHook();

console.log('\n[0] el hook está cableado');
check('customizationService.onBeforeDicomStore es función', typeof hook === 'function');
if (typeof hook !== 'function') {
  console.log('\nSin hook no hay nada más que probar.');
  process.exit(1);
}

// ── 0. Los defaults que este hook existe para corregir ─────────────────────
// Si dcmjs deja de ponerlos, el hook queda sin sentido O los cambió de nombre y
// hay que actualizarlo. Las dos cosas hay que enterarse acá, no en producción.
console.log('\n[1] dcmjs sigue poniendo los defaults de investigación');
const virgin = buildReport({});
check(
  'ContentQualification = RESEARCH',
  virgin.ContentQualification === 'RESEARCH',
  virgin.ContentQualification
);
check(
  'ImageComments = NOT FOR CLINICAL USE',
  virgin.ImageComments === 'NOT FOR CLINICAL USE',
  virgin.ImageComments
);
check('Manufacturer = Unspecified', virgin.Manufacturer === 'Unspecified', virgin.Manufacturer);
check(
  'SeriesDescription = Research Derived series',
  virgin.SeriesDescription === 'Research Derived series',
  virgin.SeriesDescription
);
check(
  'SOPClassUID = EnhancedSR (no Comprehensive3DSR)',
  virgin.SOPClassUID === '1.2.840.10008.5.1.4.1.1.88.22',
  virgin.SOPClassUID
);

// ── 2. El sellado, con sesión completa ─────────────────────────────────────
console.log('\n[2] sesión completa + nombre escrito por el usuario');
storage.set(
  USER_KEY,
  JSON.stringify({
    profile: { family_name: 'Pérez García', given_name: 'María', preferred_username: 'mperez' },
  })
);
let r = buildReport({ SeriesDescription: 'medidas torax', SeriesNumber: 3001 });
const returned = hook({ dicomDict: undefined, measurementData: [], naturalizedReport: r });

check('devuelve undefined (muta in place)', returned === undefined, returned);
check('ContentQualification borrado', !('ContentQualification' in r));
check('ImageComments borrado', !('ImageComments' in r));
check(
  'ClinicalTrial* borrados',
  !('ClinicalTrialSeriesID' in r) &&
    !('ClinicalTrialTimePointID' in r) &&
    !('ClinicalTrialCoordinatingCenterName' in r)
);
check('DeviceSerialNumber borrado', !('DeviceSerialNumber' in r));
check('Manufacturer = GenX', r.Manufacturer === 'GenX', r.Manufacturer);
check(
  'ManufacturerModelName = GenX RIS Viewer',
  r.ManufacturerModelName === 'GenX RIS Viewer',
  r.ManufacturerModelName
);
check('SoftwareVersions del prefijo publicado', r.SoftwareVersions === 'v4', r.SoftwareVersions);
check(
  'respeta el nombre que escribió el usuario',
  r.SeriesDescription === 'medidas torax',
  r.SeriesDescription
);
check(
  'PersonObserverName firmado',
  r.ContentSequence[1].PersonName === 'Pérez García^María',
  r.ContentSequence[1].PersonName
);
check('Modality sigue SR', r.Modality === 'SR', r.Modality);
check('SOPClassUID intacto', r.SOPClassUID === '1.2.840.10008.5.1.4.1.1.88.22', r.SOPClassUID);

// Los cinco campos con los que AHI decide primary vs non-primary image set
// (docs/annotations.md §4.3). Tocar cualquiera manda el SR a un image set
// aparte y el estudio deja de listarlo — el riesgo que F1 descartó.
check(
  'agrupación de AHI intacta (los 5 campos)',
  r.StudyInstanceUID === REFERENCED.StudyInstanceUID &&
    r.AccessionNumber === REFERENCED.AccessionNumber &&
    r.StudyID === REFERENCED.StudyID &&
    r.PatientID === REFERENCED.PatientID &&
    r.StudyDate === REFERENCED.StudyDate
);

// ── 3. SeriesDescription genérico ──────────────────────────────────────────
console.log('\n[3] el usuario deja el campo vacío');
r = buildReport({ SeriesDescription: 'Create Report' });
hook({ naturalizedReport: r });
check(
  'sustituye "Create Report" por etiqueta con fecha',
  /^Anotaciones \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r.SeriesDescription),
  r.SeriesDescription
);

r = buildReport({});
hook({ naturalizedReport: r });
check(
  'sustituye "Research Derived series"',
  /^Anotaciones /.test(r.SeriesDescription),
  r.SeriesDescription
);

// ── 4. Perfiles parciales y sin sesión ─────────────────────────────────────
console.log('\n[4] la autoría degrada sin inventar');
storage.set(USER_KEY, JSON.stringify({ profile: { name: 'Juan Carlos Ruiz Mena' } }));
r = buildReport({});
hook({ naturalizedReport: r });
check(
  'sin family/given usa `name` en un solo componente',
  r.ContentSequence[1].PersonName === 'Juan Carlos Ruiz Mena',
  r.ContentSequence[1].PersonName
);

storage.set(
  USER_KEY,
  JSON.stringify({ profile: { family_name: 'Ruiz^Mena=X\\Y', given_name: '  Juan   Carlos ' } })
);
r = buildReport({});
hook({ naturalizedReport: r });
check(
  'neutraliza los delimitadores de PN (^ = \\)',
  r.ContentSequence[1].PersonName === 'Ruiz Mena X Y^Juan Carlos',
  r.ContentSequence[1].PersonName
);

storage.delete(USER_KEY);
r = buildReport({});
hook({ naturalizedReport: r });
check(
  'sin sesión deja unknown^unknown (no inventa autor)',
  r.ContentSequence[1].PersonName === 'unknown^unknown',
  r.ContentSequence[1].PersonName
);
check(
  'sin sesión igual sella el producto',
  r.Manufacturer === 'GenX' && !('ContentQualification' in r)
);

// ── 5. Bordes que no deben tirar el guardado ───────────────────────────────
console.log('\n[5] bordes');
check('sin naturalizedReport no revienta', hook({}) === undefined);
r = buildReport({});
delete r.ContentSequence;
check('sin ContentSequence no revienta', hook({ naturalizedReport: r }) === undefined);

// ── 6. Los bytes que recibiría AHI ─────────────────────────────────────────
// Lo anterior prueba el objeto en memoria; esto prueba el part-10 ya escrito,
// que es lo que sale en el POST.
console.log('\n[6] round-trip por los bytes del part-10');
storage.set(
  USER_KEY,
  JSON.stringify({ profile: { family_name: 'Pérez García', given_name: 'María' } })
);
r = buildReport({ SeriesDescription: 'medidas torax' });
hook({ naturalizedReport: r });
const buffer = toPart10(r);
const back = DicomMetaDictionary.naturalizeDataset(DicomMessage.readFile(buffer).dict);

check('el part-10 se escribe', buffer.byteLength > 0, buffer.byteLength);
check(
  'ContentQualification ausente en los bytes',
  back.ContentQualification === undefined,
  back.ContentQualification
);
check('ImageComments ausente en los bytes', back.ImageComments === undefined, back.ImageComments);
check(
  'sin rastro de RESEARCH ni NOT FOR CLINICAL USE',
  !buffer.includes(Buffer.from('RESEARCH')) && !buffer.includes(Buffer.from('NOT FOR CLINICAL USE'))
);
check('Manufacturer en los bytes', back.Manufacturer === 'GenX', back.Manufacturer);
check(
  'SeriesDescription en los bytes',
  back.SeriesDescription === 'medidas torax',
  back.SeriesDescription
);
check(
  'SpecificCharacterSet declarado',
  back.SpecificCharacterSet === 'ISO_IR 192',
  back.SpecificCharacterSet
);

// ⚠️ Dos cosas que NO son bugs y engañan al verificar a mano:
//   - naturalizeDataset devuelve PN como { Alphabetic: '...' }, no como string.
//   - DicomMessage.readFile decodifica latin1, así que un nombre con acentos
//     REGRESA como mojibake ('PÃ©rez') aunque los bytes sean UTF-8 correctos.
// La pregunta real es qué bytes recibe AHI, así que se comprueban los bytes.
const observer = [].concat(back.ContentSequence || []).find(i => i.ValueType === 'PNAME');
const personName =
  observer &&
  (typeof observer.PersonName === 'string'
    ? observer.PersonName
    : observer.PersonName && observer.PersonName.Alphabetic);
check(
  'PersonObserverName presente y firmado',
  typeof personName === 'string' && personName.indexOf('^') !== -1,
  personName
);
check(
  'acentos escritos como UTF-8, no latin1',
  buffer.includes(Buffer.from('Pérez García^María', 'utf8'))
);

console.log('\n' + (failures ? failures + ' FALLO(S)' : 'todo verde') + '\n');
process.exit(failures ? 1 : 0);
