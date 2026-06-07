const SSH_AUTH_ERROR_PATTERNS = [
  "All configured authentication methods failed",
];

const RETRYABLE_CONNECTION_ERROR_PATTERNS = [
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "Timed out",
  "Not connected",
  "Connection lost",
  "read ECONNRESET",
  "Handshake failed",
  "keepalive timeout",
  "SSH connection closed before ready",
  // ssh2 emits "Channel open failure: open failed" / "Channel open failure: …"
  // when the SSH SERVER refuses a new channel - typically because the cached
  // connection has gone half-dead (peer-side LOGOUT, network blip,
  // remote sshd MaxSessions). The inner SshExecutor retries `exec`/
  // `streamExec` on this, but `pipeLocal`, `transferIn`, and any other
  // channel-bearing op bubble it up. Listing it here lets `withExecutor`
  // drop the dead connection and retry transparently - fixes the
  // "first redeploy fails, second click works" pattern.
  "Channel open failure",
  "open failed",
];

export function isSshAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return SSH_AUTH_ERROR_PATTERNS.some((pattern) => err.message.includes(pattern));
}

export function isRetryableRemoteConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return RETRYABLE_CONNECTION_ERROR_PATTERNS.some((pattern) =>
    err.message.includes(pattern),
  );
}

export function isRemoteConnectionError(err: unknown): boolean {
  return isSshAuthError(err) || isRetryableRemoteConnectionError(err);
}