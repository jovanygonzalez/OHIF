/**
 * Production entry point — AWS Lambda handler.
 *
 * Deploy as Lambda Function URL (no API Gateway needed).
 * Credentials come from the Lambda execution role automatically.
 * No env vars for AWS_ACCESS_KEY_ID/SECRET needed.
 *
 * Uses response streaming (invoke_mode = RESPONSE_STREAM, set on the
 * Function URL in infra/modules/viewer-proxy-lambda). A buffered
 * (non-streaming) Lambda response is capped at 6MB — a base64-encoded DICOM
 * frame crosses that easily, and the runtime rejects it with
 * RequestEntityTooLarge, which the Function URL surfaces to the browser as a
 * bare 502. Streaming removes that cap (and the base64 inflation, since we
 * write raw bytes) — the `awslambda` global below only exists inside the
 * Lambda execution environment, not in Docker/local (see index.js).
 */
import { rewriteRequest, proxyToAWS } from './core.js';

// CloudFront serves this function under /api/* on the viewer's own domain (see
// `proxy_path_pattern` in infra/modules/viewer-site) so the browser can reach
// it same-origin over HTTP/2. CloudFront forwards the path verbatim — origin_path
// prepends, it never trims — so requests land here as /api/studies/... and
// /api/datastore/.... The second shape is the one that breaks: rewriteRequest
// only rewrites the frame path and passes everything else through untouched, so
// /api/datastore/{id}/imageSet/{id}/getImageSetMetadata would go to AWS
// HealthImaging verbatim and 404.
//
// Stripped conditionally, so the Docker/dev path (index.js, no prefix) and any
// viewer version still calling the Function URL directly keep working unchanged.
const PATH_PREFIX = '/api';

function stripPathPrefix(path) {
  if (path === PATH_PREFIX) {
    return '/';
  }
  return path.startsWith(`${PATH_PREFIX}/`) ? path.slice(PATH_PREFIX.length) : path;
}

// The Function URL's own CORS config (infra/modules/viewer-proxy-lambda)
// already adds the correct Access-Control-* headers and handles OPTIONS
// preflight automatically, before this handler even runs. Don't also return
// CORS_HEADERS here (that's for index.js/Docker, which has no such layer) —
// combining both produces a duplicate Access-Control-Allow-Origin header,
// which browsers reject outright ("contains multiple values ... only one is
// allowed").
function stripCorsHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!key.toLowerCase().startsWith('access-control-')) {
      result[key] = value;
    }
  }
  return result;
}

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const method = event.requestContext?.http?.method || event.httpMethod || 'GET';

  if (method === 'OPTIONS') {
    responseStream = awslambda.HttpResponseStream.from(responseStream, { statusCode: 204 });
    responseStream.end();
    return;
  }

  try {
    const path = stripPathPrefix(event.rawPath || event.path || '/');
    const queryString = event.rawQueryString || '';
    const url = queryString ? `${path}?${queryString}` : path;
    const body = event.body
      ? event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString()
        : event.body
      : null;

    const rewritten = rewriteRequest(url, method, body);
    const result = await proxyToAWS(rewritten);

    const httpStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: result.status,
      headers: stripCorsHeaders(result.headers),
    });

    for await (const chunk of result.body) {
      httpStream.write(chunk);
    }
    httpStream.end();
  } catch (err) {
    console.error(err);
    const httpStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 500,
      headers: { 'content-type': 'text/plain' },
    });
    httpStream.end('Internal Server Error');
  }
});
