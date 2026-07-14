/**
 * Consume a deployment's build-session SSE stream (GET /deployments/:id/stream)
 * and render it to the terminal. Shared by `deploy --watch` and `logs --follow`.
 *
 * The API's session-manager emits these events (see session-manager.ts):
 *   log            {type:"log", message, level}   — terminal output
 *   progress       step metadata                  — ignored here
 *   service-status per-service compose status     — ignored here
 *   ping           keep-alive                      — ignored
 *   complete       {success, message?}
 *   cancelled      {message}
 *   end            {status}                        — terminal, closes stream
 *   error          {error}                         — session not found
 */
import { sseRequest } from "./sse";
import { isJsonMode, info, ok, err } from "./output";

export interface StreamResult {
  status?: string;
  success?: boolean;
  message?: string;
}

export async function streamDeploymentLogs(deploymentId: string): Promise<StreamResult> {
  const result: StreamResult = {};

  for await (const ev of sseRequest(`/deployments/${deploymentId}/stream`)) {
    if (ev.event === "ping") continue;

    let payload: Record<string, unknown> = {};
    try {
      payload = ev.data ? (JSON.parse(ev.data) as Record<string, unknown>) : {};
    } catch {
      // Non-JSON frames (shouldn't happen) — treat data as a raw line.
      if (ev.event === "log" && ev.data) process.stdout.write(ev.data);
      continue;
    }

    if (isJsonMode()) {
      // Machine-readable: one compact JSON object per event on stdout.
      process.stdout.write(JSON.stringify({ event: ev.event, ...payload }) + "\n");
    }

    switch (ev.event) {
      case "log": {
        // formatLogPayload already appends a trailing newline to line logs.
        const msg = String(payload.message ?? "");
        if (!isJsonMode() && msg) process.stdout.write(msg);
        break;
      }
      case "complete": {
        result.success = payload.success === true;
        result.message = typeof payload.message === "string" ? payload.message : undefined;
        if (result.success) ok(`\n✓ ${result.message ?? "Deployment ready"}`);
        else err(`\n✗ ${result.message ?? "Deployment failed"}`);
        break;
      }
      case "cancelled":
        result.status = "cancelled";
        info(`\n${(payload.message as string) ?? "Build cancelled"}`);
        break;
      case "end":
        result.status = (payload.status as string) ?? result.status;
        return result;
      case "error":
        err(`\n${(payload.error as string) ?? "Stream error"}`);
        result.success = false;
        return result;
    }
  }
  return result;
}
