// Named after the built-in web fetch's error codes, which the model already knows.
export type ErrorCode =
  | "INVALID_URL"
  | "URL_NOT_ALLOWED"
  | "URL_NOT_ACCESSIBLE"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "INTERNAL_ERROR";

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
