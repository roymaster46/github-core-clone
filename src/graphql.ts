// GraphQL v4 endpoint (POST /api/graphql) for the github-core-clone-01 forge.
// Hand-rolled executor for the documents gh and github-mcp-server send —
// NOT a general GraphQL engine. Shared helpers (issue/PR creation, squash
// merge, REST-shaped objects) are exported for mcp.ts to reuse so both
// surfaces act on the same store with the same semantics.
//
// NUMBERING CONTRACT (agreed with REST, see report): issues and pull
// requests share ONE sequence per repo, repo.issueSeq, starting at 1.
// A PR takes its number from repo.issueSeq and also bumps repo.pullSeq.
// Do not change this without aligning rest.ts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { nextRequestId, pathnameOf } from './transport.ts';
import type { IssueRecord, PullRecord, RepoRecord, Store } from './types.ts';
import { fromGlobalId, toGlobalId } from './types.ts';
import { displayOwner, resolveRepo } from './store.ts';
import { noteReachable } from './git.ts';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function sha1GitObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
}

/** Numeric repo id: the sequential id store.ts assigns ((repo as any).id),
 * falling back to a stable hash when a store never assigned one. This is
 * the same value REST returns as `id` / `databaseId`. */
export function repoDatabaseId(repo: RepoRecord): number {
  const raw = (repo as unknown as Record<string, unknown>).id;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  const key = `${repo.owner}/${repo.name}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 2147483646) + 1;
}

/** REST's record-id scheme: repoId * 2M + (1M for PRs) + number. */
export function recordIdFor(repo: RepoRecord, number: number, isPull: boolean): number {
  return repoDatabaseId(repo) * 2_000_000 + (isPull ? 1_000_000 : 0) + number;
}

export function repoGlobalId(repo: RepoRecord): string {
  return toGlobalId('Repository', String(repoDatabaseId(repo)));
}
export function issueGlobalId(repo: RepoRecord, issue: IssueRecord): string {
  return toGlobalId('Issue', String(issue.id));
}
export function pullGlobalId(repo: RepoRecord, pull: PullRecord): string {
  return toGlobalId('PullRequest', String(pull.id));
}

function repoUrl(repo: RepoRecord): string {
  return `https://github.com/${repo.owner}/${repo.name}`;
}

function authed(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return false;
  const presented = (match[1] ?? '').trim();
  if (presented === '') return false;
  if (token !== undefined && token !== '') return presented === token;
  return true; // token unset: accept any non-empty Bearer (local dev)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) {
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': requestId,
  });
  res.end(text);
}

// ---------------------------------------------------------------------------
// Git object helpers (implemented directly on repo.objects; no git.ts import,
// so this module works even before git.ts lands)
// ---------------------------------------------------------------------------

export function commitTreeSha(repo: RepoRecord, commitSha: string): string | null {
  const obj = repo.objects.get(commitSha);
  if (!obj || obj.type !== 'commit') return null;
  const text = obj.data.toString('utf8');
  const m = /^tree ([0-9a-f]{40})/m.exec(text);
  return m ? (m[1] as string) : null;
}

function createCommitObject(repo: RepoRecord, treeSha: string, parents: string[], actor: string, message: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const who = `${actor} <${actor}@users.noreply.github.com> ${ts} +0000`;
  const lines = [`tree ${treeSha}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '', message, '');
  const data = Buffer.from(lines.join('\n'), 'utf8');
  const sha = sha1GitObject('commit', data);
  repo.objects.set(sha, { type: 'commit', data });
  return sha;
}

/** Flatten a tree object to path -> blob sha. */
export function flattenTree(repo: RepoRecord, treeSha: string, prefix: string, out: Map<string, string>): void {
  const obj = repo.objects.get(treeSha);
  if (!obj || obj.type !== 'tree') return;
  const buf = obj.data;
  let off = 0;
  while (off < buf.length) {
    const sp = buf.indexOf(0x20, off);
    if (sp < 0) break;
    const mode = buf.toString('utf8', off, sp);
    const nul = buf.indexOf(0, sp + 1);
    if (nul < 0) break;
    const name = buf.toString('utf8', sp + 1, nul);
    const sha = buf.subarray(nul + 1, nul + 21).toString('hex');
    off = nul + 21;
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (mode === '40000') flattenTree(repo, sha, path, out);
    else out.set(path, sha);
  }
}

export function pullChangedFiles(repo: RepoRecord, pull: PullRecord): string[] {
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTree = baseSha ? commitTreeSha(repo, baseSha) : null;
  const headTree = headSha ? commitTreeSha(repo, headSha) : null;
  const base = new Map<string, string>();
  const head = new Map<string, string>();
  if (baseTree) flattenTree(repo, baseTree, '', base);
  if (headTree) flattenTree(repo, headTree, '', head);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const changed: string[] = [];
  for (const p of paths) {
    if (base.get(p) !== head.get(p)) changed.push(p);
  }
  return changed.sort();
}

// ---------------------------------------------------------------------------
// Shared record creation / merge (used by GraphQL mutations and MCP tools)
// ---------------------------------------------------------------------------

export function createIssueRecord(store: Store, repo: RepoRecord, title: string, body: string, actor: string): IssueRecord {
  const number = repo.issueSeq + 1;
  repo.issueSeq = number;
  const ts = nowIso();
  const issue: IssueRecord = {
    id: recordIdFor(repo, number, false),
    number,
    title,
    body: body ?? '',
    state: 'open',
    labels: [],
    user: { login: actor },
    created_at: ts,
    updated_at: ts,
  };
  repo.issues.set(number, issue);
  void store;
  return issue;
}

export function createPullRecord(
  repo: RepoRecord,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
  actor: string,
): PullRecord | null {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  if (!headSha) return null;
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? '';
  const number = repo.issueSeq + 1;
  repo.issueSeq = number;
  repo.pullSeq = repo.issueSeq;
  const ts = nowIso();
  const pull: PullRecord = {
    id: recordIdFor(repo, number, true),
    number,
    title,
    body: body ?? '',
    state: 'open',
    merged: false,
    mergeable: true,
    headRef,
    baseRef,
    headSha,
    baseSha,
    mergeCommitSha: null,
    user: { login: actor },
    created_at: ts,
    updated_at: ts,
  };
  repo.pulls.set(number, pull);
  return pull;
}

/** Squash merge: commit on the base branch, tree = head tip tree, parents = [base tip]. */
export function squashMergePull(repo: RepoRecord, pull: PullRecord, actor: string): { sha: string } | { error: string } {
  if (pull.merged) return { error: 'pull request is already merged' };
  if (pull.state !== 'open') return { error: 'pull request is closed' };
  const baseRef = `refs/heads/${pull.baseRef}`;
  const headRef = `refs/heads/${pull.headRef}`;
  const baseSha = repo.refs.get(baseRef);
  const headSha = repo.refs.get(headRef);
  if (!baseSha || !headSha) return { error: 'missing branch tip' };
  const headTree = commitTreeSha(repo, headSha);
  if (!headTree) return { error: 'missing head tree' };
  const sha = createCommitObject(repo, headTree, [baseSha], actor, `${pull.title} (#${pull.number})`);
  repo.refs.set(baseRef, sha);
  noteReachable(repo, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeCommitSha = sha;
  pull.updated_at = nowIso();
  return { sha };
}

// ---------------------------------------------------------------------------
// Comments (GraphQL addComment). Stored on the repo record itself so the
// REST sibling (same in-memory object) can read them if it looks at
// (repo as any).__graphqlComments: Map<number, {id, body, created_at}[]>.
// ---------------------------------------------------------------------------

type CommentEntry = { id: string; body: string; created_at: string };
const commentStore = new WeakMap<RepoRecord, Map<number, CommentEntry[]>>();
/** Bumped on every comment add (REST or GraphQL): the REST issue-JSON cache keys on it. */
const commentVersions = new WeakMap<RepoRecord, Map<number, number>>();

export function commentVersionOf(repo: RepoRecord, issueNumber: number): number {
  return commentVersions.get(repo)?.get(issueNumber) ?? 0;
}

export function addCommentRecord(repo: RepoRecord, issueNumber: number, body: string): CommentEntry {
  let perRepo = commentStore.get(repo);
  if (!perRepo) {
    perRepo = new Map();
    commentStore.set(repo, perRepo);
    (repo as unknown as Record<string, unknown>).__graphqlComments = perRepo;
  }
  const list = perRepo.get(issueNumber) ?? [];
  const entry: CommentEntry = {
    id: toGlobalId('IssueComment', `${repo.owner}/${repo.name}/${issueNumber}/${list.length + 1}`),
    body,
    created_at: nowIso(),
  };
  list.push(entry);
  perRepo.set(issueNumber, list);
  let versions = commentVersions.get(repo);
  if (versions === undefined) {
    versions = new Map();
    commentVersions.set(repo, versions);
  }
  versions.set(issueNumber, (versions.get(issueNumber) ?? 0) + 1);
  return entry;
}

export function commentsFor(repo: RepoRecord, issueNumber: number): CommentEntry[] {
  return commentStore.get(repo)?.get(issueNumber) ?? [];
}

// ---------------------------------------------------------------------------
// REST-shaped objects (for MCP tool results)
// ---------------------------------------------------------------------------

export function restRepoObject(store: Store, repo: RepoRecord): Record<string, unknown> {
  const owner = displayOwner(store, repo);
  return {
    id: repoDatabaseId(repo),
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, type: 'User' },
    private: false,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: repoUrl(repo),
    url: repoUrl(repo),
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    has_issues: true,
  };
}

export function restIssueObject(repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: issue.user.login },
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    html_url: `${repoUrl(repo)}/issues/${issue.number}`,
    url: `${repoUrl(repo)}/issues/${issue.number}`,
  };
}

export function restPullObject(repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.mergeable,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: pull.user.login },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    html_url: `${repoUrl(repo)}/pull/${pull.number}`,
    url: `${repoUrl(repo)}/pull/${pull.number}`,
    merge_commit_sha: pull.mergeCommitSha,
  };
}

// ---------------------------------------------------------------------------
// Schema description (introspection)
// ---------------------------------------------------------------------------

const KNOWN_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'createdAt', 'updatedAt', 'isPrivate'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'url', 'createdAt', 'updatedAt', 'author', 'files'],
  User: ['login', 'id', 'name', 'url', 'avatarUrl'],
  Ref: ['name', 'id', 'prefix'],
  Label: ['id', 'name', 'color', 'description', 'url'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  LabelConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueCommentConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  LabelEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  SearchResultItemConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  __Type: ['kind', 'name', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['description', 'types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
};

const TYPE_KINDS: Record<string, string> = {
  Query: 'OBJECT', Mutation: 'OBJECT', Repository: 'OBJECT', Issue: 'OBJECT',
  PullRequest: 'OBJECT', User: 'OBJECT', Ref: 'OBJECT', Label: 'OBJECT',
  IssueConnection: 'OBJECT', PullRequestConnection: 'OBJECT', LabelConnection: 'OBJECT',
  IssueCommentConnection: 'OBJECT', PullRequestChangedFileConnection: 'OBJECT',
  IssueEdge: 'OBJECT', PullRequestEdge: 'OBJECT', LabelEdge: 'OBJECT',
  IssueCommentEdge: 'OBJECT', PullRequestChangedFileEdge: 'OBJECT',
  PageInfo: 'OBJECT', PullRequestChangedFile: 'OBJECT', IssueComment: 'OBJECT',
  CreateIssuePayload: 'OBJECT', CloseIssuePayload: 'OBJECT',
  CreatePullRequestPayload: 'OBJECT', MergePullRequestPayload: 'OBJECT',
  AddCommentPayload: 'OBJECT', SearchResultItemConnection: 'OBJECT',
  SearchType: 'ENUM', IssueState: 'ENUM', PullRequestState: 'ENUM',
  MergeableState: 'ENUM', OrderDirection: 'ENUM', IssueOrderField: 'ENUM',
  RepositoryPermission: 'ENUM', PullRequestMergeMethod: 'ENUM',
  __Type: 'OBJECT', __Field: 'OBJECT', __EnumValue: 'OBJECT',
  __InputValue: 'OBJECT', __Schema: 'OBJECT',
  String: 'SCALAR', Int: 'SCALAR', Boolean: 'SCALAR', ID: 'SCALAR', DateTime: 'SCALAR', URI: 'SCALAR',
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'CODE', 'DISCUSSION', 'MILESTONE', 'PACKAGE', 'PROJECT', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function typeRef(name: string): Record<string, unknown> {
  return { kind: TYPE_KINDS[name] ?? 'OBJECT', name, ofType: null };
}

function introspectionType(name: string): Record<string, unknown> | null {
  const kind = TYPE_KINDS[name];
  if (!kind) return null;
  const fields = KNOWN_FIELDS[name] ?? [];
  return {
    kind,
    name,
    description: null,
    fields: kind === 'OBJECT' || kind === 'INTERFACE'
      ? fields.map((f) => ({ name: f, description: null, args: [], type: typeRef('String'), isDeprecated: false, deprecationReason: null }))
      : null,
    enumValues: kind === 'ENUM'
      ? (ENUM_VALUES[name] ?? []).map((v) => ({ name: v, description: null, isDeprecated: false, deprecationReason: null }))
      : null,
    inputFields: null,
    interfaces: [],
    possibleTypes: null,
    specifiedByURL: null,
  };
}

// ---------------------------------------------------------------------------
// GraphQL document parser (tokenizer + recursive descent)
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

type Selection =
  | { kind: 'field'; alias: string | null; name: string; args: Record<string, ValueNode>; selections: Selection[] }
  | { kind: 'fragment'; typeCondition: string | null; selections: Selection[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name: string | null;
  varDefaults: Record<string, ValueNode>;
  selections: Selection[];
}

interface Token { kind: string; value: string }

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { tokens.push({ kind: '...', value: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(c)) { tokens.push({ kind: c, value: c }); i += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1] as string;
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else { out += src[j] as string; j += 1; }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j] as string)) j += 1;
      const raw = src.slice(i, j);
      tokens.push({ kind: raw.includes('.') || /e/i.test(raw) ? 'float' : 'int', value: raw });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    i += 1; // skip anything else
  }
  tokens.push({ kind: 'EOF', value: '' });
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }
  peek(): Token { return this.tokens[this.pos] as Token; }
  next(): Token { const t = this.tokens[this.pos] as Token; this.pos += 1; return t; }
  expect(kind: string): Token {
    const t = this.next();
    if (t.kind !== kind) throw new Error(`expected ${kind}, got ${t.kind} ${t.value}`);
    return t;
  }
  accept(kind: string): boolean {
    if (this.peek().kind === kind) { this.pos += 1; return true; }
    return false;
  }

  parseDocument(): { operations: Operation[]; fragments: Record<string, Selection[]> } {
    const operations: Operation[] = [];
    const fragments: Record<string, Selection[]> = {};
    while (this.peek().kind !== 'EOF') {
      if (this.peek().kind === 'name' && this.peek().value === 'fragment') {
        this.next();
        const name = this.expect('name').value;
        this.expect('name'); // 'on'
        this.expect('name'); // type condition (ignored, applied at spread site via stored selections)
        fragments[name] = this.parseSelectionSet();
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  parseOperation(): Operation {
    let type: Operation['type'] = 'query';
    let name: string | null = null;
    const varDefaults: Record<string, ValueNode> = {};
    const t = this.peek();
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      type = this.next().value as Operation['type'];
      if (this.peek().kind === 'name') name = this.next().value;
    }
    if (this.peek().kind === '(') {
      this.next();
      while (this.peek().kind !== ')') {
        this.expect('$');
        const vname = this.expect('name').value;
        this.expect(':');
        // skip type tokens (names, !, [, ])
        while (this.peek().kind === 'name' || this.peek().kind === '!' || this.peek().kind === '[' || this.peek().kind === ']') this.next();
        if (this.accept('=')) varDefaults[vname] = this.parseValue();
        if (this.peek().kind === 'EOF' || this.peek().kind === ')') break;
      }
      this.expect(')');
    }
    const selections = this.parseSelectionSet();
    return { type, name, varDefaults, selections };
  }

  parseSelectionSet(): Selection[] {
    this.expect('{');
    const sels: Selection[] = [];
    while (this.peek().kind !== '}') {
      if (this.peek().kind === 'EOF') throw new Error('unterminated selection set');
      sels.push(this.parseSelection());
    }
    this.expect('}');
    return sels;
  }

  parseSelection(): Selection {
    if (this.peek().kind === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const cond = this.expect('name').value;
        return { kind: 'fragment', typeCondition: cond, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        return { kind: 'spread', name: this.next().value };
      }
      return { kind: 'fragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expect('name').value;
    if (this.accept(':')) {
      alias = name;
      name = this.expect('name').value;
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek().kind === '(') {
      this.next();
      while (this.peek().kind !== ')') {
        const aname = this.expect('name').value;
        this.expect(':');
        args[aname] = this.parseValue();
        if (this.peek().kind === 'EOF') break;
      }
      this.expect(')');
    }
    const selections = this.peek().kind === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === '$') return { kind: 'variable', name: this.expect('name').value };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === '[') {
      const items: ValueNode[] = [];
      while (this.peek().kind !== ']') {
        items.push(this.parseValue());
        if (this.peek().kind === 'EOF') break;
      }
      this.expect(']');
      return { kind: 'list', items };
    }
    if (t.kind === '{') {
      const fields: Record<string, ValueNode> = {};
      while (this.peek().kind !== '}') {
        const fname = this.expect('name').value;
        this.expect(':');
        fields[fname] = this.parseValue();
        if (this.peek().kind === 'EOF') break;
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${t.kind} ${t.value}`);
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface ExecCtx {
  store: Store;
  vars: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Record<string, Selection[]>;
}

function resolveValue(node: ValueNode, ctx: ExecCtx): unknown {
  switch (node.kind) {
    case 'variable': {
      const v = ctx.vars[node.name];
      return v === undefined ? null : v;
    }
    case 'string': case 'int': case 'float': case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.items.map((i) => resolveValue(i, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = resolveValue(v, ctx);
      return out;
    }
  }
}

function resolveArgs(sel: { args: Record<string, ValueNode> }, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sel.args)) out[k] = resolveValue(v, ctx);
  return out;
}

interface Resolved { v: unknown; t?: string; nt?: string }
interface Connection {
  __connection: true;
  nodes: unknown[];
  totalCount: number;
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  nodeType: string;
}

function cursorFor(n: number): string {
  return Buffer.from(`cursor:${n}`).toString('base64');
}
function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const s = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(s);
    return m ? parseInt(m[1] as string, 10) : null;
  } catch { return null; }
}

function paginate<T extends { number: number }>(sorted: T[], args: Record<string, unknown>): Connection & { nodes: T[] } {
  // nodeType filled by caller via Object.assign
  const first = typeof args.first === 'number' ? args.first : undefined;
  const afterNum = cursorNumber(args.after);
  let start = 0;
  if (afterNum !== null) {
    const idx = sorted.findIndex((x) => x.number === afterNum);
    start = idx >= 0 ? idx + 1 : sorted.length;
  }
  const slice = first !== undefined ? sorted.slice(start, start + first) : sorted.slice(start);
  const endCursor = slice.length > 0 ? cursorFor((slice[slice.length - 1] as T).number) : null;
  const startCursor = slice.length > 0 ? cursorFor((slice[0] as T).number) : null;
  return {
    __connection: true,
    nodes: slice,
    totalCount: sorted.length,
    pageInfo: {
      hasNextPage: start + slice.length < sorted.length,
      hasPreviousPage: start > 0,
      startCursor,
      endCursor,
    },
    nodeType: '',
  };
}

function sortedIssues(repo: RepoRecord, args: Record<string, unknown>): IssueRecord[] {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    list = list.filter((i) => wanted.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const field = String(orderBy.field ?? 'CREATED_AT');
  const dir = String(orderBy.direction ?? 'ASC');
  const cmp = (a: IssueRecord, b: IssueRecord): number => {
    if (field === 'CREATED_AT' || field === 'UPDATED_AT') {
      const ta = field === 'CREATED_AT' ? a.created_at : a.updated_at;
      const tb = field === 'CREATED_AT' ? b.created_at : b.updated_at;
      if (ta !== tb) return ta < tb ? -1 : 1;
    }
    return a.number - b.number; // tie-break by number
  };
  list.sort((a, b) => (dir === 'DESC' ? -cmp(a, b) : cmp(a, b)));
  return list;
}

function sortedPulls(repo: RepoRecord, args: Record<string, unknown>): PullRecord[] {
  let list = [...repo.pulls.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    list = list.filter((p) => {
      const st = p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED';
      return wanted.has(st);
    });
  }
  list.sort((a, b) => a.number - b.number);
  return list;
}

function lookupRepoByGlobalId(store: Store, globalId: unknown): RepoRecord | undefined {
  if (typeof globalId !== 'string') return undefined;
  const parsed = fromGlobalId(globalId);
  if (parsed && parsed.type === 'Repository') {
    // Numeric id form: "Repository:<n>" (REST's node_id).
    const n = Number(parsed.id);
    if (Number.isInteger(n) && n > 0) {
      for (const repo of store.repos.values()) {
        if (repoDatabaseId(repo) === n) return repo;
      }
      return undefined;
    }
    const [owner, name] = parsed.id.split('/');
    if (owner && name) return resolveRepo(store, owner, name);
  }
  // Fallback: plain "owner/name"
  if (globalId.includes('/')) {
    const [owner, name] = globalId.split('/');
    if (owner && name) return resolveRepo(store, owner, name);
  }
  return undefined;
}

function parseNodeId(store: Store, globalId: unknown): { typename: string; value: unknown } | null {
  if (typeof globalId !== 'string') return null;
  const parsed = fromGlobalId(globalId);
  if (!parsed) return null;
  // Numeric-id form (REST's node_id): Repository:<repoId>,
  // Issue/PullRequest:<repoId*2M + (1M if PR) + number>.
  const n = Number(parsed.id);
  if (Number.isInteger(n) && n > 0) {
    if (parsed.type === 'Repository') {
      for (const repo of store.repos.values()) {
        if (repoDatabaseId(repo) === n) return { typename: 'Repository', value: repo };
      }
      return null;
    }
    if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
      const repoId = Math.floor(n / 2_000_000);
      const rem = n % 2_000_000;
      const isPull = rem >= 1_000_000;
      const number = isPull ? rem - 1_000_000 : rem;
      if ((parsed.type === 'PullRequest') !== isPull) return null;
      for (const repo of store.repos.values()) {
        if (repoDatabaseId(repo) !== repoId) continue;
        if (parsed.type === 'Issue') {
          const issue = repo.issues.get(number);
          return issue ? { typename: 'Issue', value: { __repo: repo, __issue: issue } } : null;
        }
        const pull = repo.pulls.get(number);
        return pull ? { typename: 'PullRequest', value: { __repo: repo, __pull: pull } } : null;
      }
      return null;
    }
    return null;
  }
  // Legacy "owner/repo/number" form.
  const parts = parsed.id.split('/');
  if (parsed.type === 'Repository' && parts.length === 2) {
    const repo = resolveRepo(store, parts[0] as string, parts[1] as string);
    return repo ? { typename: 'Repository', value: repo } : null;
  }
  if (parsed.type === 'Issue' && parts.length === 3) {
    const repo = resolveRepo(store, parts[0] as string, parts[1] as string);
    const issue = repo?.issues.get(Number(parts[2]));
    return issue && repo ? { typename: 'Issue', value: { __repo: repo, __issue: issue } } : null;
  }
  if (parsed.type === 'PullRequest' && parts.length === 3) {
    const repo = resolveRepo(store, parts[0] as string, parts[1] as string);
    const pull = repo?.pulls.get(Number(parts[2]));
    return pull && repo ? { typename: 'PullRequest', value: { __repo: repo, __pull: pull } } : null;
  }
  return null;
}

// Unwrap node wrappers: Issue/PullRequest values are carried as {__repo, __issue/__pull}.
function unwrapIssue(v: unknown): { repo: RepoRecord; issue: IssueRecord } | null {
  if (v && typeof v === 'object' && '__issue' in (v as Record<string, unknown>)) {
    const w = v as { __repo: RepoRecord; __issue: IssueRecord };
    return { repo: w.__repo, issue: w.__issue };
  }
  return null;
}
function unwrapPull(v: unknown): { repo: RepoRecord; pull: PullRecord } | null {
  if (v && typeof v === 'object' && '__pull' in (v as Record<string, unknown>)) {
    const w = v as { __repo: RepoRecord; __pull: PullRecord };
    return { repo: w.__repo, pull: w.__pull };
  }
  return null;
}

function issueState(issue: IssueRecord): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}
function pullState(pull: PullRecord): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function fieldValue(typeName: string, src: unknown, field: string, args: Record<string, unknown>, ctx: ExecCtx): Resolved {
  const store = ctx.store;
  const actor = store.tokenOwner;
  const s = src as Record<string, unknown>;

  switch (typeName) {
    case 'Query': {
      if (field === 'viewer') return { v: { login: actor }, t: 'User' };
      if (field === 'repository') {
        const repo = resolveRepo(store, String(args.owner ?? ''), String(args.name ?? ''));
        return { v: repo ?? null, t: 'Repository' };
      }
      if (field === 'node') {
        const found = parseNodeId(store, args.id);
        if (!found) return { v: null };
        return { v: { __typename: found.typename, __src: found.value }, t: found.typename };
      }
      if (field === 'search') {
        const q = String(args.query ?? '').toLowerCase();
        const matches: Array<{ __repo: RepoRecord; __issue: IssueRecord }> = [];
        for (const repo of store.repos.values()) {
          for (const issue of repo.issues.values()) {
            if (q === '' || issue.title.toLowerCase().includes(q) || issue.body.toLowerCase().includes(q)) {
              matches.push({ __repo: repo, __issue: issue });
            }
          }
        }
        matches.sort((a, b) => b.__issue.number - a.__issue.number);
        const first = typeof args.first === 'number' ? args.first : 10;
        const nodes = matches.slice(0, first);
        const conn: Connection = {
          __connection: true,
          nodes,
          totalCount: matches.length,
          pageInfo: { hasNextPage: matches.length > nodes.length, hasPreviousPage: false, startCursor: null, endCursor: null },
          nodeType: 'Issue',
        };
        return { v: conn, t: 'SearchResultItemConnection', nt: 'Issue' };
      }
      if (field === '__type') {
        const t = introspectionType(String(args.name ?? ''));
        return { v: t, t: '__Type' };
      }
      if (field === '__schema') {
        return { v: {}, t: '__Schema' };
      }
      break;
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = lookupRepoByGlobalId(store, input.repositoryId);
        if (!repo) {
          ctx.errors.push({ message: `createIssue: repository not found for id ${String(input.repositoryId ?? '')}` });
          return { v: { issue: null }, t: 'CreateIssuePayload' };
        }
        const issue = createIssueRecord(store, repo, String(input.title ?? ''), String(input.body ?? ''), actor);
        return { v: { issue: { __repo: repo, __issue: issue } }, t: 'CreateIssuePayload' };
      }
      if (field === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = parseNodeId(store, input.issueId);
        let done: { __repo: RepoRecord; __issue: IssueRecord } | null = null;
        if (found && found.typename === 'Issue') {
          const w = unwrapIssue(found.value);
          if (w) {
            w.issue.state = 'closed';
            w.issue.updated_at = nowIso();
            done = { __repo: w.repo, __issue: w.issue };
          }
        }
        if (!done) ctx.errors.push({ message: `closeIssue: issue not found for id ${String(input.issueId ?? '')}` });
        return { v: { issue: done }, t: 'CloseIssuePayload' };
      }
      if (field === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = lookupRepoByGlobalId(store, input.repositoryId);
        if (!repo) {
          ctx.errors.push({ message: `createPullRequest: repository not found for id ${String(input.repositoryId ?? '')}` });
          return { v: { pullRequest: null }, t: 'CreatePullRequestPayload' };
        }
        const pull = createPullRecord(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''), actor);
        if (!pull) {
          ctx.errors.push({ message: `createPullRequest: head branch ${String(input.headRefName ?? '')} does not exist` });
          return { v: { pullRequest: null }, t: 'CreatePullRequestPayload' };
        }
        return { v: { pullRequest: { __repo: repo, __pull: pull } }, t: 'CreatePullRequestPayload' };
      }
      if (field === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = parseNodeId(store, input.pullRequestId);
        let done: { __repo: RepoRecord; __pull: PullRecord } | null = null;
        if (found && found.typename === 'PullRequest') {
          const w = unwrapPull(found.value);
          if (w) {
            const res = squashMergePull(w.repo, w.pull, actor);
            if ('error' in res) ctx.errors.push({ message: `mergePullRequest: ${res.error}` });
            else done = { __repo: w.repo, __pull: w.pull };
          }
        }
        if (!done && !ctx.errors.length) ctx.errors.push({ message: `mergePullRequest: pull request not found for id ${String(input.pullRequestId ?? '')}` });
        return { v: { pullRequest: done }, t: 'MergePullRequestPayload' };
      }
      if (field === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = parseNodeId(store, input.subjectId);
        let node: { id: string; body: string; created_at: string } | null = null;
        if (found && found.typename === 'Issue') {
          const w = unwrapIssue(found.value);
          if (w) node = addCommentRecord(w.repo, w.issue.number, String(input.body ?? ''));
        }
        if (!node) {
          ctx.errors.push({ message: `addComment: subject not found for id ${String(input.subjectId ?? '')}` });
          return { v: { commentEdge: null }, t: 'AddCommentPayload' };
        }
        return { v: { commentEdge: { node } }, t: 'AddCommentPayload' };
      }
      break;
    }
    case 'Repository': {
      const repo = src as RepoRecord;
      switch (field) {
        case 'id': return { v: repoGlobalId(repo) };
        case 'databaseId': return { v: repoDatabaseId(repo) };
        case 'name': return { v: repo.name };
        case 'nameWithOwner': return { v: `${repo.owner}/${repo.name}` };
        case 'description': return { v: repo.description };
        case 'url': return { v: repoUrl(repo) };
        case 'createdAt': return { v: repo.created_at };
        case 'updatedAt': return { v: repo.updated_at };
        case 'isPrivate': return { v: false };
        case 'viewerPermission': return { v: 'ADMIN' };
        case 'hasIssuesEnabled': return { v: true };
        case 'owner': return { v: { login: displayOwner(store, repo) }, t: 'User' };
        case 'defaultBranchRef': {
          const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (!sha) return { v: null };
          return { v: { name: repo.defaultBranch, __repo: repo }, t: 'Ref' };
        }
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return { v: issue ? { __repo: repo, __issue: issue } : null, t: 'Issue' };
        }
        case 'issues': {
          const sorted = sortedIssues(repo, args);
          const conn = paginate(sorted, args);
          conn.nodeType = 'Issue';
          const wrapped = sorted.slice(0, 0); // keep type only
          void wrapped;
          return { v: { ...conn, nodes: conn.nodes.map((i) => ({ __repo: repo, __issue: i as IssueRecord })) }, t: 'IssueConnection', nt: 'Issue' };
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return { v: pull ? { __repo: repo, __pull: pull } : null, t: 'PullRequest' };
        }
        case 'pullRequests': {
          const sorted = sortedPulls(repo, args);
          const conn = paginate(sorted, args);
          conn.nodeType = 'PullRequest';
          return { v: { ...conn, nodes: conn.nodes.map((p) => ({ __repo: repo, __pull: p as PullRecord })) }, t: 'PullRequestConnection', nt: 'PullRequest' };
        }
      }
      break;
    }
    case 'Issue': {
      const w = unwrapIssue(src);
      if (!w) return { v: null };
      const { repo, issue } = w;
      switch (field) {
        case 'id': return { v: issueGlobalId(repo, issue) };
        case 'number': return { v: issue.number };
        case 'title': return { v: issue.title };
        case 'state': return { v: issueState(issue) };
        case 'body': return { v: issue.body };
        case 'url': return { v: `${repoUrl(repo)}/issues/${issue.number}` };
        case 'createdAt': return { v: issue.created_at };
        case 'updatedAt': return { v: issue.updated_at };
        case 'author': return { v: { login: issue.user.login }, t: 'User' };
        case 'labels': {
          const nodes = issue.labels.map((name) => {
            const rec = repo.labels.get(name);
            return { name, color: rec?.color ?? 'ededed', description: rec?.description ?? '' };
          });
          const conn: Connection = {
            __connection: true, nodes, totalCount: nodes.length,
            pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
            nodeType: 'Label',
          };
          return { v: conn, t: 'LabelConnection', nt: 'Label' };
        }
        case 'comments': {
          const list = commentsFor(repo, issue.number);
          const conn: Connection = {
            __connection: true, nodes: list, totalCount: list.length,
            pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
            nodeType: 'IssueComment',
          };
          return { v: conn, t: 'IssueCommentConnection', nt: 'IssueComment' };
        }
      }
      break;
    }
    case 'PullRequest': {
      const w = unwrapPull(src);
      if (!w) return { v: null };
      const { repo, pull } = w;
      switch (field) {
        case 'id': return { v: pullGlobalId(repo, pull) };
        case 'number': return { v: pull.number };
        case 'title': return { v: pull.title };
        case 'body': return { v: pull.body };
        case 'state': return { v: pullState(pull) };
        case 'merged': return { v: pull.merged };
        case 'mergeable': return { v: pull.mergeable ? 'MERGEABLE' : 'CONFLICTING' };
        case 'headRefName': return { v: pull.headRef };
        case 'baseRefName': return { v: pull.baseRef };
        case 'url': return { v: `${repoUrl(repo)}/pull/${pull.number}` };
        case 'createdAt': return { v: pull.created_at };
        case 'updatedAt': return { v: pull.updated_at };
        case 'author': return { v: { login: pull.user.login }, t: 'User' };
        case 'headRef': return { v: { name: pull.headRef, __repo: repo }, t: 'Ref' };
        case 'baseRef': return { v: { name: pull.baseRef, __repo: repo }, t: 'Ref' };
        case 'files': {
          const paths = pullChangedFiles(repo, pull);
          const first = typeof args.first === 'number' ? args.first : paths.length;
          const nodes = paths.slice(0, first).map((p) => ({ path: p, additions: 0, deletions: 0, changeType: 'ADDED' }));
          const conn: Connection = {
            __connection: true, nodes, totalCount: paths.length,
            pageInfo: { hasNextPage: paths.length > nodes.length, hasPreviousPage: false, startCursor: null, endCursor: null },
            nodeType: 'PullRequestChangedFile',
          };
          return { v: conn, t: 'PullRequestChangedFileConnection', nt: 'PullRequestChangedFile' };
        }
      }
      break;
    }
    case 'User': {
      const login = String((s as Record<string, unknown>).login ?? '');
      switch (field) {
        case 'login': return { v: login };
        case 'id': return { v: toGlobalId('User', login) };
        case 'name': return { v: login };
        case 'url': return { v: `https://github.com/${login}` };
        case 'avatarUrl': return { v: `https://avatars.githubusercontent.com/${login}` };
      }
      break;
    }
    case 'Ref': {
      const name = String((s as Record<string, unknown>).name ?? '');
      const repo = (s as Record<string, unknown>).__repo as RepoRecord | undefined;
      switch (field) {
        case 'name': return { v: name };
        case 'id': return { v: repo ? toGlobalId('Ref', `${repo.owner}/${repo.name}/refs/heads/${name}`) : toGlobalId('Ref', name) };
        case 'prefix': return { v: 'refs/heads/' };
      }
      break;
    }
    case 'Label': {
      switch (field) {
        case 'id': return { v: toGlobalId('Label', String(s.name ?? '')) };
        case 'name': return { v: s.name ?? '' };
        case 'color': return { v: s.color ?? 'ededed' };
        case 'description': return { v: s.description ?? '' };
        case 'url': return { v: '' };
      }
      break;
    }
    case 'PullRequestChangedFile': {
      switch (field) {
        case 'path': return { v: s.path ?? '' };
        case 'additions': return { v: 0 };
        case 'deletions': return { v: 0 };
        case 'changeType': return { v: 'ADDED' };
      }
      break;
    }
    case 'IssueComment': {
      switch (field) {
        case 'id': return { v: s.id ?? '' };
        case 'body': return { v: s.body ?? '' };
        case 'createdAt': return { v: s.created_at ?? nowIso() };
        case 'updatedAt': return { v: s.created_at ?? nowIso() };
        case 'author': return { v: { login: actor }, t: 'User' };
      }
      break;
    }
    case 'PageInfo': {
      switch (field) {
        case 'hasNextPage': return { v: Boolean(s.hasNextPage) };
        case 'hasPreviousPage': return { v: Boolean(s.hasPreviousPage) };
        case 'startCursor': return { v: s.startCursor ?? null };
        case 'endCursor': return { v: s.endCursor ?? null };
      }
      break;
    }
    case '__Type': {
      const t = s as Record<string, unknown>;
      switch (field) {
        case 'kind': return { v: t.kind ?? null };
        case 'name': return { v: t.name ?? null };
        case 'description': return { v: t.description ?? null };
        case 'fields': {
          const list = (t.fields ?? null) as Array<Record<string, unknown>> | null;
          return { v: list, t: '__Field' };
        }
        case 'enumValues': {
          const list = (t.enumValues ?? null) as Array<Record<string, unknown>> | null;
          return { v: list, t: '__EnumValue' };
        }
        case 'inputFields': return { v: t.inputFields ?? null };
        case 'interfaces': return { v: [] };
        case 'possibleTypes': return { v: t.possibleTypes ?? null };
        case 'specifiedByURL': return { v: null };
      }
      break;
    }
    case '__Field': {
      switch (field) {
        case 'name': return { v: s.name ?? '' };
        case 'description': return { v: s.description ?? null };
        case 'args': return { v: [] };
        case 'type': return { v: s.type ?? { kind: 'SCALAR', name: 'String', ofType: null }, t: '__Type' };
        case 'isDeprecated': return { v: false };
        case 'deprecationReason': return { v: null };
      }
      break;
    }
    case '__EnumValue': {
      switch (field) {
        case 'name': return { v: s.name ?? '' };
        case 'description': return { v: s.description ?? null };
        case 'isDeprecated': return { v: false };
        case 'deprecationReason': return { v: null };
      }
      break;
    }
    case '__Schema': {
      switch (field) {
        case 'description': return { v: null };
        case 'types': {
          const types = Object.keys(TYPE_KINDS).map((n) => introspectionType(n)).filter((x): x is Record<string, unknown> => x !== null);
          return { v: types };
        }
        case 'queryType': return { v: { name: 'Query', kind: 'OBJECT' }, t: '__Type' };
        case 'mutationType': return { v: { name: 'Mutation', kind: 'OBJECT' }, t: '__Type' };
        case 'subscriptionType': return { v: null };
        case 'directives': return { v: [] };
      }
      break;
    }
    default: break;
  }

  if (typeName.endsWith('Payload')) {
    const v = s[field];
    if (v === undefined) return { v: null };
    if (typeName === 'AddCommentPayload' && field === 'commentEdge') return { v, t: 'IssueCommentEdge' };
    if (field === 'issue') return { v, t: 'Issue' };
    if (field === 'pullRequest') return { v, t: 'PullRequest' };
    if (field === 'clientMutationId') return { v: null };
    return { v };
  }
  if (typeName.endsWith('Edge')) {
    if (field === 'node') {
      const nodeType = typeName.slice(0, -'Edge'.length);
      return { v: s.node ?? null, t: nodeType };
    }
    if (field === 'cursor') return { v: s.cursor ?? null };
    return { v: null };
  }
  if (typeName.endsWith('Connection')) {
    const conn = src as unknown as Connection;
    switch (field) {
      case 'nodes': return { v: conn.nodes ?? [], t: conn.nodeType };
      case 'edges': {
        const edges = (conn.nodes ?? []).map((n, i) => ({ node: n, cursor: cursorFor(i + 1) }));
        return { v: edges, t: `${conn.nodeType}Edge` };
      }
      case 'totalCount': return { v: conn.totalCount ?? (conn.nodes ?? []).length };
      case 'pageInfo': return { v: conn.pageInfo ?? { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, t: 'PageInfo' };
    }
  }
  return { v: null };
}

function executeSelection(typeName: string, src: unknown, selections: Selection[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const known = new Set(KNOWN_FIELDS[typeName] ?? []);
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = ctx.fragments[sel.name];
      if (frag) Object.assign(out, executeSelection(typeName, src, frag, ctx));
      continue;
    }
    if (sel.kind === 'fragment') {
      if (!sel.typeCondition || sel.typeCondition === typeName) {
        Object.assign(out, executeSelection(typeName, src, sel.selections, ctx));
      } else if (src && typeof src === 'object' && (src as Record<string, unknown>).__typename === sel.typeCondition) {
        Object.assign(out, executeSelection(sel.typeCondition, (src as Record<string, unknown>).__src ?? src, sel.selections, ctx));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (!known.has(sel.name)) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    const args = resolveArgs(sel, ctx);
    const resolved = fieldValue(typeName, src, sel.name, args, ctx);
    if (sel.selections.length === 0 || resolved.v === null || resolved.v === undefined) {
      out[key] = resolved.v ?? null;
      continue;
    }
    // Recurse into sub-selections.
    const raw = resolved.v as Record<string, unknown>;
    if (raw && typeof raw === 'object' && '__connection' in raw) {
      const conn = raw as unknown as Connection;
      const nodeType = resolved.nt ?? conn.nodeType;
      const edgeType = `${nodeType}Edge`;
      if (sel.name === 'nodes') {
        out[key] = (conn.nodes ?? []).map((n) => executeSelection(nodeType, n, sel.selections, ctx));
      } else if (sel.name === 'edges') {
        out[key] = (conn.nodes ?? []).map((n, i) => executeSelection(edgeType, { node: n, cursor: cursorFor(i + 1) }, sel.selections, ctx));
      } else {
        out[key] = executeSelection(resolved.t ?? typeName, resolved.v, sel.selections, ctx);
      }
      continue;
    }
    if (Array.isArray(resolved.v)) {
      // nodes/edges lists resolved directly (fieldValue for connections returns the connection object,
      // but a field like __Type.fields returns a plain array)
      const itemType = resolved.t ?? 'String';
      out[key] = (resolved.v as unknown[]).map((item) => {
        if (item !== null && typeof item === 'object' && sel.selections.length > 0 && (KNOWN_FIELDS[itemType] ?? []).length > 0) {
          return executeSelection(itemType, item, sel.selections, ctx);
        }
        return item;
      });
      continue;
    }
    // Node wrapper (node(id:)): __typename + __src
    if (raw && typeof raw === 'object' && '__typename' in raw && '__src' in raw) {
      out[key] = executeSelection(String(raw.__typename), raw.__src, sel.selections, ctx);
      continue;
    }
    out[key] = executeSelection(resolved.t ?? typeName, resolved.v, sel.selections, ctx);
  }
  return out;
}

function executeOperation(op: Operation, vars: Record<string, unknown>, store: Store, fragments: Record<string, Selection[]>): Record<string, unknown> {
  const ctx: ExecCtx = { store, vars, errors: [], fragments };
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(rootType, {}, op.selections, ctx);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  // The transport already parsed the path: no `new URL` per request.
  let pathname = pathnameOf(req);
  if (pathname === undefined) {
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      return false;
    }
  }
  if (pathname !== '/api/graphql') return false;
  const requestId = nextRequestId();
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'method not allowed' }, requestId);
    return true;
  }
  if (!authed(req)) {
    sendJson(res, 401, { message: 'unauthorized' }, requestId);
    return true;
  }
  let text: string;
  try {
    text = await readBody(req);
  } catch {
    sendJson(res, 400, { message: 'could not read request body' }, requestId);
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    sendJson(res, 400, { message: 'malformed JSON body' }, requestId);
    return true;
  }
  const ops: Array<{ query?: unknown; variables?: unknown; operationName?: unknown }> = Array.isArray(body)
    ? (body as Array<Record<string, unknown>>)
    : [body as Record<string, unknown>];
  const results: Array<Record<string, unknown>> = [];
  for (const entry of ops) {
    const query = entry.query;
    if (typeof query !== 'string' || query.trim() === '') {
      results.push({ data: null, errors: [{ message: 'query is required' }] });
      continue;
    }
    const variables = (entry.variables ?? {}) as Record<string, unknown>;
    let parsed: { operations: Operation[]; fragments: Record<string, Selection[]> };
    try {
      parsed = new Parser(tokenize(query)).parseDocument();
    } catch (e) {
      results.push({ data: null, errors: [{ message: `syntax error: ${e instanceof Error ? e.message : String(e)}` }] });
      continue;
    }
    if (parsed.operations.length === 0) {
      results.push({ data: null, errors: [{ message: 'no operation found' }] });
      continue;
    }
    let op = parsed.operations[0] as Operation;
    if (typeof entry.operationName === 'string') {
      const named = parsed.operations.find((o) => o.name === entry.operationName);
      if (named) op = named;
    }
    const vars: Record<string, unknown> = { ...variables };
    for (const [k, v] of Object.entries(op.varDefaults)) {
      if (!(k in vars)) vars[k] = resolveValue(v, { store, vars, errors: [], fragments: parsed.fragments });
    }
    try {
      results.push(executeOperation(op, vars, store, parsed.fragments));
    } catch (e) {
      results.push({ data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] });
    }
  }
  if (Array.isArray(body)) sendJson(res, 200, results, requestId);
  else sendJson(res, 200, results[0] as Record<string, unknown>, requestId);
  return true;
}
