/**
 * Server-Sent Events reader over native fetch, no dependencies. Parses the
 * text/event-stream wire format (event:/data:/id:/retry: fields, blank line
 * terminates an event; multiple data: lines join with "\n"). Used by --follow
 * and log-stream commands against the API's streamSSE endpoints.
 */
import { apiRaw, ApiError } from "./api-client";

export interface SSEEvent {
  /** Event name; "message" when the stream omits an `event:` field. */
  event: string;
  /** Concatenated data payload (data: lines joined by "\n"). */
  data: string;
  id?: string;
  retry?: number;
}

/** Parse an SSE byte stream into events. */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let event = "message";
  let data: string[] = [];
  let id: string | undefined;
  let retry: number | undefined;

  const flush = (): SSEEvent | null => {
    if (data.length === 0 && event === "message" && id === undefined && retry === undefined) {
      return null;
    }
    const ev: SSEEvent = { event, data: data.join("\n") };
    if (id !== undefined) ev.id = id;
    if (retry !== undefined) ev.retry = retry;
    event = "message";
    data = [];
    id = undefined;
    retry = undefined;
    return ev;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      // Split on \n; tolerate \r\n by trimming a trailing \r.
      while ((nl = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line === "") {
          const ev = flush();
          if (ev) yield ev;
          continue;
        }
        if (line.startsWith(":")) continue; // comment / keep-alive

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let val = colon === -1 ? "" : line.slice(colon + 1);
        if (val.startsWith(" ")) val = val.slice(1);

        if (field === "event") event = val;
        else if (field === "data") data.push(val);
        else if (field === "id") id = val;
        else if (field === "retry") {
          const n = Number(val);
          if (!Number.isNaN(n)) retry = n;
        }
      }
    }
    const ev = flush();
    if (ev) yield ev;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Open an authenticated SSE request and yield its events. Sends
 * Accept: text/event-stream and throws ApiError if the connection fails
 * (non-2xx) before the stream opens. `path` is relative to /api.
 */
export async function* sseRequest(
  path: string,
  options?: RequestInit,
): AsyncGenerator<SSEEvent, void, unknown> {
  const headers = new Headers(options?.headers);
  if (!headers.has("Accept")) headers.set("Accept", "text/event-stream");
  const res = await apiRaw(path, { ...options, headers });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const message = (body.error as string) || `API error: ${res.status}`;
    throw new ApiError(message, res.status, body);
  }
  if (!res.body) throw new ApiError("No response body for SSE stream", res.status, null);

  yield* parseSSE(res.body);
}
