import { afterAll, beforeAll } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://creator:creator@localhost:5432/creator_test';
process.env.JWT_SECRET = 'test-jwt-secret-test-jwt-secret-0123456789';
process.env.QUOTE_SECRET = 'test-quote-secret-test-quote-secret-012345';
process.env.FILE_URL_SECRET = 'test-file-secret-test-file-secret-01234567';
process.env.ENABLE_MOCK_PROVIDER = 'true';
process.env.MODERATION_ENABLED = 'false';
process.env.STORAGE_LOCAL_DIR = './storage-test';
process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'rzp_webhook_secret';
process.env.ADMIN_EMAILS = 'admin@example.com';
delete process.env.REDIS_URL;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

beforeAll(async () => {
  const { pool } = await import('../src/db/pool.js');
  const { migrate } = await import('../src/db/migrate.js');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
});

afterAll(async () => {
  const { pool } = await import('../src/db/pool.js');
  await pool.end();
});
