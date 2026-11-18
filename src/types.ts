// Shared data model for the github-core-clone-01 forge entry.
// This file is the contract between modules. DO NOT change these interfaces;
// git.ts, store.ts, rest.ts, graphql.ts and mcp.ts all import from here.

export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer; // raw content WITHOUT the "<type> <len>\0" git header
}

export interface LabelRecord {
  name: string;
  color: string;
  description: string;
}

export interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: { login: string };
  created_at: string;
  updated_at: string;
}

export interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean;
  headRef: string; // branch name, e.g. "feature"
  baseRef: string; // branch name, e.g. "main"
  headSha: string; // tip commit of head branch at creation (updated on push)
  baseSha: string; // tip commit of base branch at creation
  mergeCommitSha: string | null;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

export interface RepoRecord {
  owner: string;
  name: string;
  description: string;
  defaultBranch: string; // "main"
  created_at: string;
  updated_at: string;
  refs: Map<string, string>; // full refname "refs/heads/main" -> commit sha
  objects: Map<string, GitObject>; // sha -> object
  labels: Map<string, LabelRecord>;
  issues: Map<number, IssueRecord>;
  pulls: Map<number, PullRecord>;
  issueSeq: number;
  pullSeq: number;
}

/** In-memory store. Implemented in store.ts, used by rest.ts, graphql.ts, mcp.ts, git.ts. */
export interface Store {
  repos: Map<string, RepoRecord>; // key `${owner}/${name}`
  tokenOwner: string; // login named by MAKEFUN_SHOP_TOKEN (default "octocat" when unset)
  createRepo(owner: string, name: string, description: string): RepoRecord;
  getRepo(owner: string, name: string): RepoRecord | undefined;
  deleteRepo(owner: string, name: string): boolean;
  listRepos(owner: string): RepoRecord[];
  repoKey(owner: string, name: string): string;
}

export function newRepoRecord(owner: string, name: string, description: string): RepoRecord {
  const now = new Date().toISOString();
  return {
    owner,
    name,
    description,
    defaultBranch: 'main',
    created_at: now,
    updated_at: now,
    refs: new Map(),
    objects: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    issueSeq: 0,
    pullSeq: 0,
  };
}

/** Node id helpers (GraphQL global ids are base64 of "Type:id"). */
export function toGlobalId(type: string, id: string | number): string {
  return Buffer.from(`${type}:${id}`).toString('base64');
}
export function fromGlobalId(gid: string): { type: string; id: string } | null {
  try {
    const s = Buffer.from(gid, 'base64').toString('utf8');
    const i = s.indexOf(':');
    if (i < 0) return null;
    return { type: s.slice(0, i), id: s.slice(i + 1) };
  } catch {
    return null;
  }
}
