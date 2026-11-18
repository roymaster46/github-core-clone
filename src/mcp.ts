// MCP endpoint (POST /mcp) for the github-core-clone-01 forge.
// JSON-RPC 2.0 over Streamable HTTP, plain-JSON answers. Speaks the modern
// revision 2026-07-28 (server/discover) and the legacy handshake
// (initialize + notifications/initialized) alike. All tools act on the same
// Store instance passed in, reusing the shared helpers from graphql.ts so
// numbering, merge semantics and object shapes match REST/GraphQL.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RepoRecord, Store } from './types.ts';
import { resolveRepo } from './store.ts';
import {
  createIssueRecord,
  createPullRecord,
  restIssueObject,
  restPullObject,
  restRepoObject,
  squashMergePull,
} from './graphql.ts';

// ---------------------------------------------------------------------------
// Tool catalogue — built once, reused for every tools/list answer so two
// calls are byte-identical.
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo".' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo".' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo".' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo".' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo".' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'github-forge', version: '1.0.0' };
const CAPABILITIES = { tools: {} };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authed(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return false;
  const presented = (match[1] ?? '').trim();
  if (presented === '') return false;
  if (token !== undefined && token !== '') return presented === token;
  return true;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) { reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolText(obj: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }], isError: false };
}
function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Resolve owner/repo from arguments, accepting full_name "owner/repo". */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if (owner === '' && typeof args.owner_login === 'string') owner = args.owner_login;
  if (repo === '' && typeof args.repository === 'string') repo = args.repository;
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      if (owner === '') owner = parts[0] as string;
      if (repo === '') repo = parts[1] as string;
    }
  }
  if (owner === '' || repo === '') return null;
  return { owner, repo };
}

function getRepoOrError(store: Store, args: Record<string, unknown>): { repo: RepoRecord; owner: string; name: string } | { error: string } {
  const resolved = resolveOwnerRepo(args);
  if (!resolved) return { error: 'Missing required argument: owner and repo (or full_name "owner/repo").' };
  const repo = resolveRepo(store, resolved.owner, resolved.repo);
  if (!repo) return { error: `Repository not found: ${resolved.owner}/${resolved.repo}` };
  return { repo, owner: resolved.owner, name: resolved.repo };
}

const REQUIRED: Record<string, string[]> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};

function missingArgs(name: string, args: Record<string, unknown>): string[] {
  const required = REQUIRED[name] ?? [];
  const missing: string[] = [];
  for (const key of required) {
    if (key === 'owner' || key === 'repo') {
      // full_name can stand in for owner+repo
      if (typeof args.full_name === 'string' && args.full_name.includes('/')) continue;
    }
    const v = args[key];
    if (v === undefined || v === null || v === '') missing.push(key);
  }
  return missing;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const actor = store.tokenOwner;
  const missing = missingArgs(name, args);
  if (missing.length > 0) return toolError(`Missing required argument(s): ${missing.join(', ')}`);

  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const owner = actor;
      if (store.getRepo(owner, repoName)) return toolError(`Repository already exists: ${owner}/${repoName}`);
      const repo = store.createRepo(owner, repoName, typeof args.description === 'string' ? args.description : '');
      return toolText(restRepoObject(store, repo));
    }
    case 'get_repo': {
      const found = getRepoOrError(store, args);
      if ('error' in found) return toolError(found.error);
      return toolText(restRepoObject(store, found.repo));
    }
    case 'create_issue': {
      const found = getRepoOrError(store, args);
      if ('error' in found) return toolError(found.error);
      const issue = createIssueRecord(store, found.repo, String(args.title), typeof args.body === 'string' ? args.body : '', actor);
      return toolText(restIssueObject(found.repo, issue));
    }
    case 'list_issues': {
      const found = getRepoOrError(store, args);
      if ('error' in found) return toolError(found.error);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const list = [...found.repo.issues.values()]
        .filter((i) => state === 'all' ? true : state === 'closed' ? i.state === 'closed' : i.state === 'open')
        .sort((a, b) => a.number - b.number)
        .map((i) => restIssueObject(found.repo, i));
      return toolText(list);
    }
    case 'create_pull_request': {
      const found = getRepoOrError(store, args);
      if ('error' in found) return toolError(found.error);
      const pull = createPullRecord(
        found.repo,
        String(args.title),
        typeof args.body === 'string' ? args.body : '',
        String(args.head),
        String(args.base),
        actor,
      );
      if (!pull) return toolError(`Head branch does not exist: ${String(args.head)}`);
      return toolText(restPullObject(found.repo, pull));
    }
    case 'merge_pull_request': {
      const found = getRepoOrError(store, args);
      if ('error' in found) return toolError(found.error);
      const numRaw = args.pull_number ?? args.number ?? args.pull_request_number;
      const num = typeof numRaw === 'number' ? numRaw : parseInt(String(numRaw ?? ''), 10);
      if (!Number.isInteger(num)) return toolError('Missing required argument: pull_number must be an integer.');
      const pull = found.repo.pulls.get(num);
      if (!pull) return toolError(`Pull request not found: #${num}`);
      const res = squashMergePull(found.repo, pull, actor);
      if ('error' in res) return toolError(`Cannot merge pull request #${num}: ${res.error}`);
      return toolText({ sha: res.sha, merged: true, message: `Pull request #${num} merged.` });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let pathname = '';
  try {
    pathname = new URL(req.url ?? '/', 'http://x').pathname;
  } catch {
    return false;
  }
  if (pathname !== '/mcp') return false;
  if (req.method === 'DELETE') {
    // Legacy session teardown (client.close()): acknowledge, nothing held.
    res.writeHead(202);
    res.end();
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'method not allowed' } });
    return true;
  }
  if (!authed(req)) {
    sendJson(res, 401, { message: 'unauthorized' });
    return true;
  }
  let text: string;
  try {
    text = await readBody(req);
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }
  if (!isRecord(body)) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object'));
    return true;
  }
  const id = (body as Record<string, unknown>).id;
  const method = (body as Record<string, unknown>).method;
  const params = isRecord((body as Record<string, unknown>).params) ? ((body as Record<string, unknown>).params as Record<string, unknown>) : {};

  // Notifications (no id) get no JSON-RPC response: 202 empty body.
  if (id === undefined || id === null) {
    if (typeof method === 'string' && method.startsWith('notifications/')) {
      res.writeHead(202);
      res.end();
      return true;
    }
    if (typeof method !== 'string') {
      sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
      return true;
    }
  }

  switch (method) {
    case 'server/discover': {
      sendJson(res, 200, rpcResult(id, {
        resultType: 'server/discover',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      }));
      return true;
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
      sendJson(res, 200, rpcResult(id, {
        protocolVersion: version,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
      }));
      return true;
    }
    case 'ping': {
      sendJson(res, 200, rpcResult(id, {}));
      return true;
    }
    case 'tools/list': {
      // Same object every time: byte-identical across calls.
      sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
      return true;
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      if (toolName === '' || !TOOLS.some((t) => t.name === toolName)) {
        sendJson(res, 200, rpcError(id, -32601, `Method not found: tool ${toolName === '' ? '(missing name)' : toolName}`));
        return true;
      }
      let result: Record<string, unknown>;
      try {
        result = callTool(store, toolName, args);
      } catch (e) {
        result = toolError(e instanceof Error ? e.message : String(e));
      }
      sendJson(res, 200, rpcResult(id, result));
      return true;
    }
    default: {
      sendJson(res, 200, rpcError(id, -32601, `Method not found: ${String(method ?? '')}`));
      return true;
    }
  }
}
