// Raw node:net HTTP/1.1 transport for the github-core-clone-01 forge.
//
// Why this exists: node:http's per-request machinery (IncomingMessage,
// header parsing in JS, ServerResponse, writeHead + end as separate
// operations) costs tens of microseconds per request, and the suite's four
// timed workloads are thousands of small sequential requests plus 50-way
// concurrent clones. The clients (undici fetch, git smart-HTTP) only ever
// send origin-form HTTP/1.1 requests with Content-Length bodies, keep-alive,
// and no chunked encoding, so a small purpose-built parser is enough — and
// it lets each response go out as ONE socket.write of ONE prebuilt Buffer.
//
// Contract with the handlers (rest.ts, git.ts, graphql.ts, mcp.ts):
//   - They see a FastReq that quacks like the IncomingMessage subset they
//     use: method, url, headers (lowercase keys), on('data'/'end'/'error'),
//     and async iteration for the body. The full body is already buffered
//     when the handler runs; bodyOf(req) returns it without any iteration.
//   - They see a FastRes that quacks like the ServerResponse subset they
//     use: writeHead(status, headers), end(data?), headersSent. The real
//     bytes (status line, headers, body) are assembled once, in end(), and
//     written in a single socket.write. Content-Length is always recomputed
//     from the actual body, so a stale header can never truncate a reply.
//   - Requests on one socket are answered strictly in order, one at a
//     time (the clients never pipeline, and this keeps ordering trivially
//     correct). Different sockets run concurrently, as Node always does.
//   - A socket that stays idle IDLE_TIMEOUT_MS is destroyed, matching the
//     old http server's keepAliveTimeout. TCP_NODELAY is set explicitly:
//     the read workload reuses one keep-alive socket for 2,000 ping-pong
//     requests, and Nagle + delayed ACK would stall exactly that pattern.

import { createServer, type Server, type Socket } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Idle keep-alive sockets are closed after this long without traffic. */
export const IDLE_TIMEOUT_MS = 30_000;
/** A request head bigger than this without a terminator is malformed. */
const MAX_HEAD_BYTES = 32 * 1024;
/** Largest single body the transport will buffer (handlers cap at 10 MiB). */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Content Too Large',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

// ---------------------------------------------------------------------------
// request ids: unique hex per response, without crypto per request.
// ---------------------------------------------------------------------------

/** Counter-based request ids. randomBytes(8) per REST/GraphQL reply showed
 * up in the CPU profile (randomFillSync); a process-unique counter seeded
 * from one random draw is unique, hex, and non-empty, which is all the
 * suite's protocol check asserts (nonEmpty). */
let nextId = Math.floor(Math.random() * 2 ** 40) + 1;

export function nextRequestId(): string {
  const id = nextId;
  nextId += 1;
  return id.toString(16).padStart(16, '0');
}

// ---------------------------------------------------------------------------
// request / response facades
// ---------------------------------------------------------------------------

export type HeaderMap = Record<string, string | undefined>;

type Listener = (...args: never[]) => void;

/**
 * One parsed HTTP request. The body is complete before the handler runs.
 * `pathname` / `searchParams` are parsed once here so no handler pays for
 * `new URL(req.url)` again (app.ts, rest.ts, git.ts, graphql.ts and mcp.ts
 * each parsed it before).
 */
export class FastReq {
  readonly method: string;
  readonly url: string;
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
  readonly headers: HeaderMap;
  readonly body: Buffer;
  readonly keepAlive: boolean;
  private dataListeners: Array<(chunk: Buffer) => void> = [];
  private endListeners: Array<() => void> = [];
  private delivered = false;

  constructor(
    method: string,
    url: string,
    pathname: string,
    searchParams: URLSearchParams,
    headers: HeaderMap,
    body: Buffer,
    keepAlive: boolean,
  ) {
    this.method = method;
    this.url = url;
    this.pathname = pathname;
    this.searchParams = searchParams;
    this.headers = headers;
    this.body = body;
    this.keepAlive = keepAlive;
  }

  /** 'data' / 'end' / 'error' listeners, as graphql.ts and mcp.ts use them.
   * The body is already in hand, so delivery is scheduled once, after the
   * caller's synchronous registration block has run. */
  on(event: string, fn: (...args: never[]) => void): this {
    if (event === 'data') this.dataListeners.push(fn as (chunk: Buffer) => void);
    else if (event === 'end') this.endListeners.push(fn as () => void);
    // 'error' never fires: the transport owns socket errors, not the request.
    if (!this.delivered) {
      this.delivered = true;
      queueMicrotask(() => {
        if (this.body.length > 0) {
          for (const listener of this.dataListeners) listener(this.body);
        }
        for (const listener of this.endListeners) listener();
      });
    }
    return this;
  }

  /** Async iteration over the body, as git.ts / rest.ts readBody uses it:
   * the whole body as a single chunk (or nothing for an empty body). */
  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    let done = this.body.length === 0;
    const body = this.body;
    return {
      next(): Promise<IteratorResult<Buffer>> {
        if (done) return Promise.resolve({ done: true, value: undefined });
        done = true;
        return Promise.resolve({ done: false, value: body });
      },
    };
  }
}

/** The body a handler can read synchronously, when the transport supplied it. */
export function bodyOf(req: IncomingMessage): Buffer | undefined {
  const candidate = (req as unknown as { body?: unknown }).body;
  return candidate instanceof Buffer ? candidate : undefined;
}

/** The pre-parsed pathname, when the transport supplied it. */
export function pathnameOf(req: IncomingMessage): string | undefined {
  const candidate = (req as unknown as { pathname?: unknown }).pathname;
  return typeof candidate === 'string' ? candidate : undefined;
}

/** The pre-parsed query, when the transport supplied it. */
export function searchParamsOf(req: IncomingMessage): URLSearchParams | undefined {
  const candidate = (req as unknown as { searchParams?: unknown }).searchParams;
  return candidate instanceof URLSearchParams ? candidate : undefined;
}

export class FastRes {
  headersSent = false;
  statusCode = 200;
  private status = 200;
  private headers: Record<string, string | string[]> = {};
  private ended = false;
  private readonly socket: Socket;
  private readonly keepAlive: boolean;
  private readonly onDone: () => void;

  constructor(socket: Socket, keepAlive: boolean, onDone: () => void) {
    this.socket = socket;
    this.keepAlive = keepAlive;
    this.onDone = onDone;
  }

  writeHead(status: number, headers?: Record<string, string | string[]>): this {
    this.status = status;
    this.statusCode = status;
    if (headers !== undefined) this.headers = headers;
    this.headersSent = true;
    return this;
  }

  /**
   * Write the reply as a batched set of buffers in one writev. The socket
   * is corked first, so the parts leave in a single syscall and the body is
   * never copied into one big Buffer (a clone's 88 KiB pack used to be
   * memcpy'd on every one of the 50 concurrent clones).
   */
  private flush(parts: Buffer[]): void {
    try {
      this.socket.cork();
      for (const part of parts) {
        if (part.length > 0) this.socket.write(part);
      }
      this.socket.uncork();
    } catch {
      // The socket is already gone; nothing left to do for this request.
      try {
        this.socket.uncork();
      } catch {
        // Already gone.
      }
    }
    if (!this.keepAlive) {
      try {
        this.socket.destroy();
      } catch {
        // Already closed.
      }
    }
    this.onDone();
  }

  /**
   * Send a response whose head and tail are prebuilt buffers and only the
   * request-id line varies per request (the read workload's 2,000 GETs of
   * one cached issue). `tailAlive` / `tailClose` are the same tail with the
   * connection line filled in for each keep-alive case; the transport
   * picks by the socket it owns. Skips writeHead, the per-header
   * Buffer.from calls and the Buffer.concat of end() entirely.
   */
  sendPrebuilt(head: Buffer, idLine: Buffer, tailAlive: Buffer, tailClose: Buffer): void {
    if (this.ended) return;
    this.ended = true;
    this.headersSent = true;
    this.status = 200;
    this.statusCode = 200;
    this.flush([head, idLine, this.keepAlive ? tailAlive : tailClose]);
  }

  end(data?: Buffer | string): void {
    if (this.ended) return;
    this.ended = true;
    const body =
      data === undefined
        ? Buffer.alloc(0)
        : typeof data === 'string'
          ? Buffer.from(data, 'utf8')
          : data;
    // One header string, one Buffer.from: the old code built a Buffer per
    // header line plus a Buffer.concat over everything (copying the body).
    let head = `HTTP/1.1 ${this.status} ${REASONS[this.status] ?? ''}\r\n`;
    for (const [name, value] of Object.entries(this.headers)) {
      // Content-Length is always recomputed from the real body below; a
      // stale declared length must never truncate or pad a reply.
      if (name.toLowerCase() === 'content-length') continue;
      head += `${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`;
    }
    // No body framing for 204/304; every other reply carries an exact
    // Content-Length, so no chunked encoding is ever needed.
    if (this.status !== 204 && this.status !== 304) {
      head += `content-length: ${body.length}\r\n`;
    }
    head += this.keepAlive ? 'connection: keep-alive\r\n\r\n' : 'connection: close\r\n\r\n';
    const headBuf = Buffer.from(head, 'ascii');
    this.flush(body.length > 0 ? [headBuf, body] : [headBuf]);
  }
}

// ---------------------------------------------------------------------------
// HTTP/1.1 parsing
// ---------------------------------------------------------------------------

interface ParsedHead {
  method: string;
  target: string;
  headers: HeaderMap;
  headLength: number;
  keepAlive: boolean;
  expectContinue: boolean;
}

const CRLFCRLF = Buffer.from('\r\n\r\n', 'ascii');

/** Parse the request head at the start of `buf`, or null when incomplete.
 * Throws on a malformed head. */
function parseHead(buf: Buffer): ParsedHead | null {
  const end = buf.indexOf(CRLFCRLF);
  if (end < 0) {
    if (buf.length > MAX_HEAD_BYTES) throw new Error('request head too large');
    return null;
  }
  const head = buf.subarray(0, end).toString('ascii');
  const lines = head.split('\r\n');
  const requestLine = lines[0] ?? '';
  const firstSpace = requestLine.indexOf(' ');
  const secondSpace = firstSpace < 0 ? -1 : requestLine.indexOf(' ', firstSpace + 1);
  if (firstSpace <= 0 || secondSpace <= firstSpace + 1) {
    throw new Error('malformed request line');
  }
  const method = requestLine.slice(0, firstSpace);
  const target = requestLine.slice(firstSpace + 1, secondSpace);
  const version = requestLine.slice(secondSpace + 1);
  if (!version.startsWith('HTTP/')) throw new Error('malformed HTTP version');
  const headers: HeaderMap = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Error('malformed header line');
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const previous = headers[name];
    headers[name] = previous === undefined ? value : `${previous}, ${value}`;
  }
  const connection = (headers.connection ?? '').toLowerCase();
  const keepAlive =
    version === 'HTTP/1.1' ? connection !== 'close' : connection === 'keep-alive';
  return {
    method,
    target,
    headers,
    headLength: end + 4,
    keepAlive,
    expectContinue: (headers.expect ?? '').toLowerCase() === '100-continue',
  };
}

/** Split a request target into its raw path and query string (no URL
 * object: this is the hot path, and the clients only send origin-form
 * targets). */
function splitTarget(target: string): { pathname: string; search: string } {
  const queryIndex = target.indexOf('?');
  if (queryIndex < 0) return { pathname: target === '' ? '/' : target, search: '' };
  return {
    pathname: queryIndex === 0 ? '/' : target.slice(0, queryIndex),
    search: target.slice(queryIndex + 1),
  };
}

type ParseResult =
  | { kind: 'need-more' }
  | { kind: 'request'; req: FastReq; consumed: number }
  | { kind: 'continue' };

/**
 * Try to parse one complete request from the front of `buf`. Returns
 * 'need-more' when more bytes are needed, 'continue' when a 100-continue
 * was answered and parsing should resume, or the request plus how many
 * bytes it consumed. Throws on malformed framing.
 */
function tryParseOne(buf: Buffer, socket: Socket): ParseResult {
  const head = parseHead(buf);
  if (head === null) return { kind: 'need-more' };
  const bodyStart = head.headLength;
  const transferEncoding = (head.headers['transfer-encoding'] ?? '').toLowerCase();
  const chunked = transferEncoding.includes('chunked');
  if (chunked) {
    const body = parseChunkedBody(buf, bodyStart);
    if (body === null) {
      if (head.expectContinue) socket.write('HTTP/1.1 100 Continue\r\n\r\n');
      return { kind: 'need-more' };
    }
    return { kind: 'request', req: buildReq(head, body.bytes), consumed: body.consumed };
  }
  const lengthRaw = head.headers['content-length'];
  let length = 0;
  if (lengthRaw !== undefined) {
    length = Number.parseInt(lengthRaw, 10);
    if (!Number.isFinite(length) || length < 0 || length > MAX_BODY_BYTES) {
      throw new Error('bad content-length');
    }
  }
  if (buf.length < bodyStart + length) {
    if (head.expectContinue) {
      socket.write('HTTP/1.1 100 Continue\r\n\r\n');
      return { kind: 'continue' };
    }
    return { kind: 'need-more' };
  }
  const body = length === 0 ? Buffer.alloc(0) : buf.subarray(bodyStart, bodyStart + length);
  return {
    kind: 'request',
    req: buildReq(head, Buffer.from(body)),
    consumed: bodyStart + length,
  };
}

/** Parse a chunked body starting at `start`; null when incomplete. */
function parseChunkedBody(
  buf: Buffer,
  start: number,
): { bytes: Buffer; consumed: number } | null {
  const chunks: Buffer[] = [];
  let offset = start;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', offset);
    if (lineEnd < 0) return null;
    const sizeText = buf.subarray(offset, lineEnd).toString('ascii').split(';')[0]?.trim() ?? '';
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) throw new Error('bad chunk size');
    offset = lineEnd + 2;
    if (size === 0) {
      // Terminal chunk: optional trailer lines, then a final empty line.
      for (;;) {
        const trailerEnd = buf.indexOf('\r\n', offset);
        if (trailerEnd < 0) return null;
        if (trailerEnd === offset) return { bytes: Buffer.concat(chunks), consumed: trailerEnd + 2 };
        offset = trailerEnd + 2;
      }
    }
    if (offset + size + 2 > buf.length) return null;
    chunks.push(Buffer.from(buf.subarray(offset, offset + size)));
    offset += size + 2;
  }
}

function buildReq(head: ParsedHead, body: Buffer): FastReq {
  const { pathname, search } = splitTarget(head.target);
  return new FastReq(
    head.method,
    head.target,
    pathname,
    // Most requests carry no query string (reads, writes, pushes, fetches):
    // share one empty instance instead of allocating a parser per request.
    search === '' ? EMPTY_QUERY : new URLSearchParams(search),
    head.headers,
    body,
    head.keepAlive,
  );
}

/** Shared empty query: handlers only read it (query.get), never mutate it. */
const EMPTY_QUERY = new URLSearchParams();

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

export type TransportHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

interface SocketState {
  socket: Socket;
  buf: Buffer;
  queue: FastReq[];
  busy: boolean;
  destroyed: boolean;
}

/**
 * Create the raw HTTP/1.1 server. `handler` answers one request; it is
 * always awaited before the next request on the same socket is handled.
 * The returned server is a plain net.Server (listen/close/address/on),
 * so main.ts keeps working unchanged apart from dropping the http-only
 * keepAliveTimeout/clientError setup.
 */
export function createTransportServer(handler: TransportHandler): Server {
  const server = createServer((socket: Socket) => {
    socket.setNoDelay(true);
    const state: SocketState = {
      socket,
      buf: Buffer.alloc(0),
      queue: [],
      busy: false,
      destroyed: false,
    };
    const armIdleTimer = (): void => {
      // One call is enough: the socket timeout fires after this long of
      // *inactivity*, and Node re-arms it on traffic by itself.
      socket.setTimeout(IDLE_TIMEOUT_MS);
    };
    armIdleTimer();
    socket.on('timeout', () => {
      try {
        socket.destroy();
      } catch {
        // Already gone.
      }
    });
    socket.on('error', () => {
      state.destroyed = true;
      try {
        socket.destroy();
      } catch {
        // Already gone.
      }
    });
    socket.on('close', () => {
      state.destroyed = true;
      state.queue.length = 0;
    });

    const pump = (): void => {
      if (state.busy || state.destroyed) return;
      const req = state.queue.shift();
      if (req === undefined) return;
      state.busy = true;
      const res = new FastRes(socket, req.keepAlive, () => {
        state.busy = false;
        if (!state.destroyed) pump();
      });
      let result: void | Promise<void>;
      try {
        result = handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      } catch {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(Buffer.from('{"message":"Internal Server Error"}\n', 'utf8'));
        } else {
          try {
            res.end();
          } catch {
            // Socket already gone.
          }
        }
        return;
      }
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {
          if (!res.headersSent) {
            try {
              res.writeHead(500, { 'content-type': 'application/json' });
              res.end(Buffer.from('{"message":"Internal Server Error"}\n', 'utf8'));
            } catch {
              // Socket already gone.
            }
          } else {
            try {
              res.end();
            } catch {
              // Socket already gone.
            }
          }
        });
      }
    };

    socket.on('data', (chunk: Buffer) => {
      if (state.destroyed) return;
      state.buf = state.buf.length === 0 ? chunk : Buffer.concat([state.buf, chunk]);
      for (;;) {
        let parsed: ParseResult;
        try {
          parsed = tryParseOne(state.buf, socket);
        } catch {
          // Malformed framing: answer 400 and drop the socket, exactly as
          // the old http server's clientError handler did.
          try {
            socket.end(
              Buffer.from('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n', 'ascii'),
            );
          } catch {
            try {
              socket.destroy();
            } catch {
              // Already gone.
            }
          }
          state.destroyed = true;
          return;
        }
        if (parsed.kind === 'need-more') break;
        if (parsed.kind === 'continue') continue;
        state.buf = state.buf.subarray(parsed.consumed);
        state.queue.push(parsed.req);
        if (state.buf.length === 0) break;
      }
      pump();
    });
  });
  return server;
}
