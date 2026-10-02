export type ErrorCode =
  | "INVALID_URL"
  | "SSRF_BLOCKED"
  | "DOMAIN_BLOCKED"
  | "SUSPICIOUS_QUERY"
  | "TIMEOUT"
  | "BLOCKED_AFTER_UNLOCKER"
  | "UNLOCKER_ERROR"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "TOO_LARGE"
  | "HTTP_ERROR";

/** An expected failure, reported to the model as `ERROR <CODE>: <message>`. */
export class FetchError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }

  toString() {
    return `ERROR ${this.code}: ${this.message}`;
  }
}
