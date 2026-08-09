/** @type {AppTypes.Config} */

window.config = {
  extensions: [],
  modes: [],
  showStudyList: true,
  showWarningMessageForCrossOrigin: false,
  showCPUFallbackMessage: true,
  showLoadingIndicator: true,
  strictZSpacingForVolumeViewport: true,
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
          endpoint: 'https://dx54b5pa2bihl34k37de245hai0ioaaa.lambda-url.us-east-1.on.aws',
        },
        wadoRoot: 'https://dx54b5pa2bihl34k37de245hai0ioaaa.lambda-url.us-east-1.on.aws',
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
