import { utils } from '@ohif/core';
import React, { useEffect, useState } from 'react';
import html2canvas from 'html2canvas';
import {
  getEnabledElement,
  StackViewport,
  BaseVolumeViewport,
  metaData,
} from '@cornerstonejs/core';
import { ToolGroupManager, segmentation, Enums } from '@cornerstonejs/tools';
import { getEnabledElement as OHIFgetEnabledElement } from '../state';
import { useSystem } from '@ohif/core/src';

const { downloadUrl } = utils;

const DEFAULT_SIZE = 512;
const MAX_TEXTURE_SIZE = 10000;
const VIEWPORT_ID = 'cornerstone-viewport-download-form';

const FILE_TYPE_OPTIONS = [
  {
    value: 'jpg',
    label: 'JPG',
  },
  {
    value: 'png',
    label: 'PNG',
  },
];

type ViewportDownloadFormProps = {
  hide: () => void;
  activeViewportId: string;
};

const CornerstoneViewportDownloadForm = ({
  hide,
  activeViewportId: activeViewportIdProp,
}: ViewportDownloadFormProps) => {
  const { servicesManager } = useSystem();
  const { customizationService, cornerstoneViewportService } = servicesManager.services;
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [viewportDimensions, setViewportDimensions] = useState({
    width: DEFAULT_SIZE,
    height: DEFAULT_SIZE,
  });

  const warningState = customizationService.getCustomization('viewportDownload.warningMessage') as {
    enabled: boolean;
    value: string;
  };

  const refViewportEnabledElementOHIF = OHIFgetEnabledElement(activeViewportIdProp);
  const activeViewportElement = refViewportEnabledElementOHIF?.element;
  const { viewportId: activeViewportId, renderingEngineId } =
    getEnabledElement(activeViewportElement);

  const renderingEngine = cornerstoneViewportService.getRenderingEngine();
  const toolGroup = ToolGroupManager.getToolGroupForViewport(activeViewportId, renderingEngineId);

  useEffect(() => {
    const toolModeAndBindings = Object.keys(toolGroup.toolOptions).reduce((acc, toolName) => {
      const tool = toolGroup.toolOptions[toolName];
      const { mode, bindings } = tool;

      return {
        ...acc,
        [toolName]: { mode, bindings },
      };
    }, {});

    return () => {
      Object.keys(toolModeAndBindings).forEach(toolName => {
        const { mode, bindings } = toolModeAndBindings[toolName];
        try {
          toolGroup.setToolMode(toolName, mode, { bindings });
        } catch (error) {
          // Handle errors when restoring tool mode during cleanup (e.g., when tool state is undefined)
          console.debug('Error restoring tool mode during cleanup:', toolName, error);
        }
      });
    };
  }, []);

  const handleEnableViewport = (viewportElement: HTMLElement) => {
    if (!viewportElement) {
      return;
    }

    const { viewport } = getEnabledElement(activeViewportElement);

    const viewportInput = {
      viewportId: VIEWPORT_ID,
      element: viewportElement,
      type: viewport.type,
      defaultOptions: {
        background: viewport.defaultOptions.background,
        orientation: viewport.defaultOptions.orientation,
      },
    };

    renderingEngine.enableElement(viewportInput);
  };

  const handleDisableViewport = async () => {
    renderingEngine.disableElement(VIEWPORT_ID);
  };

  const handleLoadImage = async (width: number, height: number) => {
    if (!activeViewportElement) {
      return;
    }

    const activeViewportEnabledElement = getEnabledElement(activeViewportElement);
    if (!activeViewportEnabledElement) {
      return;
    }

    const segmentationRepresentations =
      segmentation.state.getViewportSegmentationRepresentations(activeViewportId);

    const { viewport } = activeViewportEnabledElement;
    const downloadViewport = renderingEngine.getViewport(VIEWPORT_ID);

    try {
      if (downloadViewport instanceof StackViewport) {
        const imageId = viewport.getCurrentImageId();
        const properties = viewport.getProperties();

        await downloadViewport.setStack([imageId]);
        downloadViewport.setProperties(properties);
      } else if (downloadViewport instanceof BaseVolumeViewport) {
        const volumeIds = viewport.getAllVolumeIds();
        downloadViewport.setVolumes([{ volumeId: volumeIds[0] }]);
      }

      if (segmentationRepresentations?.length) {
        segmentationRepresentations.forEach(segRepresentation => {
          const { segmentationId, colorLUTIndex, type } = segRepresentation;
          if (type === Enums.SegmentationRepresentations.Labelmap) {
            segmentation.addLabelmapRepresentationToViewportMap({
              [downloadViewport.id]: [
                {
                  segmentationId,
                  type: Enums.SegmentationRepresentations.Labelmap,
                  config: {
                    colorLUTOrIndex: colorLUTIndex,
                  },
                },
              ],
            });
          }

          if (type === Enums.SegmentationRepresentations.Contour) {
            segmentation.addContourRepresentationToViewportMap({
              [downloadViewport.id]: [
                {
                  segmentationId,
                  type: Enums.SegmentationRepresentations.Contour,
                  config: {
                    colorLUTOrIndex: colorLUTIndex,
                  },
                },
              ],
            });
          }
        });
      }

      return {
        width: Math.min(width || DEFAULT_SIZE, MAX_TEXTURE_SIZE),
        height: Math.min(height || DEFAULT_SIZE, MAX_TEXTURE_SIZE),
      };
    } catch (error) {
      console.error('Error loading image:', error);
    }
  };

  const handleToggleAnnotations = (show: boolean) => {
    const activeViewportEnabledElement = getEnabledElement(activeViewportElement);
    if (!activeViewportEnabledElement) {
      return;
    }

    const downloadViewport = renderingEngine.getViewport(VIEWPORT_ID);
    if (!downloadViewport) {
      return;
    }

    const { viewportId: activeViewportId, renderingEngineId } = activeViewportEnabledElement;
    const { id: downloadViewportId } = downloadViewport;

    const toolGroup = ToolGroupManager.getToolGroupForViewport(activeViewportId, renderingEngineId);
    toolGroup.addViewport(downloadViewportId, renderingEngineId);

    const toolInstances = toolGroup.getToolInstances();
    const toolInstancesArray = Object.values(toolInstances);

    toolInstancesArray.forEach(toolInstance => {
      if (toolInstance.constructor.isAnnotation !== false) {
        if (show) {
          toolGroup.setToolEnabled(toolInstance.toolName);
        } else {
          toolGroup.setToolDisabled(toolInstance.toolName);
        }
      }
    });
  };

  useEffect(() => {
    if (viewportDimensions.width && viewportDimensions.height) {
      setTimeout(() => {
        handleLoadImage(viewportDimensions.width, viewportDimensions.height);
        handleToggleAnnotations(showAnnotations);
        // we need a resize here to make suer annotations world to canvas
        // are properly calculated
        renderingEngine.resize();
        renderingEngine.render();
      }, 100);
    }
  }, [viewportDimensions, showAnnotations]);

  /**
   * GENX: la captura, compartida por descargar y copiar.
   *
   * El canvas que sale de aquí ya trae las marcas dibujadas encima del pixel —
   * cornerstone las pintó— y con la ventana, el zoom y el encuadre que eligió el
   * médico. Eso es criterio clínico, y es lo que un render del servidor tendría
   * que adivinar.
   */
  const captureCanvas = async (): Promise<HTMLCanvasElement | null> => {
    const div = document.querySelector(`div[data-viewport-uid="${VIEWPORT_ID}"]`);
    if (!div) {
      console.debug('No viewport found for capture');
      return null;
    }
    return html2canvas(div as HTMLElement);
  };

  const handleDownload = async (baseFilename: string, fileType: string) => {
    const canvas = await captureCanvas();
    if (!canvas) {
      return;
    }
    const filename = `${baseFilename}.${fileType}`;
    downloadUrl(canvas.toDataURL(`image/${fileType}`, 1.0), { filename });
  };

  /**
   * GENX: de qué instancia DICOM es esta captura.
   *
   * Sin esto la imagen pegada en el informe es pixel mudo: nadie puede volver de
   * la figura al estudio. Viaja en atributos `data-genx-*` del sabor text/html
   * del portapapeles, así que es invisible para quien pegue en Word y
   * recuperable para quien pegue en el editor de GenX.
   *
   * Devuelve null sin ruido en un viewport de volumen (no tiene "la imagen
   * actual") — la captura sigue siendo válida, solo que anónima.
   */
  const currentInstanceRef = (): Record<string, string> | null => {
    try {
      const { viewport } = getEnabledElement(activeViewportElement) ?? {};
      const imageId = (viewport as StackViewport)?.getCurrentImageId?.();
      if (!imageId) {
        return null;
      }
      const sop = metaData.get('sopCommonModule', imageId);
      const series = metaData.get('generalSeriesModule', imageId);
      const study = metaData.get('generalStudyModule', imageId);
      return {
        sop: sop?.sopInstanceUID ?? '',
        series: series?.seriesInstanceUID ?? '',
        study: study?.studyInstanceUID ?? series?.studyInstanceUID ?? '',
      };
    } catch (e) {
      console.debug('GENX: no se pudo leer la instancia actual', e);
      return null;
    }
  };

  /**
   * GENX: copiar la captura al portapapeles del SISTEMA.
   *
   * Es la vía genérica del informe: el médico pega con Ctrl+V donde escriba, sea
   * el editor de GenX o Word. Que no dependa de GenX es el punto — un cliente que
   * dicta en Word no tiene otra.
   *
   * Se escriben DOS sabores del mismo contenido:
   *   image/png   lo que entiende cualquier destino (Word, correo, chat)
   *   text/html   un <img> con los identificadores DICOM en data-genx-*
   * El editor de GenX prefiere el HTML y se queda la procedencia; el resto toma
   * el PNG y ni se entera.
   *
   * ⚠️ PNG y no JPG aunque el selector diga otra cosa: `image/jpeg` NO es un tipo
   * que el portapapeles del navegador acepte escribir.
   *
   * ⚠️ Los valores se pasan como PROMESAS a ClipboardItem a propósito. La captura
   * es asíncrona, y en algunos navegadores un `clipboard.write` después de un
   * `await` ya perdió el gesto del usuario y lo rechazan. Con promesas la llamada
   * sale síncrona con el clic y el navegador espera el contenido.
   */
  const handleCopy = async (): Promise<'ok' | 'unsupported' | 'error'> => {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      // Contexto no seguro (http) o navegador viejo. La descarga sigue estando.
      return 'unsupported';
    }

    const pngPromise = (async () => {
      const canvas = await captureCanvas();
      if (!canvas) {
        throw new Error('GENX: no hay viewport para capturar');
      }
      return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          blob => (blob ? resolve(blob) : reject(new Error('GENX: toBlob vacío'))),
          'image/png'
        );
      });
    })();

    const htmlPromise = pngPromise.then(async blob => {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      const ref = currentInstanceRef();
      const attrs = ref
        ? ` data-genx-sop="${ref.sop}" data-genx-series="${ref.series}" data-genx-study="${ref.study}"`
        : '';
      return new Blob([`<img src="${dataUrl}"${attrs} alt="Captura del visor" />`], {
        type: 'text/html',
      });
    });

    try {
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': pngPromise, 'text/html': htmlPromise }),
      ]);
      return 'ok';
    } catch (e) {
      console.warn('GENX: no se pudo copiar al portapapeles', e);
      return 'error';
    }
  };

  const ViewportDownloadFormNew = customizationService.getCustomization(
    'ohif.captureViewportModal'
  );

  return (
    <ViewportDownloadFormNew
      onClose={hide}
      defaultSize={DEFAULT_SIZE}
      fileTypeOptions={FILE_TYPE_OPTIONS}
      viewportId={VIEWPORT_ID}
      showAnnotations={showAnnotations}
      onAnnotationsChange={setShowAnnotations}
      dimensions={viewportDimensions}
      onDimensionsChange={setViewportDimensions}
      onEnableViewport={handleEnableViewport}
      onDisableViewport={handleDisableViewport}
      onDownload={handleDownload}
      onCopy={handleCopy}
      warningState={warningState}
    />
  );
};

export default CornerstoneViewportDownloadForm;
