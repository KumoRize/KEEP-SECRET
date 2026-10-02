import { describe, expect, it } from 'vitest';
import { pool, tx } from '../src/db/pool.js';
import { addPurchasedCredits, getBalance, holdCredits, resetSubscriptionCredits, settleHold } from '../src/modules/billing/wallet.js';

async function newUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [`w${Math.random()}@example.com`],
  );
  return rows[0]!.id;
}

async function newGeneration(userId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO generations (user_id, prompt, modality, held_credits, idempotency_key) VALUES ($1,'p','image',0,$2) RETURNING id`,
    [userId, Math.random().toString()],
  );
  return rows[0]!.id;
}

describe('wallet', () => {
  it('spends subscription credits first and refunds purchased first', async () => {
    const u = await newUser();
    await resetSubscriptionCredits(u, 30, 'cycle-1');
    await addPurchasedCredits(u, 50, { kind: 'purchase', idempotencyKey: `p-${u}` });
    const g = await newGeneration(u);
    const hold = await tx((c) => holdCredits(c, u, 40, g));
    expect(hold).toEqual({ subscription: 30, purchased: 10 });
    expect(await getBalance(u)).toMatchObject({ subscription: 0, purchased: 40, total: 40 });

    await tx((c) => settleHold(c, u, g, hold, 25)); // keep 25 (all subscription), refund 15
    expect(await getBalance(u)).toMatchObject({ subscription: 5, purchased: 50, total: 55 });
  });

  it('rejects holds larger than the balance', async () => {
    const u = await newUser();
    await addPurchasedCredits(u, 10, { kind: 'purchase' });
    const g = await newGeneration(u);
    await expect(tx((c) => holdCredits(c, u, 11, g))).rejects.toMatchObject({ status: 402, code: 'insufficient_credits' });
    expect((await getBalance(u)).total).toBe(10);
  });

  it('applies grants idempotently', async () => {
    const u = await newUser();
    await addPurchasedCredits(u, 100, { kind: 'purchase', idempotencyKey: `dup-${u}` });
    await addPurchasedCredits(u, 100, { kind: 'purchase', idempotencyKey: `dup-${u}` });
    await resetSubscriptionCredits(u, 60, `cyc-${u}`);
    await resetSubscriptionCredits(u, 60, `cyc-${u}`);
    expect(await getBalance(u)).toMatchObject({ purchased: 100, subscription: 60 });
  });

  it('expires unused subscription credits at cycle reset', async () => {
    const u = await newUser();
    await resetSubscriptionCredits(u, 60, `a-${u}`);
    await resetSubscriptionCredits(u, 600, `b-${u}`);
    expect((await getBalance(u)).subscription).toBe(600);
  });

  it('never overdraws under concurrent holds', async () => {
    const u = await newUser();
    await addPurchasedCredits(u, 100, { kind: 'purchase' });
    const gens = await Promise.all(Array.from({ length: 8 }, () => newGeneration(u)));
    const results = await Promise.allSettled(gens.map((g) => tx((c) => holdCredits(c, u, 30, g))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect((await getBalance(u)).total).toBe(10);
  });
});
