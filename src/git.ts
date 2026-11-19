// Git core for the github-core-clone-01 forge: object model, tree/commit
// helpers, ancestry, and the git smart-HTTP surface (upload-pack v2 + v0,
// receive-pack v0). Node.js stdlib only, no git binary, no network.
//
// The wire behaviour here mirrors what the suite's client
// (kit program/env/src/git-client.ts) sends and parses:
//  - info/refs answers v2 when Git-Protocol: version=2 is present on
//    git-upload-pack, v0 otherwise; receive-pack is always v0.
//  - v0 advertisements open with "# service=..." + flush; v2 opens with
//    "version 2". Empty repos advertise the zero-id capabilities^{} line.
//  - Packs are plain objects only (no deltas), zlib-deflated, with a SHA-1
//    trailer; fetch responses are side-band-64k framed.
//  - receive-pack applies only fast-forward updates (or creates/deletes)
//    and reports per-ref ok/ng lines under report-status.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GitObject, RepoRecord } from './types.ts';
import { pathnameOf, searchParamsOf } from './transport.ts';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

const ZERO_OID = '0'.repeat(40);
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const HEX40 = /^[0-9a-f]{40}$/;
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const AGENT = 'makefun-git/1.0';
/** Largest side-band payload chunk: a pkt-line holds 65520 bytes incl. header. */
const SIDEBAND_CHUNK = 32768;

// ---------------------------------------------------------------------------------------------
// object model
// ---------------------------------------------------------------------------------------------

export function sha1Object(type: string, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function storeObject(repo: RepoRecord, type: 'blob' | 'tree' | 'commit' | 'tag', data: Buffer): string {
  const sha = sha1Object(type, data);
  repo.objects.set(sha, { type, data });
  return sha;
}

export function getObject(repo: RepoRecord, sha: string): GitObject | undefined {
  return repo.objects.get(sha);
}

export function parseTree(data: Buffer): Array<{ mode: string; name: string; sha: string }> {
  const entries: Array<{ mode: string; name: string; sha: string }> = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      sha: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function isDirMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** git's tree sort: byte order of the name, a directory compared as name + '/'. */
function compareTreeEntries(
  a: { mode: string; name: string },
  b: { mode: string; name: string },
): number {
  const left = Buffer.from(isDirMode(a.mode) ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(isDirMode(b.mode) ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(
  repo: RepoRecord,
  entries: Array<{ mode: string; name: string; sha: string }>,
): string {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return storeObject(repo, 'tree', Buffer.concat(parts));
}

export function parseCommit(data: Buffer): {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
} {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function createCommit(
  repo: RepoRecord,
  treeSha: string,
  parents: string[],
  message: string,
  authorName: string,
  authorEmail: string,
): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const who = `${authorName} <${authorEmail}> ${timestamp} +0000`;
  const lines = [`tree ${treeSha}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const body = message.endsWith('\n') ? message : `${message}\n`;
  return storeObject(repo, 'commit', Buffer.from(`${lines.join('\n')}\n${body}`, 'utf8'));
}

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/**
 * Recursive worker: returns the new tree sha, or null when the subtree
 * became empty (so the caller drops the directory entry, as git does).
 */
function updateInTree(
  repo: RepoRecord,
  baseTreeSha: string | null,
  parts: string[],
  blobSha: string | null,
  mode: string | undefined,
): string | null {
  let entries: TreeEntry[] = [];
  if (baseTreeSha !== null) {
    const base = getObject(repo, baseTreeSha);
    if (base && base.type === 'tree') entries = parseTree(base.data);
  }
  const name = parts[0];
  const idx = entries.findIndex((entry) => entry.name === name);
  if (parts.length === 1) {
    if (blobSha === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else {
      const entryMode = mode ?? (idx >= 0 ? entries[idx].mode : '100644');
      const entry: TreeEntry = { mode: entryMode, name, sha: blobSha };
      if (idx >= 0) entries[idx] = entry;
      else entries.push(entry);
    }
  } else {
    const childSha = idx >= 0 && isDirMode(entries[idx].mode) ? entries[idx].sha : null;
    const next = updateInTree(repo, childSha, parts.slice(1), blobSha, mode);
    if (next === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else {
      const entry: TreeEntry = { mode: '40000', name, sha: next };
      if (idx >= 0) entries[idx] = entry;
      else entries.push(entry);
    }
  }
  if (entries.length === 0) return null;
  return buildTree(repo, entries);
}

export function updatePathInTree(
  repo: RepoRecord,
  baseTreeSha: string | null,
  parts: string[],
  blobSha: string | null,
  mode?: string,
): string {
  if (parts.length === 0) {
    if (baseTreeSha !== null) return baseTreeSha;
    return buildTree(repo, []);
  }
  const next = updateInTree(repo, baseTreeSha, parts, blobSha, mode);
  if (next !== null) return next;
  return buildTree(repo, []);
}

export function getPathEntry(
  repo: RepoRecord,
  commitSha: string,
  path: string,
): { sha: string; data: Buffer; mode: string; type: string } | undefined {
  const commitObj = getObject(repo, commitSha);
  if (!commitObj || commitObj.type !== 'commit') return undefined;
  const { tree } = parseCommit(commitObj.data);
  const segments = path.split('/').filter((segment) => segment.length > 0);
  let curSha = tree;
  let curMode = '40000';
  let curObj = getObject(repo, curSha);
  if (segments.length === 0) {
    if (!curObj) return undefined;
    return { sha: curSha, data: curObj.data, mode: '40000', type: 'tree' };
  }
  for (let i = 0; i < segments.length; i += 1) {
    if (!curObj || curObj.type !== 'tree') return undefined;
    const entry = parseTree(curObj.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return undefined;
    curSha = entry.sha;
    curMode = entry.mode;
    curObj = getObject(repo, curSha);
    if (i === segments.length - 1) {
      if (!curObj) {
        // A gitlink names a commit this repo does not hold.
        if (curMode === '160000') return { sha: curSha, data: Buffer.alloc(0), mode: curMode, type: 'commit' };
        return undefined;
      }
      return { sha: curSha, data: curObj.data, mode: curMode, type: curObj.type };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// ancestry
// ---------------------------------------------------------------------------------------------

function commitParents(repo: RepoRecord, sha: string): string[] | null {
  const meta = commitMeta(repo, sha);
  return meta === null ? null : meta.parents;
}

/** Parsed commit header (tree + parents), cached per repo: the push path
 * walks ancestry on every update, and re-parsing the same commit buffers
 * each time made it quadratic in history length. */
const commitMetaCache = new WeakMap<RepoRecord, Map<string, { tree: string; parents: string[] }>>();

function commitMeta(repo: RepoRecord, sha: string): { tree: string; parents: string[] } | null {
  let perRepo = commitMetaCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map<string, { tree: string; parents: string[] }>();
    commitMetaCache.set(repo, perRepo);
  }
  const cached = perRepo.get(sha);
  if (cached !== undefined) return cached;
  const obj = getObject(repo, sha);
  if (!obj || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  const meta = { tree: parsed.tree, parents: parsed.parents };
  perRepo.set(sha, meta);
  return meta;
}

/**
 * Commits known reachable from a ref, per repo. Objects are never removed
 * from a repo, and a commit only enters this set once its ancestry has been
 * verified present (receive-pack) or built complete (REST), so stopping a
 * completeness walk here is sound: everything below it is already in the
 * repo. A missing entry just means the walk goes further, never a wrong
 * answer, so REST paths that forget to note a ref stay correct (only
 * slower).
 */
const reachableCache = new WeakMap<RepoRecord, Set<string>>();

function reachableSet(repo: RepoRecord): Set<string> {
  let set = reachableCache.get(repo);
  if (set === undefined) {
    set = new Set<string>();
    reachableCache.set(repo, set);
  }
  return set;
}

/** Record that `oid` (and its ancestors, up to already-known ones) is reachable from a ref. */
export function noteReachable(repo: RepoRecord, oid: string): void {
  const set = reachableSet(repo);
  const stack: string[] = [oid];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (set.has(cur)) continue;
    const obj = getObject(repo, cur);
    if (!obj) continue;
    if (obj.type === 'commit') {
      set.add(cur);
      const parents = commitParents(repo, cur);
      if (parents === null) continue;
      for (const parent of parents) stack.push(parent);
    } else if (obj.type === 'tag') {
      stack.push(peelTag(repo, cur));
    }
  }
}

/**
 * Is every commit reachable from `oid` present in the repo (tags peeled)?
 * Same acceptance as collectReachable(..., allowMissing=false) for the push
 * path — a missing commit rejects — but it walks cached parent lists and
 * stops at commits already known reachable, instead of re-parsing every
 * commit and tree on each push, so a push stays O(new history) instead of
 * O(whole history). Trees are not re-checked: the original walk tolerated
 * a missing tree object too.
 */
function isComplete(repo: RepoRecord, oid: string): boolean {
  const known = reachableSet(repo);
  const seen = new Set<string>();
  const stack: string[] = [oid];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur) || known.has(cur)) continue;
    seen.add(cur);
    const obj = getObject(repo, cur);
    if (!obj) return false;
    if (obj.type === 'commit') {
      const parents = commitParents(repo, cur);
      if (parents === null) return false;
      for (const parent of parents) stack.push(parent);
    } else if (obj.type === 'tag') {
      stack.push(peelTag(repo, cur));
    }
  }
  return true;
}

export function findMergeBase(repo: RepoRecord, a: string, b: string): string | undefined {
  if (a === b) return getObject(repo, a)?.type === 'commit' ? a : undefined;
  const ancestorsA = new Set<string>();
  const stackA: string[] = [a];
  while (stackA.length > 0) {
    const cur = stackA.pop()!;
    if (ancestorsA.has(cur)) continue;
    const parents = commitParents(repo, cur);
    if (parents === null) continue;
    ancestorsA.add(cur);
    for (const parent of parents) stackA.push(parent);
  }
  // BFS from b: the first common commit is the merge base closest to b.
  const seenB = new Set<string>();
  const queue: string[] = [b];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seenB.has(cur)) continue;
    seenB.add(cur);
    if (ancestorsA.has(cur)) return cur;
    const parents = commitParents(repo, cur);
    if (parents === null) continue;
    for (const parent of parents) queue.push(parent);
  }
  return undefined;
}

export function isAncestor(repo: RepoRecord, anc: string, desc: string): boolean {
  if (anc === desc) return getObject(repo, desc)?.type === 'commit';
  const seen = new Set<string>();
  const stack: string[] = [desc];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === anc) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const parents = commitParents(repo, cur);
    if (parents === null) continue;
    for (const parent of parents) stack.push(parent);
  }
  return false;
}

export function listCommits(repo: RepoRecord, tipSha: string, limit?: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = tipSha;
  while (cur !== undefined) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const parents = commitParents(repo, cur);
    if (parents === null) break;
    out.push(cur);
    if (limit !== undefined && out.length >= limit) break;
    cur = parents[0];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

type DecodedPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Decode pkt-lines from the start of `buf`. Returns the packets and the
 * offset just past the last complete packet (trailing bytes, e.g. a raw
 * packfile after the flush, start there). Throws on malformed framing.
 * With `stopAtFlush`, decoding stops right after the first flush packet,
 * so trailing raw bytes are left untouched.
 */
function decodePktLines(
  buf: Buffer,
  options: { stopAtFlush?: boolean } = {},
): { packets: DecodedPacket[]; consumed: number } {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    }
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (options.stopAtFlush) return { packets, consumed: offset };
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  if (offset !== buf.length) throw new Error('truncated pkt-line header');
  return { packets, consumed: offset };
}

/** Data-packet payloads as lines, control packets dropped. */
function packetLines(packets: readonly DecodedPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/** Peel an annotated tag (recursively) to its target object id. */
function peelTag(repo: RepoRecord, oid: string): string {
  let cur = oid;
  for (;;) {
    const obj = getObject(repo, cur);
    if (!obj || obj.type !== 'tag') return cur;
    const blank = obj.data.indexOf('\n\n');
    const headerEnd = blank < 0 ? obj.data.length : blank;
    let target = '';
    for (const line of obj.data.subarray(0, headerEnd).toString('utf8').split('\n')) {
      if (line.startsWith('object ')) target = line.slice(7);
    }
    if (!HEX40.test(target)) return cur;
    cur = target;
  }
}

/** Add a tree and everything under it (skipping gitlinks) to `out`. */
function addTreeClosure(repo: RepoRecord, treeSha: string, out: Set<string>): void {
  const stack: string[] = [treeSha];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (out.has(cur)) continue;
    const obj = getObject(repo, cur);
    if (!obj || obj.type !== 'tree') continue;
    out.add(cur);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '160000') continue;
      if (isDirMode(entry.mode)) stack.push(entry.sha);
      else out.add(entry.sha);
    }
  }
}

/**
 * Every object reachable from `roots` (commit -> tree + parents, tag ->
 * target, tree -> entries). Unknown roots are skipped when `allowMissing`.
 */
function collectReachable(repo: RepoRecord, roots: Iterable<string>, allowMissing: boolean): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (!obj) {
      if (allowMissing) continue;
      throw new Error(`object ${oid} is missing`);
    }
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      addTreeClosure(repo, commit.tree, seen);
      for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tag') {
      stack.push(peelTag(repo, oid));
    } else if (obj.type === 'tree') {
      addTreeClosure(repo, oid, seen);
    }
  }
  return seen;
}

/**
 * Reachable from `roots`, but never following the parents of a commit in
 * `cutoff` (the client's shallow boundaries: the client holds the boundary
 * commit itself, not its ancestors).
 */
function collectReachableCutoff(repo: RepoRecord, roots: Iterable<string>, cutoff: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      addTreeClosure(repo, commit.tree, seen);
      if (!cutoff.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (obj.type === 'tag') {
      stack.push(peelTag(repo, oid));
    } else if (obj.type === 'tree') {
      addTreeClosure(repo, oid, seen);
    }
  }
  return seen;
}

interface DepthWalk {
  objects: Set<string>;
  /** Included commits and their distance from a want (want = 1). */
  commits: Map<string, number>;
  /** Commits at exactly maxDepth that still have parents: the new boundary. */
  boundary: string[];
}

/** Depth-limited walk from `roots`: a commit at distance d is kept iff d <= maxDepth. */
function collectDepthLimited(repo: RepoRecord, roots: Iterable<string>, maxDepth: number): DepthWalk {
  const objects = new Set<string>();
  const commits = new Map<string, number>();
  const boundary: string[] = [];
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const root of roots) {
    const obj = getObject(repo, root);
    if (!obj) continue;
    if (obj.type === 'tag') {
      objects.add(root);
      const target = peelTag(repo, root);
      const targetObj = getObject(repo, target);
      if (targetObj?.type === 'commit') queue.push({ oid: target, depth: 1 });
      else if (targetObj?.type === 'tree') addTreeClosure(repo, target, objects);
      else if (targetObj) objects.add(target);
    } else if (obj.type === 'commit') {
      queue.push({ oid: root, depth: 1 });
    } else if (obj.type === 'tree') {
      addTreeClosure(repo, root, objects);
    } else {
      objects.add(root);
    }
  }
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    if (commits.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    commits.set(oid, depth);
    objects.add(oid);
    const commit = parseCommit(obj.data);
    addTreeClosure(repo, commit.tree, objects);
    if (depth < maxDepth) {
      for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
    } else if (commit.parents.length > 0) {
      boundary.push(oid);
    }
  }
  return { objects, commits, boundary };
}

interface FetchPlan {
  /** Object ids to send. */
  send: Set<string>;
  shallow: string[];
  unshallow: string[];
}

function planFetch(
  repo: RepoRecord,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
): FetchPlan {
  let wantedObjects: Set<string>;
  let wantedCommits: Map<string, number>;
  let boundary: string[] = [];
  if (depth !== null) {
    const walk = collectDepthLimited(repo, wants, depth);
    wantedObjects = walk.objects;
    wantedCommits = walk.commits;
    boundary = walk.boundary;
  } else {
    wantedObjects = collectReachable(repo, wants, true);
    wantedCommits = new Map<string, number>();
    for (const oid of wantedObjects) {
      if (getObject(repo, oid)?.type === 'commit') wantedCommits.set(oid, 0);
    }
  }
  const cutoff = new Set(clientShallow);
  const held = collectReachableCutoff(repo, haves, cutoff);
  const send = new Set<string>();
  for (const oid of wantedObjects) {
    if (!held.has(oid)) send.add(oid);
  }
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (boundary.includes(oid)) continue;
    if (!wantedCommits.has(oid)) continue;
    const parents = commitParents(repo, oid);
    if (parents !== null && parents.some((parent) => wantedCommits.has(parent))) unshallow.push(oid);
  }
  return { send, shallow: boundary, unshallow };
}

// ---------------------------------------------------------------------------------------------
// packfile write / read (plain objects, no deltas on write; deltas resolved on read)
// ---------------------------------------------------------------------------------------------

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function buildPack(repo: RepoRecord, oids: Iterable<string>): Buffer {
  const list = [...oids].sort();
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const oid of list) {
    const obj = getObject(repo, oid);
    if (!obj) continue;
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Frame a pack in side-band-64k packets (band 1), then a flush. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function readVarintSize(buf: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buf.length) throw new Error('pack entry has no size header');
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new Error('pack entry size varint is truncated');
    byte = buf[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buf.length) throw new Error('ofs-delta has no base offset');
  let byte = buf[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new Error('ofs-delta base offset is truncated');
    byte = buf[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA (thin-pack
 * bases come from `resolveBase`, i.e. objects the repo already holds).
 * Verifies the trailer checksum and every inflated size.
 */
function readPack(pack: Buffer, resolveBase: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolved = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = resolved.get(entry.offset);
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor on the server`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = sha1Object(type, data);
    const out = { type, data, oid };
    resolved.set(entry.offset, out);
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const item = resolve(entry);
    if (!objects.has(item.oid)) objects.set(item.oid, { type: item.type, data: item.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': String(body.length) });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  sendBuffer(res, status, 'application/json', Buffer.from(JSON.stringify(body), 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// ref advertisement
// ---------------------------------------------------------------------------------------------

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** Sorted refs (heads then tags), with peeled targets for annotated tags. */
function listRefs(repo: RepoRecord): RefLine[] {
  const names = [...repo.refs.keys()].sort();
  const out: RefLine[] = [];
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: RefLine = { oid, name };
    const obj = getObject(repo, oid);
    if (name.startsWith('refs/tags/') && obj?.type === 'tag') {
      const target = peelTag(repo, oid);
      if (target !== oid && getObject(repo, target)?.type !== 'tag') entry.peeled = target;
    }
    out.push(entry);
  }
  return out;
}

function v0Advertisement(repo: RepoRecord, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  // Fingerprint cache: the ad is fully determined by the ref set (oids are
  // content hashes, so a ref's peeled target is fixed once its object is
  // present, and objects never change). Every push advertises first, so
  // this turns the advertisement into a Map lookup plus a short string
  // join instead of rebuilding pkt-lines on every push.
  const names = [...repo.refs.keys()].sort();
  let fp = service;
  for (const name of names) fp += `\0${name}=${repo.refs.get(name)}`;
  const cached = v0AdCache.get(repo);
  if (cached !== undefined && cached.fp === fp) return cached.buf;
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:refs/heads/main`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get('refs/heads/main') ?? ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  const buf = Buffer.concat(parts);
  v0AdCache.set(repo, { fp, buf });
  return buf;
}

/** Fingerprinted v0 advertisements, per repo (see v0Advertisement). */
const v0AdCache = new WeakMap<RepoRecord, { fp: string; buf: Buffer }>();

/** The v2 capability advertisement never changes: build it once, share it.
 * Every clone asks for it three times (advertisement, ls-refs, fetch). */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine(`agent=${AGENT}\n`),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow filter\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

// ---------------------------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------------------------

function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoRecord | undefined,
  service: string | null,
): boolean {
  if (!repo) {
    sendJson(res, 404, { message: 'repository not found' });
    return true;
  }
  if (service === 'git-upload-pack') {
    const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (wantsV2) {
      sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
    } else {
      sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', v0Advertisement(repo, 'git-upload-pack'));
    }
    return true;
  }
  if (service === 'git-receive-pack') {
    sendBuffer(res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack'));
    return true;
  }
  sendJson(res, 400, { message: `unknown service ${String(service)}` });
  return true;
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2: ls-refs
// ---------------------------------------------------------------------------------------------

function handleLsRefsV2(repo: RepoRecord, argLines: string[]): Buffer {
  const args = argLines.map((line) => line.replace(/\n$/, ''));
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes: string[] = [];
  for (const line of args) {
    if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const refs = listRefs(repo);
  const mainOid = repo.refs.get('refs/heads/main');
  if (refs.length === 0) {
    // Unborn HEAD. `unborn` is only emitted when the client asked for it or
    // when there is nothing else to list; the client parses it either way.
    if (keep('HEAD')) {
      parts.push(
        pktLine(
          symrefs
            ? 'unborn HEAD symref-target:refs/heads/main\n'
            : 'unborn HEAD\n',
        ),
      );
    }
  } else {
    if (mainOid && keep('HEAD')) {
      parts.push(
        pktLine(symrefs ? `${mainOid} HEAD symref-target:refs/heads/main\n` : `${mainOid} HEAD\n`),
      );
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack: fetch (v2 and v0)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0];
      if (HEX40.test(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).split(' ')[0];
      if (HEX40.test(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).split(' ')[0];
      if (HEX40.test(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, done, deepen-since,
    // deepen-not, agent, object-format: accepted and ignored.
  }
  return { wants, haves, shallow, depth };
}

function handleFetchV2(repo: RepoRecord, args: FetchArgs): Buffer {
  const cacheKey = fetchCacheKey(2, args);
  const cached = fetchCacheGet(repo, cacheKey);
  if (cached !== undefined) return cached;
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = buildPack(repo, plan.send);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  parts.push(PKT_DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  const out = Buffer.concat(parts);
  if (args.wants.every((want) => getObject(repo, want) !== undefined)) fetchCacheSet(repo, cacheKey, out);
  return out;
}

function handleFetchV0(repo: RepoRecord, args: FetchArgs): Buffer {
  const cacheKey = fetchCacheKey(0, args);
  const cached = fetchCacheGet(repo, cacheKey);
  if (cached !== undefined) return cached;
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = buildPack(repo, plan.send);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  const out = Buffer.concat(parts);
  if (args.wants.every((want) => getObject(repo, want) !== undefined)) fetchCacheSet(repo, cacheKey, out);
  return out;
}

/**
 * Fetch-response cache, per repo. A fetch's bytes are fully determined by
 * (protocol version, wants, haves, shallow boundaries, depth) plus objects
 * that never change content, so a cached response stays correct without
 * invalidation — with one guard: a fetch is only cached when every want
 * was present, so a fetch that answered "missing object" (empty pack) can
 * never shadow the object arriving later. Bounded; clears when full.
 */
const fetchResponseCache = new WeakMap<RepoRecord, Map<string, Buffer>>();
const FETCH_CACHE_MAX = 128;

function fetchCacheKey(version: 0 | 2, args: FetchArgs): string {
  return `${version}|${args.wants.join(',')}|${args.haves.join(',')}|${args.shallow.join(',')}|${args.depth ?? ''}`;
}

function fetchCacheGet(repo: RepoRecord, key: string): Buffer | undefined {
  return fetchResponseCache.get(repo)?.get(key);
}

function fetchCacheSet(repo: RepoRecord, key: string, value: Buffer): void {
  let perRepo = fetchResponseCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map<string, Buffer>();
    fetchResponseCache.set(repo, perRepo);
  }
  if (perRepo.size >= FETCH_CACHE_MAX) perRepo.clear();
  perRepo.set(key, value);
}

async function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoRecord,
): Promise<void> {
  const body = await readBody(req);
  let decoded: { packets: DecodedPacket[]; consumed: number };
  try {
    decoded = decodePktLines(body);
  } catch {
    sendJson(res, 400, { message: 'malformed pkt-line stream' });
    return;
  }
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (isV2) {
    const lines = packetLines(decoded.packets);
    const commandLine = lines[0] ?? '';
    if (!commandLine.startsWith('command=')) {
      sendJson(res, 400, { message: 'missing command' });
      return;
    }
    const command = commandLine.slice('command='.length).replace(/\n$/, '');
    const delimIndex = decoded.packets.findIndex((packet) => packet.kind === 'delim');
    const argPackets =
      delimIndex >= 0 ? decoded.packets.slice(delimIndex + 1) : decoded.packets.slice(1);
    const argLines = packetLines(argPackets);
    if (command === 'ls-refs') {
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', handleLsRefsV2(repo, argLines));
      return;
    }
    if (command === 'fetch') {
      const args = parseFetchArgs(argLines);
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', handleFetchV2(repo, args));
      return;
    }
    sendJson(res, 400, { message: `unknown command ${command}` });
    return;
  }
  // v0: wants (+shallow/deepen), flush, haves, done, flush.
  const lines = packetLines(decoded.packets);
  const args = parseFetchArgs(lines);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', handleFetchV0(repo, args));
}

// ---------------------------------------------------------------------------------------------
// receive-pack v0
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(lines: string[]): { commands: PushCommand[]; capabilities: string[] } {
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  lines.forEach((raw, index) => {
    const line = raw.replace(/\n$/, '');
    if (!line) return;
    let rest = line;
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line
          .slice(nul + 1)
          .split(' ')
          .map((token) => token.trim())
          .filter((token) => token.length > 0);
        rest = line.slice(0, nul);
      }
    }
    const parts = rest.split(' ');
    if (parts.length < 3) throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!HEX40.test(oldOid) || !HEX40.test(newOid) || !ref.startsWith('refs/')) {
      throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
    }
    commands.push({ oldOid, newOid, ref });
  });
  return { commands, capabilities };
}

function pushReport(
  unpackOk: boolean,
  unpackDetail: string,
  results: Array<{ ref: string; ok: boolean; reason: string }>,
  sideband: boolean,
): Buffer {
  const inner: Buffer[] = [pktLine(`unpack ${unpackDetail}\n`)];
  for (const result of results) {
    inner.push(
      result.ok
        ? pktLine(`ok ${result.ref}\n`)
        : pktLine(`ng ${result.ref} ${result.reason}\n`),
    );
  }
  inner.push(PKT_FLUSH);
  const innerBuf = Buffer.concat(inner);
  if (!sideband) return innerBuf;
  const parts: Buffer[] = [];
  for (let offset = 0; offset < innerBuf.length; offset += SIDEBAND_CHUNK) {
    const chunk = innerBuf.subarray(offset, Math.min(innerBuf.length, offset + SIDEBAND_CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoRecord,
): Promise<void> {
  const body = await readBody(req);
  let commands: PushCommand[];
  let capabilities: string[];
  let packOffset: number;
  try {
    const decoded = decodePktLines(body, { stopAtFlush: true });
    const flushIndex = decoded.packets.findIndex((packet) => packet.kind === 'flush');
    if (flushIndex < 0) throw new Error('push command list has no flush');
    const parsed = parsePushCommands(packetLines(decoded.packets.slice(0, flushIndex)));
    commands = parsed.commands;
    capabilities = parsed.capabilities;
    packOffset = decoded.consumed;
    if (commands.length === 0) throw new Error('push needs at least one command');
  } catch (err) {
    sendJson(res, 400, { message: (err as Error).message });
    return;
  }
  const sideband = capabilities.includes('side-band-64k');
  const packBytes = body.subarray(packOffset);
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => getObject(repo, oid));
      for (const [oid, obj] of objects) repo.objects.set(oid, obj);
    } catch (err) {
      unpackDetail = 'unpacker error';
      void err;
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (unpackDetail !== 'ok') {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === undefined) {
      // Create.
      if (command.oldOid !== ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (!isComplete(repo, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'missing object' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      noteReachable(repo, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // Update.
    if (command.oldOid === ZERO_OID) {
      results.push({ ref: command.ref, ok: false, reason: 'already exists' });
    } else if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
    } else if (command.newOid === current) {
      results.push({ ref: command.ref, ok: true, reason: '' });
    } else {
      let complete = isComplete(repo, command.newOid);
      if (!complete) {
        results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      } else if (command.ref.startsWith('refs/heads/') && !isAncestor(repo, current, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        noteReachable(repo, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
    }
  }
  const report = pushReport(unpackDetail === 'ok', unpackDetail, results, sideband);
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', report);
}

// ---------------------------------------------------------------------------------------------
// entry point: the caller routes only /{owner}/{repo}.git/* paths here.
// ---------------------------------------------------------------------------------------------

export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoRecord,
): Promise<boolean> {
  // The transport already parsed the path and query: no `new URL` here.
  let pathname = pathnameOf(req);
  if (pathname === undefined) {
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return false;
    }
  }
  try {
    if (pathname.endsWith('/info/refs')) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { message: 'method not allowed' });
        return true;
      }
      const service =
        searchParamsOf(req)?.get('service') ??
        (() => {
          try {
            return new URL(req.url ?? '/', 'http://localhost').searchParams.get('service');
          } catch {
            return null;
          }
        })();
      return handleInfoRefs(req, res, repo, service);
    }
    if (pathname.endsWith('/git-upload-pack')) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { message: 'method not allowed' });
        return true;
      }
      if (!repo) {
        sendJson(res, 404, { message: 'repository not found' });
        return true;
      }
      await handleUploadPack(req, res, repo);
      return true;
    }
    if (pathname.endsWith('/git-receive-pack')) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { message: 'method not allowed' });
        return true;
      }
      if (!repo) {
        sendJson(res, 404, { message: 'repository not found' });
        return true;
      }
      await handleReceivePack(req, res, repo);
      return true;
    }
    return false;
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, { message: (err as Error).message });
    } else {
      try {
        res.end();
      } catch {
        // The response is already half-written; nothing more to do.
      }
    }
    return true;
  }
}
