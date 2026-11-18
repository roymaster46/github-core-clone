// The forge's HTTP surface: routes every request to the module that owns it.
// main.ts (lifecycle) is unchanged; this file wires git smart HTTP, REST v3,
// GraphQL v4 and MCP onto one shared in-memory store.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { MemoryStore, resolveRepo } from './src/store.ts';
import { handleRest } from './src/rest.ts';
import { handleGit } from './src/git.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function createApp(): Server {
  const store = new MemoryStore();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
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
