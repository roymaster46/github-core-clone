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

Result (2026-11-18, fresh server): **120/120 checks pass** — git 30/30,
repos 15/15, issues 15/15, pulls 20/20, protocol 5/5, GraphQL 20/20,
MCP 15/15. Score **978/1000** (feature 600, agent 200, perf 178:
push 43, clone 40, read 48, write 47; perf_p50_us 269343).
