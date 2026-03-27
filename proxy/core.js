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
  const credentials = process.env.AWS_ACCESS_KEY_ID
    ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
    : undefined; // Lambda: aws4 picks up credentials from env automatically

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

  return { status: res.status, headers, body: res.body };
}

export { CORS_HEADERS };
