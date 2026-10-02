import { describe, expect, it } from 'vitest';
import { signPayload, verifyPayload, hashPassword, verifyPassword } from '../src/lib/crypto.js';
import { CircuitBreaker } from '../src/modules/providers/circuitBreaker.js';
import { parseCodegenFiles } from '../src/modules/providers/codegen.js';
import { classifyStatus } from '../src/modules/providers/http.js';
import { usdToCredits } from '../src/modules/orchestrator/router.js';

describe('CircuitBreaker', () => {
  it('opens after threshold failures and half-opens after cooldown', () => {
    let now = 0;
    const b = new CircuitBreaker(3, 1000, () => now);
    b.recordFailure('p'); b.recordFailure('p');
    expect(b.isOpen('p')).toBe(false);
    b.recordFailure('p');
    expect(b.isOpen('p')).toBe(true);
    now = 1000;
    expect(b.isOpen('p')).toBe(false); // half-open
    b.recordFailure('p');
    expect(b.isOpen('p')).toBe(true); // single failure re-opens
    now = 2000;
    b.recordSuccess('p');
    expect(b.isOpen('p')).toBe(false);
  });

  it('opens immediately for misconfiguration', () => {
    const b = new CircuitBreaker(5, 1000, () => 0);
    b.recordFailure('p', true);
    expect(b.isOpen('p')).toBe(true);
  });
});

describe('parseCodegenFiles', () => {
  it('accepts valid output wrapped in prose', () => {
    const files = parseCodegenFiles('t', 'Here you go: {"files":[{"path":"index.html","content":"<h1>x</h1>"}]}');
    expect(files[0]).toMatchObject({ filename: 'index.html', contentType: 'text/html' });
  });

  it.each(['../etc/passwd', '/abs.html', 'a/../../b.js', 'a//b.js', 'bad name.html'])('rejects unsafe path %s', (path) => {
    expect(() => parseCodegenFiles('t', JSON.stringify({ files: [{ path, content: 'x' }] }))).toThrow(/unsafe/);
  });
});

describe('provider error classification', () => {
  it('never falls back on content rejections, does on outages', () => {
    expect(classifyStatus(400)).toBe('rejected');
    expect(classifyStatus(401)).toBe('unavailable');
    expect(classifyStatus(429)).toBe('retriable');
    expect(classifyStatus(503)).toBe('retriable');
  });
});

describe('pricing', () => {
  it('converts USD cost to credits with markup, minimum 1', () => {
    // 0.05 USD * 84 INR * 1.6 markup / 0.25 INR per credit = 26.88 -> 27
    expect(usdToCredits(0.05)).toBe(27);
    expect(usdToCredits(0)).toBe(1);
  });
});

describe('crypto', () => {
  it('signed payloads detect tampering', () => {
    const t = signPayload('s'.repeat(32), { a: 1 });
    expect(verifyPayload('s'.repeat(32), t)).toEqual({ a: 1 });
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ a: 2 })).toString('base64url');
    expect(verifyPayload('s'.repeat(32), `${forged}.${sig}`)).toBeNull();
    expect(verifyPayload('x'.repeat(32), `${body}.${sig}`)).toBeNull();
  });

  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
});
