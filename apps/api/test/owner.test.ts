import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { ensureOwner } from '../src/modules/auth/service.js';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const signup = async (email = `o${randomUUID()}@example.com`) => {
  const r = await request(app).post('/api/v1/auth/register').send({ email, password: 'a-strong-password' });
  return { token: r.body.accessToken as string, id: r.body.user.id as string, role: r.body.user.role as string };
};

describe('single owner', () => {
  it('makes OWNER_EMAIL (here the first ADMIN_EMAILS entry) the one owner, protected from staff', async () => {
    const owner = await signup('admin@example.com');
    expect(owner.role).toBe('owner');
    const staff = await signup();
    const customer = await signup();

    // Only the owner appoints staff.
    expect((await request(app).patch(`/api/v1/admin/users/${staff.id}`).set(auth(customer.token)).send({ role: 'admin' })).status).toBe(403);
    expect((await request(app).patch(`/api/v1/admin/users/${staff.id}`).set(auth(owner.token)).send({ role: 'admin' })).status).toBe(200);

    // Staff can support customers...
    expect((await request(app).post(`/api/v1/admin/users/${customer.id}/credits`).set(auth(staff.token)).send({ amount: 10, reason: 'goodwill' })).status).toBe(200);
    // ...but cannot touch the owner, other admins, roles, money or keys.
    expect((await request(app).patch(`/api/v1/admin/users/${owner.id}`).set(auth(staff.token)).send({ status: 'suspended' })).status).toBe(403);
    expect((await request(app).post(`/api/v1/admin/users/${owner.id}/credits`).set(auth(staff.token)).send({ amount: -50, reason: 'nope' })).status).toBe(403);
    expect((await request(app).patch(`/api/v1/admin/users/${customer.id}`).set(auth(staff.token)).send({ role: 'admin' })).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/stats').set(auth(staff.token))).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/invoices.csv?from=2026-01-01&to=2026-01-02').set(auth(staff.token))).status).toBe(403);
    expect((await request(app).put('/api/v1/admin/providers/mock').set(auth(staff.token)).send({ enabled: false, priority: 1 })).status).toBe(403);
    // Ownership can't be granted through the API, and the owner can't lock themselves out.
    expect((await request(app).patch(`/api/v1/admin/users/${staff.id}`).set(auth(owner.token)).send({ role: 'owner' })).status).toBe(400);
    expect((await request(app).patch(`/api/v1/admin/users/${owner.id}`).set(auth(owner.token)).send({ status: 'suspended' })).status).toBe(403);
    // Owner removes staff.
    expect((await request(app).patch(`/api/v1/admin/users/${staff.id}`).set(auth(owner.token)).send({ role: 'user' })).status).toBe(200);
  });

  it('enforces a single owner at the database level and re-asserts the configured owner at startup', async () => {
    const other = await signup();
    await expect(pool.query(`UPDATE users SET role = 'owner' WHERE id = $1`, [other.id])).rejects.toThrow(/users_single_owner/);
    // Simulate drift: the configured owner was demoted by hand.
    await pool.query(`UPDATE users SET role = 'user' WHERE lower(email) = 'admin@example.com'`);
    await pool.query(`UPDATE users SET role = 'owner' WHERE id = $1`, [other.id]);
    const ownerId = await ensureOwner();
    const { rows } = await pool.query(`SELECT id, role FROM users WHERE role = 'owner'`);
    expect(rows).toEqual([{ id: ownerId, role: 'owner' }]);
    expect((await pool.query('SELECT role FROM users WHERE id = $1', [other.id])).rows[0].role).toBe('admin');
  });
});

describe('owner setup code', () => {
  it('blocks claiming the owner email without the code, and allows it with the code', async () => {
    const { config } = await import('../src/config.js');
    await pool.query(`DELETE FROM users WHERE lower(email) = 'admin@example.com'`);
    config.OWNER_SETUP_CODE = 'my-secret-setup-code';
    try {
      const attacker = await request(app).post('/api/v1/auth/register').send({ email: 'ADMIN@example.com', password: 'a-strong-password' });
      expect(attacker.status).toBe(403);
      expect(attacker.body.error.code).toBe('owner_setup_code_invalid');
      const wrong = await request(app).post('/api/v1/auth/register').send({ email: 'admin@example.com', password: 'a-strong-password', setupCode: 'guess' });
      expect(wrong.status).toBe(403);
      const ok = await request(app).post('/api/v1/auth/register').send({ email: 'admin@example.com', password: 'a-strong-password', setupCode: 'my-secret-setup-code' });
      expect(ok.status).toBe(201);
      expect(ok.body.user.role).toBe('owner');
      // Ordinary sign-ups don't need any code.
      expect((await signup()).role).toBe('user');
    } finally {
      config.OWNER_SETUP_CODE = undefined;
    }
  });

  it('refuses owner sign-up in production until a setup code is configured', async () => {
    const { config } = await import('../src/config.js');
    await pool.query(`DELETE FROM users WHERE lower(email) = 'admin@example.com'`);
    const env = config.NODE_ENV;
    config.NODE_ENV = 'production';
    try {
      const r = await request(app).post('/api/v1/auth/register').send({ email: 'admin@example.com', password: 'a-strong-password' });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('owner_setup_code_required');
    } finally {
      config.NODE_ENV = env;
    }
  });
});
