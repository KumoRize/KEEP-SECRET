import type { NextFunction, Request, Response } from 'express';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

interface Store {
  hit(key: string, windowSec: number): Promise<number>;
}

class MemoryStore implements Store {
  private counts = new Map<string, { n: number; resetAt: number }>();
  async hit(key: string, windowSec: number): Promise<number> {
    const now = Date.now();
    const e = this.counts.get(key);
    if (!e || e.resetAt <= now) {
      this.counts.set(key, { n: 1, resetAt: now + windowSec * 1000 });
      if (this.counts.size > 50_000) this.prune(now);
      return 1;
    }
    return ++e.n;
  }
  private prune(now: number) {
    for (const [k, v] of this.counts) if (v.resetAt <= now) this.counts.delete(k);
  }
}

class RedisStore implements Store {
  constructor(private redis: Redis) {}
  async hit(key: string, windowSec: number): Promise<number> {
    const res = await this.redis.multi().incr(key).expire(key, windowSec, 'NX').exec();
    return Number(res?.[0]?.[1] ?? 0);
  }
}

let store: Store = new MemoryStore();
if (config.REDIS_URL) {
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
  redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
  store = new RedisStore(redis);
}
const fallback = new MemoryStore();

/** Fixed-window limiter (shared across instances via Redis, per-process memory otherwise). */
export function rateLimit(opts: { name: string; limit: number; windowSec: number; key?: (req: Request) => string }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const id = opts.key?.(req) ?? req.user?.id ?? req.ip ?? 'unknown';
    const key = `rl:${opts.name}:${id}:${Math.floor(Date.now() / 1000 / opts.windowSec)}`;
    let count: number;
    try {
      count = await store.hit(key, opts.windowSec);
    } catch {
      count = await fallback.hit(key, opts.windowSec); // fail safe, not open
    }
    res.setHeader('RateLimit-Limit', opts.limit);
    res.setHeader('RateLimit-Remaining', Math.max(0, opts.limit - count));
    if (count > opts.limit) {
      res.setHeader('Retry-After', opts.windowSec);
      res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests, slow down.' } });
      return;
    }
    next();
  };
}
