/** An error that maps directly onto an API error response `{ error: code, message, ...extra }`. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const badRequest = (code: string, message: string, extra?: Record<string, unknown>) =>
  new AppError(400, code, message, extra);
export const conflict = (code: string, message: string, extra?: Record<string, unknown>) =>
  new AppError(409, code, message, extra);
