// github-core-clone: HTTP server. Routes:
//
//   GET  /healthz                       -> 200 {"ok":true}
//   GET  /{owner}/{repo}.git/info/refs  -> git advertisement (upload-pack / receive-pack)
//   POST /{owner}/{repo}.git/git-upload-pack
//   POST /{owner}/{repo}.git/git-receive-pack
//   /api/v3/*                           -> REST v3 (rest.ts)
//   POST /api/graphql                   -> GraphQL v4 (graphql.ts)
//   POST /mcp                           -> MCP JSON-RPC (mcp.ts)
//
// Auth: the bearer token must equal MAKEFUN_SHOP_TOKEN when it is set. When it is unset (a
// local run) any non-empty bearer is accepted. Every REST reply carries a non-empty
// X-GitHub-Request-Id, and every REST reply is application/json.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { handleGraphQL } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitRequest } from './gitproto.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { VIEWER, store } from './store.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const REQUEST_ID_HEADER = 'x-github-request-id';

function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match === null) return false;
  const token = match[1] as string;
  if (TOKEN === '') return token.length > 0;
  return token === TOKEN;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  const text = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    [REQUEST_ID_HEADER]: randomUUID(),
    ...(extra ?? {}),
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
  });
  res.end(body);
}

function headersOf(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();
  const headers = headersOf(req);

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // git smart HTTP
  const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
  if (gitMatch !== null) {
    const owner = gitMatch[1] as string;
    const repoName = gitMatch[2] as string;
    const action = gitMatch[3] as string;
    const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    const gitReq: GitRequest = {
      owner,
      repoName,
      service: url.searchParams.get('service') ?? '',
      query: url.searchParams,
      headers,
      body,
    };
    if (action === 'info/refs' && method === 'GET') {
      const out = handleInfoRefs(gitReq);
      sendRaw(res, out.status, out.contentType, out.body);
      return;
    }
    if (action === 'git-upload-pack' && method === 'POST') {
      if (!authed(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      const out = handleUploadPack(gitReq);
      sendRaw(res, out.status, out.contentType, out.body);
      return;
    }
    if (action === 'git-receive-pack' && method === 'POST') {
      if (!authed(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      const out = handleReceivePack(gitReq);
      sendRaw(res, out.status, out.contentType, out.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // REST v3
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const segments = path.replace(/^\/api\/v3\/?/, '').split('/').filter((segment) => segment !== '');
    const bodyRaw = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE' ? (await readBody(req)).toString('utf8') : '';
    let body: unknown = null;
    if (bodyRaw !== '') {
      try {
        body = JSON.parse(bodyRaw);
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
    }
    const isAuthed = authed(req);
    const restReq: RestRequest = {
      method,
      segments,
      query: url.searchParams,
      headers: { ...headers, 'x-authed': isAuthed ? '1' : '0' },
      body,
      bodyRaw,
      host: req.headers.host ?? '127.0.0.1',
    };
    const out = handleRest(restReq);
    const extra: Record<string, string> = {};
    if (out.headers?.link !== undefined) extra.link = out.headers.link;
    if (out.headers?.['x-oauth-scopes'] !== undefined) extra['x-oauth-scopes'] = out.headers['x-oauth-scopes'];
    sendJson(res, out.status, out.body, extra);
    return;
  }

  // GraphQL v4
  if (path === '/api/graphql' && method === 'POST') {
    const bodyRaw = (await readBody(req)).toString('utf8');
    let body: unknown = null;
    try {
      body = JSON.parse(bodyRaw);
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const out = handleGraphQL({ body, authed: authed(req) });
    sendJson(res, out.status, out.body);
    return;
  }

  // MCP
  if (path === '/mcp' && method === 'POST') {
    const bodyRaw = (await readBody(req)).toString('utf8');
    const out = handleMcp({ body: null, bodyRaw, authed: authed(req) });
    sendJson(res, out.status, out.body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

export function createApp() {
  const server = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
    });
  });

  server.on('error', (err) => {
    console.error('server error', err);
    process.exit(1);
  });

  // Keep-alive throughput matters for the read benchmark (2,000 sequential GETs on one connection).
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 60_000;
  return server;
}

// When app.ts itself is the entry point (a local run), listen on PORT; main.ts imports
// createApp() and owns the listen instead.
if (process.argv[1] !== undefined && process.argv[1].endsWith('app.ts')) {
  const PORT = Number(process.env.PORT ?? '0') || 0;
  const server = createApp();
  server.listen(PORT, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : PORT;
    console.log(`github-core-clone listening on 127.0.0.1:${port} (viewer ${VIEWER.login})`);
  });
}

export { store };
