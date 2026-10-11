# Aeto Connect

A Slack-style web app where **B2B vendors join a buyer's workspace**, the **end user (buyer) requests source documents**
from them in chat, and the **RT-FEPE engine** (Real-Time Financial Entry Processing Engine) turns each submitted document
into a balanced, audited double-entry journal that the buyer can pay from the same conversation.

The earlier single-user DocFlow MVP (upload → source documents → bills under the PayUno policy) is kept and still runs at `/docflow`.

## The flow

1. **Workspaces.** A company admin creates a workspace and becomes its **owner / end user**. Other companies join with the
   workspace invite code and become **vendors**; each vendor gets a private `#pay-<vendor>` channel. A vendor company can also
   own its own workspace and be the buyer there.
2. **Request.** Only owner-company members can click **Request a document**: pick a template, vendor, note and due date.
   Vendors cannot request documents, and cannot submit unsolicited ones. They can only answer a request addressed to their company.
3. **Respond.** The vendor uploads a soft copy (**unstructured**: PDF, Word, text; **structured**: CSV, JSON) or **fills in the
   template form** (line items, VAT rate, WHT).
4. **RT-FEPE runs immediately** (in the request, no batch):
   - extracts number, date, currency, issuer, line items, subtotal, VAT, WHT, total;
   - validates arithmetic, required template fields, currency, dates;
   - maps each line to a Chart of Accounts code and drafts `Dr expense / Dr Input VAT / Cr Accounts Payable / Cr WHT Payable`,
     converted to USD with the rounding residue kept inside the entry so it always balances;
   - raises anomaly flags: **duplicate** (same vendor + number, same file hash, or same date + amount), **unusual amount**
     (> 3× the vendor's average), **large amount**, **unauthorised mapping**, total mismatch, unknown currency, future/stale dates,
     issuer ≠ submitting vendor.
5. **Review in chat.** An owner-side admin/approver accepts (optionally reclassifying a line within allowed accounts) or sends the
   document back with a reason. Flags that block need a written override reason, which goes into the audit log. With
   *auto-post* on, documents with zero blocking flags post by themselves.
6. **Pay in chat.** An approver releases payment from the thread: `Dr Accounts Payable / Cr Bank`, with a receipt card
   the vendor sees in their channel.
7. **Ledger & audit.** Live trial balance, journal entries, CSV export, and a **voucher** per entry: the source file (SHA-256),
   the extracted data, the journal and the chat transcript that led to it. A hash-chained audit log can be verified at any time.

### Controls

| Control | Where |
|---|---|
| Vendors only see channels their company is in; request/submission threads are private to the owner and the addressed vendor, even in a shared channel | `service.js` `canSee`, `visible` |
| Only the owner company can request documents, review, pay, or see the ledger | `createRequest`, `ownerReviewer`, `ownerWs` |
| Segregation of duties (toggle in Settings): requester ≠ accepter; payer ∉ {requester, accepter} | `accept`, `pay` |
| Posted entries are deep-frozen and each entry's SHA-256 is committed in the audit chain; editing an entry or the log is detected | `postEntry`, `auditVerify` |
| Every chat message, submission, decision, entry and payment is an audit record chained by SHA-256 | `fepe/audit.js` |
| Passwords: scrypt + per-user salt; sessions: random 192-bit tokens stored hashed; HttpOnly SameSite=Lax cookie; login/join rate limits | `service.js`, `api.js` |
| Downloads are served as attachments with `nosniff` and a sandbox CSP; UI renders all text via `textContent` | `api.js`, `app.js` |

## Run

```bash
npm install
npm start                 # http://localhost:3000   (PORT=… to change)
npm run demo              # same, with demo companies and open requests (DEMO=1)
DATA_DIR=./.data npm start   # persist state + uploaded files across restarts
npm test
```

Demo logins (password `demo-pass-123`): buyer **ada@northwind.test** (admin), **kemi@northwind.test**, **tolu@northwind.test**
(approvers); vendors **tunde@securetech.test** and **chidi@okafor.test**. Use two browser profiles (or a private window) to be
buyer and vendor at once, then upload files from `samples/invoices/` (a clean invoice, one with a wrong total, a CSV, a JSON
receipt, a tax clearance certificate). Submit the clean invoice twice to see duplicate detection. A sensible walk-through:
vendor submits → Kemi accepts → Tolu releases payment (the requester, Ada, can't) → Ledger → open the voucher → Verify audit chain.

## Templates

Built in: **Vendor Invoice** (posts to AP), **Expense Receipt / Claim** (posts to Employee Payables), **Purchase Order
Acknowledgement** and **Tax Exemption / Compliance Certificate** (supporting documents: stored with the audit trail, no entry).
Owner admins/approvers can clone a template and add required custom fields (read from forms, `Label: value` lines in text,
and JSON/CSV columns).

## Honest limits of this build

- **Payments are simulated.** "Release payment" books the bank entry and issues a receipt; no bank or payment-gateway call is made.
  `rail: "simulated"` is shown everywhere. A real rail would plug in at `pay()` in `src/chat/service.js`.
- **No OCR engine is bundled.** Images (PNG/JPG) are stored as evidence and flagged "needs data"; pass an `ocr(buffer, ext)`
  function to `createChatService` to read them. Scanned PDFs without a text layer extract nothing. No `.xlsx`/`.doc`.
- **Extraction is heuristic** (labels, tables, `qty × price = amount`). It is deliberately conservative: anything it can't
  reconcile is flagged for the approver rather than guessed. Expect to tune patterns for real vendors' layouts.
- **FX rates are static reference rates** (`src/fepe/fx.js`, override with `FX_RATES='{"NGN":0.0007}'`), not dated market rates, so no FX gain/loss is computed on payment.
- **Chart of accounts is a fixed default** (`src/fepe/coa.js`), adapted from the PayUno policy ranges; there is no per-workspace COA editor, no credit notes, no reversal entries, no partial payments, and WHT is booked as a liability but its remittance isn't modelled.
- **Single process, JSON-file persistence.** Fine for a demo or pilot; use a real database before multi-instance deployment. Set `NODE_ENV=production` behind HTTPS so the cookie is `Secure`.
- Real-time updates use server-sent events (ids only; clients refetch through the authorised endpoints).
- GAAP/IFRS: the engine keeps balanced, immutable, traceable records, but that's not a compliance certification; account policy decisions still belong to your accountants.

## Layout

`server.js` app wiring · `src/chat/service.js` domain rules and authorisation · `src/chat/api.js` HTTP + SSE ·
`src/chat/store.js` persistence · `src/fepe/` engine (`parse`, `engine`, `coa`, `fx`, `templates`, `audit`) ·
`src/extract.js`, `src/matcher.js`, `data/Financial_Master_Data.csv` (text extraction and financial-event matching, shared with DocFlow) ·
`public/` UI · `docflow.js` + `public/docflow/` previous DocFlow app · `scripts/demo.js` demo data · `test/` unit, service and HTTP tests.
