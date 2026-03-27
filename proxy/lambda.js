/**
 * Production entry point — AWS Lambda handler.
 *
 * Deploy as Lambda Function URL (no API Gateway needed).
 * Credentials come from the Lambda execution role automatically.
 * No env vars for AWS_ACCESS_KEY_ID/SECRET needed.
 */
import { rewriteRequest, proxyToAWS, CORS_HEADERS } from './core.js';

export async function handler(event) {
  const method = event.requestContext?.http?.method || event.httpMethod || 'GET';

  // CORS preflight
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS };
  }

  try {
    const path = event.rawPath || event.path || '/';
    const queryString = event.rawQueryString || '';
    const url = queryString ? `${path}?${queryString}` : path;
    const body = event.body
      ? event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString()
        : event.body
      : null;

    const rewritten = rewriteRequest(url, method, body);
    const result = await proxyToAWS(rewritten);

    // Read response body
    const chunks = [];
    for await (const chunk of result.body) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Binary responses (image frames) need base64 encoding
    const contentType = result.headers['content-type'] || '';
    const isBinary = !contentType.startsWith('application/json') && !contentType.startsWith('text/');

    return {
      statusCode: result.status,
      headers: result.headers,
      body: isBinary ? buffer.toString('base64') : buffer.toString('utf-8'),
      isBase64Encoded: isBinary,
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'content-type': 'text/plain' },
      body: 'Internal Server Error',
    };
  }
}
