# DocFlow — unstructured document → source document → bill (MVP)

A small web app that turns an uploaded, unstructured document into source documents
(payment voucher, expense claim, purchase order, …) and then processes each one under the
PayUno Enterprise Finance & Operations policy until it becomes a bill with a balanced journal entry.

## How it works

1. **Upload** (`.docx`, `.pdf`, `.txt`, `.md`, `.csv`). Text is extracted into numbered line items held **in memory**.
2. **Select source document.** Pick a type from `data/Financial_Master_Data.csv` (Payment Voucher, Vendor Invoice,
   Purchase Order, Contract, Expense Claim, …). Every line item is matched to that type's **Financial Event** and
   **High Frequency Phrase** (stop-word removal, light stemming, synonyms such as supplier = vendor; exact phrase = 100 %).
   Each line you keep becomes its **own source document** with a line item carrying the matched event, debit/credit
   accounts and journal template — **no figures**; you enter quantity, unit price, VAT and WHT.
   Unmatched lines are listed and can be assigned an event manually (low confidence → Finance Reviewer must confirm).
3. **Payment processing** — rules read from `data/PayUno_Finance_Operations_Policy.docx` (chunks are served in the UI):
   | Step | Control (policy chunk) |
   |---|---|
   | Complete figures | counterparty, department, cost centre, purpose; VAT/WHT only where the event allows (TAX-EVT-001/002); purchase request > ₦100k, quotation > ₦500k, PO + receipt for vendor invoices, invoice ref on vendor payments (PROC-POL-001, AP-EVT-002); expense-claim 15-business-day warning (EXP-POL-001) |
   | Approvals | amount tiers ₦100k / 500k / 2m / 10m (FIN-POL-001) + additional approver for payroll, tax, loan, contract, PO |
   | Finance review | independent reviewer; three-way match + vendor verification (PROC-CTRL-001); low-confidence acknowledgement (RAG-CTRL-001); COA code for accounts the policy COA doesn't name (COA-001) |
   | Convert to bill | a different Payment Processor; journal must balance; bill gets a number, control trail, CSV export |

   Segregation of duties (FIN-POL-002 / GOV-001): preparer, each approver, finance reviewer and payment processor must be
   different people, and nobody may act on a document where they are the counterparty.

## Run

```bash
npm install
npm start          # http://localhost:3000   (PORT=... to change)
npm test
```
Try it: click **Use sample payables pack**, choose *Payment Voucher* (line 1 matches) or *Vendor Invoice* (lines 3–6).

## Known MVP limits

- **State is in memory** — restart the server and uploads, documents and bills are gone.
- **No authentication.** Approver names are typed in; segregation checks compare names, not logged-in users.
- No OCR: scanned PDFs/images produce no text. No `.xlsx`/`.doc`.
- The master data has no *Quote* source document, so none is offered; add rows to the CSV and it appears automatically.
- Many accounts in the master data (Revenue, Expense, Interest Expense, …) have no code in the policy chart of accounts;
  the Finance Reviewer assigns a code within the correct range. `Input VAT` is mapped to 2310 because the COA has no input-VAT account.
- Matching is lexical (tokens/synonyms), not semantic; WHT/VAT amounts are entered, not computed from rates.

## Layout

`server.js` API · `src/matcher.js` line→event matching · `src/workflow.js` figures, journals, policy checks ·
`src/service.js` lifecycle (draft → pending approval → approved → reviewed → billed) · `src/accounts.js` COA mapping ·
`src/policy.js` policy chunks + thresholds · `public/` UI · `test/` unit + end-to-end service tests.

## Further reading

- [RT-FEPE business case study](docs/RT-FEPE_Case_Study.md) — the real-time financial entry processing vision and ROI analysis from the Sales, HR and Accounting perspectives.
