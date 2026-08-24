/** @type {AppTypes.Config} */

// Config BASE del visor GenX — compartida por todos los clientes.
//
// Este archivo NO contiene nada específico de un cliente. El datastore de AWS
// HealthImaging (y opcionalmente logo/título) los aporta un delta por cliente
// desde `config/clients/{slug}.js`, que `scripts/publish-client.sh` concatena
// DESPUÉS de este archivo al publicar.
//
//   app-config.js publicado  =  genx-base.js  +  clients/{slug}.js
//
// Por eso el visor se compila UNA sola vez y se publica N veces: webpack copia
// este archivo tal cual (no lo bundlea, ver .webpack/webpack.pwa.js), así que
// el `dist/` es idéntico para todos los clientes.
//
// Flujo:
//   scripts/build.sh v3
//   scripts/publish-client.sh mx-san-mungo v3 genx-viewer <distribution-id>
//
// Contexto y decisiones: ../../../../GENX-MULTI-TENANT.md
//
// Los configs `aws-healthimaging.js` (v1) y `aws-healthimaging-v2.js` (v2) están
// CONGELADOS: son el config de los artefactos ya desplegados y existen solo para
// rollback. Cualquier cambio de comportamiento va aquí.

// Marcador que publish-client.sh verifica para asegurarse de que el dist/ se
// construyó con este base y no con un config legacy que ya trae datastore
// horneado (publicar eso a un cliente le mostraría el datastore de otro).
window.GENX_CONFIG_BASE = true;

window.config = {
  // SIN barra final, y eso NO es cosmético.
  //
  // Sin este campo, OHIF cae a `window.PUBLIC_URL`, que el build hornea CON
  // barra ('/v4/'). `OpenIdConnectRoutes.tsx` hace:
  //
  //   redirect_uri = new URL(redirectURI).pathname.replace(routerBasename, '')
  //   if (pathname !== redirect_uri) sessionStorage.setItem('ohif-redirect-to', ...)
  //
  // Con '/v4/' eso da '/v4/callback'.replace('/v4/','') === 'callback' —sin
  // barra inicial— así que la comparación contra el pathname real ('/callback')
  // SIEMPRE es distinta, y OHIF guarda la propia página de callback como
  // "a dónde iba el usuario". Resultado: tras autenticarse el visor navega a
  // /callback otra vez, ahora sin `code`, y muere con
  // "No matching state found in storage" y un Error 404. El login sí había
  // funcionado —el token queda en sessionStorage— así que el síntoma manda a
  // debuggear a Keycloak, que está bien.
  //
  // Se deriva de PUBLIC_URL para que siga valiendo en v5, v6, ... sin editarlo.
  routerBasename: (window.PUBLIC_URL || '/').replace(/\/$/, '') || '/',
  extensions: [],
  modes: [],
  showStudyList: true,
  showWarningMessageForCrossOrigin: false,
  showCPUFallbackMessage: true,
  showLoadingIndicator: true,
  strictZSpacingForVolumeViewport: true,
  // Tamaño del pool de peticiones de cornerstone. Sin configurar cae a los
  // defaults de extensions/cornerstone/src/init.tsx (interaction 10 /
  // thumbnail 5 / prefetch 5), y ESE era el techo real observado: una serie de
  // 96 frames cargaba con solo **5 en vuelo**, tanto en v1 (Function URL,
  // HTTP/1.1) como en v3 (same-origin /api por CloudFront, h2). O sea el
  // multiplexado que compró la fase 1 no tenía nada que multiplexar.
  //
  // Historia, para no repetir el error: subirlo a 60 se probó ANTES y produjo
  // 81 throttles en una sola carga (429 = frame que no pinta), porque la quota
  // de Lambda de la cuenta (L-B99A9384) era de **10 ejecuciones concurrentes**
  // y cada frame es una invocación. Esa quota ya está en **1000** (aprobada
  // 2026-08), y en la medición de control el pico fue 7 con 0 throttles.
  //
  // 25 es deliberadamente conservador frente a los 60 que fallaron: cubre de
  // sobra las 5 en vuelo actuales, y aun con 10 radiólogos simultáneos son 250
  // invocaciones concurrentes contra un techo de 1000. OJO multi-cliente: esa
  // quota es de CUENTA, se comparte entre todos los clientes — por eso no se
  // abre más sin volver a medir Throttles en CloudWatch.
  maxNumRequests: {
    interaction: 25,
    thumbnail: 10,
    prefetch: 25,
  },
  // APAGADO tras una regresión medida en producción. Se deja el bloque para
  // documentar por qué, y para que quien lo reactive lo haga con los ojos
  // abiertos.
  //
  // La idea era buena: precargar en segundo plano para matar el "loading"
  // imagen por imagen en la primera pasada de modo cine. Y funciona — con
  // `enabled: true` un estudio pasaba de descargar 6 frames a descargar los
  // 162 (348 MB) sin que el usuario tocara nada.
  //
  // El problema es CUÁNDO. El prefetcher arranca al agregarse los display sets,
  // o sea ANTES de que la primera imagen termine de pintar, y mete 20 requests
  // de ~2.2 MB en el cable POR DELANTE de ese primer frame. La prioridad del
  // pool de cornerstone ordena lo que se despacha, pero no puede cancelar lo
  // que ya va en vuelo: quedan ~44 MB encolados antes de lo que el visor
  // necesita para mostrar algo. En un estudio de tomosíntesis de mama
  // (2.16.840.1.113669.632.25.1.110403.20260326072833852.1: 162 frames,
  // 348.4 MB) sobre un enlace de 93 Mbps eso dejó el spinner inicial girando
  // casi un minuto — el visor efectivamente tenía que bajar el estudio entero
  // antes de pintar el primer píxel.
  //
  // Dos correcciones a lo que se creyó al activarlo:
  //   - `displaySetsCount: 2` NO acota el total. Avanza progresivamente hasta
  //     traerse todos los display sets del estudio.
  //   - El prefetcher EXCLUYE el display set activo por diseño (ver
  //     `_getSortedDisplaySetsToPrefetch`). La serie que el usuario está
  //     mirando ya la cubre `stackContextPrefetch` de cornerstone, que es otro
  //     mecanismo. O sea esto nunca fue lo que arreglaba el cine.
  //
  // Para reactivarlo hay que resolver la competencia por el cable primero:
  // arrancar el prefetch DESPUÉS del primer render, y mantener pocos requests
  // en vuelo (~3) para que la cola por delante del foreground sea de cientos de
  // ms y no de decenas de segundos.
  studyPrefetcher: {
    enabled: false,
    displaySetsCount: 2,
    maxNumPrefetchRequests: 20,
    order: 'closest',
  },
  // OJO: NO copiar el 3-4 de los configs de referencia del repo — sería un
  // downgrade. extensions/cornerstone/src/initWADOImageLoader.js calcula
  // `Math.min(hardwareConcurrency - 1, maxNumberOfWebWorkers)`, y sin este
  // campo eso da NaN, que es falsy, así que dicom-image-loader cae a su propio
  // `getReasonableWorkerCount()` = **cores / 2**. En una workstation de 16
  // núcleos eso ya son 8 workers; fijar 4 los partiría a la mitad.
  //
  // 8 está elegido para no ser nunca peor que ese default accidental y ser
  // mejor en las máquinas de gama media: 16 núcleos -> 8 (igual), 8 núcleos ->
  // 7 (antes 4), 4 núcleos -> 3 (antes 2). Importa aquí porque decodificar
  // HTJ2K de mamografía son 6.8 MB por frame, y una serie son 82.
  maxNumberOfWebWorkers: 8,
  defaultDataSourceName: 'aws-dicomweb',
  // Autenticación OIDC contra Keycloak. `response_type: 'code'` NO es
  // decorativo: OpenIdConnectRoutes.tsx elige el cliente PKCE (oidc-client-ts)
  // SOLO cuando vale exactamente 'code'; con cualquier otro valor cae al
  // cliente legacy de flujo implícito, que Keycloak tiene deshabilitado en
  // `genx-viewer` — el login fallaría sin decir por qué.
  //
  // El token que termina viajando a AWS es el `access_token` (ver
  // OpenIdConnectRoutes.tsx:109), no el id_token. Es lo correcto: AHI exige un
  // JWT y el access token de Keycloak lo es.
  //
  // `authority` LA DEFINE EL DELTA DEL CLIENTE — config/clients/{slug}.js.
  // Es específica del ENTORNO (QA y producción tienen Keycloak distintos) y el
  // base es client-agnostic, igual que las tres raíces DICOMweb de abajo:
  // hornearla aquí obligaría a compilar una vez por entorno, que es justo lo
  // que el reparto base+delta existe para evitar.
  //
  // Tiene que coincidir EXACTO con el claim `iss` que emite Keycloak y con
  // `oidc_issuer` del authorizer en infra/viewer. Es la ÚNICA cadena que hay
  // que configurar: `oidc-client-ts` descubre authorize, token y JWKS solo,
  // pidiendo {authority}/.well-known/openid-configuration.
  //
  // publish-client.sh corta la publicación si el delta no la asigna. Sin ella
  // getUserManagerForOpenIdConnectClient() devuelve undefined y el visor
  // arranca SIN autenticación, avisando con un único console.error.
  oidc: [
    {
      authority: null,
      client_id: 'genx-viewer',
      redirect_uri: '/callback',
      response_type: 'code',
      scope: 'openid profile email',
      post_logout_redirect_uri: '/logout-redirect.html',
      automaticSilentRenew: true,
      revokeAccessTokenOnSignout: true,
    },
  ],
  // Fetch each frame whole instead of decoding partial chunks as they stream.
  // OHIF's default (streaming + decodeLevel) assumes the server encodes HTJ2K
  // so that a *prefix* of the codestream is decodable. AWS HealthImaging does
  // not: openjph runs off the end of an incomplete tile header and throws.
  //
  // Además es lo que mantiene el camino por `xhrRequest`, que es el único donde
  // se verificó que el hook `beforeSend` pisa el Accept (ver abajo).
  stackRetrieveOptions: { retrieveOptions: { single: {} } },
  // Required, not optional: OHIF's errorHandler.getHTTPErrorHandler() is a
  // factory that returns THIS value, and several call sites invoke the result
  // without a guard (e.g. extensions/cornerstone init.tsx on IMAGE_LOAD_FAILED).
  // Leaving it undefined turns every failed image load into
  // "getHTTPErrorHandler(...) is not a function", masking the real error.
  //
  // Además de loguear, le pasa el fallo a la capa de sesión. `window.genxSession`
  // lo publica OpenIdConnectRoutes.tsx mientras está montado; es la ÚNICA costura
  // posible porque este archivo es config plana que se carga antes del bundle y
  // no puede importar nada. Si no está (arranque, o build sin OIDC), esto sigue
  // siendo solo el console.error de siempre.
  //
  // Por qué importa: un token vigente puede ser rechazado igual por AHI (deriva
  // de reloj en `iat`, `aud` que no coincide, authorizer mal apuntado), y ese
  // caso NO emite ningún evento de oidc-client-ts. Sin este aviso el síntoma es
  // el de siempre: imágenes rotas y nada en pantalla.
  httpErrorHandler: error => {
    console.error('[genx] HealthImaging request failed', error?.status ?? '', error);
    window.genxSession?.reportHttpError?.(error);
  },
  // ─────────────────────────────────────────────────────────────────────────
  // Sellado de los objetos DICOM que el visor ESCRIBE (F2 de docs/annotations.md)
  //
  // Cuando el radiólogo guarda mediciones, OHIF construye un DICOM SR con dcmjs
  // y lo manda por STOW-RS a AWS HealthImaging. Ese objeto sale de fábrica con
  // los defaults de `DerivedDataset`, que es una clase pensada para
  // INVESTIGACIÓN (dcmjs.es.js:13974-14001):
  //
  //   ContentQualification = "RESEARCH"            <- hardcodeado, sin perilla
  //   ImageComments        = "NOT FOR CLINICAL USE"
  //   Manufacturer         = "Unspecified"
  //   PersonObserverName   = "unknown^unknown"
  //
  // Verificado en el objeto real guardado el 24-ago-2026 (§8 del doc): llegó a
  // AHI con los tres primeros puestos y sin autor. Un producto clínico no puede
  // emitir objetos que se autodeclaran no clínicos y anónimos — y en DICOM no
  // existe borrar, así que cada guardado anterior a esto queda así PARA SIEMPRE
  // dentro del estudio del paciente. Por eso el sellado va acá y no "después".
  //
  // ⚠️ EL HOOK NO RECIBE LO QUE SU NOMBRE SUGIERE. En
  // extensions/cornerstone-dicom-sr/src/commandsModule.ts:131-136:
  //
  //     let dicomDict;                                   // <- undefined
  //     if (typeof onBeforeDicomStore === 'function') {
  //       dicomDict = onBeforeDicomStore({ dicomDict, measurementData, naturalizedReport });
  //     }
  //     await dataSource.store.dicom(naturalizedReport, null, dicomDict);
  //
  // O sea: el `dicomDict` que llega es SIEMPRE `undefined`, y lo que la función
  // DEVUELVE se convierte en el dicomDict que se escribe, con precedencia sobre
  // `naturalizedReport`. Entonces el patrón correcto es exactamente uno:
  //
  //     mutar `naturalizedReport` in place y devolver `undefined`.
  //
  // Devolver un objeto reemplaza el SR entero por algo que casi seguro no es un
  // `DicomDict` válido, y el fallo aparece recién en el POST.
  //
  // Lo que NO se puede arreglar desde acá: `ImplementationVersionName`, que
  // DicomWebDataSource hornea como la constante 'OHIF-3.11.0' (index.ts:26) y
  // por lo tanto no data el build. No usarlo para diagnosticar versiones.
  customizationService: (function () {
    var MANUFACTURER = 'GenX';
    var MODEL_NAME = 'GenX RIS Viewer';

    // Prefijo de publicación del bundle ('/v4/' -> 'v4'). Es la única versión
    // REAL que el visor conoce de sí mismo: scripts/build.sh y publish-client.sh
    // versionan por ese prefijo. Ver arriba por qué ImplementationVersionName no
    // sirve para esto.
    var SOFTWARE_VERSION = String(window.PUBLIC_URL || '').replace(/\//g, '') || 'dev';

    // Defaults de dcmjs que hay que reconocer para pisarlos SOLO si nadie los
    // cambió. El de SeriesDescription casi nunca sobrevive —promptSaveReport le
    // pasa el nombre que teclea el usuario— pero 'Create Report' sí llega tal
    // cual cuando deja el campo vacío, y es igual de opaco en la lista de series.
    var RESEARCH_IMAGE_COMMENTS = 'NOT FOR CLINICAL USE';
    var GENERIC_SERIES_DESCRIPTIONS = ['Research Derived series', 'Create Report'];

    // TID 1002 Observer Context: el ítem PNAME cuyo concepto es
    // DCM 121008 "Person Observer Name" (dcmjs.es.js:15094-15102).
    var PERSON_OBSERVER_NAME_CODE = '121008';

    // El perfil OIDC vive en localStorage porque nextOIDCClient.ts fija
    // `userStore: WebStorageStateStore({ store: window.localStorage })` a
    // propósito (ver el comentario largo ahí). La llave la arma oidc-client-ts
    // como 'oidc.' + 'user:{authority}:{client_id}'.
    function sessionProfile() {
      try {
        var oidc = (window.config.oidc || [])[0];
        if (!oidc || !oidc.authority) {
          return null;
        }
        var raw = window.localStorage.getItem('oidc.user:' + oidc.authority + ':' + oidc.client_id);
        return raw ? JSON.parse(raw).profile || null : null;
      } catch (e) {
        return null;
      }
    }

    // VR PN: '^' separa componentes, '=' separa grupos (alfabético/ideográfico/
    // fonético) y '\' separa valores. Un nombre con cualquiera de los tres
    // adentro corrompe la estructura, así que se neutralizan.
    function pnComponent(value) {
      return String(value == null ? '' : value)
        .replace(/[\^=\\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 64);
    }

    function personName(profile) {
      if (!profile) {
        return null;
      }
      var family = pnComponent(profile.family_name);
      var given = pnComponent(profile.given_name);
      if (family && given) {
        return family + '^' + given;
      }
      // Sin los dos claims no se puede partir el nombre: en español los
      // apellidos compuestos ('María del Carmen Pérez García') hacen que
      // cualquier heurística de "la última palabra es el apellido" se
      // equivoque. Un PN de un solo componente es válido y honesto.
      return pnComponent(profile.name) || pnComponent(profile.preferred_username) || null;
    }

    // Fecha legible A PARTIR DEL OBJETO, no del reloj del navegador: así la
    // etiqueta y el ContentDate/ContentTime del SR nunca se contradicen.
    function contentStamp(report) {
      var d = String(report.ContentDate || '');
      var t = String(report.ContentTime || '');
      if (d.length < 8) {
        return '';
      }
      var stamp = d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
      return t.length >= 4 ? stamp + ' ' + t.slice(0, 2) + ':' + t.slice(2, 4) : stamp;
    }

    function setPersonObserverName(report, name) {
      var items = report.ContentSequence;
      if (!items) {
        return false;
      }
      if (!Array.isArray(items)) {
        items = [items];
      }
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (!item || item.ValueType !== 'PNAME') {
          continue;
        }
        var concept = item.ConceptNameCodeSequence;
        if (Array.isArray(concept)) {
          concept = concept[0];
        }
        if (concept && concept.CodeValue === PERSON_OBSERVER_NAME_CODE) {
          item.PersonName = name;
          return true;
        }
      }
      return false;
    }

    return {
      onBeforeDicomStore: function (params) {
        var report = params && params.naturalizedReport;
        if (!report) {
          return undefined;
        }

        // 1. Quitar los sellos de investigación.
        //
        // Se BORRAN en vez de reescribirse a 'PRODUCT'. Los dos son atributos
        // que ni siquiera pertenecen al IOD de SR —el propio dcmjs deja el TODO
        // "ImageComments no es parte del Enhanced SR IOD" justo arriba— así que
        // ausentes es lo conforme. Y 'PRODUCT' significa, en PS3.3, que el
        // contenido lo produjo un equipo aprobado/autorizado: afirmarlo sería
        // cambiar una etiqueta falsa por otra. No aseverar nada es lo correcto
        // mientras el producto no tenga esa aprobación.
        delete report.ContentQualification;
        if (report.ImageComments === RESEARCH_IMAGE_COMMENTS) {
          delete report.ImageComments;
        }
        // dcmjs los deja en cadena vacía (options.ClinicalTrial* || ''). Son
        // atributos de ensayo clínico: vacíos no dicen nada y ensucian.
        [
          'ClinicalTrialTimePointID',
          'ClinicalTrialCoordinatingCenterName',
          'ClinicalTrialSeriesID',
        ].forEach(function (tag) {
          if (!report[tag]) {
            delete report[tag];
          }
        });
        // '1' es el relleno de DerivedDataset, no un número de serie.
        if (report.DeviceSerialNumber === '1') {
          delete report.DeviceSerialNumber;
        }

        // 2. Identidad del producto. Además de ser lo correcto, es la marca por
        // la que el ingestor de F3 va a reconocer los SR propios entre los que
        // pueda haber de otros orígenes en el mismo datastore.
        report.Manufacturer = MANUFACTURER;
        report.ManufacturerModelName = MODEL_NAME;
        report.SoftwareVersions = SOFTWARE_VERSION;

        // 3. SeriesDescription legible. Se RESPETA lo que haya escrito el
        // usuario en el diálogo de guardado; solo se sustituyen los genéricos.
        var description = String(report.SeriesDescription || '').trim();
        if (!description || GENERIC_SERIES_DESCRIPTIONS.indexOf(description) !== -1) {
          var stamp = contentStamp(report);
          report.SeriesDescription = stamp ? 'Anotaciones ' + stamp : 'Anotaciones';
        }

        // 4. Autoría. Si la sesión no alcanza para armar un nombre se deja el
        // 'unknown^unknown' de dcmjs: es feo, pero inventar un autor en un
        // objeto clínico es peor que admitir que no se sabe.
        var name = personName(sessionProfile());
        if (name) {
          if (!setPersonObserverName(report, name)) {
            console.warn('[genx] SR sin ítem de Person Observer Name; no se pudo firmar');
          }
        } else {
          console.warn('[genx] sin perfil OIDC en sesión; el SR queda sin autor');
        }

        // ⚠️ undefined A PROPÓSITO. Ver el bloque de arriba.
        return undefined;
      },
    };
  })(),
  // Branding por defecto. Un cliente puede pisarlo desde su delta.
  whiteLabeling: {
    createLogoComponentFn: function (React) {
      return React.createElement('img', {
        // Absoluta desde PUBLIC_URL, igual que `routerBasename` arriba.
        // Relativa NO sirve: en la LISTA de estudios la URL es '/v4' (sin
        // barra final), asi que './assets/...' resuelve a '/assets/...'
        // —fuera del prefijo de version— y CloudFront responde 403. Dentro
        // del visor ('/v4/viewer') si resolvia bien, por eso el 403 solo
        // aparecia en la lista y parecia intermitente.
        src: (window.PUBLIC_URL || '/').replace(/\/?$/, '/') + 'assets/genx-logo.png',
        alt: 'GenX RIS',
        style: { height: '20px', marginLeft: '10px' },
      });
    },
  },
  // Datasource DICOMweb de STOCK. Ya no se usa `ohif-aws-healthimaging`: desde
  // 2025 AHI habla DICOMweb nativo, así que el extension propietario y el
  // proxy que traducía rutas (viewer/proxy/core.js rewriteRequest) sobran.
  //
  // Las tres raíces las aporta el delta del cliente: llevan el datastore id
  // adentro de la URL.
  dataSources: [
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
      sourceName: 'aws-dicomweb',
      configuration: {
        friendlyName: 'AWS HealthImaging (DICOMweb)',
        name: 'aws',
        // LAS DEFINE EL DELTA DEL CLIENTE — config/clients/{slug}.js.
        wadoUriRoot: null,
        qidoRoot: null,
        wadoRoot: null,
        imageRendering: 'wadors',
        thumbnailRendering: 'wadors',
        enableStudyLazyLoad: true,
        // Conservador y SIN VERIFICAR contra AHI. Si se confirma que su QIDO-RS
        // los soporta, encenderlos ahorra viajes; encenderlos a ciegas produce
        // búsquedas que devuelven vacío sin error.
        qidoSupportsIncludeField: false,
        // NO TOCAR SIN MEDIR. Esta linea vale ~950 ms en CADA apertura de la
        // lista de estudios.
        //
        // Por default OHIF pide `includefield=00081030,00080060` en la busqueda
        // de estudios (mapParams, extensions/default/.../qido.js). A nivel
        // ESTUDIO, AHI tiene que abrir el metadata de cada image set para
        // responder eso: cuesta ~19 ms por fila devuelta y escala hasta el tope
        // de 101 que pide OHIF.
        //
        // Medido con 47 estudios, corridas ALTERNADAS por el camino real
        // (navegador -> CloudFront -> authorizer OIDC -> AHI):
        //
        //   con includefield -> 1713 / 1488 / 1449 ms   (mediana 1488)
        //   sin includefield ->  469 /  537 /  573 ms   (mediana  537)
        //
        // En la apertura completa de la lista (bundle ya cacheado, sesion viva)
        // eso es pasar de ~3.1 s a ~2.1 s; el QIDO era el 45% del total.
        //
        // Lo que se pierde es poco y ya se verifico campo por campo:
        //   - 00080060 (Modality) es REDUNDANTE. AHI devuelve 00080061
        //     (ModalitiesInStudy) sin pedirlo, y es MAS completo: donde
        //     Modality dice `US`, ModalitiesInStudy dice `SR/US`.
        //     getModalities() (platform/core/src/DICOMWeb) cae a
        //     ModalitiesInStudy cuando Modality falta -> la columna no cambia.
        //   - 00081030 (StudyDescription) SI se pierde en la lista. Venia lleno
        //     en 6 de 47 estudios (13%). Ese es el trade real.
        //
        // No hay termino medio: pedir un solo campo dispara el mismo costo
        // (00081030 solo = 1528 ms, 00080060 solo = 1322 ms). Es todo o nada.
        //
        // Solo afecta la busqueda de ESTUDIOS. El includefield del QIDO de
        // SERIES (al expandir una fila) es gratis (233 vs 239 ms) y sigue ahi.
        qidoIncludeFields: [],
        // DEJAR EN false. Probado contra AHI: lo acepta y vuelve `PatientName`
        // insensible a mayusculas, pero devuelve 11 de 47 estudios buscando
        // "galvan" -- es el matching fonetico de nombres de DICOM y es
        // demasiado laxo para una lista clinica. Ademas `mapParams` solo lo
        // aplica a PatientName, asi que ni siquiera arregla el filtro de
        // Descripcion, que es el caso que importa. El comodin de abajo si.
        supportsFuzzyMatching: false,
        // ENCENDIDO a proposito. Sin esto OHIF manda el valor del filtro TAL
        // CUAL y AHI exige coincidencia exacta: escribir `TORAX` en el filtro
        // de Descripcion devuelve 204 vacio y solo funciona escribiendo
        // `*TORAX*` a mano, que nadie va a adivinar.
        //
        // Pesa mas desde que `qidoIncludeFields: []` (arriba) quito la columna
        // Descripcion de la lista: el filtro paso a ser el unico acceso a ese
        // dato. El filtro NO depende de includefield -- va server-side.
        //
        // Medido contra AHI (47 estudios):
        //
        //   filtro                        sin comodin      con comodin
        //   StudyDescription=TORAX        204, 0 filas     *TORAX*     -> 1
        //   AccessionNumber=FAA           204, 0 filas     *FAA*       -> 11
        //   00100020=2604 (MRN parcial)   204, 0 filas     *2604*      -> 1
        //   AccessionNumber=FAA-45587     1                *FAA-45587* -> 1
        //   00100020=26046433             1                *26046433*  -> 1
        //   PatientName=GALVAN            1                *GALVAN*    -> 1
        //
        // Ninguna consulta exacta se degrada al envolverla; solo empiezan a
        // funcionar las parciales. Es lo que upstream considera normal: casi
        // todos los configs de ejemplo de OHIF lo traen en true.
        //
        // Envuelve exactamente 4 campos (`withWildcard` en qido.js): PatientName,
        // 00100020, AccessionNumber y StudyDescription. NO toca ModalitiesInStudy,
        // StudyDate ni StudyInstanceUID, y solo aplica a la busqueda de ESTUDIOS.
        //
        // Dos limites que quedan:
        //   - Sigue siendo sensible a mayusculas: `*torax*` -> 204, `*TORAX*` -> 1.
        //     El comodin arregla lo parcial, no el case. AHI no ofrece perilla.
        //   - Envolver un valor exacto puede casar mas de una fila por subcadena.
        //     Es el comportamiento esperado de una caja de busqueda.
        //
        // El panel de estudios previos del paciente NO se ve afectado:
        // getStudiesForPatientByMRN pasa `disableWildcard: true`, que en
        // qido.js tiene precedencia sobre esta bandera.
        supportsWildcard: true,
        supportsReject: false,
        bulkDataURI: { enabled: true },
        // ─────────────────────────────────────────────────────────────────
        // NO TOCAR SIN MEDIR LOS BYTES. Esta línea vale 6.8x en el cable.
        //
        // AHI solo devuelve HTJ2K si el Accept trae el media type Y el
        // transfer-syntax juntos. El default del loader
        // (`multipart/related; type=application/octet-stream; transfer-syntax=*`,
        // constante de módulo en dicom-image-loader wadors/loadImage.js) hace
        // que AHI transcodifique a ELE: 20,134,080 B en vez de 2,956,744 B, con
        // HTTP 200 y sin un solo error en consola. Se ve lento, no roto.
        //
        // `generateAcceptHeader` devuelve este arreglo TAL CUAL si no está
        // vacío, así que es la única forma de fijarlo. NO usar
        // `requestTransferSyntaxUID` por dos razones independientes: el UID de
        // HTJ2K no está en su tabla `typeForTS` (cae a octet-stream), y aunque
        // estuviera, el default entrecomilla el transfer-syntax y AHI responde
        // 400 a `transfer-syntax="..."`.
        //
        // Cubre metadata (generateWadoHeader) y frames (hook beforeSend de
        // initWADOImageLoader.js) con una sola clave.
        acceptHeader: [
          'multipart/related; type="image/jphc"; transfer-syntax=1.2.840.10008.1.2.4.202',
        ],
      },
    },
  ],
  hotkeys: [
    { commandName: 'incrementActiveViewport', label: 'Next Viewport', keys: ['right'] },
    { commandName: 'decrementActiveViewport', label: 'Previous Viewport', keys: ['left'] },
    { commandName: 'rotateViewportCW', label: 'Rotate Right', keys: ['r'] },
    { commandName: 'rotateViewportCCW', label: 'Rotate Left', keys: ['l'] },
    { commandName: 'invertViewport', label: 'Invert', keys: ['i'] },
    { commandName: 'flipViewportHorizontal', label: 'Flip Horizontally', keys: ['h'] },
    { commandName: 'flipViewportVertical', label: 'Flip Vertically', keys: ['v'] },
    { commandName: 'scaleUpViewport', label: 'Zoom In', keys: ['+'] },
    { commandName: 'scaleDownViewport', label: 'Zoom Out', keys: ['-'] },
    { commandName: 'fitViewportToWindow', label: 'Zoom to Fit', keys: ['='] },
    { commandName: 'resetViewport', label: 'Reset', keys: ['space'] },
    { commandName: 'nextImage', label: 'Next Image', keys: ['down'] },
    { commandName: 'previousImage', label: 'Previous Image', keys: ['up'] },
    { commandName: 'setZoomTool', label: 'Zoom', keys: ['z'] },
    { commandName: 'windowLevelPreset1', label: 'W/L Preset 1', keys: ['1'] },
    { commandName: 'windowLevelPreset2', label: 'W/L Preset 2', keys: ['2'] },
    { commandName: 'windowLevelPreset3', label: 'W/L Preset 3', keys: ['3'] },
  ],
};

// Red de seguridad en runtime: si este archivo llegó a producción SIN su delta
// de cliente, el visor arrancaría y mostraría una lista de estudios vacía — que
// se lee como "este cliente no tiene estudios" y manda a debuggear al lado
// equivocado. Mejor un error explícito en consola.
//
// El camino normal ya está cubierto en publish-client.sh, que se niega a subir
// un app-config.js sin las raíces. Esto cubre las subidas a mano.
setTimeout(function () {
  var cfg = window.config?.dataSources?.[0]?.configuration;
  if (!cfg?.qidoRoot || !cfg?.wadoRoot) {
    console.error(
      '[genx] app-config.js publicado sin qidoRoot/wadoRoot: falta concatenar el ' +
        'delta de cliente (config/clients/{slug}.js). El visor no encontrará ' +
        'estudios. Publicar con scripts/publish-client.sh.'
    );
  }
}, 0);
