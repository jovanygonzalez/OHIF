import aws4 from 'aws4';

const awsRegion = process.env.AWS_REGION || 'us-east-1';
const awsHost = process.env.AWS_HOST || `runtime-medical-imaging.${awsRegion}.amazonaws.com`;

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'OPTIONS, POST, GET',
  'access-control-max-age': '2592000',
  'access-control-allow-headers': '*',
};

// Node's fetch auto-decompresses, so forwarding these causes double-decode.
const SKIP_HEADERS = new Set(['content-encoding', 'transfer-encoding', 'content-length']);

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
 */
export async function proxyToAWS({ url, method, body }) {
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

  const uri = `https://${awsHost}${url}`;
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

  aws4.sign(req, credentials);

  const res = await fetch(uri, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });

  // Collect safe headers
  const headers = { ...CORS_HEADERS };
  res.headers.forEach((value, key) => {
    if (!SKIP_HEADERS.has(key.toLowerCase())) {
      headers[key] = value;
    }
  });

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
  if (res.ok && url.endsWith('/getImageFrame')) {
    headers['content-type'] = 'image/jphc';
  }

  return { status: res.status, headers, body: res.body };
}

export { CORS_HEADERS };
