import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { isValidGstin } from '../src/lib/gstin.js';
import { computeTax, financialYear, invoiceNumber, placeOfSupply } from '../src/modules/billing/gst.js';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const SELLER_GSTIN = '27AAPFU0939F1ZV'; // Maharashtra
const KA_BUYER_GSTIN = '29AAGCB7383J1Z4'; // Karnataka

describe('GST rules (pure)', () => {
  const base = { sellerRegistered: true, sellerState: '27', ratePercent: 18, pricesIncludeGst: true };

  it('splits CGST/SGST within the state, carving tax out of an inclusive ₹199', () => {
    expect(computeTax({ ...base, amountPaise: 19900, placeOfSupply: '27' })).toEqual({
      docType: 'tax_invoice', taxablePaise: 16864, cgstPaise: 1518, sgstPaise: 1518, igstPaise: 0, totalPaise: 19900, ratePercent: 18, secondTaxLabel: 'SGST',
    });
  });

  it('charges IGST across states and adds tax on exclusive prices', () => {
    expect(computeTax({ ...base, amountPaise: 19900, placeOfSupply: '29' })).toMatchObject({ igstPaise: 3036, cgstPaise: 0, totalPaise: 19900 });
    expect(computeTax({ ...base, pricesIncludeGst: false, amountPaise: 10000, placeOfSupply: '29' })).toMatchObject({ taxablePaise: 10000, igstPaise: 1800, totalPaise: 11800 });
  });

  it('labels the second half UTGST for union territories without a legislature', () => {
    expect(computeTax({ ...base, sellerState: '04', amountPaise: 10000, placeOfSupply: '04' }).secondTaxLabel).toBe('UTGST');
  });

  it('issues a Bill of Supply with no tax when the seller is not registered', () => {
    expect(computeTax({ ...base, sellerRegistered: false, amountPaise: 19900, placeOfSupply: '29' }))
      .toMatchObject({ docType: 'bill_of_supply', taxablePaise: 19900, igstPaise: 0, totalPaise: 19900 });
  });

  it('keeps totals exact for every price in the catalogue', () => {
    for (const amountPaise of [19900, 49900, 99900, 199900]) {
      for (const pos of ['27', '29']) {
        const t = computeTax({ ...base, amountPaise, placeOfSupply: pos });
        expect(t.taxablePaise + t.cgstPaise + t.sgstPaise + t.igstPaise).toBe(amountPaise);
      }
    }
  });

  it('derives place of supply from GSTIN, then stated state, then the seller', () => {
    expect(placeOfSupply('27', { gstin: KA_BUYER_GSTIN, stateCode: '07' })).toBe('29');
    expect(placeOfSupply('27', { stateCode: '07' })).toBe('07');
    expect(placeOfSupply('27', {})).toBe('27');
  });

  it('uses the April-March financial year in IST', () => {
    expect(financialYear(new Date('2027-03-31T18:00:00Z'))).toBe('2026-27'); // 23:30 IST, 31 Mar
    expect(financialYear(new Date('2027-03-31T19:00:00Z'))).toBe('2027-28'); // 00:30 IST, 1 Apr
    expect(financialYear(new Date('2026-10-09T12:00:00Z'))).toBe('2026-27');
  });

  it('formats invoice numbers within the 16-character limit', () => {
    expect(invoiceNumber('INV', '2026-27', 42)).toBe('INV2627-000042');
    expect(invoiceNumber('ABCD', '2026-27', 999999).length).toBeLessThanOrEqual(16);
  });

  it('validates GSTIN format and check character', () => {
    expect(isValidGstin(SELLER_GSTIN)).toBe(true);
    expect(isValidGstin(KA_BUYER_GSTIN)).toBe(true);
    expect(isValidGstin('27AAPFU0939F1ZA')).toBe(false); // wrong check character
    expect(isValidGstin('27aapfu0939f1zv')).toBe(false);
  });
});

async function user(email = `i${randomUUID()}@example.com`) {
  const res = await request(app).post('/api/v1/auth/register').send({ email, password: 'a-strong-password' });
  return { token: res.body.accessToken as string, id: res.body.user.id as string, email };
}

/** Simulates a captured Razorpay payment for a ₹199 pack via a signed webhook. */
async function buyPack(userId: string) {
  const orderId = `order_${randomUUID()}`;
  const payId = `pay_${randomUUID()}`;
  await pool.query(`INSERT INTO payments (user_id, kind, item_id, amount_paise, razorpay_order_id) VALUES ($1,'credit_pack','pack_500',19900,$2)`, [userId, orderId]);
  const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: payId, order_id: orderId, amount: 19900, status: 'captured' } } } });
  const sig = createHmac('sha256', 'rzp_webhook_secret').update(body).digest('hex');
  const res = await request(app).post('/api/v1/webhooks/razorpay').set('Content-Type', 'application/json')
    .set('X-Razorpay-Signature', sig).set('X-Razorpay-Event-Id', `evt_${randomUUID()}`).send(body);
  expect(res.status).toBe(200);
  return { orderId, payId };
}

async function invoices(token: string) {
  return (await request(app).get('/api/v1/billing/invoices').set(auth(token))).body.items as {
    id: string; number: string; docType: string; totalPaise: number; taxPaise: number; htmlUrl: string;
  }[];
}

describe('invoices end to end', () => {
  afterEach(() => {
    config.SELLER_GSTIN = undefined;
    config.GST_SAC_CODE = undefined;
  });

  const register = () => {
    config.SELLER_GSTIN = SELLER_GSTIN;
    config.GST_SAC_CODE = '998314';
  };

  it('issues a Bill of Supply when the seller has no GSTIN', async () => {
    const u = await user();
    await buyPack(u.id);
    const [inv] = await invoices(u.token);
    expect(inv).toMatchObject({ docType: 'bill_of_supply', totalPaise: 19900, taxPaise: 0 });
    expect(inv!.number).toMatch(/^INV2627-\d{6}$/);
  });

  it('issues one tax invoice per payment with sequential numbers, even if notified twice', async () => {
    register();
    const u = await user();
    const { orderId, payId } = await buyPack(u.id);
    // Checkout verification for the same payment must not create a second invoice.
    const sig = createHmac('sha256', 'rzp_test_secret').update(`${orderId}|${payId}`).digest('hex');
    await request(app).post('/api/v1/billing/orders/verify').set(auth(u.token)).send({ orderId, paymentId: payId, signature: sig });
    await buyPack(u.id);
    const list = await invoices(u.token);
    expect(list).toHaveLength(2);
    const [second, first] = list.map((i) => Number(i.number.split('-')[1]));
    expect(second).toBe(first! + 1);
    expect(list[0]).toMatchObject({ docType: 'tax_invoice', taxPaise: 3036, totalPaise: 19900 });
  });

  it('charges IGST to a buyer registered in another state and prints their GSTIN', async () => {
    register();
    const u = await user();
    const bad = await request(app).put('/api/v1/billing/profile').set(auth(u.token))
      .send({ legalName: 'Acme', address: 'Bengaluru', gstin: '29AAGCB7383J1Z5' });
    expect(bad.status).toBe(400);
    const mismatch = await request(app).put('/api/v1/billing/profile').set(auth(u.token))
      .send({ legalName: 'Acme', address: 'Bengaluru', gstin: KA_BUYER_GSTIN, stateCode: '27' });
    expect(mismatch.status).toBe(400);
    const ok = await request(app).put('/api/v1/billing/profile').set(auth(u.token))
      .send({ legalName: 'Acme <script>alert(1)</script> Pvt Ltd', address: 'MG Road, Bengaluru', gstin: KA_BUYER_GSTIN.toLowerCase() });
    expect(ok.status).toBe(200);
    expect(ok.body.profile).toMatchObject({ gstin: KA_BUYER_GSTIN, state_code: '29' });

    await buyPack(u.id);
    const { rows: [row] } = await pool.query('SELECT * FROM invoices WHERE user_id = $1', [u.id]);
    expect(row).toMatchObject({ place_of_supply: '29', igst_paise: 3036, cgst_paise: 0, sac_code: '998314' });

    const [inv] = await invoices(u.token);
    const html = await request(app).get(new URL(inv!.htmlUrl).pathname);
    expect(html.status).toBe(200);
    expect(html.text).toContain('Tax Invoice');
    expect(html.text).toContain('IGST @ 18%');
    expect(html.text).toContain(`GSTIN: ${KA_BUYER_GSTIN}`);
    expect(html.text).toContain('Karnataka (29)');
    expect(html.text).not.toContain('<script>alert(1)</script>'); // buyer input is escaped
    expect(html.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect((await request(app).get(new URL(inv!.htmlUrl).pathname.slice(0, -3) + 'abc')).status).toBe(404);
  });

  it('keeps invoices private to their owner', async () => {
    const a = await user();
    const b = await user();
    await buyPack(a.id);
    const [inv] = await invoices(a.token);
    expect((await request(app).get(`/api/v1/billing/invoices/${inv!.id}`).set(auth(b.token))).status).toBe(404);
  });

  it('invoices each subscription charge', async () => {
    register();
    const u = await user();
    await pool.query(`INSERT INTO subscriptions (user_id, plan_id, razorpay_subscription_id) VALUES ($1, 'pro', $2)`, [u.id, `sub_${u.id}`]);
    const body = JSON.stringify({
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: `sub_${u.id}`, status: 'active', current_end: Math.floor(Date.now() / 1000) + 30 * 86400 } },
        payment: { entity: { id: `pay_sub_${u.id}`, amount: 99900, status: 'captured' } },
      },
    });
    const sig = createHmac('sha256', 'rzp_webhook_secret').update(body).digest('hex');
    await request(app).post('/api/v1/webhooks/razorpay').set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', sig).set('X-Razorpay-Event-Id', `evt_${randomUUID()}`).send(body);
    const [inv] = await invoices(u.token);
    expect(inv).toMatchObject({ docType: 'tax_invoice', totalPaise: 99900 });
    const { rows: [row] } = await pool.query('SELECT description FROM invoices WHERE id = $1', [inv!.id]);
    expect(row.description).toBe('Pro plan subscription, 1 month');
  });

  it('exports a spreadsheet-safe CSV for admins only', async () => {
    const admin = await user('admin@example.com');
    const u = await user();
    await request(app).put('/api/v1/billing/profile').set(auth(u.token)).send({ legalName: '=HYPERLINK("http://evil")', address: 'x', stateCode: '07' });
    await buyPack(u.id);
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    expect((await request(app).get(`/api/v1/admin/invoices.csv?from=${today}&to=${today}`).set(auth(u.token))).status).toBe(403);
    const csv = await request(app).get(`/api/v1/admin/invoices.csv?from=${today}&to=${today}`).set(auth(admin.token));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toMatch(/^invoice_number,date,doc_type/);
    expect(csv.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });
});
