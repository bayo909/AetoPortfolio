// In-memory application state + document lifecycle:
// upload -> source documents (draft) -> approval -> finance review -> bill.
const { matchLines } = require('./matcher');
const { assess, segregationError, norm } = require('./workflow');
const { validateOverride, resolveAccount } = require('./accounts');
const policy = require('./policy');
const { toCsv } = require('./csv');

class HttpError extends Error {
  constructor(status, message, issues) { super(message); this.status = status; this.issues = issues; }
}

const PREFIX = {
  'Payment Voucher': 'PV', 'Expense Claim': 'EC', 'Purchase Order': 'PO', 'Vendor Invoice': 'VI', 'Sales Invoice': 'SI',
  'Sales Receipt': 'SR', 'Customer Invoice': 'CI', 'Contract': 'CT', 'Bank Statement': 'BS', 'Payroll File': 'PF',
  'Tax Assessment': 'TA', 'Loan Agreement': 'LA', 'Inventory Receipt': 'IR',
};

function createService({ master, chunks = {}, now = () => new Date() }) {
  const uploads = new Map(), docs = new Map(), bills = new Map();
  let docSeq = 0, billSeq = 0, idSeq = 0;
  const year = () => now().getFullYear();
  const today = () => now().toISOString().slice(0, 10);
  const uid = p => `${p}_${++idSeq}`;
  const mustGet = (map, id, what) => { const v = map.get(id); if (!v) throw new HttpError(404, `${what} not found`); return v; };
  const str = v => (v == null ? '' : String(v).trim());

  const view = d => {
    const a = assess(d, master.rows, { today: today() });
    return {
      id: d.id, number: d.number, sourceDocument: d.sourceDocument, status: d.status, uploadId: d.uploadId,
      sourceLine: d.sourceLine, header: d.header, refs: d.refs, approvals: d.approvals, review: d.review,
      rejection: d.rejection, billId: d.billId, createdAt: d.createdAt,
      lines: a.lines.map(l => ({
        id: l.id, rowIndex: l.rowIndex, confidence: l.confidence, description: l.description,
        quantity: l.quantity, unitPrice: l.unitPrice, vat: l.vat, wht: l.wht,
        event: l.row.financialEvent, phrase: l.row.phrase, journalEntry: l.row.journalEntry,
        debitAccount: l.row.debitAccount, creditAccount: l.row.creditAccount, glPosting: l.row.glPosting,
        statementImpact: l.row.statementImpact, figures: l.figs, journal: l.journal,
      })),
      events: master.rows.filter(r => r.sourceDocument === d.sourceDocument)
        .map(r => ({ rowIndex: r.index, event: r.financialEvent, phrase: r.phrase, journalEntry: r.journalEntry })),
      totals: a.totals, journal: a.journal, balanced: a.balanced, tier: a.tier,
      requiredApprovals: a.requiredApprovals.map(r => ({ ...r, approval: d.approvals.find(x => x.role === r.role) || null })),
      accountsNeedingCode: a.accountsNeedingCode, issues: a.issues,
      checklists: { threeWay: policy.THREE_WAY_CHECKS, vendor: policy.VENDOR_CHECKS, lowConfidence: policy.LOW_CONFIDENCE },
      policyRefs: policyRefsFor(d, a),
    };
  };

  function policyRefsFor(d, a) {
    const ids = new Set(['FIN-POL-001', 'FIN-POL-002', 'RAG-CTRL-001', 'EVENT-LIFECYCLE-001']);
    if (['Purchase Order', 'Vendor Invoice'].includes(d.sourceDocument)) ['PROC-POL-001', 'PROC-CTRL-001'].forEach(x => ids.add(x));
    if (d.sourceDocument === 'Expense Claim') ['EXP-POL-001', 'EXP-POL-002', 'EXP-EVT-001'].forEach(x => ids.add(x));
    if (d.sourceDocument === 'Payment Voucher') ids.add('AP-EVT-002');
    if (d.sourceDocument === 'Vendor Invoice') ids.add('AP-EVT-001');
    if (a.totals.vat > 0 || a.lines.some(l => l.figs.tax.vat)) ids.add('TAX-EVT-001');
    if (a.lines.some(l => l.figs.tax.wht)) ids.add('TAX-EVT-002');
    ids.add('COA-001');
    return [...ids].filter(id => chunks[id]).map(id => ({ id, title: chunks[id].title }));
  }

  const summary = d => {
    const v = view(d);
    return {
      id: d.id, number: d.number, sourceDocument: d.sourceDocument, status: d.status,
      counterparty: d.header.counterparty, description: d.sourceLine.text, gross: v.totals.gross,
      lines: v.lines.length, events: [...new Set(v.lines.map(l => l.event))], billId: d.billId, createdAt: d.createdAt,
    };
  };

  const svc = {
    HttpError,
    sourceDocuments: () => master.sourceDocuments.map(name => ({
      name, events: master.rows.filter(r => r.sourceDocument === name).length,
    })),

    createUpload(filename, lines) {
      const up = { id: uid('upl'), filename, uploadedAt: now().toISOString(), lines };
      uploads.set(up.id, up);
      return up;
    },
    getUpload: id => mustGet(uploads, id, 'Upload'),

    previewMatches(uploadId, sourceDocument) {
      const up = mustGet(uploads, uploadId, 'Upload');
      if (!master.sourceDocuments.includes(sourceDocument)) throw new HttpError(400, `Unknown source document "${sourceDocument}"`);
      const events = master.rows.filter(r => r.sourceDocument === sourceDocument)
        .map(r => ({ rowIndex: r.index, event: r.financialEvent, phrase: r.phrase }));
      const matches = matchLines(up.lines, master.rows, sourceDocument).map(m => ({
        lineNo: m.lineNo, text: m.text, matched: m.matched,
        candidates: m.candidates.map(c => ({ rowIndex: c.row.index, event: c.row.financialEvent, phrase: c.row.phrase, score: c.score })),
      }));
      return { sourceDocument, events, matches };
    },

    /** items: [{lineNo, rowIndex?}] — rowIndex overrides the best automatic match. */
    generate(uploadId, sourceDocument, items) {
      const up = mustGet(uploads, uploadId, 'Upload');
      if (!master.sourceDocuments.includes(sourceDocument)) throw new HttpError(400, `Unknown source document "${sourceDocument}"`);
      if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'Select at least one line item');
      const auto = new Map(matchLines(up.lines, master.rows, sourceDocument).map(m => [m.lineNo, m]));
      const created = [], skipped = [];
      for (const it of items) {
        const line = up.lines.find(l => l.n === Number(it.lineNo));
        if (!line) { skipped.push({ lineNo: it.lineNo, reason: 'Line not found' }); continue; }
        let rowIndex, confidence;
        if (it.rowIndex != null && it.rowIndex !== '') {
          const row = master.rows[Number(it.rowIndex)];
          if (!row || row.sourceDocument !== sourceDocument) { skipped.push({ lineNo: line.n, reason: 'Event does not belong to this source document' }); continue; }
          rowIndex = row.index;
          const cand = auto.get(line.n).candidates.find(c => c.row.index === rowIndex);
          confidence = cand ? cand.score : 0; // manual pick without textual evidence -> low confidence, forces review ack
        } else {
          const m = auto.get(line.n);
          if (!m.matched) { skipped.push({ lineNo: line.n, reason: 'No Financial Event / High Frequency Phrase match' }); continue; }
          rowIndex = m.best.row.index; confidence = m.best.score;
        }
        const prefix = PREFIX[sourceDocument] || sourceDocument.split(/\s+/).map(w => w[0]).join('').toUpperCase();
        const d = {
          id: uid('doc'), number: `${prefix}-${year()}-${String(++docSeq).padStart(5, '0')}`,
          sourceDocument, uploadId, sourceLine: { n: line.n, text: line.text }, status: 'draft', createdAt: now().toISOString(),
          header: { counterparty: '', department: '', costCenter: '', documentDate: today(), purpose: line.text, preparedBy: '', receiptsAttached: false },
          refs: { purchaseRequest: '', purchaseOrder: '', receipt: '', invoice: '', quotation: '', quotationWaiver: '' },
          lines: [{ id: uid('ln'), rowIndex, confidence, description: line.text, quantity: '', unitPrice: '', vat: '', wht: '' }],
          approvals: [], review: { threeWay: {}, vendorChecks: {}, ackLowConfidence: false, accountOverrides: {}, by: null, at: null },
          rejection: null, billId: null,
        };
        docs.set(d.id, d);
        created.push(summary(d));
      }
      return { created, skipped };
    },

    listDocuments: () => [...docs.values()].map(summary),
    getDocument: id => view(mustGet(docs, id, 'Document')),

    update(id, patch) {
      const d = mustGet(docs, id, 'Document');
      if (d.status !== 'draft') throw new HttpError(409, 'Only draft documents can be edited');
      if (patch.header) for (const k of Object.keys(d.header)) if (k in patch.header) d.header[k] = k === 'receiptsAttached' ? !!patch.header[k] : str(patch.header[k]);
      if (patch.refs) for (const k of Object.keys(d.refs)) if (k in patch.refs) d.refs[k] = str(patch.refs[k]);
      if (Array.isArray(patch.lines)) {
        const next = patch.lines.map(l => {
          const old = d.lines.find(x => x.id === l.id);
          let rowIndex = old ? old.rowIndex : undefined;
          let confidence = old ? old.confidence : 0;
          if (l.rowIndex != null && (!old || Number(l.rowIndex) !== old.rowIndex)) {
            const row = master.rows[Number(l.rowIndex)];
            if (!row || row.sourceDocument !== d.sourceDocument) throw new HttpError(400, 'Event does not belong to this source document');
            rowIndex = row.index;
            const cand = matchLines([{ n: 0, text: d.sourceLine.text }], master.rows, d.sourceDocument)[0].candidates.find(c => c.row.index === rowIndex);
            confidence = cand ? cand.score : 0;
          }
          if (rowIndex == null) throw new HttpError(400, 'Line needs a financial event');
          return {
            id: old ? old.id : uid('ln'), rowIndex, confidence, description: l.description == null ? (old ? old.description : '') : str(l.description),
            quantity: str(l.quantity), unitPrice: str(l.unitPrice), vat: str(l.vat), wht: str(l.wht),
          };
        });
        d.lines = next;
      }
      return view(d);
    },

    submit(id, by) {
      const d = mustGet(docs, id, 'Document');
      if (d.status !== 'draft') throw new HttpError(409, `Document is ${d.status}`);
      if (!str(by)) throw new HttpError(400, 'Preparer name is required');
      d.header.preparedBy = str(by);
      const errs = assess(d, master.rows, { today: today() }).issues.submit.filter(i => i.level === 'error');
      if (errs.length) throw new HttpError(422, 'Document is not ready for approval', errs);
      d.status = 'pending_approval'; d.rejection = null;
      return view(d);
    },

    approve(id, role, by) {
      const d = mustGet(docs, id, 'Document');
      if (d.status !== 'pending_approval') throw new HttpError(409, `Document is ${d.status}`);
      const a = assess(d, master.rows, { today: today() });
      if (!a.requiredApprovals.some(r => r.role === role)) throw new HttpError(400, `${role} is not a required approver`);
      if (d.approvals.some(x => x.role === role)) throw new HttpError(409, `${role} has already approved`);
      const err = segregationError(d, by, role);
      if (err) throw new HttpError(403, err);
      d.approvals.push({ role, by: str(by), at: now().toISOString() });
      if (a.requiredApprovals.every(r => d.approvals.some(x => x.role === r.role))) d.status = 'approved';
      return view(d);
    },

    reject(id, by, reason) {
      const d = mustGet(docs, id, 'Document');
      if (!['pending_approval', 'approved', 'reviewed'].includes(d.status)) throw new HttpError(409, `Document is ${d.status}`);
      if (!str(by) || !str(reason)) throw new HttpError(400, 'Name and reason are required');
      d.status = 'draft'; d.approvals = [];
      d.review = { threeWay: {}, vendorChecks: {}, ackLowConfidence: false, accountOverrides: {}, by: null, at: null };
      d.rejection = { by: str(by), reason: str(reason), at: now().toISOString() };
      return view(d);
    },

    financeReview(id, { by, threeWay, vendorChecks, ackLowConfidence, accountOverrides } = {}) {
      const d = mustGet(docs, id, 'Document');
      if (d.status !== 'approved') throw new HttpError(409, `Document is ${d.status}; Finance Review follows approval`);
      const err = segregationError(d, by, 'Finance Reviewer');
      if (err) throw new HttpError(403, err);
      const ov = {};
      for (const [k, v] of Object.entries(accountOverrides || {})) if (str(v)) ov[k] = str(v);
      for (const [k, v] of Object.entries(ov)) { const m = validateOverride(k, v); if (m) throw new HttpError(422, m); }
      const draft = { ...d, review: { threeWay: threeWay || {}, vendorChecks: vendorChecks || {}, ackLowConfidence: !!ackLowConfidence, accountOverrides: ov, by: null, at: null } };
      const errs = assess(draft, master.rows, { today: today() }).issues.review.filter(i => i.level === 'error');
      d.review = draft.review;
      if (errs.length) throw new HttpError(422, 'Finance review incomplete', errs);
      d.review.by = str(by); d.review.at = now().toISOString(); d.status = 'reviewed';
      return view(d);
    },

    convertToBill(id, by) {
      const d = mustGet(docs, id, 'Document');
      if (d.status !== 'reviewed') throw new HttpError(409, `Document is ${d.status}; it must be finance-reviewed before conversion`);
      const err = segregationError(d, by, 'Payment Processor');
      if (err) throw new HttpError(403, err);
      const a = assess(d, master.rows, { today: today() });
      const missing = a.requiredApprovals.filter(r => !d.approvals.some(x => x.role === r.role));
      if (missing.length) throw new HttpError(422, 'Mandatory approvals are incomplete', missing.map(m => ({ level: 'error', msg: `${m.role} approval missing`, ref: 'FIN-POL-001' })));
      if (!a.balanced) throw new HttpError(422, 'Journal does not balance');
      // aggregate identical account/side lines for the posted entry
      const agg = new Map();
      for (const j of a.journal) {
        const k = `${j.side}|${j.account}`;
        const cur = agg.get(k) || { side: j.side, account: j.account, code: j.code, memo: j.memo, amount: 0 };
        cur.amount = Math.round((cur.amount + j.amount) * 100) / 100; agg.set(k, cur);
      }
      const entries = [...agg.values()].sort((x, y) => (x.side === y.side ? 0 : x.side === 'Dr' ? -1 : 1));
      const bill = {
        id: uid('bill'), number: `BILL-${year()}-${String(++billSeq).padStart(5, '0')}`,
        documentId: d.id, documentNumber: d.number, sourceDocument: d.sourceDocument,
        counterparty: d.header.counterparty, department: d.header.department, costCenter: d.header.costCenter,
        documentDate: d.header.documentDate, purpose: d.header.purpose, currency: 'NGN', refs: d.refs,
        totals: a.totals, entries, glPosting: entries.length ? 'Ready to post' : 'No GL posting (commitment only)',
        lines: a.lines.map(l => ({ event: l.row.financialEvent, phrase: l.row.phrase, description: l.description, glPosting: l.row.glPosting, figures: l.figs, confidence: l.confidence })),
        workflow: {
          preparedBy: d.header.preparedBy, approvals: d.approvals, financeReviewer: d.review.by, financeReviewedAt: d.review.at,
          paymentProcessor: str(by), convertedAt: now().toISOString(),
        },
        policyRefs: view(d).policyRefs, status: 'billed',
      };
      bills.set(bill.id, bill);
      d.status = 'billed'; d.billId = bill.id;
      return bill;
    },

    listBills: () => [...bills.values()].map(b => ({
      id: b.id, number: b.number, documentNumber: b.documentNumber, sourceDocument: b.sourceDocument,
      counterparty: b.counterparty, gross: b.totals.gross, payable: b.totals.payable, glPosting: b.glPosting, convertedAt: b.workflow.convertedAt,
    })),
    getBill: id => mustGet(bills, id, 'Bill'),
    billCsv(id) {
      const b = mustGet(bills, id, 'Bill');
      return toCsv([
        ['Bill', b.number], ['Source document', b.documentNumber], ['Counterparty', b.counterparty], ['Date', b.documentDate], [],
        ['Side', 'Account code', 'Account', 'Amount (NGN)'],
        ...b.entries.map(e => [e.side, e.code || '', e.account, e.amount.toFixed(2)]),
      ]);
    },
    policyChunk: id => chunks[id] || null,
    policyChunks: () => Object.values(chunks).map(({ id, title }) => ({ id, title })),
  };
  return svc;
}

module.exports = { createService, HttpError };
