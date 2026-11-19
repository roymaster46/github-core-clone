// Entry <-> env lifecycle for the github-core-clone forge.
//
// The trial env (the suite) drives everything through two endpoints, and this
// file is only the glue between the forge in ./app.ts and that env:
//
//   1. The env's origin comes from MAKEFUN_ENV_URL. With no origin there is
//      nobody to talk to, so the process fails fast with exit code 1.
//   2. The forge binds an ephemeral port (listen(0) — the kernel chooses).
//      Port 8080 is the env's own and is never bound here.
//   3. The bound port is announced with POST {origin}/register {"port": N}.
//      The env notes the caller's address plus N and dials the forge there.
//      A 409 means some other entry registered first; that is fine, this
//      process simply carries on waiting like any other.
//   4. The process then polls GET {origin}/done until it reads
//      {"done": true}. While the suite is still running the env answers
//      {"done": false} at once, so this is a poll loop, never a long-held
//      request. A failed or slow poll is retried; the process never exits
//      before the env says the trial is over.
//   5. On {"done": true} the server is closed and the process exits 0.
//      The harness then stops the env, which writes the export the scorer
//      reads.
//
// Nothing else lives here: no package import, no Node built-in, no model
// call — just createApp() from ./app.ts and the two HTTP calls above.

import { createApp } from './app.ts';

// The env origin, without trailing slashes so URL building stays clean.
const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_ORIGIN === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One register or poll request may take this long before it is abandoned.
const REQUEST_BUDGET_MS = 30_000;
// Backoff between retries: start here, double each time, never pass the cap.
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Wait before retry number `n` (0-based): exponential, capped at BACKOFF_CAP_MS. */
function backoffMs(n: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** Math.min(n, 8));
}

/**
 * Run `step` until it reports success, retrying after every failure.
 * `step` returns true when the work is done, false when it should be tried
 * again, and throws only for a fatal error that must end the process.
 * Each failed attempt waits out the backoff before the next try.
 */
async function keepTrying(step: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    if (await step()) return;
    await pause(backoffMs(attempt));
  }
}

/**
 * Announce the bound port to the env. Succeeds on HTTP 200, and also on 409
 * (another entry registered first — not ours to fix). HTTP 400/405 are
 * contract errors and abort the process; any other status, or a network
 * failure, just means the env may still be starting, so it is retried.
 */
async function announcePort(port: number): Promise<void> {
  // The payload never changes across retries: serialize it once instead
  // of rebuilding the same JSON on every attempt.
  const payload = JSON.stringify({ port });
  await keepTrying(async () => {
    try {
      const res = await fetch(`${ENV_ORIGIN}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (res.status === 200 || res.status === 409) return true;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
      return false;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
      return false;
    }
  });
}

/** Poll GET /done until the env answers {"done": true}; never return sooner. */
async function awaitFinished(): Promise<void> {
  await keepTrying(async () => {
    try {
      const res = await fetch(`${ENV_ORIGIN}/done`, {
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { done?: unknown };
      return body.done === true;
    } catch {
      // The env is not answering yet, or the poll timed out: not done.
      return false;
    }
  });
}

/** Bind the forge, announce it, then wait for the env: the whole life of the process. */
async function run(): Promise<void> {
  const server = createApp();
  // The transport is a raw node:net server: it sets TCP_NODELAY per socket
  // and closes idle keep-alive sockets after IDLE_TIMEOUT_MS itself, so
  // there is no http keepAliveTimeout or clientError handler to set here.
  // A malformed request ends its socket with a 400 instead of taking the
  // server down with it (handled inside the transport).
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  // The trial ends with SIGTERM: close the server and exit 0 instead of
  // dying on the signal (a 143 exit reads as a crash to the harness).
  // Drop idle keep-alive sockets first, so server.close() does not wait
  // out their 30 s idle timer; server.close() waits for open connections,
  // so a 5 s fallback forces the exit if a socket still holds it open.
  let stopping = false;
  process.once('SIGTERM', () => {
    if (stopping) return;
    stopping = true;
    server.closeIdleConnections();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });

  await announcePort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitFinished();
  // server.close() waits for open connections; an idle keep-alive socket
  // would hold the exit out for its whole 30 s idle timer, so force the
  // exit after 5 s, exactly as the SIGTERM path already does.
  server.closeIdleConnections();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
