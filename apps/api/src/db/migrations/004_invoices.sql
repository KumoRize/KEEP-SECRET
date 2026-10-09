-- Optional buyer details used on invoices (B2B buyers add a GSTIN to claim input tax credit).
CREATE TABLE billing_profiles (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  legal_name TEXT NOT NULL DEFAULT '',
  address    TEXT NOT NULL DEFAULT '',
  state_code TEXT,                -- 2-digit GST state code; place of supply for B2C
  gstin      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Gap-free invoice serials per financial year; incremented inside the payment transaction.
CREATE TABLE invoice_counters (
  financial_year TEXT PRIMARY KEY, -- e.g. '2026-27'
  last_serial    INT NOT NULL
);

-- Invoices are immutable snapshots: seller and buyer details are copied at issue time.
CREATE TABLE invoices (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number           TEXT NOT NULL UNIQUE,
  financial_year   TEXT NOT NULL,
  doc_type         TEXT NOT NULL CHECK (doc_type IN ('tax_invoice', 'bill_of_supply')),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payment_id       UUID NOT NULL UNIQUE REFERENCES payments(id) ON DELETE RESTRICT,
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  seller           JSONB NOT NULL,
  buyer            JSONB NOT NULL,
  description      TEXT NOT NULL,
  sac_code         TEXT,
  place_of_supply  TEXT NOT NULL,  -- state code
  taxable_paise    BIGINT NOT NULL,
  cgst_paise       BIGINT NOT NULL DEFAULT 0,
  sgst_paise       BIGINT NOT NULL DEFAULT 0, -- SGST or UTGST (see seller.second_tax_label)
  igst_paise       BIGINT NOT NULL DEFAULT 0,
  total_paise      BIGINT NOT NULL,
  rate_percent     NUMERIC(5,2) NOT NULL DEFAULT 0,
  CHECK (taxable_paise + cgst_paise + sgst_paise + igst_paise = total_paise)
);
CREATE INDEX invoices_user_idx ON invoices (user_id, issued_at DESC);
CREATE INDEX invoices_issued_idx ON invoices (issued_at);
