import aws4 from 'aws4';
import https from 'node:https';

const awsRegion = process.env.AWS_REGION || 'us-east-1';
const awsHost = process.env.AWS_HOST || `runtime-medical-imaging.${awsRegion}.amazonaws.com`;

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'OPTIONS, POST, GET',
  'access-control-max-age': '2592000',
  'access-control-allow-headers': '*',
};

// Hop-by-hop headers: meaningful only for the AHI->proxy connection, never to be
// forwarded (RFC 9110 7.6.1). `content-encoding` and `content-length` are
// deliberately NOT here — see the note on node:https in proxyToAWS.
const SKIP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Rewrites DICOMWeb-style frame URLs to HealthImaging API paths.
 * Returns { url, method, body } with the rewritten request, or the original.
 */
export function rewriteRequest(url, method, body) {
  const frameMatch = url.match(/\/studies\/[^/]+\/series\/[^/]+\/instances\/[^/]+\/frames\/\d+/);
  if (frameMatch) {
    const params = new URLSearchParams(url.split('?')[1] || '');
    const datastoreID = params.get('DatastoreID');
    const imageSetID = params.get('ImageSetID');
    const frameID = params.get('frameID');

    if (datastoreID && imageSetID && frameID) {
      return {
        url: `/datastore/${datastoreID}/imageSet/${imageSetID}/getImageFrame`,
        method: 'POST',
        body: JSON.stringify({ imageFrameId: frameID }),
      };
    }
  }
  return { url, method, body };
}

/**
 * Proxies a request to AWS HealthImaging, signing it with aws4.
 * In Lambda, credentials come from the execution role automatically.
 * In Docker (dev), credentials come from env vars.
 *
 * Uses `node:https` and NOT the global `fetch` on purpose. fetch is undici,
 * which advertises `accept-encoding: gzip` on its own and then transparently
 * inflates the response — and GetImageSetMetadata is gzip by API contract
 * (the CLI reports `"contentEncoding": "gzip"`). Measured on a real study:
 * AHI returns 347,973 bytes, undici handed us 5,428,695, and because the old
 * SKIP_HEADERS dropped `content-encoding` we then shipped those 5.4 MB to the
 * browser uncompressed — a 15.6x inflation on the slowest hop, in front of the
 * first image. node:https sends no accept-encoding and decodes nothing, so the
 * gzip AHI produced travels untouched all the way to the browser, which
 * inflates it itself.
 *
 * That is also why content-length is no longer stripped: it was only ever
 * wrong because the body had been silently decoded underneath it. Forwarding
 * it truthfully restores real download progress in the viewer and lets
 * CloudFront compress anything that does arrive uncompressed.
 *
 * Resolves with `body` as a Node Readable (an IncomingMessage), which both
 * entry points already consume — `for await` in lambda.js, `pipeline` in
 * index.js.
 */
export function proxyToAWS({ url, method, body }) {
  // In Lambda, the execution role provides temporary credentials via env vars,
  // including a session token — without it, aws4 won't set X-Amz-Security-Token
  // and AWS rejects the signed request. Docker/local IAM users have no session
  // token, so this stays undefined there and aws4 signs without it.
  const credentials = process.env.AWS_ACCESS_KEY_ID
    ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN,
      }
    : undefined;

  const req = {
    path: url,
    service: 'medical-imaging',
    host: awsHost,
    method,
    body: body || null,
    headers: {},
  };

  if (body && method === 'POST') {
    req.headers['Content-Type'] = 'application/json';
  }

  // aws4 fills in Host, X-Amz-Date, Authorization and — when there's a body —
  // Content-Length, all of which https.request then sends verbatim.
  aws4.sign(req, credentials);

  return new Promise((resolve, reject) => {
    const upstream = https.request(
      { host: awsHost, path: url, method: req.method, headers: req.headers },
      res => resolve(buildResponse(url, res))
    );
    upstream.on('error', reject);
    if (req.body) {
      upstream.write(req.body);
    }
    upstream.end();
  });
}

function buildResponse(url, res) {
  const headers = { ...CORS_HEADERS };
  for (const [key, value] of Object.entries(res.headers)) {
    if (!SKIP_HEADERS.has(key.toLowerCase())) {
      // node:https gives repeated headers as arrays; both entry points want strings.
      headers[key] = Array.isArray(value) ? value.join(', ') : value;
    }
  }

  // HealthImaging labels frame bytes `image/jph` (HTJ2K wrapped in a JP2
  // container — correct per ISO/IEC 15444-15, but not a DICOMweb media type).
  // Cornerstone maps content-type -> transfer syntax with a DICOMweb table
  // (PS3.18) that only knows `image/jphc`, so `image/jph` misses and silently
  // falls back to Implicit VR LE — i.e. "these bytes are raw pixels". The
  // still-compressed frame then goes straight to WebGL and blows up with
  // "texImage2D: ArrayBufferView not big enough", leaving a black viewport.
  //
  // We are the ones presenting a DICOMweb-shaped surface over an API that
  // isn't DICOMweb, so translating the media type is our job. Upstream has no
  // reason to add `image/jph` (checked dicom-image-loader 5.7.0 — still
  // absent). `url` is already rewritten here, so this covers both the fetch
  // path (GET /studies/.../frames/N, used by the main viewport) and the XHR
  // path (POST .../getImageFrame, used by thumbnails).
  // Only on success: an error from AHI comes back as JSON/XML, and labelling
  // that `image/jphc` would send it to the decoder and bury the real message.
  if (res.statusCode < 400 && url.endsWith('/getImageFrame')) {
    headers['content-type'] = 'image/jphc';
  }

  return { status: res.statusCode, headers, body: res };
}

export { CORS_HEADERS };
