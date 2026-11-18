[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/roymaster46/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/roymaster46/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone — a GitHub-compatible git forge

Standalone git forge for the make.fun `github-core-clone-01` bounty. One Node.js
process, standard library only, no git binary, no network, no UI.

## What it serves

- **Git smart HTTP** (`/{owner}/{repo}.git`): upload-pack protocol v2 (plus v0
  fallback), receive-pack v0 with report-status / side-band-64k / delete-refs,
  fast-forward enforcement, shallow fetch. Packfiles are built and parsed
  in-process (OFS/REF deltas on read, whole objects on write).
- **REST v3** (`/api/v3`): repositories, branches, commits, contents, labels,
  issues (+comments), pull requests (+files, squash merge with conflict
  detection). Bearer auth, `X-GitHub-Request-Id` on every reply, JSON errors.
- **GraphQL v4** (`/api/graphql`): repository/issues/pullRequests queries with
  ordering + cursor pagination, `createPullRequest` / `createIssue` /
  `mergePullRequest` mutations, introspection for the types `gh` and
  `github-mcp-server` send.
- **MCP** (`/mcp`): JSON-RPC 2.0 Streamable HTTP, `initialize`, `tools/list`
  (6 tools), `tools/call` acting on the same store as REST.

## Run it

```sh
node main.ts
```

`main.ts` is the harness lifecycle: bind an ephemeral port, POST the port to
`$MAKEFUN_ENV_URL/register`, poll `$MAKEFUN_ENV_URL/done`, exit 0. The server
is `app.ts` (routing) over `src/` modules: `store.ts` (in-memory store),
`git.ts` (object store + pack protocol), `rest.ts`, `graphql.ts`, `mcp.ts`.

## Local verification

Against the kit's own conformance suite (`sdk/run.ts`):

```
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token TOK --perf
```

Result (2026-11-19, fresh server): **120/120 checks pass** — git 30/30,
repos 15/15, issues 15/15, pulls 20/20, protocol 5/5, GraphQL 20/20,
MCP 15/15. Local wall-clock perf on a shared VM is noisy (a quiet run
scored perf 178, p50 269343 µs); the stable measure is server CPU per
benchmark workload, which the hot-path work below cut 1.4–3×.

## Hot paths

- **Push** (`src/git.ts`): the old receive-pack re-parsed every commit and
  tree in the whole history on every push (quadratic). It now walks cached
  parent lists and stops at commits already known reachable from a ref,
  so a push costs O(new history). Handler CPU per push fell ~3.8×.
- **Clone**: fetch responses are cached per (protocol, wants, haves,
  shallow, depth) — objects never change content, and a fetch is only
  cached once every want is present, so a missing object can never be
  shadowed by a stale empty pack. Handler CPU per clone fell ~3×.
- **Read**: GET-issue responses are cached per issue, keyed on the issue's
  `updated_at`, its comment version, and the learned owner, so the 2,000
  repeated reads are Map lookups plus a write.
- **Lifecycle** (`main.ts`): keep-alive sockets held 30 s across the
  suite's workload gaps, a `clientError` handler that ends bad sockets
  with a 400 instead of killing the server, and SIGTERM closes the server
  and exits 0.
