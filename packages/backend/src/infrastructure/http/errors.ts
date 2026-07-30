/**
 * HTTP errors carry a status and a human-readable message, plus the original domain error
 * for the client to switch on. The panel can then render a specific message without parsing
 * prose, while a curl user still gets something readable.
 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly detail: unknown;

  constructor(statusCode: number, message: string, detail?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

export function httpError(statusCode: number, message: string, detail?: unknown): HttpError {
  return new HttpError(statusCode, message, detail);
}

export interface ErrorResponseBody {
  readonly error: {
    readonly message: string;
    readonly kind?: string;
  };
}

export function toErrorResponse(error: HttpError): ErrorResponseBody {
  const kind =
    typeof error.detail === 'object' && error.detail !== null && 'kind' in error.detail
      ? String((error.detail as { kind: unknown }).kind)
      : undefined;

  return { error: kind === undefined ? { message: error.message } : { message: error.message, kind } };
}
