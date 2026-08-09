/** @type {AppTypes.Config} */

// v2 of the viewer config. Identical to aws-healthimaging.js except that the
// proxy is reached SAME-ORIGIN through CloudFront (/api/*) instead of directly
// at the Lambda Function URL.
//
// Why: Function URLs speak HTTP/1.1, so the browser capped a series at 6 frames
// in flight against that host, each with its own round trip to us-east-1 and its
// own TLS handshake — and being a separate origin it also paid a CORS preflight.
// Routed through the distribution that already serves this app, frames get HTTP/2
// multiplexing, CORS disappears entirely, and the edge->Lambda hop rides a warm
// connection over the AWS backbone.
//
// v1 stays deployed and unchanged, pointing at the Function URL directly — it's
// the rollback and the A/B baseline. Build this one with:
//   scripts/deploy-version.sh v2 genx-viewer <distribution-id> config/aws-healthimaging-v2.js

window.config = {
  extensions: [],
  modes: [],
  showStudyList: true,
  showWarningMessageForCrossOrigin: false,
  showCPUFallbackMessage: true,
  showLoadingIndicator: true,
  strictZSpacingForVolumeViewport: true,
  // NO subir `maxNumRequests` todavía. El cuello de botella real de esta
  // arquitectura hoy NO es el transporte: es el límite de **10 ejecuciones
  // concurrentes de Lambda** de la cuenta (quota L-B99A9384, sin subir nunca).
  // Cada frame es una invocación, así que una serie de 96 frames son 96
  // invocaciones y nunca puede haber más de 10 en vuelo, dé igual lo que
  // permita HTTP/2 o cuánto se abra el pool de cornerstone.
  //
  // Sin configurar, el pool cae a los defaults de
  // extensions/cornerstone/src/init.tsx (interaction 10 / thumbnail 5 /
  // prefetch 5), que ya rozan ese techo con un solo usuario. Subirlo a 60 se
  // probó y produjo 81 throttles en una sola carga: cada throttle es un 429 y
  // un frame que no pinta. Con dos radiólogos a la vez es peor.
  //
  // Orden correcto: (1) subir la quota a 1000, (2) volver a medir, (3) recién
  // ahí fijar este valor con datos limpios.
  defaultDataSourceName: 'healthimaging',
  // Fetch each frame whole instead of decoding partial chunks as they stream.
  // OHIF's default (streaming + decodeLevel) assumes the server encodes HTJ2K
  // so that a *prefix* of the codestream is decodable. AWS HealthImaging does
  // not: openjph runs off the end of an incomplete tile header and throws, and
  // because extractMultipart never sets `extractDone` on the singlepart path,
  // that failure aborts the whole image load instead of waiting for more data.
  // Every frame above streamRequest's 128 KB minChunkSize hits this — i.e. all
  // CT/MR/CR. Nothing is lost: with content-length stripped by the proxy,
  // percentComplete was Infinity and decodeLevel resolved to 0 anyway, so the
  // progressive path only ever cost a second, doomed decode per frame.
  stackRetrieveOptions: { retrieveOptions: { single: {} } },
  // Required, not optional: OHIF's errorHandler.getHTTPErrorHandler() is a
  // factory that returns THIS value, and several call sites invoke the result
  // without a guard (e.g. extensions/cornerstone init.tsx on IMAGE_LOAD_FAILED).
  // Leaving it undefined turns every failed image load into
  // "getHTTPErrorHandler(...) is not a function", masking the real error.
  httpErrorHandler: error => {
    console.error('[genx] HealthImaging request failed', error?.status ?? '', error);
  },
  whiteLabeling: {
    createLogoComponentFn: function (React) {
      return React.createElement('img', {
        src: './assets/genx-logo.png',
        alt: 'GenX RIS',
        style: { height: '20px', marginLeft: '10px' },
      });
    },
  },
  dataSources: [
    {
      namespace: 'ohif-aws-healthimaging.dataSourcesModule.healthlake',
      sourceName: 'healthimaging',
      configuration: {
        friendlyName: 'AWS HealthImaging',
        name: 'healthimaging',
        healthlake: {
          datastoreID: '233cd98bfad7421ab3ac51e9235cc5b1',
          // Relative, so every request goes to whatever host is serving this
          // page — that's what makes it same-origin. It CANNOT be '': the
          // extension throws `endpoint is mandatory` on any falsy value while
          // wiring up its XHR override, so the prefix has to be non-empty.
          // Must match `proxy_path_pattern` in infra/modules/viewer-site and
          // PATH_PREFIX in viewer/proxy/lambda.js.
          endpoint: '/api',
        },
        wadoRoot: '/api',
        singlepart: 'bulkdata,video,pdf,image/jphc',
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
