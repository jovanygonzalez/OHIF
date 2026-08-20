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
        supportsFuzzyMatching: false,
        supportsWildcard: false,
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
