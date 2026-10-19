/** Internal result shared by the host route dispatcher and its HTTP/desktop adapters. */
export type RouteResult =
  | { kind: 'json'; status: number; obj: unknown; headers?: Record<string, string> }
  | { kind: 'text'; status: number; body: string }
  | { kind: 'file'; file: string; contentType: string }
  /** Caller disconnected while waiting; adapters must not write a response. */
  | { kind: 'none' };

/** Parsed request passed to a domain route handler. `rest` is already URL-decoded. */
export interface RouteRequest {
  rest: string;
  method: string;
  body?: string;
  signal?: AbortSignal;
  /** Parsed once by the dispatcher for routes that inspect query parameters. */
  query?: URLSearchParams;
}

/** A domain handler returns undefined only when it does not own the requested route. */
export type RouteHandler = (request: RouteRequest) => RouteResult | undefined | Promise<RouteResult | undefined>;
