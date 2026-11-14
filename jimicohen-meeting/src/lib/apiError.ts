/** The one error type every API call throws. `status` 0 means the request never got an answer. */
export class ApiFailure extends Error {
  readonly status: number;
  /** machine-readable reason: "slot_taken", "calendar_unavailable", "invalid", "unauthorized", "network", ... */
  readonly code: string;
  /** per-field validation messages, keyed by field name (422 responses) */
  readonly fields?: Record<string, string>;

  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = code;
    this.fields = fields;
    Object.setPrototypeOf(this, ApiFailure.prototype);
  }

  /** the device is offline or the server did not respond */
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

/** Narrowing helper: `if (isApiFailure(e, 'slot_taken')) ...` */
export function isApiFailure(e: unknown, code?: string): e is ApiFailure {
  return e instanceof ApiFailure && (code === undefined || e.code === code);
}

/** A sentence that is safe to show to people, whatever was thrown. */
export function errorMessage(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (e instanceof ApiFailure && e.message) return e.message;
  return fallback;
}

export function defaultMessageForStatus(status: number): string {
  if (status === 0) return 'Could not reach the server. Check your connection and try again.';
  if (status === 401) return 'Your session has ended. Please sign in again.';
  if (status === 403) return 'You do not have access to this.';
  if (status === 404) return 'We could not find that.';
  if (status === 409) return 'That changed while you were looking at it. Please try again.';
  if (status === 413) return 'That file is too large.';
  if (status === 422) return 'Please check the details and try again.';
  if (status === 429) return 'Too many attempts. Please wait a moment and try again.';
  if (status >= 500) return 'Something went wrong on our side. Please try again in a moment.';
  return 'Something went wrong. Please try again.';
}
