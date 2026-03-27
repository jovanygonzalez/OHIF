/**
 * Development entry point — HTTP server for local Docker.
 * Usage: docker compose up -d (from viewer/)
 */
import { promisify } from 'node:util';
import { pipeline } from 'node:stream';
import { createServer } from 'http';
import { rewriteRequest, proxyToAWS, CORS_HEADERS } from './core.js';

const streamPipeline = promisify(pipeline);

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', async () => {
    try {
      const rewritten = rewriteRequest(req.url, req.method, body || null);
      console.log('Proxying:', rewritten.method, rewritten.url);

      const result = await proxyToAWS(rewritten);
      res.writeHead(result.status, result.headers);
      return await streamPipeline(result.body, res);
    } catch (err) {
      console.error(err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('Internal Server Error');
    }
  });
});

const port = process.env.PORT || 8089;
server.listen(port, () => {
  console.log(`HealthImaging proxy running on http://:::${port}`);
});
