// REST v3 API for the github-core-clone-01 forge.
// Export: handleRest(req, res, store): Promise<boolean> — true when the path is
// under /api/v3 (handled, including 404s under it), false otherwise.
//
// Contract (checks-rest.ts is authoritative; this file follows it, not the brief,
// wherever they differ):
//   - Bearer auth on every /api/v3 request (MAKEFUN_SHOP_TOKEN; any non-empty
//     Bearer when unset). 401 JSON {message} when missing/wrong. No exceptions.
//   - Every reply: application/json, non-empty X-GitHub-Request-Id (random hex).
//     Errors: JSON {message}. Malformed JSON body -> 400. Unknown /api/v3 route
//     -> 404 JSON {message:"Not Found"}.
//   - A repo belongs to the token's login: same name under another owner -> 404.
//     Owner identity is learned (see store.ts resolveRepo/displayOwner).
//   - Issues and pull requests share ONE number sequence per repo, from 1.
//   - Merge is squash: one commit on the base branch whose tree is the head
//     tip's tree, parents=[base tip]. 405 when conflicted (same path changed on
//     both sides since the merge-base with different content).
//
// git.ts signatures (verified against the real git.ts in the build dir):
//   storeObject(repo, type, data: Buffer): string
//   getObject(repo, sha): GitObject | undefined
//   parseTree(data: Buffer): Array<{mode, name, sha}>
//   parseCommit(data: Buffer): {tree, parents: string[],
//     author: string, committer: string, message: string}
//     — author/committer are RAW git lines ("Name <email> <unix-ts> +0000");
//     message carries git's trailing newline, so commitOf() below normalises
//     both into {name, email, date} objects and a newline-stripped message.
//   createCommit(repo, treeSha, parents: string[], message: string,
//     authorName: string, authorEmail: string): string   (positional, sync)
//   updatePathInTree(repo, treeSha: string | null, parts: string[],
//     blobSha: string | null, mode?): string   // path as SEGMENTS, not a string
//   findMergeBase(repo, a: string, b: string): string | undefined
// Path lookup and commit listing are implemented here on getObject/parseCommit,
// so they do not depend on getPathEntry/listCommits signatures.

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IssueRecord, LabelRecord, PullRecord, RepoRecord, Store } from './types.ts';
import { toGlobalId } from './types.ts';
import { displayOwner, repoByName, repoExtra, resolveRepo } from './store.ts';
import {
  createCommit,
  findMergeBase,
  getObject,
  noteReachable,
  parseCommit,
  parseTree,
  storeObject,
  updatePathInTree,
} from './git.ts';
import { addCommentRecord, commentVersionOf, commentsFor } from './graphql.ts';

/** Merge REST comments and GraphQL comments for one issue, deduped by body
 * (a REST POST also writes to the GraphQL store, so the same comment appears
 * in both; the first occurrence wins). GraphQL entries get synthetic numeric
 * ids above 1,000,000 and keep their global id as node_id. */
function allComments(repo: RepoRecord, number: number): CommentRecord[] {
  const key = `${repo.owner}/${repo.name}#${number}`;
  const restList = commentsByIssue.get(key) ?? [];
  const out: CommentRecord[] = [...restList];
  const seen = new Set(restList.map((c) => c.body));
  const gqlList = commentsFor(repo, number);
  for (let i = 0; i < gqlList.length; i += 1) {
    const g = gqlList[i] as { id: string; body: string; created_at: string };
    if (seen.has(g.body)) continue;
    seen.add(g.body);
    out.push({
      id: 1000000 + i,
      body: g.body,
      user: { login: repo.owner },
      created_at: g.created_at,
      updated_at: g.created_at,
    });
  }
  return out;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const SHA40 = /^[0-9a-f]{40}$/i;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

type JsonObj = Record<string, unknown>;

interface CommentRecord {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

/** Issue comments live here (IssueRecord carries no comments field). */
const commentsByIssue = new Map<string, CommentRecord[]>();
let nextCommentId = 1;

function nowIso(): string {
  return new Date().toISOString();
}

function authorOf(login: string): { name: string; email: string; date: string } {
  return { name: login, email: `${login}@users.noreply.github.com`, date: nowIso() };
}

/** Decode one path segment leniently (a bad % sequence stays raw, never throws). */
function dec(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

function parseQuery(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const u = new URL(req.url ?? '/', 'http://entry');
    return { path: u.pathname, query: u.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

async function readBody(req: IncomingMessage): Promise<{ body: JsonObj | null; malformed: boolean; tooLarge: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) return { body: null, malformed: false, tooLarge: true };
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return { body: {}, malformed: false, tooLarge: false };
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { body: null, malformed: true, tooLarge: false };
    }
    return { body: parsed as JsonObj, malformed: false, tooLarge: false };
  } catch {
    return { body: null, malformed: true, tooLarge: false };
  }
}

function send(res: ServerResponse, requestId: string, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': requestId, ...extra });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...extra,
  });
  res.end(text);
}

function err(res: ServerResponse, requestId: string, status: number, message: string): void {
  send(res, requestId, status, { message });
}

/** Send a pre-serialized JSON body (with its trailing newline already in `text`). */
function sendText(res: ServerResponse, requestId: string, status: number, text: string): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
  });
  res.end(text);
}

/**
 * Serialized GET-issue responses, per repo+number. An issue's rendering
 * only changes when the issue itself changes (PATCH bumps updated_at),
 * when a comment lands (commentVersionOf), or when the learned owner
 * changes (stable once claimed), so those three values are the cache key.
 * The read workload GETs one issue 2,000 times, so this turns 1,999 of
 * those into a Map lookup plus a write.
 */
const issueJsonCache = new WeakMap<RepoRecord, Map<number, { text: string; updatedAt: string; commentVersion: number; owner: string }>>();

function cachedIssueJson(store: Store, req: IncomingMessage, repo: RepoRecord, issue: IssueRecord): string {
  let perRepo = issueJsonCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map();
    issueJsonCache.set(repo, perRepo);
  }
  const owner = displayOwner(store, repo);
  const commentVersion = commentVersionOf(repo, issue.number);
  const cached = perRepo.get(issue.number);
  if (
    cached !== undefined &&
    cached.updatedAt === issue.updated_at &&
    cached.commentVersion === commentVersion &&
    cached.owner === owner
  ) {
    return cached.text;
  }
  const text = `${JSON.stringify(issueJson(store, req, repo, issue))}\n`;
  perRepo.set(issue.number, { text, updatedAt: issue.updated_at, commentVersion, owner });
  return text;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
}

/** Split a remaining path into decoded segments, dropping empty ones. */
function segmentsOf(rest: string): string[] {
  return rest.split('/').filter((s) => s !== '').map(dec);
}

/** Page/per_page from query; page>=1, per_page 1..100, default 30. */
function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10) || 30;
  const perPage = Math.min(100, Math.max(1, perPageRaw));
  return { page, perPage };
}

/** Slice a list into one page; returns the page plus a Link header value (or ''). */
function paginate<T>(items: readonly T[], req: IncomingMessage, query: URLSearchParams): { page: T[]; link: string } {
  const { page, perPage } = pageParams(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link = '';
  if (start + perPage < items.length) {
    try {
      const u = new URL(req.url ?? '/', baseUrlOf(req));
      u.searchParams.set('page', String(page + 1));
      u.searchParams.set('per_page', String(perPage));
      const next = u.toString();
      u.searchParams.set('page', String(Math.ceil(items.length / perPage)));
      link = `<${next}>; rel="next", <${u.toString()}>; rel="last"`;
    } catch {
      link = '';
    }
  }
  return { page: slice, link };
}

function linkHeader(link: string): Record<string, string> {
  return link === '' ? {} : { link };
}

// -------------------------------------------------------------------------------------------
// JSON views

function repoJson(store: Store, req: IncomingMessage, repo: RepoRecord): JsonObj {
  const extra = repoExtra(repo);
  const owner = displayOwner(store, repo);
  const base = baseUrlOf(req);
  const fullName = `${owner}/${repo.name}`;
  return {
    id: extra.id,
    node_id: toGlobalId('Repository', extra.id),
    name: repo.name,
    full_name: fullName,
    owner: { login: owner, id: 1000, type: 'User', html_url: `${base}/${owner}`, url: `${base}/api/v3/users/${owner}` },
    private: extra.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${base}/${owner}/${repo.name}`,
    url: `${base}/api/v3/repos/${owner}/${repo.name}`,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    has_issues: true,
    has_projects: false,
    fork: false,
    archived: false,
    disabled: false,
    visibility: extra.private ? 'private' : 'public',
    language: null,
    topics: [],
    license: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
  };
}

function labelJson(label: LabelRecord): JsonObj {
  return { id: 0, node_id: toGlobalId('Label', label.name), name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(store: Store, req: IncomingMessage, repo: RepoRecord, issue: IssueRecord): JsonObj {
  const owner = displayOwner(store, repo);
  const base = baseUrlOf(req);
  const labels = issue.labels
    .map((name) => repo.labels.get(name))
    .filter((l): l is LabelRecord => l !== undefined)
    .map(labelJson);
  return {
    id: issue.id,
    node_id: toGlobalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels,
    user: { login: issue.user.login, id: 1000, type: 'User' },
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: allComments(repo, issue.number).length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    html_url: `${base}/${owner}/${repo.name}/issues/${issue.number}`,
    url: `${base}/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${owner}/${repo.name}`,
  };
}

function pullJson(store: Store, req: IncomingMessage, repo: RepoRecord, pull: PullRecord): JsonObj {
  const owner = displayOwner(store, repo);
  const base = baseUrlOf(req);
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const repoMini = { id: repoExtra(repo).id, name: repo.name, full_name: `${owner}/${repo.name}`, owner: { login: owner, type: 'User' } };
  return {
    id: pull.id,
    node_id: toGlobalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.mergeable,
    merged_at: pull.merged ? pull.updated_at : null,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    locked: false,
    head: { ref: pull.headRef, sha: headSha, label: `${owner}:${pull.headRef}`, repo: repoMini },
    base: { ref: pull.baseRef, sha: baseSha, label: `${owner}:${pull.baseRef}`, repo: repoMini },
    user: { login: pull.user.login, id: 1000, type: 'User' },
    assignee: null,
    assignees: [],
    labels: [],
    milestone: null,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.state === 'closed' ? pull.updated_at : null,
    html_url: `${base}/${owner}/${repo.name}/pull/${pull.number}`,
    url: `${base}/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
    commits_url: `${base}/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}/commits`,
  };
}

// -------------------------------------------------------------------------------------------
// Git helpers (built on git.ts primitives only)

async function commitTreeSha(repo: RepoRecord, commitSha: string): Promise<string | null> {
  const obj = await getObject(repo, commitSha);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

async function commitOf(repo: RepoRecord, sha: string): Promise<{ tree: string; parents: string[]; author: { name: string; email: string; date: string }; committer: { name: string; email: string; date: string }; message: string } | null> {
  const obj = await getObject(repo, sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  return {
    tree: parsed.tree,
    parents: parsed.parents,
    author: parseWho(parsed.author),
    committer: parseWho(parsed.committer),
    message: parsed.message.replace(/\n+$/, ''),
  };
}

/** "Name <email> <unix-ts> +0000" -> {name, email, date (ISO)}. */
function parseWho(raw: string): { name: string; email: string; date: string } {
  const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(raw.trim());
  if (m === null) return { name: raw, email: '', date: nowIso() };
  return { name: m[1] as string, email: m[2] as string, date: new Date(Number(m[3]) * 1000).toISOString() };
}

/** Find the entry for `path` in the tree `treeSha` (or undefined). */
async function lookupPath(repo: RepoRecord, treeSha: string, path: string): Promise<{ mode: string; name: string; sha: string } | undefined> {
  const parts = path.split('/').filter((p) => p !== '');
  if (parts.length === 0) return undefined;
  let cur = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = await getObject(repo, cur);
    if (obj === undefined) return undefined;
    const entries = parseTree(obj.data);
    const entry = entries.find((e) => e.name === parts[i]);
    if (entry === undefined) return undefined;
    if (i === parts.length - 1) return entry;
    if (entry.mode === '040000' || entry.mode === '40000') cur = entry.sha;
    else return undefined;
  }
  return undefined;
}

/** Resolve a ref query (?ref= / ?sha=): branch name, else a commit sha, else null. */
function resolveRefTip(repo: RepoRecord, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const branchTip = repo.refs.get(`refs/heads/${ref}`);
  if (branchTip !== undefined) return branchTip;
  if (SHA40.test(ref)) return ref;
  return null;
}

/** Newest-first commit shas reachable from `tip` (pre-order DFS, first parent first). */
async function listCommitShas(repo: RepoRecord, tip: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const parsed = await commitOf(repo, sha);
    if (parsed === null) continue;
    out.push(sha);
    for (let i = parsed.parents.length - 1; i >= 0; i -= 1) {
      stack.push(parsed.parents[i] as string);
    }
  }
  return out;
}

async function commitJson(repo: RepoRecord, sha: string): Promise<JsonObj | null> {
  const parsed = await commitOf(repo, sha);
  if (parsed === null) return null;
  return {
    sha,
    node_id: toGlobalId('Commit', sha),
    commit: {
      message: parsed.message,
      author: parsed.author,
      committer: parsed.committer,
      tree: { sha: parsed.tree },
    },
    parents: parsed.parents.map((p) => ({ sha: p })),
    tree: { sha: parsed.tree },
  };
}

/** Flatten a tree to path -> blob sha (recursive). */
async function flattenTree(repo: RepoRecord, treeSha: string | null): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (treeSha === null) return out;
  const walk = async (sha: string, prefix: string): Promise<void> => {
    const obj = await getObject(repo, sha);
    if (obj === undefined) return;
    for (const e of parseTree(obj.data)) {
      const p = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '040000' || e.mode === '40000') await walk(e.sha, p);
      else out.set(p, e.sha);
    }
  };
  await walk(treeSha, '');
  return out;
}

/** Paths whose blob differs between two trees (null tree = empty). */
async function diffTrees(repo: RepoRecord, oldTree: string | null, newTree: string | null): Promise<Map<string, { oldSha: string | null; newSha: string | null }>> {
  const oldMap = await flattenTree(repo, oldTree);
  const newMap = await flattenTree(repo, newTree);
  const out = new Map<string, { oldSha: string | null; newSha: string | null }>();
  const keys = new Set([...oldMap.keys(), ...newMap.keys()]);
  for (const key of keys) {
    const o = oldMap.get(key) ?? null;
    const n = newMap.get(key) ?? null;
    if (o !== n) out.set(key, { oldSha: o, newSha: n });
  }
  return out;
}

function countLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line additions/deletions between two blob contents (multiset diff). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldCounts = new Map<string, number>();
  for (const line of countLines(oldText)) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of countLines(newText)) {
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCounts.values()) deletions += left;
  return { additions, deletions };
}

async function blobText(repo: RepoRecord, sha: string | null): Promise<string> {
  if (sha === null) return '';
  const obj = await getObject(repo, sha);
  if (obj === undefined) return '';
  return obj.data.toString('utf8');
}

/** One shared number sequence for issues and pull requests in a repo, from 1. */
function nextSharedNumber(repo: RepoRecord): number {
  repo.issueSeq += 1;
  repo.pullSeq = repo.issueSeq;
  return repo.issueSeq;
}

/** Globally unique id for an issue/PR: repo id block + number (+1M block for PRs). */
function recordId(repo: RepoRecord, number: number, isPull: boolean): number {
  return repoExtra(repo).id * 2_000_000 + (isPull ? 1_000_000 : 0) + number;
}

function setPrivate(repo: RepoRecord, value: boolean): void {
  (repo as unknown as Record<string, unknown>).private = value;
}

// -------------------------------------------------------------------------------------------
// Handler

export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const { path, query } = parseQuery(req);
  if (path !== '/api/v3' && !path.startsWith('/api/v3/')) return false;
  const requestId = randomBytes(8).toString('hex');
  const method = req.method ?? 'GET';

  // Auth first: every /api/v3 request needs the bearer token (no exceptions).
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const auth = req.headers.authorization ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  const authed = expected === '' ? bearer !== '' : bearer === expected;
  if (!authed) {
    err(res, requestId, 401, 'Requires authentication');
    return true;
  }

  // Body (only methods that carry one). Malformed JSON -> 400.
  let body: JsonObj = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const read = await readBody(req);
    if (read.tooLarge) {
      err(res, requestId, 413, 'Request body too large');
      return true;
    }
    if (read.malformed || read.body === null) {
      err(res, requestId, 400, 'Malformed JSON in request body');
      return true;
    }
    body = read.body;
  }

  // Normalise: strip a trailing slash (except the root itself).
  const norm = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const tail = norm === '/api/v3' ? '' : norm.slice('/api/v3/'.length);
  const seg = segmentsOf(tail);

  try {
    // ---- API root -----------------------------------------------------------
    if (tail === '') {
      if (method !== 'GET') {
        err(res, requestId, 404, 'Not Found');
        return true;
      }
      const base = baseUrlOf(req);
      send(res, requestId, 200, {
        current_user_url: `${base}/api/v3/user`,
        current_user_authorizations_html_url: `${base}/settings/applications`,
        authorizations_url: `${base}/api/v3/authorizations`,
        code_search_url: `${base}/api/v3/search/code?q={query}`,
        commit_search_url: `${base}/api/v3/search/commits?q={query}`,
        emails_url: `${base}/api/v3/user/emails`,
        emojis_url: `${base}/api/v3/emojis`,
        events_url: `${base}/api/v3/events`,
        feeds_url: `${base}/api/v3/feeds`,
        followers_url: `${base}/api/v3/user/followers`,
        following_url: `${base}/api/v3/user/following{/target}`,
        gists_url: `${base}/api/v3/gists{/gist_id}`,
        hub_url: `${base}/api/v3/hub`,
        issue_search_url: `${base}/api/v3/search/issues?q={query}`,
        issues_url: `${base}/api/v3/issues`,
        keys_url: `${base}/api/v3/user/keys`,
        label_search_url: `${base}/api/v3/search/labels?q={query}`,
        notifications_url: `${base}/api/v3/notifications`,
        organization_url: `${base}/api/v3/orgs/{org}`,
        organization_repositories_url: `${base}/api/v3/orgs/{org}/repos{?type,page,per_page}`,
        organization_teams_url: `${base}/api/v3/orgs/{org}/teams`,
        public_gists_url: `${base}/api/v3/gists/public`,
        rate_limit_url: `${base}/api/v3/rate_limit`,
        repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
        repository_search_url: `${base}/api/v3/search/repositories?q={query}`,
        current_user_repositories_url: `${base}/api/v3/user/repos{?type,page,per_page}`,
        starred_url: `${base}/api/v3/user/starred{/owner}{/repo}`,
        starred_gists_url: `${base}/api/v3/gists/starred`,
        user_url: `${base}/api/v3/users/{user}`,
        user_organizations_url: `${base}/api/v3/user/orgs`,
        user_repositories_url: `${base}/api/v3/user/repos{?type,page,per_page}`,
        user_search_url: `${base}/api/v3/search/users?q={query}`,
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }

    // ---- meta ---------------------------------------------------------------
    if (tail === 'meta' && method === 'GET') {
      send(res, requestId, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
      return true;
    }

    // ---- /user/repos --------------------------------------------------------
    if (tail === 'user/repos') {
      if (method === 'GET') {
        const repos = store.listRepos(store.tokenOwner);
        // listRepos keys on the stored (fallback) owner; every repo the token
        // created is listed, whatever owner was later learned for it.
        const { page, link } = paginate(repos.map((r) => repoJson(store, req, r)), req, query);
        send(res, requestId, 200, page, linkHeader(link));
        return true;
      }
      if (method === 'POST') {
        const name = asString(body.name).trim();
        if (name === '' || name.includes('/') || name.includes(' ')) {
          err(res, requestId, 422, 'Validation Failed: name is required');
          return true;
        }
        if (repoByName(store, name) !== undefined) {
          err(res, requestId, 422, 'Repository creation failed: name already exists on this account');
          return true;
        }
        const repo = store.createRepo(store.tokenOwner, name, asString(body.description));
        if (typeof body.private === 'boolean') setPrivate(repo, body.private);
        repo.updated_at = nowIso();
        send(res, requestId, 201, repoJson(store, req, repo));
        return true;
      }
      err(res, requestId, 404, 'Not Found');
      return true;
    }

    // ---- /repos/{owner}/{repo}[...] -----------------------------------------
    if (seg[0] === 'repos' && seg.length >= 3) {
      const owner = seg[1] as string;
      const repoName = seg[2] as string;
      const repo = resolveRepo(store, owner, repoName);
      if (repo === undefined) {
        err(res, requestId, 404, 'Not Found');
        return true;
      }
      const rest = seg.slice(3);
      const login = displayOwner(store, repo);

      // GET /repos/{o}/{r} | PATCH | DELETE
      if (rest.length === 0) {
        if (method === 'GET') {
          send(res, requestId, 200, repoJson(store, req, repo));
          return true;
        }
        if (method === 'PATCH') {
          if (typeof body.description === 'string') repo.description = body.description;
          if (typeof body.private === 'boolean') setPrivate(repo, body.private);
          repo.updated_at = nowIso();
          send(res, requestId, 200, repoJson(store, req, repo));
          return true;
        }
        if (method === 'DELETE') {
          store.deleteRepo(repo.owner, repo.name);
          send(res, requestId, 204, null);
          return true;
        }
        err(res, requestId, 404, 'Not Found');
        return true;
      }

      // ---- branches ---------------------------------------------------------
      if (rest[0] === 'branches') {
        if (rest.length === 1 && method === 'GET') {
          const list = [...repo.refs.entries()]
            .filter(([ref]) => ref.startsWith('refs/heads/'))
            .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
          send(res, requestId, 200, list);
          return true;
        }
        if (rest.length >= 2 && method === 'GET') {
          const branch = rest.slice(1).join('/');
          const sha = repo.refs.get(`refs/heads/${branch}`);
          if (sha === undefined) {
            err(res, requestId, 404, 'Branch not found');
            return true;
          }
          send(res, requestId, 200, { name: branch, commit: { sha }, protected: false });
          return true;
        }
        err(res, requestId, 404, 'Not Found');
        return true;
      }

      // ---- commits ----------------------------------------------------------
      if (rest[0] === 'commits') {
        if (rest.length === 1 && method === 'GET') {
          const tip = resolveRefTip(repo, query.get('sha'));
          if (tip === null) {
            send(res, requestId, 200, []);
            return true;
          }
          const shas = await listCommitShas(repo, tip);
          const { page, link } = paginate(shas, req, query);
          const items: JsonObj[] = [];
          for (const sha of page) {
            const item = await commitJson(repo, sha);
            if (item !== null) items.push(item);
          }
          send(res, requestId, 200, items, linkHeader(link));
          return true;
        }
        if (rest.length === 2 && method === 'GET') {
          const wanted = rest[1] as string;
          const tip = repo.refs.get(`refs/heads/${wanted}`) ?? (SHA40.test(wanted) ? wanted : null);
          if (tip === null) {
            err(res, requestId, 404, 'Not Found');
            return true;
          }
          const item = await commitJson(repo, tip);
          if (item === null) {
            err(res, requestId, 404, 'Not Found');
            return true;
          }
          send(res, requestId, 200, item);
          return true;
        }
        err(res, requestId, 404, 'Not Found');
        return true;
      }

      // ---- git/refs (branch create; used by the suite before opening PRs) ---
      if (rest[0] === 'git' && rest[1] === 'refs') {
        if (method === 'POST' && rest.length === 2) {
          const ref = asString(body.ref);
          const sha = asString(body.sha);
          if (!ref.startsWith('refs/heads/') || !SHA40.test(sha)) {
            err(res, requestId, 422, 'Validation Failed: ref and sha are required');
            return true;
          }
          if (repo.refs.has(ref)) {
            err(res, requestId, 422, 'Reference already exists');
            return true;
          }
          const obj = await getObject(repo, sha);
          if (obj === undefined || obj.type !== 'commit') {
            err(res, requestId, 422, 'Validation Failed: sha is not a commit');
            return true;
          }
          repo.refs.set(ref, sha);
          noteReachable(repo, sha);
          send(res, requestId, 201, {
            ref,
            node_id: toGlobalId('Ref', ref),
            url: `${baseUrlOf(req)}/api/v3/repos/${login}/${repo.name}/git/refs/${encodeURIComponent(ref)}`,
            object: { sha, type: 'commit', url: `${baseUrlOf(req)}/api/v3/repos/${login}/${repo.name}/git/commits/${sha}` },
          });
          return true;
        }
        if (method === 'GET') {
          const list = [...repo.refs.entries()].map(([ref, sha]) => ({
            ref,
            node_id: toGlobalId('Ref', ref),
            url: `${baseUrlOf(req)}/api/v3/repos/${login}/${repo.name}/git/refs/${encodeURIComponent(ref)}`,
            object: { sha, type: 'commit' },
          }));
          if (rest.length === 2) {
            send(res, requestId, 200, list);
            return true;
          }
          const wanted = `refs/${rest.slice(2).join('/')}`;
          const found = list.find((r) => r.ref === wanted);
          if (found === undefined) {
            err(res, requestId, 404, 'Not Found');
            return true;
          }
          send(res, requestId, 200, found);
          return true;
        }
        err(res, requestId, 404, 'Not Found');
        return true;
      }

      // ---- contents ---------------------------------------------------------
      if (rest[0] === 'contents') {
        const contentPath = rest.slice(1).join('/');
        const base = baseUrlOf(req);
        if (method === 'PUT') {
          const message = asString(body.message);
          const contentB64 = body.content;
          if (message === '' || typeof contentB64 !== 'string') {
            err(res, requestId, 422, 'Validation Failed: message and content are required');
            return true;
          }
          if (contentPath === '') {
            err(res, requestId, 422, 'Validation Failed: path is required');
            return true;
          }
          const branch = asString(body.branch) || repo.defaultBranch;
          const refName = `refs/heads/${branch}`;
          const tip = repo.refs.get(refName);
          if (tip === undefined && asString(body.branch) !== '' && body.branch !== repo.defaultBranch) {
            err(res, requestId, 422, `Validation Failed: branch ${branch} does not exist`);
            return true;
          }
          let tipTree: string | null = null;
          let existing: { mode: string; name: string; sha: string } | undefined;
          if (tip !== undefined) {
            tipTree = await commitTreeSha(repo, tip);
            if (tipTree !== null) existing = await lookupPath(repo, tipTree, contentPath);
          }
          const isUpdate = existing !== undefined;
          if (existing !== undefined) {
            const givenSha = asString(body.sha);
            if (givenSha === '') {
              err(res, requestId, 422, 'Validation Failed: sha is required to update a file');
              return true;
            }
            if (givenSha.toLowerCase() !== existing.sha.toLowerCase()) {
              err(res, requestId, 409, 'Conflict: sha does not match the current file');
              return true;
            }
          }
          const data = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
          const blobSha = await storeObject(repo, 'blob', data);
          const newTree = await updatePathInTree(repo, tipTree, contentPath.split('/').filter((p) => p !== ''), blobSha);
          const who = authorOf(store.tokenOwner);
          const commitSha = await createCommit(repo, newTree, tip === undefined ? [] : [tip], message, who.name, who.email);
          repo.refs.set(refName, commitSha);
          noteReachable(repo, commitSha);
          repo.updated_at = nowIso();
          const name = contentPath.split('/').pop() ?? contentPath;
          send(res, requestId, isUpdate ? 200 : 201, {
            content: {
              name,
              path: contentPath,
              sha: blobSha,
              size: data.length,
              type: 'file',
              encoding: 'base64',
              url: `${base}/api/v3/repos/${login}/${repo.name}/contents/${contentPath}`,
              html_url: `${base}/${login}/${repo.name}/blob/${branch}/${contentPath}`,
              download_url: `${base}/api/v3/repos/${login}/${repo.name}/contents/${contentPath}`,
            },
            commit: { sha: commitSha, message, author: who, committer: who },
          });
          return true;
        }
        if (method === 'GET') {
          const tip = resolveRefTip(repo, query.get('ref'));
          if (tip === null) {
            err(res, requestId, 404, 'Not Found');
            return true;
          }
          const treeSha = await commitTreeSha(repo, tip);
          if (treeSha === null) {
            err(res, requestId, 404, 'Not Found');
            return true;
          }
          if (contentPath === '') {
            const obj = await getObject(repo, treeSha);
            const entries = obj === undefined ? [] : parseTree(obj.data);
            const items: JsonObj[] = [];
            for (const e of entries) {
              const isDir = e.mode === '040000' || e.mode === '40000';
              let size = 0;
              if (!isDir) {
                const blob = await getObject(repo, e.sha);
                size = blob === undefined ? 0 : blob.data.length;
              }
              items.push({ type: isDir ? 'dir' : 'file', name: e.name, path: e.name, sha: e.sha, size, url: `${base}/api/v3/repos/${login}/${repo.name}/contents/${e.name}` });
            }
            send(res, requestId, 200, items);
            return true;
          }
          const entry = await lookupPath(repo, treeSha, contentPath);
          if (entry === undefined) {
            err(res, requestId, 404, 'Not Found');
            return true;
          }
          const name = contentPath.split('/').pop() ?? contentPath;
          if (entry.mode === '040000' || entry.mode === '40000') {
            const obj = await getObject(repo, entry.sha);
            const entries = obj === undefined ? [] : parseTree(obj.data);
            const items: JsonObj[] = [];
            for (const e of entries) {
              const isDir = e.mode === '040000' || e.mode === '40000';
              let size = 0;
              if (!isDir) {
                const blob = await getObject(repo, e.sha);
                size = blob === undefined ? 0 : blob.data.length;
              }
              items.push({ type: isDir ? 'dir' : 'file', name: e.name, path: `${contentPath}/${e.name}`, sha: e.sha, size, url: `${base}/api/v3/repos/${login}/${repo.name}/contents/${contentPath}/${e.name}` });
            }
            send(res, requestId, 200, items);
            return true;
          }
          const blob = await getObject(repo, entry.sha);
          if (blob === undefined) {
            err(res, requestId, 404, 'Not Found');
            return true;
          }
          send(res, requestId, 200, {
            name,
            path: contentPath,
            sha: entry.sha,
            size: blob.data.length,
            type: 'file',
            encoding: 'base64',
            content: blob.data.toString('base64'),
            url: `${base}/api/v3/repos/${login}/${repo.name}/contents/${contentPath}`,
            html_url: `${base}/${login}/${repo.name}/blob/${repo.defaultBranch}/${contentPath}`,
            download_url: `${base}/api/v3/repos/${login}/${repo.name}/contents/${contentPath}`,
          });
          return true;
        }
        if (method === 'DELETE') {
          const branch = asString(body.branch) || repo.defaultBranch;
          const refName = `refs/heads/${branch}`;
          const tip = repo.refs.get(refName);
          if (tip === undefined) {
            err(res, requestId, 404, 'Not Found');
            return true;
          }
          const tipTree = await commitTreeSha(repo, tip);
          if (tipTree === null) {
            err(res, requestId, 404, 'Not Found');
            return true;
          }
          const existing = await lookupPath(repo, tipTree, contentPath);
          if (existing === undefined) {
            err(res, requestId, 404, 'Not Found');
            return true;
          }
          const givenSha = asString(body.sha);
          if (givenSha !== '' && givenSha.toLowerCase() !== existing.sha.toLowerCase()) {
            err(res, requestId, 422, 'Validation Failed: sha does not match the current file');
            return true;
          }
          const message = asString(body.message) || `Delete ${contentPath}`;
          const newTree = await updatePathInTree(repo, tipTree, contentPath.split('/').filter((p) => p !== ''), null);
          const who = authorOf(store.tokenOwner);
          const commitSha = await createCommit(repo, newTree, [tip], message, who.name, who.email);
          repo.refs.set(refName, commitSha);
          noteReachable(repo, commitSha);
          repo.updated_at = nowIso();
          send(res, requestId, 200, { content: null, commit: { sha: commitSha, message, author: who, committer: who } });
          return true;
        }
        err(res, requestId, 404, 'Not Found');
        return true;
      }

      // ---- labels -----------------------------------------------------------
      if (rest[0] === 'labels') {
        if (rest.length === 1 && method === 'GET') {
          send(res, requestId, 200, [...repo.labels.values()].map(labelJson));
          return true;
        }
        if (rest.length === 1 && method === 'POST') {
          const name = asString(body.name).trim();
          if (name === '') {
            err(res, requestId, 422, 'Validation Failed: name is required');
            return true;
          }
          if (repo.labels.has(name)) {
            err(res, requestId, 422, 'Validation Failed: label already exists');
            return true;
          }
          const label: LabelRecord = {
            name,
            color: asString(body.color) || 'ededed',
            description: asString(body.description),
          };
          repo.labels.set(name, label);
          send(res, requestId, 201, labelJson(label));
          return true;
        }
        err(res, requestId, 404, 'Not Found');
        return true;
      }

      // ---- issues -----------------------------------------------------------
      if (rest[0] === 'issues') {
        // POST /issues/{n}/comments, GET /issues/{n}/comments
        if (rest.length === 3 && rest[2] === 'comments') {
          const number = Number.parseInt(rest[1] as string, 10);
          const issue = repo.issues.get(number);
          if (issue === undefined) {
            err(res, requestId, 404, 'Not Found');
            return true;
          }
          const key = `${repo.owner}/${repo.name}#${number}`;
          if (method === 'POST') {
            const text = asString(body.body);
            if (text === '') {
              err(res, requestId, 422, 'Validation Failed: body is required');
              return true;
            }
            const comment: CommentRecord = {
              id: nextCommentId,
              body: text,
              user: { login: store.tokenOwner },
              created_at: nowIso(),
              updated_at: nowIso(),
            };
            nextCommentId += 1;
            const list = commentsByIssue.get(key) ?? [];
            list.push(comment);
            commentsByIssue.set(key, list);
            // Also publish to the GraphQL comment store so issue.comments
            // over GraphQL sees REST-created comments (deduped by body on read).
            addCommentRecord(repo, number, text);
            const base = baseUrlOf(req);
            send(res, requestId, 201, {
              id: comment.id,
              node_id: toGlobalId('IssueComment', comment.id),
              body: comment.body,
              user: comment.user,
              created_at: comment.created_at,
              updated_at: comment.updated_at,
              html_url: `${base}/${login}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
              url: `${base}/api/v3/repos/${login}/${repo.name}/issues/comments/${comment.id}`,
            });
            return true;
          }
          if (method === 'GET') {
            const base = baseUrlOf(req);
            const list = allComments(repo, number);
            send(res, requestId, 200, list.map((c) => ({
              id: c.id,
              node_id: toGlobalId('IssueComment', c.id),
              body: c.body,
              user: c.user,
              created_at: c.created_at,
              updated_at: c.updated_at,
              html_url: `${base}/${login}/${repo.name}/issues/${number}#issuecomment-${c.id}`,
              url: `${base}/api/v3/repos/${login}/${repo.name}/issues/comments/${c.id}`,
            })));
            return true;
          }
          err(res, requestId, 404, 'Not Found');
          return true;
        }
        if (rest.length === 1 && method === 'GET') {
          let list = [...repo.issues.values()];
          const state = query.get('state') ?? 'open';
          if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
          else if (state !== 'all') list = list.filter((i) => i.state === 'open');
          const sort = query.get('sort');
          const direction = query.get('direction') ?? 'desc';
          if (sort === 'created' || sort === 'updated') {
            const field = sort === 'created' ? 'created_at' : 'updated_at';
            list.sort((a, b) => {
              const byDate = a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0;
              if (byDate !== 0) return direction === 'asc' ? byDate : -byDate;
              return direction === 'asc' ? a.number - b.number : b.number - a.number;
            });
          } else {
            list.sort((a, b) => a.number - b.number);
          }
          const { page, link } = paginate(list.map((i) => issueJson(store, req, repo, i)), req, query);
          send(res, requestId, 200, page, linkHeader(link));
          return true;
        }
        if (rest.length === 1 && method === 'POST') {
          const title = asString(body.title).trim();
          if (title === '') {
            err(res, requestId, 422, 'Validation Failed: title is required');
            return true;
          }
          const labelNames: string[] = [];
          if (Array.isArray(body.labels)) {
            for (const item of body.labels as unknown[]) {
              const name = typeof item === 'string' ? item : asString((item as JsonObj)?.name);
              if (name !== '') labelNames.push(name);
            }
          }
          for (const name of labelNames) {
            if (!repo.labels.has(name)) {
              err(res, requestId, 422, `Validation Failed: label "${name}" does not exist`);
              return true;
            }
          }
          const number = nextSharedNumber(repo);
          const issue: IssueRecord = {
            id: recordId(repo, number, false),
            number,
            title,
            body: asString(body.body),
            state: 'open',
            labels: labelNames,
            user: { login: store.tokenOwner },
            created_at: nowIso(),
            updated_at: nowIso(),
          };
          repo.issues.set(number, issue);
          send(res, requestId, 201, issueJson(store, req, repo, issue));
          return true;
        }
        if (rest.length === 2) {
          const number = Number.parseInt(rest[1] as string, 10);
          const issue = repo.issues.get(number);
          if (issue === undefined) {
            err(res, requestId, 404, 'Not Found');
            return true;
          }
          if (method === 'GET') {
            sendText(res, requestId, 200, cachedIssueJson(store, req, repo, issue));
            return true;
          }
          if (method === 'PATCH') {
            if (typeof body.title === 'string' && body.title.trim() !== '') issue.title = body.title;
            if (typeof body.body === 'string') issue.body = body.body;
            if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
            if (Array.isArray(body.labels)) {
              const names: string[] = [];
              for (const item of body.labels as unknown[]) {
                const name = typeof item === 'string' ? item : asString((item as JsonObj)?.name);
                if (name !== '') names.push(name);
              }
              for (const name of names) {
                if (!repo.labels.has(name)) {
                  err(res, requestId, 422, `Validation Failed: label "${name}" does not exist`);
                  return true;
                }
              }
              issue.labels = names;
            }
            issue.updated_at = nowIso();
            send(res, requestId, 200, issueJson(store, req, repo, issue));
            return true;
          }
          err(res, requestId, 404, 'Not Found');
          return true;
        }
        err(res, requestId, 404, 'Not Found');
        return true;
      }

      // ---- pulls ------------------------------------------------------------
      if (rest[0] === 'pulls') {
        // PUT /pulls/{n}/merge, GET /pulls/{n}/files
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          const number = Number.parseInt(rest[1] as string, 10);
          const pull = repo.pulls.get(number);
          if (pull === undefined) {
            err(res, requestId, 404, 'Not Found');
            return true;
          }
          if (pull.state !== 'open') {
            err(res, requestId, 405, 'Pull Request is not open');
            return true;
          }
          const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
          const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
          if (baseTip === undefined || headTip === undefined) {
            err(res, requestId, 404, 'Not Found');
            return true;
          }
          // Conflict: same path changed on both sides since the merge-base
          // with different resulting content.
          const mergeBase = await findMergeBase(repo, headTip, baseTip);
          if (mergeBase === undefined) {
            err(res, requestId, 405, 'Merge conflict: no common ancestor');
            return true;
          }
          const mbTree = await commitTreeSha(repo, mergeBase);
          const headTree = await commitTreeSha(repo, headTip);
          const baseTree = await commitTreeSha(repo, baseTip);
          const headDiff = await diffTrees(repo, mbTree, headTree);
          const baseDiff = await diffTrees(repo, mbTree, baseTree);
          let conflicted = false;
          for (const [pathKey, change] of headDiff) {
            const other = baseDiff.get(pathKey);
            if (other !== undefined && other.newSha !== change.newSha) {
              conflicted = true;
              break;
            }
          }
          if (conflicted) {
            err(res, requestId, 405, 'Merge conflict');
            return true;
          }
          const title = asString(body.commit_title) || `${pull.title} (#${pull.number})`;
          const msgBody = asString(body.commit_message) || pull.body;
          const message = msgBody === '' ? title : `${title}\n\n${msgBody}`;
          const who = authorOf(store.tokenOwner);
          const mergeSha = await createCommit(repo, headTree ?? '', [baseTip], message, who.name, who.email);
          repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
          noteReachable(repo, mergeSha);
          pull.state = 'closed';
          pull.merged = true;
          pull.mergeCommitSha = mergeSha;
          pull.updated_at = nowIso();
          repo.updated_at = nowIso();
          send(res, requestId, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
          return true;
        }
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          const number = Number.parseInt(rest[1] as string, 10);
          const pull = repo.pulls.get(number);
          if (pull === undefined) {
            err(res, requestId, 404, 'Not Found');
            return true;
          }
          const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
          const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
          const mergeBase = await findMergeBase(repo, headTip, baseTip);
          const baseTree = mergeBase !== undefined
            ? await commitTreeSha(repo, mergeBase)
            : await commitTreeSha(repo, pull.baseSha);
          const headTree = await commitTreeSha(repo, headTip);
          const diff = await diffTrees(repo, baseTree, headTree);
          const files: JsonObj[] = [];
          for (const [filename, change] of diff) {
            const status = change.oldSha === null ? 'added' : change.newSha === null ? 'removed' : 'modified';
            const { additions, deletions } = lineDiff(await blobText(repo, change.oldSha), await blobText(repo, change.newSha));
            files.push({ filename, status, additions, deletions, changes: additions + deletions });
          }
          files.sort((a, b) => String(a.filename).localeCompare(String(b.filename)));
          send(res, requestId, 200, files);
          return true;
        }
        if (rest.length === 1 && method === 'GET') {
          let list = [...repo.pulls.values()];
          const state = query.get('state') ?? 'open';
          if (state === 'open' || state === 'closed') list = list.filter((p) => p.state === state);
          else if (state !== 'all') list = list.filter((p) => p.state === 'open');
          list.sort((a, b) => a.number - b.number);
          const { page, link } = paginate(list.map((p) => pullJson(store, req, repo, p)), req, query);
          send(res, requestId, 200, page, linkHeader(link));
          return true;
        }
        if (rest.length === 1 && method === 'POST') {
          const title = asString(body.title).trim();
          const head = asString(body.head);
          const base = asString(body.base);
          if (title === '' || head === '' || base === '') {
            err(res, requestId, 422, 'Validation Failed: title, head and base are required');
            return true;
          }
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (headSha === undefined || baseSha === undefined) {
            err(res, requestId, 404, 'Not Found: head or base branch does not exist');
            return true;
          }
          const number = nextSharedNumber(repo);
          const pull: PullRecord = {
            id: recordId(repo, number, true),
            number,
            title,
            body: asString(body.body),
            state: 'open',
            merged: false,
            mergeable: true,
            headRef: head,
            baseRef: base,
            headSha,
            baseSha,
            mergeCommitSha: null,
            user: { login: store.tokenOwner },
            created_at: nowIso(),
            updated_at: nowIso(),
          };
          repo.pulls.set(number, pull);
          send(res, requestId, 201, pullJson(store, req, repo, pull));
          return true;
        }
        if (rest.length === 2) {
          const number = Number.parseInt(rest[1] as string, 10);
          const pull = repo.pulls.get(number);
          if (pull === undefined) {
            err(res, requestId, 404, 'Not Found');
            return true;
          }
          if (method === 'GET') {
            send(res, requestId, 200, pullJson(store, req, repo, pull));
            return true;
          }
          if (method === 'PATCH') {
            if (typeof body.title === 'string' && body.title.trim() !== '') pull.title = body.title;
            if (typeof body.body === 'string') pull.body = body.body;
            if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) pull.state = body.state;
            pull.updated_at = nowIso();
            send(res, requestId, 200, pullJson(store, req, repo, pull));
            return true;
          }
          err(res, requestId, 404, 'Not Found');
          return true;
        }
        err(res, requestId, 404, 'Not Found');
        return true;
      }

      err(res, requestId, 404, 'Not Found');
      return true;
    }

    // Unknown route under /api/v3.
    err(res, requestId, 404, 'Not Found');
    return true;
  } catch (e) {
    // Never leak a stack or HTML: a handler bug is still a JSON 500.
    err(res, requestId, 500, e instanceof Error ? e.message : 'Internal Server Error');
    return true;
  }
}
