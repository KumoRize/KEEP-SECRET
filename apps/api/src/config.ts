import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(8080),
  PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  CORS_ORIGINS: z.string().default(''),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  QUOTE_SECRET: z.string().min(32, 'QUOTE_SECRET must be at least 32 chars'),
  FILE_URL_SECRET: z.string().min(32, 'FILE_URL_SECRET must be at least 32 chars'),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),

  // Credit economics. 1 credit is sold at roughly INR 0.26-0.33 through plans.
  USD_INR: z.coerce.number().positive().default(84),
  INR_PER_CREDIT_COST: z.coerce.number().positive().default(0.25),
  PRICE_MARKUP: z.coerce.number().min(1).default(1.6),
  QUOTE_TTL_SEC: z.coerce.number().int().default(600),

  // Provider credentials: server-side only, never serialised to clients.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_CODE_MODEL: z.string().default('gpt-4.1'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  STABILITY_API_KEY: z.string().optional(),
  REPLICATE_API_TOKEN: z.string().optional(),
  REPLICATE_VIDEO_MODEL: z.string().optional(),
  REPLICATE_3D_MODEL: z.string().optional(),
  REPLICATE_MUSIC_MODEL: z.string().optional(),
  // Set only after reviewing each configured Replicate model's licence for commercial use.
  REPLICATE_COMMERCIAL_LICENSE_CONFIRMED: bool.default(false),
  ELEVENLABS_API_KEY: z.string().optional(),
  ENABLE_MOCK_PROVIDER: bool.default(false),
  MODERATION_ENABLED: bool.default(true),

  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // JSON map of internal plan id -> Razorpay plan id, e.g. {"starter":"plan_XXXX"}
  RAZORPAY_PLAN_IDS: z.string().default('{}'),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('ap-south-1'),
  S3_ENDPOINT: z.string().optional(),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  RUN_WORKER_IN_API: bool.default(false),
  JOB_TIMEOUT_SEC: z.coerce.number().int().default(900),
  ADMIN_EMAILS: z.string().default(''),

  // Email: 'console' logs messages (development only); 'resend' sends via the Resend HTTP API.
  MAIL_DRIVER: z.enum(['console', 'resend']).default('console'),
  MAIL_FROM: z.string().default('Creator Studio <no-reply@example.com>'),
  RESEND_API_KEY: z.string().optional(),
  // Blocks generation until the email is verified; curbs free-credit farming with throwaway addresses.
  REQUIRE_EMAIL_VERIFICATION: bool.default(true),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && cfg.ENABLE_MOCK_PROVIDER) {
    throw new Error('ENABLE_MOCK_PROVIDER must be false in production');
  }
  if (cfg.MAIL_DRIVER === 'resend' && !cfg.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is required when MAIL_DRIVER=resend');
  }
  if (cfg.NODE_ENV === 'production' && cfg.MAIL_DRIVER === 'console' && cfg.REQUIRE_EMAIL_VERIFICATION) {
    throw new Error('MAIL_DRIVER=console cannot deliver verification emails in production');
  }
  if (cfg.STORAGE_DRIVER === 's3' && !cfg.S3_BUCKET) {
    throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
  }
  return cfg;
}

export const config = load();

export function razorpayPlanIds(): Record<string, string> {
  try {
    return JSON.parse(config.RAZORPAY_PLAN_IDS) as Record<string, string>;
  } catch {
    throw new Error('RAZORPAY_PLAN_IDS must be valid JSON');
  }
}
