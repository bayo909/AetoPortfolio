# DocFlow — document intake, billing and payment (MVP)

Uploaded documents are stored as **records**, processed by one of two pipelines, land on a **Billing** page for
corrections, go through the PayUno policy approvals, and become **bills** that are then paid.

```
upload ──► record (file stored) ──► process ──► Billing (corrections) ──► approvals ──► finance review ──► Bill ──► payment
            structured | unstructured
```

## 1 · Structured documents (invoices, quotes, receipts)

They already are source documents. After upload the record is stored, then:
text is read (OCR for images and scanned PDFs, direct extraction for text PDFs/.docx) →
document number, date, party, line items (description / qty / unit price), VAT, WHT and total are parsed →
each line is matched to a Financial Event → the result is posted as a billing document.
Document type is auto-detected (quote / receipt / invoice) or chosen: *Invoice (payable)* → Vendor Invoice,
*Invoice (receivable)* → Customer Invoice, *Quote* → Quote, *Receipt* → Sales Receipt.
The party is matched to the vendor/customer master (address, bank account, tax ID come from there).

## 2 · Unstructured documents (approved source documents, proposals, notes, memos)

Text is extracted → **summarised to the key financial events only** (sentences with amounts, payment/expense wording
or a Financial Event match; chit-chat is dropped) → each event is matched to **Financial Event** and **High Frequency
Phrase** in `data/Financial_Master_Data.csv` → source documents (Expense Claim, Payment Voucher, Vendor Invoice, …) are
generated, one per document type and party, with line items billed at **illustrative (fictitious) figures**.
The **source header** (name, address, account number, bank, department, cost centre) is pulled from the
employee/vendor/customer master (**Parties** tab). Figures are deterministic placeholders (7.5 % VAT / 5 % WHT as in
policy TAX-EVT-001/002), flagged *illustrative*, and cannot be submitted until corrected or confirmed in Billing.

After either pipeline the **record page** shows the source document (image / PDF / rendered .docx / text) on the left and
the processed document on the right (summary + generated documents, or the parsed invoice).

## Billing → approval → bill → payment (`PayUno Enterprise Finance & Operations Policy`)

| Step | Control (policy chunk) |
|---|---|
| Corrections | edit header (or pick from master), refs, events, figures. Required: counterparty, department, cost centre, purpose; purchase request > ₦100k, quotation > ₦500k, PO + receipt for vendor invoices, invoice ref on vendor payments (PROC-POL-001, PROC-CTRL-001, AP-EVT-002); VAT/WHT only where the event allows (TAX-EVT-001/002); OCR < 75 % and unknown-party warnings |
| Approvals | amount tiers ₦100k / 500k / 2m / 10m (FIN-POL-001) + additional approver for payroll, tax, loan, contract and PO documents |
| Finance review (final approval) | independent reviewer; three-way match + vendor verification; low-confidence acknowledgement (RAG-CTRL-001); COA code for accounts the policy chart doesn't name (COA-001). **On completion the document becomes a bill** with a balanced journal |
| Payment (Bills page) | a Payment Processor independent of everyone before; beneficiary account required; posts Dr Payable / Cr Bank (AP-EVT-002) |

Segregation of duties (FIN-POL-002 / GOV-001): preparer, each approver, finance reviewer and payment processor must be
different people; nobody may act on a document where they are the counterparty.

## Logins

Everything except the sign-in page and `/api/config` requires a session. Two kinds of login:

- **Buyers** (company staff). Each carries the policy role(s) it may act as: *Preparer* (upload, correct, submit), *Department Manager*,
  *Finance*, *Head of Department*, *Finance Manager*, *Business Unit Head*, *CFO*, *CEO / Executive Committee*, *Additional Approver*
  (approvals), *Finance Reviewer* (final approval → bill), *Payment Processor* (pay), *Admin* (manages parties and vendor logins; cannot approve or pay).
  The acting name comes from the login, never from a typed field, so the segregation-of-duties checks (FIN-POL-002) cannot be sidestepped.
- **Vendors**: one login per vendor. They upload their own invoices/quotes (always matched to their own vendor record) and see only
  their own records, documents and bills — status, amounts and payment reference, not the journal or the control trail.

Passwords are random, shown **once**, and stored only as scrypt hashes. Sessions are server-side, HttpOnly + SameSite=Lax cookies (12 h);
5 wrong passwords lock that username+IP for 10 minutes.

```bash
npm run logins                 # (re)generate ALL logins; old passwords stop working. Stop the server first.
npm run logins -- --missing    # only add logins that do not exist yet (e.g. after adding a vendor)
```
First start with no logins generates them automatically and prints the sheet (also saved to `storage/logins.txt`, mode 0600 — delete it once distributed).
A single vendor's login can also be created/reset by an Admin on the **Parties** tab.

## Run

```bash
npm install
npm start                   # http://localhost:3000   (PORT, STORAGE_DIR to override)
npm test
```
Use the sample buttons on the Upload page (`samples/`: invoice image + PDF, memo, .docx proposal).
State persists in `storage/` (uploaded files + `db.json`, git-ignored). OCR is offline (tesseract.js + bundled English data).

## Known limits

- Logins are username/password only (no MFA, password-change screen or self-service reset); put it behind HTTPS when hosted (the cookie is marked Secure on HTTPS requests).
- Summary is extractive and rule-based (no LLM); matching is lexical (tokens, stems, synonyms). Parsing handles labelled
  and tabular invoices, not arbitrary layouts. OCR quality bounds extraction quality; low confidence is flagged.
- Scanned PDFs need `pdftoppm` (poppler-utils) on the server. English OCR only. Max 6 pages OCR'd per PDF.
- The master data has no *Quote* type; `data/Supplemental_Financial_Events.csv` adds one (no GL posting) without touching your CSV.
- Parties can be listed and added in the UI (edit via `PATCH /api/parties/:id`). Many master-data accounts (Revenue, Expense,
  Interest Expense…) have no code in the policy chart of accounts; the finance reviewer assigns one in the right range.

## Layout

`server.js` API · `src/pipeline.js` the two pipelines · `src/extract.js` + `src/ocr.js` text/OCR ·
`src/structured.js` invoice parser · `src/summarize.js` key-event summary · `src/matcher.js` event matching ·
`src/parties.js` master data · `src/figures.js` illustrative figures · `src/workflow.js` figures, journals, policy checks ·
`src/service.js` records / documents / bills lifecycle · `src/store.js` persistence · `public/` UI · `test/` tests.
