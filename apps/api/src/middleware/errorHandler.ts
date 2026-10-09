import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.js';
import { captureError } from '../lib/monitoring.js';

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if ((err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body too large' } });
    return;
  }
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'bad_json', message: 'Malformed JSON body' } });
    return;
  }
  captureError(err, { path: req.path, method: req.method, requestId: res.getHeader('X-Request-Id') });
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong', requestId: res.getHeader('X-Request-Id') } });
}
