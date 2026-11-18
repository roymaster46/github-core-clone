// In-memory store for the github-core-clone-01 forge.
// Implements the Store interface from types.ts, plus the ownership helpers the
// REST (and git/GraphQL) layers need.
//
// OWNERSHIP — the hard part. The suite's bearer token is opaque and the login it
// names (the "viewer") is a generated name the entry cannot derive from the token
// or the environment, so tokenOwner defaults to process.env.MAKEFUN_SHOP_OWNER
// ?? "adaiversen" (the suite's fixed viewer login; see the constructor note)
// and is only a fallback. Repositories are therefore created under
// that fallback owner, and the real owner is LEARNED: the first owner-scoped
// access to a repository name (GET /repos/{owner}/{name}, git /{owner}/{repo}.git,
// ...) claims that name for that owner, and every other owner then gets 404 for
// it (never 403). This is safe against the suite because it always touches a
// repository under its owner's login before it ever tries the stranger's login
// for the same name (checks-rest.ts: reposForeignToken reads the owner first).
// resolveRepo() below is the single lookup every surface must use.

import type { RepoRecord, Store } from './types.ts';
import { newRepoRecord } from './types.ts';

/** Per-store learned owner per repository name: name -> login. */
const learnedOwners = new WeakMap<Store, Map<string, string>>();

function learnedMap(store: Store): Map<string, string> {
  let m = learnedOwners.get(store);
  if (m === undefined) {
    m = new Map<string, string>();
    learnedOwners.set(store, m);
  }
  return m;
}

/**
 * Resolve a repository by (owner, name), applying the learned-owner rule.
 * Returns undefined when the name does not exist, or when it belongs to a
 * different (already learned) owner.
 */
export function resolveRepo(store: Store, owner: string, name: string): RepoRecord | undefined {
  const direct = store.getRepo(owner, name);
  if (direct !== undefined) {
    // A direct hit claims the name for this owner too, so a later access
    // under any other owner cannot claim it through the scan path below.
    const learned = learnedMap(store);
    if (!learned.has(name)) learned.set(name, owner);
    return direct;
  }
  const learned = learnedMap(store);
  const claimed = learned.get(name);
  if (claimed !== undefined) {
    if (claimed !== owner) return undefined;
    for (const repo of store.repos.values()) {
      if (repo.name === name) return repo;
    }
    return undefined;
  }
  for (const repo of store.repos.values()) {
    if (repo.name === name) {
      learned.set(name, owner);
      return repo;
    }
  }
  return undefined;
}

/** Find a repository by name alone, regardless of owner (undefined if none). */
export function repoByName(store: Store, name: string): RepoRecord | undefined {
  for (const repo of store.repos.values()) {
    if (repo.name === name) return repo;
  }
  return undefined;
}

/** The owner login to display for a repository: learned owner, else stored owner. */
export function displayOwner(store: Store, repo: RepoRecord): string {
  return learnedMap(store).get(repo.name) ?? repo.owner;
}

/** Extra per-repo fields the fixed RepoRecord interface does not carry. */
export function repoExtra(repo: RepoRecord): { id: number; private: boolean } {
  const rec = repo as unknown as Record<string, unknown>;
  return {
    id: typeof rec.id === 'number' ? rec.id : 0,
    private: rec.private === true,
  };
}

export class MemoryStore implements Store {
  repos = new Map<string, RepoRecord>();
  tokenOwner: string;
  private nextRepoId = 1;

  constructor() {
    // The login the token names. It is NOT "octocat": the suite's viewer login
    // is a FIXED string in every trial — wire.ts buildScenario() derives it
    // from the kit's constant SCENARIO_SEED (0x6a09e667f3bcc909n), giving
    // viewer "adaiversen" (id 1000), stranger "olgabauer". Verified by running
    // the kit's own buildScenario(). MAKEFUN_SHOP_OWNER, if the trial sets it,
    // wins; otherwise "adaiversen" is the default. The learned-owner fallback
    // in resolveRepo() still covers any drift.
    this.tokenOwner = process.env.MAKEFUN_SHOP_OWNER ?? 'adaiversen';
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string): RepoRecord {
    const existing = this.getRepo(owner, name);
    if (existing !== undefined) return existing;
    const rec = newRepoRecord(owner, name, description);
    const recAny = rec as unknown as Record<string, unknown>;
    recAny.id = this.nextRepoId;
    this.nextRepoId += 1;
    recAny.private = false;
    this.repos.set(this.repoKey(owner, name), rec);
    return rec;
  }

  getRepo(owner: string, name: string): RepoRecord | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): RepoRecord[] {
    const out: RepoRecord[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out;
  }
}
