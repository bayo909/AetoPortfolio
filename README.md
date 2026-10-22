# PayUno Flow

**Every Business Document. One Connected Payment Flow.**

A working multi-tenant B2B platform: vendor storefronts, invitation-only collaboration channels, an AI Billing Agent that drafts quotes/invoices for human approval, the **RT-FEPE** document engine (OCR / extraction / Financial Event matching → side-by-side Billing Review), OPEX/CAPEX bills with policy-driven approvals, company wallets with signed-QR invoice payment, a double-entry ledger, KYB, vendor subscriptions and a hash-linked audit trail.

> **Sandbox build.** Payments use a sandbox provider with *simulated* balances. Country KYB requirement sets are *placeholders* flagged `pending_compliance_validation`. All seeded companies are fictional and flagged `is_demo`.

## Run

```bash
npm install
npm start                    # http://localhost:3000 — seeds demo data on first start
npm test                     # 78 tests
npm run seed                 # wipe ./storage and rebuild the demo data
npm run start:docflow        # the original standalone DocFlow intake UI (src/ engine only)
```
Requires Node ≥ 22.13 (uses built-in `node:sqlite`). Scanned PDFs need `pdftoppm` (poppler-utils). Docker: `docker build -t payuno . && docker run -p 3000:3000 -v pfdata:/data payuno`.

**Demo logins** (password `PayUnoDemo!2026`, also listed on the sign-in page): `chidi.nwosu@apex.example` (employee), `funmi.adebayo@apex.example` (procurement), `tunde.bakare@apex.example` / `kunle.raji@apex.example` / `lola.ade@apex.example` (finance officers), `ngozi.eze@apex.example` (CFO), `adaeze.okonkwo@apex.example` (org admin), `ibrahim.musa@apex.example` (accountant), `kemi.ola@securetech.example` (vendor sales), `seyi.adeyemi@securetech.example` (vendor owner), `platform.admin@payuno.example`. A pending vendor invitation: `/#/invite/demo-invite-brightpath-logistics-0001`.

## Demonstrations (all seeded, all covered by tests)

1. **Vendor path** — invite → RFQ → AI draft (Kemi) → approval by a *different* vendor user (Seyi) → customer acceptance + PO → invoice → issued → payable bill → OPEX/CAPEX approval tiers → QR scan or bill page → step-up auth + sandbox payment → reconciliation → balanced journals → `Audit trace`.
2. **Document path** — upload memo or invoice in *Document Inbox* → *Billing Review* (original left, processed right) → correct → submit → approvals → finance review → approved bill → pay → journals.
3. **Exceptions** — low OCR, duplicate file/invoice, unmapped event, unverified vendor (KYB), unknown vendor → quarantine, insufficient wallet balance, per-transaction limit, provider decline, provider timeout, forged/replayed webhook, rejected approval, dispute + revised invoice, locked period → posting failure → safe retry.

## Architecture (and where it differs from the brief)

| Brief | Built | Why |
|---|---|---|
| Next.js / React / Tailwind | Express API + dependency-free ES-module SPA (`web/`), text-safe DOM builder, no build step | Smallest surface for a verifiable MVP; every control is enforced server-side regardless |
| PostgreSQL + Prisma | SQLite via `node:sqlite` (FKs on, CHECKs, partial unique indexes, triggers) | Zero-dependency, same relational integrity; schema in `platform/schema.js` is plain SQL and ports to Postgres |
| WebSockets, job queue | Server-Sent Events; in-process async job per upload (retry via *Re-run extraction*) | Not durable across restarts — swap for a queue (BullMQ/SQS) in production |
| Managed auth | scrypt passwords, opaque session tokens (hashed in DB), HttpOnly SameSite=Strict cookie + CSRF header, login lockout | Replace with your IdP / MFA for production |

Layout: `platform/` services (`auth, vendor, commerce, agent, chat, bills, payments, ledger, rtfepe, policy, compliance, subscriptions, admin`) · `platform/server.js` routes · `platform/schema.js` DB · `src/` RT-FEPE engine (OCR, parsing, matching, policy checks; one isolated instance **per tenant**) · `web/` UI · `test/platform/` tests.

### Controls that matter
* **Tenant isolation**: every tenant table carries `org_id`; services take the org from the session, never the request. Cross-tenant documents (quotes/invoices/requests) have explicit vendor/customer ids and visibility rules (customers see vendor documents only after approval/issue). Each tenant has its own RT-FEPE state directory. Platform admins have no financial/tenant-data permissions.
* **Separation of duties**: vendor approval ≠ customer approval ≠ payment. Preparer ≠ approver; requester/submitter/beneficiary cannot approve or pay; each approval step needs a different person; delegated approval limits; dual control per wallet.
* **AI agent** interprets text only. Prices come from catalogue + pricing rules, totals from `platform/money.js` (integer minor units). Unknown items become `price_required` and block submission. Output is a visibly marked draft.
* **No unsolicited invoices**: invoices require an accepted quote or a customer invoice request; unknown-vendor documents are quarantined until an audited exception.
* **Payments**: signed opaque QR (`invoice id + expiry`, HMAC), single-use scans, idempotency keys, one live intent per bill (unique index), reservations, status changes only from signature-verified, de-duplicated provider events. Ledger posting is a separate retryable state.
* **Ledger**: atomic, idempotent (`posting_key`), balanced (txn + functional currency), period locks (engine **and** trigger), reversals instead of edits (triggers block UPDATE/DELETE).
* **Audit**: per-tenant hash chain (`GET /api/audit/verify`), append-only triggers. *Tamper-evident, not tamper-proof* — anchor the head hash externally for stronger guarantees.
* **Policy**: the supplied policy `.docx` is parsed into versioned, source-referenced rules; approval tiers come from the active version; ambiguous/missing → refuse, never invent.

## Configuration
See `.env.example`. Schema migrations: `CREATE … IF NOT EXISTS` is applied at start (`platform/db.js`); for evolving production databases add numbered migrations. Secrets default to generated values stored in the DB — set them via a secret manager in production. CI: `.github/workflows/ci.yml`.

## Remaining before production
Licensed payment/wallet provider adapter (replace `sandbox` in `platform/payments.js`; keep the signed-event handler) · real KYB / sanctions / PEP providers and compliance-validated country rules · managed auth + MFA + email delivery for invitations · PostgreSQL + durable queue + S3-compatible object storage (adapter points: `core.putObject/getObject`) · antivirus scanning of uploads · real FX rate feed · ERP connectors (the `payuno.journal-export 1.0` JSON is the contract) · external anchoring of audit hashes · monitoring/alerting · penetration test and accessibility audit · platform "break-glass" exception process (currently no bypass exists) · data-retention jobs · Playwright E2E in CI.

## Known limits
Extraction/summary/matching are rule-based and lexical (LLM interpreter is optional and untested against the live API); OCR is English-only; the QR scanner needs `BarcodeDetector` (Chromium/Android) — otherwise paste the link; reports are basic; UI has been smoke-tested in Chromium only.
