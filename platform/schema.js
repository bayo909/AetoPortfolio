// Relational schema (SQLite via node:sqlite). Money is stored as INTEGER minor units (kobo / cents).
// Every tenant-owned table carries org_id; cross-tenant documents (quotes, invoices, requests) carry both
// vendor_org_id and customer_org_id and are only reachable through the access rules in platform/access.js.
module.exports = `
CREATE TABLE IF NOT EXISTS system_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  is_platform_admin INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','disabled')),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS organizations(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'business' CHECK(kind IN('business','platform')),
  is_customer INTEGER NOT NULL DEFAULT 1,
  is_vendor INTEGER NOT NULL DEFAULT 0,
  country TEXT NOT NULL DEFAULT 'NG',
  currency TEXT NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','suspended','pending')),
  is_demo INTEGER NOT NULL DEFAULT 0,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS permissions(key TEXT PRIMARY KEY, description TEXT);
CREATE TABLE IF NOT EXISTS roles(key TEXT PRIMARY KEY, label TEXT NOT NULL, scope TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS role_permissions(
  role TEXT NOT NULL REFERENCES roles(key), permission TEXT NOT NULL REFERENCES permissions(key),
  PRIMARY KEY(role, permission)
);

CREATE TABLE IF NOT EXISTS organization_members(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL REFERENCES roles(key),
  approval_limit_minor INTEGER NOT NULL DEFAULT 0 CHECK(approval_limit_minor >= 0),
  department TEXT NOT NULL DEFAULT '',
  cost_center TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','suspended')),
  created_at TEXT NOT NULL,
  UNIQUE(org_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  active_org_id TEXT NOT NULL REFERENCES organizations(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invitations(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN('vendor','staff')),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL COLLATE NOCASE,
  invited_org_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL REFERENCES roles(key),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','accepted','revoked','expired')),
  expires_at TEXT NOT NULL,
  invited_by TEXT NOT NULL REFERENCES users(id),
  accepted_by TEXT REFERENCES users(id),
  accepted_org_id TEXT REFERENCES organizations(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vendor_relationships(
  id TEXT PRIMARY KEY,
  customer_org_id TEXT NOT NULL REFERENCES organizations(id),
  vendor_org_id TEXT NOT NULL REFERENCES organizations(id),
  status TEXT NOT NULL CHECK(status IN('pending_kyb','active','revoked')),
  invitation_id TEXT REFERENCES invitations(id),
  created_at TEXT NOT NULL,
  UNIQUE(customer_org_id, vendor_org_id),
  CHECK(customer_org_id <> vendor_org_id)
);

CREATE TABLE IF NOT EXISTS vendor_profiles(
  org_id TEXT PRIMARY KEY REFERENCES organizations(id),
  legal_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tax_id_enc TEXT NOT NULL DEFAULT '',
  registration_no TEXT NOT NULL DEFAULT '',
  settlement_currency TEXT NOT NULL DEFAULT 'NGN',
  bank_name TEXT NOT NULL DEFAULT '',
  account_number_enc TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL DEFAULT '',
  payment_terms_days INTEGER NOT NULL DEFAULT 14,
  kyb_status TEXT NOT NULL DEFAULT 'not_started' CHECK(kyb_status IN('not_started','in_progress','submitted','verified','rejected','expired')),
  allow_self_approval INTEGER NOT NULL DEFAULT 0,
  bank_changed_at TEXT
);

CREATE TABLE IF NOT EXISTS employee_profiles(
  org_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  employee_no TEXT NOT NULL DEFAULT '',
  bank_name TEXT NOT NULL DEFAULT '',
  account_number_enc TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(org_id, user_id)
);

CREATE TABLE IF NOT EXISTS country_kyb_configs(
  country TEXT NOT NULL,
  version INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  review_months INTEGER NOT NULL DEFAULT 12,
  fields_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  validation_status TEXT NOT NULL DEFAULT 'pending_compliance_validation' CHECK(validation_status IN('pending_compliance_validation','validated')),
  validated_by TEXT,
  PRIMARY KEY(country, version)
);

CREATE TABLE IF NOT EXISTS kyb_cases(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  country TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','submitted','in_review','verified','rejected','expired')),
  risk TEXT NOT NULL DEFAULT 'unrated',
  data_json TEXT NOT NULL DEFAULT '{}',
  screening_json TEXT NOT NULL DEFAULT '{}',
  submitted_at TEXT, decided_by TEXT, decided_at TEXT, decision_note TEXT,
  next_review_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS compliance_evidence(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  kyb_case_id TEXT NOT NULL REFERENCES kyb_cases(id),
  kind TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL, storage_key TEXT NOT NULL,
  expires_at TEXT, uploaded_by TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS storefronts(
  org_id TEXT PRIMARY KEY REFERENCES organizations(id),
  slug TEXT NOT NULL UNIQUE,
  headline TEXT NOT NULL DEFAULT '',
  about TEXT NOT NULL DEFAULT '',
  published INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS products(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  kind TEXT NOT NULL CHECK(kind IN('product','service')),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT 'unit',
  unit_price_minor INTEGER NOT NULL CHECK(unit_price_minor >= 0),
  currency TEXT NOT NULL,
  tax_bp INTEGER NOT NULL DEFAULT 0 CHECK(tax_bp BETWEEN 0 AND 10000),
  wht_bp INTEGER NOT NULL DEFAULT 0 CHECK(wht_bp BETWEEN 0 AND 10000),
  inventory INTEGER,
  available INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(org_id, sku)
);
CREATE TABLE IF NOT EXISTS pricing_rules(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  customer_org_id TEXT REFERENCES organizations(id),
  min_qty_milli INTEGER NOT NULL DEFAULT 1000,
  discount_bp INTEGER NOT NULL DEFAULT 0 CHECK(discount_bp BETWEEN 0 AND 10000),
  valid_until TEXT,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS subscription_plans(
  key TEXT PRIMARY KEY, name TEXT NOT NULL,
  monthly_minor INTEGER NOT NULL, annual_minor INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'NGN',
  entitlements_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS subscriptions(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL UNIQUE REFERENCES organizations(id),
  plan_key TEXT NOT NULL REFERENCES subscription_plans(key),
  billing_period TEXT NOT NULL DEFAULT 'monthly' CHECK(billing_period IN('monthly','annual')),
  status TEXT NOT NULL CHECK(status IN('trialing','active','past_due','cancelled')),
  trial_ends_at TEXT, current_period_end TEXT, cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  pending_plan_key TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscription_invoices(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  number TEXT NOT NULL UNIQUE,
  plan_key TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  amount_minor INTEGER NOT NULL, currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('open','paid','failed','void')),
  attempts INTEGER NOT NULL DEFAULT 0, failure_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cost_centers(
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), code TEXT NOT NULL, name TEXT NOT NULL, department TEXT NOT NULL DEFAULT '',
  UNIQUE(org_id, code)
);
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), code TEXT NOT NULL, name TEXT NOT NULL,
  UNIQUE(org_id, code)
);
CREATE TABLE IF NOT EXISTS budgets(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  cost_center TEXT NOT NULL, project TEXT NOT NULL DEFAULT '',
  classification TEXT NOT NULL CHECK(classification IN('opex','capex')),
  fiscal_year INTEGER NOT NULL,
  allocated_minor INTEGER NOT NULL CHECK(allocated_minor >= 0),
  committed_minor INTEGER NOT NULL DEFAULT 0 CHECK(committed_minor >= 0),
  spent_minor INTEGER NOT NULL DEFAULT 0 CHECK(spent_minor >= 0),
  UNIQUE(org_id, cost_center, project, classification, fiscal_year)
);

CREATE TABLE IF NOT EXISTS wallets(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN('opex','capex','reimbursement')),
  currency TEXT NOT NULL,
  balance_minor INTEGER NOT NULL DEFAULT 0 CHECK(balance_minor >= 0),
  reserved_minor INTEGER NOT NULL DEFAULT 0 CHECK(reserved_minor >= 0),
  per_txn_limit_minor INTEGER NOT NULL DEFAULT 0,
  dual_control_minor INTEGER NOT NULL DEFAULT 0,
  department TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '',
  sandbox_behavior TEXT NOT NULL DEFAULT 'normal' CHECK(sandbox_behavior IN('normal','decline','timeout')),
  is_simulated INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','frozen')),
  created_at TEXT NOT NULL,
  CHECK(reserved_minor <= balance_minor)
);
CREATE TABLE IF NOT EXISTS wallet_transactions(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  kind TEXT NOT NULL CHECK(kind IN('topup','debit','credit','reversal','refund')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  balance_after_minor INTEGER NOT NULL,
  payment_intent_id TEXT,
  ref TEXT NOT NULL UNIQUE,
  memo TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wallet_reservations(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  payment_intent_id TEXT NOT NULL UNIQUE,
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  status TEXT NOT NULL CHECK(status IN('held','released','captured')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests(
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN('rfq','order','invoice_request')),
  customer_org_id TEXT NOT NULL REFERENCES organizations(id),
  vendor_org_id TEXT NOT NULL REFERENCES organizations(id),
  title TEXT NOT NULL,
  items_json TEXT NOT NULL DEFAULT '[]',
  delivery_json TEXT NOT NULL DEFAULT '{}',
  purchase_ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','quoted','accepted','invoiced','closed','cancelled')),
  requested_by TEXT NOT NULL REFERENCES users(id),
  channel_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(customer_org_id, number)
);
CREATE TABLE IF NOT EXISTS purchase_requests(
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), number TEXT NOT NULL,
  request_id TEXT REFERENCES requests(id), description TEXT NOT NULL, estimated_minor INTEGER NOT NULL DEFAULT 0,
  cost_center TEXT NOT NULL DEFAULT '', justification TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open', requested_by TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(org_id, number)
);
CREATE TABLE IF NOT EXISTS purchase_orders(
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), number TEXT NOT NULL,
  vendor_org_id TEXT NOT NULL REFERENCES organizations(id), quote_id TEXT, request_id TEXT,
  amount_minor INTEGER NOT NULL, currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued' CHECK(status IN('issued','received','closed','cancelled')),
  issued_by TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(org_id, number)
);

CREATE TABLE IF NOT EXISTS quotations(
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT REFERENCES quotations(id),
  vendor_org_id TEXT NOT NULL REFERENCES organizations(id),
  customer_org_id TEXT NOT NULL REFERENCES organizations(id),
  request_id TEXT REFERENCES requests(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','pending_approval','approved','accepted','declined','expired','superseded','cancelled','rejected')),
  currency TEXT NOT NULL,
  subtotal_minor INTEGER NOT NULL DEFAULT 0, discount_minor INTEGER NOT NULL DEFAULT 0,
  tax_minor INTEGER NOT NULL DEFAULT 0, wht_minor INTEGER NOT NULL DEFAULT 0, total_minor INTEGER NOT NULL DEFAULT 0,
  valid_until TEXT, terms TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id), prepared_by TEXT, created_via TEXT NOT NULL DEFAULT 'user' CHECK(created_via IN('user','agent')),
  flags_json TEXT NOT NULL DEFAULT '[]',
  approved_by TEXT, approved_at TEXT, delivered_at TEXT, accepted_by TEXT, accepted_at TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(vendor_org_id, number, version)
);
CREATE TABLE IF NOT EXISTS invoices(
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT REFERENCES invoices(id),
  vendor_org_id TEXT NOT NULL REFERENCES organizations(id),
  customer_org_id TEXT NOT NULL REFERENCES organizations(id),
  quote_id TEXT REFERENCES quotations(id),
  request_id TEXT REFERENCES requests(id),
  po_id TEXT REFERENCES purchase_orders(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','submitted','approved','issued','paid','disputed','cancelled','superseded')),
  currency TEXT NOT NULL,
  subtotal_minor INTEGER NOT NULL DEFAULT 0, discount_minor INTEGER NOT NULL DEFAULT 0,
  tax_minor INTEGER NOT NULL DEFAULT 0, wht_minor INTEGER NOT NULL DEFAULT 0, total_minor INTEGER NOT NULL DEFAULT 0,
  due_date TEXT, payment_terms_days INTEGER NOT NULL DEFAULT 14, notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id), prepared_by TEXT, created_via TEXT NOT NULL DEFAULT 'user' CHECK(created_via IN('user','agent')),
  flags_json TEXT NOT NULL DEFAULT '[]',
  approved_by TEXT, approved_at TEXT, issued_at TEXT, paid_at TEXT, dispute_reason TEXT,
  bill_id TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(vendor_org_id, number, version)
);
CREATE TABLE IF NOT EXISTS commercial_lines(
  id TEXT PRIMARY KEY,
  doc_type TEXT NOT NULL CHECK(doc_type IN('quotation','invoice')),
  doc_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  product_id TEXT REFERENCES products(id),
  sku TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  qty_milli INTEGER NOT NULL CHECK(qty_milli > 0),
  unit_price_minor INTEGER NOT NULL CHECK(unit_price_minor >= 0),
  price_source TEXT NOT NULL CHECK(price_source IN('catalog','customer_rule','manual','price_required')),
  discount_bp INTEGER NOT NULL DEFAULT 0, tax_bp INTEGER NOT NULL DEFAULT 0, wht_bp INTEGER NOT NULL DEFAULT 0,
  net_minor INTEGER NOT NULL, discount_minor INTEGER NOT NULL, tax_minor INTEGER NOT NULL, wht_minor INTEGER NOT NULL, total_minor INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lines_doc ON commercial_lines(doc_type, doc_id);

CREATE TABLE IF NOT EXISTS bills(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  number TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN('invoice','rtfepe','expense')),
  invoice_id TEXT REFERENCES invoices(id),
  docflow_doc_id TEXT, docflow_bill_id TEXT, source_document_id TEXT,
  vendor_org_id TEXT REFERENCES organizations(id),
  party_name TEXT NOT NULL, party_ref TEXT NOT NULL DEFAULT '',
  beneficiary_user_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'received' CHECK(status IN('received','pending_approval','approved','rejected','disputed','cancelled','quarantined','superseded')),
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK(payment_status IN('unpaid','processing','paid')),
  accounting_status TEXT NOT NULL DEFAULT 'none' CHECK(accounting_status IN('none','posted','posting_failed')),
  accounting_error TEXT,
  currency TEXT NOT NULL,
  subtotal_minor INTEGER NOT NULL DEFAULT 0, tax_minor INTEGER NOT NULL DEFAULT 0, wht_minor INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL DEFAULT 0, payable_minor INTEGER NOT NULL DEFAULT 0,
  classification TEXT NOT NULL DEFAULT 'opex' CHECK(classification IN('opex','capex')),
  department TEXT NOT NULL DEFAULT '', cost_center TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '',
  purchase_order_id TEXT, purchase_ref TEXT NOT NULL DEFAULT '',
  receipt_confirmed_by TEXT, receipt_confirmed_at TEXT,
  financial_event TEXT NOT NULL DEFAULT '', matched_phrase TEXT NOT NULL DEFAULT '',
  due_date TEXT, requested_by TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  is_payable INTEGER NOT NULL DEFAULT 1,
  quarantine_reason TEXT,
  entries_json TEXT,
  fingerprint TEXT,
  budget_committed_minor INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT,
  created_at TEXT NOT NULL, approved_at TEXT, paid_at TEXT,
  UNIQUE(org_id, number)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bill_invoice ON bills(org_id, invoice_id) WHERE invoice_id IS NOT NULL AND status NOT IN ('superseded','cancelled');
CREATE UNIQUE INDEX IF NOT EXISTS uq_bill_docflow ON bills(org_id, docflow_bill_id) WHERE docflow_bill_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bill_fp ON bills(org_id, fingerprint);
CREATE TABLE IF NOT EXISTS bill_line_items(
  id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bills(id), org_id TEXT NOT NULL REFERENCES organizations(id),
  position INTEGER NOT NULL, description TEXT NOT NULL,
  qty_milli INTEGER NOT NULL DEFAULT 1000, unit_price_minor INTEGER NOT NULL DEFAULT 0,
  net_minor INTEGER NOT NULL, tax_minor INTEGER NOT NULL DEFAULT 0, wht_minor INTEGER NOT NULL DEFAULT 0, total_minor INTEGER NOT NULL,
  account_code INTEGER, financial_event TEXT NOT NULL DEFAULT '', matched_phrase TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS bill_attachments(
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), bill_id TEXT NOT NULL REFERENCES bills(id),
  filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, storage_key TEXT NOT NULL,
  uploaded_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approval_workflows(
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
  subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, amount_minor INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected','cancelled')),
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wf_active ON approval_workflows(subject_type, subject_id) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS approval_steps(
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES approval_workflows(id), org_id TEXT NOT NULL,
  position INTEGER NOT NULL, slot TEXT NOT NULL, label TEXT NOT NULL, allowed_roles TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected'))
);
CREATE TABLE IF NOT EXISTS approval_decisions(
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
  subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, subject_version INTEGER NOT NULL DEFAULT 1,
  workflow_id TEXT, step_id TEXT, actor_id TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK(decision IN('approved','rejected','submitted','returned')),
  comment TEXT NOT NULL DEFAULT '', at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dec_subject ON approval_decisions(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS qr_scans(
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), invoice_id TEXT NOT NULL, bill_id TEXT NOT NULL,
  scanned_by TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_intents(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  bill_id TEXT NOT NULL REFERENCES bills(id),
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), currency TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK(status IN('created','awaiting_authorization','submitted','succeeded','failed','cancelled')),
  initiated_by TEXT NOT NULL, authorized_by TEXT, scan_id TEXT,
  provider TEXT NOT NULL DEFAULT 'sandbox', provider_ref TEXT,
  failure_code TEXT, failure_reason TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(org_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_intent ON payment_intents(bill_id) WHERE status IN('created','awaiting_authorization','submitted','succeeded');
CREATE TABLE IF NOT EXISTS payment_transactions(
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
  intent_id TEXT NOT NULL UNIQUE REFERENCES payment_intents(id), bill_id TEXT NOT NULL REFERENCES bills(id),
  wallet_id TEXT NOT NULL REFERENCES wallets(id), amount_minor INTEGER NOT NULL, currency TEXT NOT NULL,
  provider TEXT NOT NULL, provider_ref TEXT NOT NULL UNIQUE, receipt_no TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN('succeeded','reversed')), is_simulated INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_provider_events(
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE, intent_id TEXT,
  type TEXT NOT NULL, payload_json TEXT NOT NULL, signature_valid INTEGER NOT NULL, processed_at TEXT, received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reconciliation_records(
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
  payment_transaction_id TEXT NOT NULL UNIQUE REFERENCES payment_transactions(id), bill_id TEXT NOT NULL,
  journal_entry_id TEXT, provider_amount_minor INTEGER,
  status TEXT NOT NULL CHECK(status IN('pending','matched','exception')), note TEXT NOT NULL DEFAULT '',
  reconciled_by TEXT, created_at TEXT NOT NULL, reconciled_at TEXT
);

CREATE TABLE IF NOT EXISTS chart_of_accounts(
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
  code INTEGER NOT NULL, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN('asset','liability','equity','revenue','expense','memo')),
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(org_id, code)
);
CREATE TABLE IF NOT EXISTS accounting_periods(
  org_id TEXT NOT NULL REFERENCES organizations(id), period TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','locked')),
  PRIMARY KEY(org_id, period)
);
CREATE TABLE IF NOT EXISTS fx_rates(
  org_id TEXT NOT NULL REFERENCES organizations(id), from_ccy TEXT NOT NULL, to_ccy TEXT NOT NULL,
  rate REAL NOT NULL CHECK(rate > 0), source TEXT NOT NULL, as_of TEXT NOT NULL,
  PRIMARY KEY(org_id, from_ccy, to_ccy, as_of)
);
CREATE TABLE IF NOT EXISTS journal_entries(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  number TEXT NOT NULL,
  posting_key TEXT NOT NULL,
  source_type TEXT NOT NULL, source_id TEXT NOT NULL,
  bill_id TEXT, source_document_id TEXT, generated_document_id TEXT,
  financial_event TEXT NOT NULL DEFAULT '', memo TEXT NOT NULL DEFAULT '',
  entry_date TEXT NOT NULL, period TEXT NOT NULL,
  currency TEXT NOT NULL, functional_currency TEXT NOT NULL, fx_rate REAL NOT NULL DEFAULT 1, fx_source TEXT NOT NULL DEFAULT 'n/a',
  reverses_entry_id TEXT REFERENCES journal_entries(id),
  cost_center TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '',
  created_by TEXT, created_at TEXT NOT NULL,
  UNIQUE(org_id, posting_key),
  UNIQUE(org_id, number)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reversal ON journal_entries(reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS journal_lines(
  id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES journal_entries(id), org_id TEXT NOT NULL REFERENCES organizations(id),
  position INTEGER NOT NULL, account_id TEXT NOT NULL REFERENCES chart_of_accounts(id),
  side TEXT NOT NULL CHECK(side IN('Dr','Cr')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  functional_minor INTEGER NOT NULL CHECK(functional_minor > 0)
);
CREATE INDEX IF NOT EXISTS idx_jl_entry ON journal_lines(entry_id);

CREATE TABLE IF NOT EXISTS financial_events(
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
  batch_id TEXT NOT NULL, position INTEGER NOT NULL,
  source_document TEXT NOT NULL, financial_event TEXT NOT NULL, phrase TEXT NOT NULL,
  accounting_impact TEXT NOT NULL DEFAULT '', ledger_effect TEXT NOT NULL DEFAULT '',
  journal_entry TEXT NOT NULL DEFAULT '', debit_account TEXT NOT NULL DEFAULT '', credit_account TEXT NOT NULL DEFAULT '',
  gl_posting TEXT NOT NULL DEFAULT '', statement_impact TEXT NOT NULL DEFAULT '',
  expense_code TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS financial_event_batches(
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), filename TEXT NOT NULL, sha256 TEXT NOT NULL,
  rows_count INTEGER NOT NULL, is_demo INTEGER NOT NULL DEFAULT 0, imported_by TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS financial_event_matches(
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
  document_id TEXT NOT NULL, line_ref TEXT NOT NULL, financial_event TEXT NOT NULL, matched_phrase TEXT NOT NULL,
  confidence REAL NOT NULL, reasons_json TEXT NOT NULL DEFAULT '[]', needs_review INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS policy_documents(
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
  version INTEGER NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL, doc_ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','active','retired')),
  is_demo INTEGER NOT NULL DEFAULT 0, imported_by TEXT, activated_by TEXT, created_at TEXT NOT NULL,
  UNIQUE(org_id, version)
);
CREATE TABLE IF NOT EXISTS policy_rules(
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, policy_document_id TEXT NOT NULL REFERENCES policy_documents(id),
  chunk_id TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', body TEXT NOT NULL,
  source_ref TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'imported' CHECK(status IN('imported','reviewed','flagged')),
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS source_documents(
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
  docflow_record_id TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  sha256 TEXT NOT NULL, intake TEXT NOT NULL CHECK(intake IN('structured','unstructured')),
  uploaded_by TEXT NOT NULL REFERENCES users(id), duplicate_of TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  UNIQUE(org_id, docflow_record_id)
);
CREATE TABLE IF NOT EXISTS document_versions(
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
  docflow_doc_id TEXT NOT NULL, version INTEGER NOT NULL, stage TEXT NOT NULL,
  content_json TEXT NOT NULL, content_sha256 TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL,
  UNIQUE(org_id, docflow_doc_id, version)
);
CREATE TABLE IF NOT EXISTS extracted_fields(
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), source_document_id TEXT NOT NULL REFERENCES source_documents(id),
  field TEXT NOT NULL, value TEXT NOT NULL, confidence REAL, page INTEGER, corrected_value TEXT, corrected_by TEXT, corrected_at TEXT
);

CREATE TABLE IF NOT EXISTS channels(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  kind TEXT NOT NULL CHECK(kind IN('general','vendor','transaction','dm')),
  name TEXT NOT NULL,
  vendor_org_id TEXT REFERENCES organizations(id),
  ref_type TEXT, ref_id TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_members(
  channel_id TEXT NOT NULL REFERENCES channels(id), user_id TEXT NOT NULL REFERENCES users(id),
  org_id TEXT NOT NULL REFERENCES organizations(id), is_external INTEGER NOT NULL DEFAULT 0,
  last_read_seq INTEGER NOT NULL DEFAULT 0, joined_at TEXT NOT NULL,
  PRIMARY KEY(channel_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id), seq INTEGER NOT NULL,
  user_id TEXT REFERENCES users(id), kind TEXT NOT NULL DEFAULT 'text' CHECK(kind IN('text','card','system','agent')),
  body TEXT NOT NULL DEFAULT '', parent_id TEXT, card_json TEXT, mentions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE(channel_id, seq)
);
CREATE TABLE IF NOT EXISTS message_attachments(
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id), channel_id TEXT NOT NULL,
  filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, storage_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS message_reactions(
  message_id TEXT NOT NULL REFERENCES messages(id), user_id TEXT NOT NULL, emoji TEXT NOT NULL,
  PRIMARY KEY(message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS notifications(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), org_id TEXT NOT NULL,
  kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, read_at TEXT
);
CREATE TABLE IF NOT EXISTS integration_connections(
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), kind TEXT NOT NULL, name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'sandbox', last_sync_at TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL,
  actor_id TEXT, actor_org_id TEXT,
  action TEXT NOT NULL, object_type TEXT NOT NULL, object_id TEXT NOT NULL,
  prior_json TEXT, new_json TEXT, reason TEXT NOT NULL DEFAULT '', refs_json TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_events(org_id, seq);
CREATE INDEX IF NOT EXISTS idx_audit_obj ON audit_events(object_type, object_id);
CREATE TABLE IF NOT EXISTS access_logs(
  id TEXT PRIMARY KEY, org_id TEXT, user_id TEXT, method TEXT, path TEXT, status INTEGER, sensitive INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL
);

-- Tamper resistance inside the database: audit rows and posted ledger rows can never be updated or deleted.
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS je_no_update BEFORE UPDATE ON journal_entries BEGIN SELECT RAISE(ABORT, 'posted journal entries are immutable; post a reversal'); END;
CREATE TRIGGER IF NOT EXISTS je_no_delete BEFORE DELETE ON journal_entries BEGIN SELECT RAISE(ABORT, 'posted journal entries are immutable; post a reversal'); END;
CREATE TRIGGER IF NOT EXISTS jl_no_update BEFORE UPDATE ON journal_lines BEGIN SELECT RAISE(ABORT, 'posted journal lines are immutable; post a reversal'); END;
CREATE TRIGGER IF NOT EXISTS jl_no_delete BEFORE DELETE ON journal_lines BEGIN SELECT RAISE(ABORT, 'posted journal lines are immutable; post a reversal'); END;
CREATE TRIGGER IF NOT EXISTS jl_period_open BEFORE INSERT ON journal_lines
  WHEN (SELECT status FROM accounting_periods p JOIN journal_entries e ON e.org_id = p.org_id AND e.period = p.period WHERE e.id = NEW.entry_id) = 'locked'
  BEGIN SELECT RAISE(ABORT, 'accounting period is locked'); END;
-- A bill that has been approved or paid keeps its commercial totals.
CREATE TRIGGER IF NOT EXISTS bill_totals_frozen BEFORE UPDATE OF total_minor, subtotal_minor, tax_minor ON bills
  WHEN OLD.status IN ('approved','pending_approval') AND (NEW.total_minor <> OLD.total_minor OR NEW.subtotal_minor <> OLD.subtotal_minor OR NEW.tax_minor <> OLD.tax_minor)
  BEGIN SELECT RAISE(ABORT, 'bill totals are frozen after submission; create a revised document'); END;
-- Approved / issued commercial documents are immutable.
CREATE TRIGGER IF NOT EXISTS quote_frozen BEFORE UPDATE OF total_minor, subtotal_minor, tax_minor, discount_minor ON quotations
  WHEN OLD.status NOT IN ('draft') AND (NEW.total_minor <> OLD.total_minor OR NEW.subtotal_minor <> OLD.subtotal_minor)
  BEGIN SELECT RAISE(ABORT, 'quotation is no longer a draft; create a revision'); END;
CREATE TRIGGER IF NOT EXISTS invoice_frozen BEFORE UPDATE OF total_minor, subtotal_minor, tax_minor, discount_minor ON invoices
  WHEN OLD.status NOT IN ('draft') AND (NEW.total_minor <> OLD.total_minor OR NEW.subtotal_minor <> OLD.subtotal_minor)
  BEGIN SELECT RAISE(ABORT, 'invoice is no longer a draft; create a revision'); END;
`;
