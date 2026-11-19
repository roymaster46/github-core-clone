// The forge's HTTP surface: routes every request to the module that owns it.
// main.ts (lifecycle) is unchanged; this file wires git smart HTTP, REST v3,
// GraphQL v4 and MCP onto one shared in-memory store.
//
// Transport: a raw node:net HTTP/1.1 server (src/transport.ts) instead of
// node:http — one socket.write per response, no IncomingMessage machinery,
// and the request path/query parsed once here (handlers used to pay for
// `new URL(req.url)` three times per request). Routing itself is unchanged.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from 'node:net';
import { MemoryStore, resolveRepo } from './src/store.ts';
import { handleRest } from './src/rest.ts';
import { handleGit } from './src/git.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { createTransportServer, pathnameOf } from './src/transport.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

export function createApp(): Server {
  const store = new MemoryStore();

  return createTransportServer((req: IncomingMessage, res: ServerResponse) => {
    // The transport already parsed the path (no `new URL` per request).
    const path = pathnameOf(req) ?? '/';
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}. No auth.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Wrap the async handlers; never let a handler throw kill the request.
    void (async () => {
      try {
        // REST v3 (includes GET /api/v3/ root and /api/v3/meta).
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (await handleRest(req, res, store)) return;
        }
        // GraphQL v4.
        if (path === '/api/graphql') {
          if (await handleGraphql(req, res, store)) return;
        }
        // MCP over streamable HTTP.
        if (path === '/mcp') {
          if (await handleMcp(req, res, store)) return;
        }
        // Git smart HTTP: /{owner}/{repo}.git/info/refs, /git-upload-pack, /git-receive-pack.
        const gitMatch = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const repo = resolveRepo(store, owner, repoName);
          if (repo === undefined) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (await handleGit(req, res, repo)) return;
        }
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          try { res.end(); } catch { /* socket already gone */ }
        }
        return;
      }
      // Everything else: GitHub's 404 body.
      if (!res.headersSent) sendJson(res, 404, { message: 'Not Found' });
    })();
  });
}
