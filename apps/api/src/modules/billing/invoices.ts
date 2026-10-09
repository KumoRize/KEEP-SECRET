import type { PoolClient } from 'pg';
import { config } from '../../config.js';
import { pool } from '../../db/pool.js';
import { signPayload, verifyPayload } from '../../lib/crypto.js';
import { notFound } from '../../lib/errors.js';
import { computeTax, financialYear, invoiceNumber, placeOfSupply, STATES } from './gst.js';
import { CREDIT_PACKS, getPlan } from './plans.js';

export interface InvoiceRow {
  id: string;
  number: string;
  financial_year: string;
  doc_type: 'tax_invoice' | 'bill_of_supply';
  user_id: string;
  payment_id: string;
  issued_at: Date;
  seller: { legalName: string; address: string; stateCode: string; gstin: string | null; secondTaxLabel: string };
  buyer: { email: string; legalName: string; address: string; stateCode: string | null; gstin: string | null };
  description: string;
  sac_code: string | null;
  place_of_supply: string;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  total_paise: number;
  rate_percent: string;
}

/**
 * Issues the invoice for a paid payment inside the caller's transaction, so a payment is never
 * recorded without its invoice. Idempotent per payment (unique payment_id).
 */
export async function issueInvoice(c: PoolClient, paymentId: string, now = new Date()): Promise<InvoiceRow> {
  const existing = await c.query<InvoiceRow>('SELECT * FROM invoices WHERE payment_id = $1', [paymentId]);
  if (existing.rows[0]) return existing.rows[0];

  const { rows: [p] } = await c.query<{ user_id: string; kind: string; item_id: string; amount_paise: number; email: string; legal_name: string | null; address: string | null; state_code: string | null; gstin: string | null }>(
    `SELECT p.user_id, p.kind, p.item_id, p.amount_paise, u.email, bp.legal_name, bp.address, bp.state_code, bp.gstin
       FROM payments p JOIN users u ON u.id = p.user_id LEFT JOIN billing_profiles bp ON bp.user_id = p.user_id
      WHERE p.id = $1`,
    [paymentId],
  );
  if (!p) throw notFound('Payment not found');

  const registered = Boolean(config.SELLER_GSTIN);
  const pos = placeOfSupply(config.SELLER_STATE_CODE, { stateCode: p.state_code, gstin: p.gstin });
  const tax = computeTax({
    amountPaise: p.amount_paise, sellerRegistered: registered, sellerState: config.SELLER_STATE_CODE,
    placeOfSupply: pos, ratePercent: config.GST_RATE_PERCENT, pricesIncludeGst: config.PRICES_INCLUDE_GST,
  });
  const description = p.kind === 'credit_pack'
    ? `AI generation credits: ${CREDIT_PACKS.find((x) => x.id === p.item_id)?.name ?? p.item_id} (non-expiring)`
    : `${getPlan(p.item_id).name} plan subscription, 1 month`;

  const fy = financialYear(now);
  // Row lock on the counter serialises numbering; rolled back with the payment if anything fails.
  const { rows: [counter] } = await c.query<{ last_serial: number }>(
    `INSERT INTO invoice_counters (financial_year, last_serial) VALUES ($1, 1)
     ON CONFLICT (financial_year) DO UPDATE SET last_serial = invoice_counters.last_serial + 1
     RETURNING last_serial`,
    [fy],
  );
  const number = invoiceNumber(config.INVOICE_PREFIX, fy, counter!.last_serial);
  const seller = {
    legalName: config.SELLER_LEGAL_NAME, address: config.SELLER_ADDRESS, stateCode: config.SELLER_STATE_CODE,
    gstin: config.SELLER_GSTIN ?? null, secondTaxLabel: tax.secondTaxLabel,
  };
  const buyer = { email: p.email, legalName: p.legal_name ?? '', address: p.address ?? '', stateCode: p.state_code, gstin: p.gstin };

  const { rows: [inv] } = await c.query<InvoiceRow>(
    `INSERT INTO invoices (number, financial_year, doc_type, user_id, payment_id, issued_at, seller, buyer, description, sac_code,
                           place_of_supply, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise, rate_percent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [number, fy, tax.docType, p.user_id, paymentId, now, seller, buyer, description, registered ? config.GST_SAC_CODE : null,
      pos, tax.taxablePaise, tax.cgstPaise, tax.sgstPaise, tax.igstPaise, tax.totalPaise, tax.ratePercent],
  );
  return inv!;
}

// ---- Rendering -------------------------------------------------------------------------------

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const inr = (paise: number) => `₹${(Number(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const stateLabel = (code: string | null) => (code ? `${esc(STATES[code] ?? code)} (${esc(code)})` : '');

/** Printable HTML; the browser's "Save as PDF" produces the PDF. Every dynamic value is escaped. */
export function renderInvoiceHtml(inv: InvoiceRow): string {
  const isTax = inv.doc_type === 'tax_invoice';
  const rate = Number(inv.rate_percent);
  const intra = inv.cgst_paise > 0 || inv.sgst_paise > 0;
  const taxRows = !isTax ? '' : intra
    ? `<tr><td>CGST @ ${rate / 2}%</td><td>${inr(inv.cgst_paise)}</td></tr>
       <tr><td>${esc(inv.seller.secondTaxLabel)} @ ${rate / 2}%</td><td>${inr(inv.sgst_paise)}</td></tr>`
    : `<tr><td>IGST @ ${rate}%</td><td>${inr(inv.igst_paise)}</td></tr>`;
  const issued = new Date(inv.issued_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(inv.number)}</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;color:#111;max-width:760px;margin:24px auto;padding:0 16px}
  h1{font-size:20px;margin:0 0 4px} .muted{color:#555} .row{display:flex;gap:24px;flex-wrap:wrap;margin:16px 0}
  .row>div{flex:1;min-width:220px} table{width:100%;border-collapse:collapse;margin:16px 0}
  th,td{border-bottom:1px solid #ddd;padding:8px;text-align:left} td:last-child,th:last-child{text-align:right}
  .total td{font-weight:700;border-top:2px solid #111} @media print{body{margin:0}}
</style></head><body>
<h1>${isTax ? 'Tax Invoice' : 'Bill of Supply'}</h1>
<div class="muted">No. <strong>${esc(inv.number)}</strong> · Date ${esc(issued)} · Original for recipient</div>
<div class="row">
  <div><strong>Supplier</strong><br>${esc(inv.seller.legalName)}<br>${esc(inv.seller.address)}<br>State: ${stateLabel(inv.seller.stateCode)}
    ${inv.seller.gstin ? `<br>GSTIN: ${esc(inv.seller.gstin)}` : ''}</div>
  <div><strong>Recipient</strong><br>${esc(inv.buyer.legalName || inv.buyer.email)}<br>${esc(inv.buyer.address)}
    ${inv.buyer.legalName ? `<br>${esc(inv.buyer.email)}` : ''}
    ${inv.buyer.gstin ? `<br>GSTIN: ${esc(inv.buyer.gstin)}` : ''}</div>
</div>
<div>Place of supply: ${stateLabel(inv.place_of_supply)}${isTax ? ' · Reverse charge: No' : ''}</div>
<table>
  <thead><tr><th>Description</th>${inv.sac_code ? '<th>SAC</th>' : ''}<th>Qty</th><th>${isTax ? 'Taxable value' : 'Amount'}</th></tr></thead>
  <tbody><tr><td>${esc(inv.description)}</td>${inv.sac_code ? `<td>${esc(inv.sac_code)}</td>` : ''}<td>1</td><td>${inr(inv.taxable_paise)}</td></tr></tbody>
</table>
<table>
  ${taxRows}
  <tr class="total"><td>Total</td><td>${inr(inv.total_paise)}</td></tr>
</table>
${isTax ? '' : '<p class="muted">Supplier not registered under GST; no tax charged.</p>'}
<p class="muted">This is a computer-generated document.</p>
</body></html>`;
}

const URL_TTL_SEC = 600;

export function invoiceHtmlUrl(id: string): string {
  return `${config.PUBLIC_URL}/invoices/${signPayload(config.FILE_URL_SECRET, { inv: id, exp: Math.floor(Date.now() / 1000) + URL_TTL_SEC })}`;
}

export async function invoiceFromToken(token: string): Promise<InvoiceRow | null> {
  const t = verifyPayload<{ inv?: string; exp: number }>(config.FILE_URL_SECRET, token);
  if (!t?.inv || t.exp < Date.now() / 1000) return null;
  const { rows } = await pool.query<InvoiceRow>('SELECT * FROM invoices WHERE id = $1', [t.inv]);
  return rows[0] ?? null;
}

export function invoiceSummary(inv: InvoiceRow) {
  return {
    id: inv.id, number: inv.number, docType: inv.doc_type, issuedAt: inv.issued_at, description: inv.description,
    totalPaise: Number(inv.total_paise), taxPaise: Number(inv.cgst_paise) + Number(inv.sgst_paise) + Number(inv.igst_paise),
    htmlUrl: invoiceHtmlUrl(inv.id),
  };
}

/** CSV of invoices in a date range, for GST return preparation (GSTR-1) by your accountant. */
export async function invoicesCsv(from: Date, to: Date): Promise<string> {
  const { rows } = await pool.query<InvoiceRow>(
    'SELECT * FROM invoices WHERE issued_at >= $1 AND issued_at < $2 ORDER BY issued_at, number', [from, to],
  );
  const cell = (v: unknown) => {
    const s = String(v ?? '');
    // Quote always; neutralise leading formula characters so the file is safe to open in Excel.
    return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
  };
  const header = ['invoice_number', 'date', 'doc_type', 'buyer_name', 'buyer_email', 'buyer_gstin', 'place_of_supply',
    'sac', 'taxable_inr', 'cgst_inr', 'sgst_or_utgst_inr', 'igst_inr', 'total_inr', 'rate_percent'];
  const lines = rows.map((r) => [
    r.number, new Date(r.issued_at).toISOString().slice(0, 10), r.doc_type, r.buyer.legalName, r.buyer.email, r.buyer.gstin ?? '',
    r.place_of_supply, r.sac_code ?? '', Number(r.taxable_paise) / 100, Number(r.cgst_paise) / 100, Number(r.sgst_paise) / 100,
    Number(r.igst_paise) / 100, Number(r.total_paise) / 100, r.rate_percent,
  ].map(cell).join(','));
  return [header.join(','), ...lines].join('\r\n') + '\r\n';
}
