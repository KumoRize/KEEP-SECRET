export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Authentication required') => new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Forbidden') => new AppError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found') => new AppError(404, 'not_found', msg);
export const conflict = (msg: string) => new AppError(409, 'conflict', msg);
export const insufficientCredits = (needed: number, available: number) =>
  new AppError(402, 'insufficient_credits', 'Not enough credits', { needed, available });
export const limitExceeded = (msg: string, details?: unknown) => new AppError(429, 'limit_exceeded', msg, details);
