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

Result (2026-11-19, fresh server, round 4): **120/120 checks pass** — git 30/30,
repos 15/15, issues 15/15, pulls 20/20, protocol 5/5, GraphQL 20/20,
MCP 15/15. Local wall-clock perf on a shared VM is noisy (sibling jobs
move it ±40%), so the stable measures are server CPU per run and
alternating A/B medians against the round-3 code: round 4 wins 3/3 rounds
on both (p50 median 413,867 µs vs 466,612 µs, −11%; server CPU median
1,720 ms vs 2,440 ms, −30%). Quiet-run local score: perf 154–156,
p50 ~375–381k µs. Production p50 for round 3 was 703,866 µs (rank 7,518);
round 4's server-CPU cut is the lever to move it, though the ~305k µs
top-Go figure is out of Node's reach (best Node entry ever: ~390k µs).

Round 5 (2026-11-19, same kit, fresh leaderboard: round 4 sits at rank 535,
score 942, perf 142, production p50 445,378 µs): **120/120 checks pass**
again on every run. The VM was heavily loaded by parallel Round-3 work
during this round, so local wall-clock p50s (556k–922k µs) are not
comparable to round 4's quiet-window 413,867 µs; the stable measure is
server CPU per request from interleaved A/B micro-benchmarks (raw-socket
client, `/proc` CPU, r5/r4/r5/r4): read 41–47 µs/req vs 50–57 µs/req
(−17%), push ~742 vs ~783 µs/op (flat, within noise), clone ~600–800 µs
(flat), write ~115–160 vs ~150 µs (inconclusive). Full suite+perf server
CPU is flat too (median 1.92 s vs 1.90 s) because the read workload is a
small share of it and push/clone did not move. Expected production gain:
a few perf points (read is ~1 of 4 workloads and was already near its
local ceiling), score ~944–948, rank ~510–530 — still far from the Go
top (305k µs, score 970). This round is a Node fallback: real but small.

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
  repeated reads are Map lookups plus a write — and the cached value is
  now the response bytes themselves (no re-stringify, no byte-length
  scan). The comment count has a no-allocation fast path when there are
  no comments anywhere.
- **Transport** (`src/transport.ts`, round 4): a raw `node:net` HTTP/1.1
  server replaces `node:http` — one `socket.write` per response, the
  request path/query parsed once (handlers used to pay for `new URL`
  three times per request), `TCP_NODELAY` set explicitly, idle sockets
  closed after 30 s. Request ids are a process-unique hex counter, not
  `randomBytes`/`randomUUID` per reply. The v2 capability advertisement
  is one shared Buffer (every clone asks for it three times) and the v0
  advertisement is cached per ref-set fingerprint. Server CPU per
  full suite+perf run fell ~30% vs the `node:http` build.
- **Round 5 transport + REST**: `FastRes.end` builds the header as one
  string and one `Buffer.from`, then writes head+body through
  `socket.cork()/uncork()` — the body is never `Buffer.concat`'d (a
  clone's 88 KiB pack used to be memcpy'd per clone). `FastRes.sendPrebuilt`
  sends a cached GET-issue reply as three prebuilt buffers (head, per-request
  id line, tail per keep-alive case) with no `writeHead`, no per-header
  `Buffer.from`, no concat. `readBody` (REST and git) takes the transport's
  already-buffered body via `bodyOf` instead of async-iterating it, and
  path segments skip `decodeURIComponent` unless they contain `%`.
- **Lifecycle** (`main.ts`): the transport owns the idle-socket timeout
  and the malformed-request 400; SIGTERM drops idle sockets first, then
  closes the server and exits 0.
