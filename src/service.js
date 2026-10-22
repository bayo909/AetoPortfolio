// Application state and document lifecycle.
//   record (stored upload) --process--> billing document(s) --corrections--> approvals --> finance review --> bill --> payment
const path = require('path');
const { matchLines } = require('./matcher');
const { assess, segregationError } = require('./workflow');
const { validateOverride } = require('./accounts');
const policy = require('./policy');
const { toCsv } = require('./csv');
const { createStore } = require('./store');
const { extractDocument, docxHtml, mimeFor } = require('./extract');
const { processStructured, processUnstructured, STRUCTURED_TYPES } = require('./pipeline');
const { SEED, PARTY_FIELDS, KINDS } = require('./parties');
const auth = require('./auth');

const DUMMY_HASH = auth.hashPassword('docflow-dummy');

class HttpError extends Error {
  constructor(status, message, issues) { super(message); this.status = status; this.issues = issues; }
}

const PREFIX = {
  'Payment Voucher': 'PV', 'Expense Claim': 'EC', 'Purchase Order': 'PO', 'Vendor Invoice': 'VI', 'Sales Invoice': 'SI',
  'Sales Receipt': 'SR', 'Customer Invoice': 'CI', 'Contract': 'CT', 'Bank Statement': 'BS', 'Payroll File': 'PF',
  'Tax Assessment': 'TA', 'Loan Agreement': 'LA', 'Inventory Receipt': 'IR', 'Quote': 'QT',
};
const HEADER_KEYS = ['partyId', 'partyKind', 'counterparty', 'address', 'accountNumber', 'bankName', 'taxId', 'email', 'department', 'costCenter', 'documentDate', 'purpose', 'preparedBy'];
const emptyReview = () => ({ threeWay: {}, vendorChecks: {}, ackLowConfidence: false, accountOverrides: {}, by: null, at: null });
const PAYABLE_ACCOUNTS = ['Accounts Payable', 'Employee Payable'];
const clone = o => JSON.parse(JSON.stringify(o));

function createService({ master, chunks = {}, storageDir = null, now = () => new Date() }) {
  const store = createStore(storageDir);
  const state = store.load() || { seq: { id: 0, doc: 0, bill: 0 }, records: {}, documents: {}, bills: {}, parties: clone(SEED) };
  state.users = state.users || []; state.sessions = state.sessions || {};
  const buffers = new Map(); // memory-only fallback when there is no storage dir
  const persist = () => store.save(state);
  const year = () => now().getFullYear();
  const today = () => now().toISOString().slice(0, 10);
  const uid = p => `${p}_${++state.seq.id}`;
  const mustGet = (coll, id, what) => { const v = state[coll][id]; if (!v) throw new HttpError(404, `${what} not found`); return v; };
  const str = v => (v == null ? '' : String(v).trim());
  const docs = () => Object.values(state.documents);

  /* ---- who is acting. A plain string is an unrestricted internal caller (tests/scripts); an actor object comes from a login. ---- */
  const actorOf = a => (a && typeof a === 'object' ? a : { name: str(a), role: 'buyer', approvalRoles: null, partyId: null });
  const needBuyer = a => { if (a.role === 'vendor') throw new HttpError(403, 'Vendor logins cannot perform this action'); };
  const needRole = (a, role) => { needBuyer(a); if (a.approvalRoles && !a.approvalRoles.includes(role)) throw new HttpError(403, `Your login (${a.name}) is not authorised to act as ${role}`); };
  const isVendor = a => a.role === 'vendor';
  const ownsRecord = (a, r) => !isVendor(a) || r.ownerPartyId === a.partyId || r.documentIds.some(id => state.documents[id] && state.documents[id].header.partyId === a.partyId);
  const ownsDoc = (a, d) => !isVendor(a) || d.header.partyId === a.partyId || (state.records[d.origin.recordId] || {}).ownerPartyId === a.partyId;
  const ownsBill = (a, b) => !isVendor(a) || b.partyId === a.partyId || (state.records[b.origin.recordId] || {}).ownerPartyId === a.partyId;
  const ownRecord = (id, actor) => { const r = mustGet('records', id, 'Record'); if (!ownsRecord(actorOf(actor), r)) throw new HttpError(404, 'Record not found'); return r; };

  /* ----------------------------- documents ----------------------------- */
  function makeDocument(spec) {
    const prefix = PREFIX[spec.sourceDocument] || spec.sourceDocument.split(/\s+/).map(w => w[0]).join('').toUpperCase();
    const d = {
      id: uid('doc'), number: `${prefix}-${year()}-${String(++state.seq.doc).padStart(5, '0')}`,
      sourceDocument: spec.sourceDocument, status: 'draft', createdAt: now().toISOString(),
      origin: { recordId: spec.record.id, intake: spec.intake, filename: spec.record.filename, ocrConfidence: spec.record.ocrConfidence, summaryText: spec.summaryText || '', notes: spec.notes || [] },
      header: { partyId: '', partyKind: '', counterparty: '', address: '', accountNumber: '', bankName: '', taxId: '', email: '', department: '', costCenter: '',
        documentDate: today(), purpose: '', preparedBy: spec.record.uploadedBy || '', receiptsAttached: false, ...spec.header },
      refs: { purchaseRequest: '', purchaseOrder: '', receipt: '', invoice: '', quotation: '', quotationWaiver: '', ...spec.refs },
      lines: spec.lines.map(l => ({ id: uid('ln'), statedAmount: null, wht: '', vat: '', ...l })),
      approvals: [], review: emptyReview(), rejection: null, billId: null,
    };
    state.documents[d.id] = d;
    return d;
  }

  function policyRefsFor(d, a) {
    const ids = new Set(['FIN-POL-001', 'FIN-POL-002', 'RAG-CTRL-001', 'EVENT-LIFECYCLE-001', 'COA-001']);
    const sd = d.sourceDocument;
    if (['Purchase Order', 'Vendor Invoice', 'Quote'].includes(sd)) ['PROC-POL-001', 'PROC-CTRL-001'].forEach(x => ids.add(x));
    if (sd === 'Expense Claim') ['EXP-POL-001', 'EXP-POL-002', 'EXP-EVT-001'].forEach(x => ids.add(x));
    if (sd === 'Payment Voucher') ids.add('AP-EVT-002');
    if (sd === 'Vendor Invoice') ids.add('AP-EVT-001');
    if (a.lines.some(l => l.figs.tax.vat)) ids.add('TAX-EVT-001');
    if (a.lines.some(l => l.figs.tax.wht)) ids.add('TAX-EVT-002');
    return [...ids].filter(id => chunks[id]).map(id => ({ id, title: chunks[id].title }));
  }

  const view = d => {
    const a = assess(d, master.rows, { today: today() });
    return {
      id: d.id, number: d.number, sourceDocument: d.sourceDocument, status: d.status, origin: d.origin, company: policy.COMPANY,
      header: d.header, refs: d.refs, approvals: d.approvals, review: d.review, rejection: d.rejection, billId: d.billId, createdAt: d.createdAt,
      lines: a.lines.map(l => ({
        id: l.id, rowIndex: l.rowIndex, confidence: l.confidence, description: l.description, evidence: l.evidence, figureSource: l.figureSource, statedAmount: l.statedAmount,
        quantity: l.quantity, unitPrice: l.unitPrice, vat: l.vat, wht: l.wht,
        event: l.row.financialEvent, phrase: l.row.phrase, journalEntry: l.row.journalEntry, debitAccount: l.row.debitAccount, creditAccount: l.row.creditAccount,
        glPosting: l.row.glPosting, statementImpact: l.row.statementImpact, figures: l.figs, journal: l.journal,
      })),
      events: master.rows.filter(r => r.sourceDocument === d.sourceDocument).map(r => ({ rowIndex: r.index, event: r.financialEvent, phrase: r.phrase, journalEntry: r.journalEntry })),
      totals: a.totals, journal: a.journal, balanced: a.balanced, tier: a.tier,
      requiredApprovals: a.requiredApprovals.map(r => ({ ...r, approval: d.approvals.find(x => x.role === r.role) || null })),
      accountsNeedingCode: a.accountsNeedingCode, issues: a.issues,
      checklists: { threeWay: policy.THREE_WAY_CHECKS, vendor: policy.VENDOR_CHECKS, lowConfidence: policy.LOW_CONFIDENCE },
      policyRefs: policyRefsFor(d, a),
    };
  };

  const summary = d => {
    const v = view(d);
    return {
      id: d.id, number: d.number, sourceDocument: d.sourceDocument, status: d.status, intake: d.origin.intake, recordId: d.origin.recordId, filename: d.origin.filename,
      counterparty: d.header.counterparty, description: d.header.purpose, gross: v.totals.gross, lines: v.lines.length,
      events: [...new Set(v.lines.map(l => l.event))], billId: d.billId, createdAt: d.createdAt,
    };
  };

  function applyParty(d, p) {
    d.header.partyId = p.id; d.header.partyKind = p.kind; d.header.counterparty = p.name;
    for (const k of ['address', 'accountNumber', 'bankName', 'taxId', 'email']) d.header[k] = p[k] || '';
    if (p.department) d.header.department = p.department;
    if (p.costCenter) d.header.costCenter = p.costCenter;
  }

  /* ------------------------------- records ------------------------------ */
  const recordSummary = r => ({
    id: r.id, filename: r.filename, mime: r.mime, size: r.size, intake: r.intake, docType: r.docType, uploadedBy: r.uploadedBy, uploadedAt: r.uploadedAt,
    status: r.status, error: r.error, method: r.method, ocrConfidence: r.ocrConfidence, documentIds: r.documentIds, note: r.note,
  });
  const readBuffer = r => (store.persistent ? store.readFile(r.file) : buffers.get(r.id));

  async function runProcessing(r) {
    r.status = 'processing'; r.error = null; persist();
    try {
      const ex = await extractDocument(readBuffer(r), r.filename);
      r.lines = ex.lines; r.method = ex.method; r.ocrConfidence = ex.ocrConfidence;
      if (!ex.lines.length) throw new HttpError(422, 'No text could be extracted from this document.');
      const ctx = { master, parties: state.parties, makeDocument, today };
      const res = r.intake === 'structured' ? processStructured(ctx, r) : processUnstructured(ctx, r);
      r.summary = res.summary; r.structured = res.structured || null; r.documentIds = res.documentIds; r.note = res.note || null;
      r.status = 'processed';
    } catch (e) {
      r.status = 'failed'; r.error = e.message;
    }
    persist();
    return r;
  }

  const svc = {
    HttpError,
    config: () => ({
      company: policy.COMPANY,
      structuredTypes: Object.entries(STRUCTURED_TYPES).map(([key, t]) => ({ key, label: t.label, sourceDocument: t.sourceDocument })),
      sourceDocuments: master.sourceDocuments,
    }),

    /** Stores the upload as a record immediately; call processRecord() to run the pipeline. */
    createRecord({ buffer, filename, intake, docType, uploadedBy, actor }) {
      const a = actorOf(actor);
      if (isVendor(a)) {   // vendors submit their own invoices / quotes only
        intake = 'structured'; uploadedBy = a.name;
        docType = ['invoice_payable', 'quote'].includes(docType) ? docType : 'invoice_payable';
      } else if (actor) uploadedBy = a.name;
      if (!['structured', 'unstructured'].includes(intake)) throw new HttpError(400, 'Choose the document type: structured or unstructured');
      if (intake === 'structured' && docType && docType !== 'auto' && !STRUCTURED_TYPES[docType]) throw new HttpError(400, 'Unknown structured document type');
      const id = uid('rec');
      const ext = path.extname(filename).toLowerCase();
      const r = {
        id, filename, mime: mimeFor(filename), size: buffer.length, intake, docType: intake === 'structured' ? (docType || 'auto') : null, uploadedBy: str(uploadedBy), ownerPartyId: isVendor(a) ? a.partyId : null,
        uploadedAt: now().toISOString(), status: 'stored', error: null, method: null, ocrConfidence: null, lines: [], summary: null, structured: null, documentIds: [], note: null,
        file: `${id}${ext}`,
      };
      if (store.persistent) store.writeFile(r.file, buffer); else buffers.set(id, buffer);
      state.records[id] = r; persist();
      return recordSummary(r);
    },
    processRecord: id => runProcessing(mustGet('records', id, 'Record')).then(recordSummary),
    getRecord(id, actor) {
      const r = ownRecord(id, actor);
      return { ...recordSummary(r), lines: r.lines, summary: r.summary, structured: r.structured, documents: r.documentIds.filter(x => state.documents[x]).map(x => summary(state.documents[x])) };
    },
    listRecords: actor => Object.values(state.records).filter(r => ownsRecord(actorOf(actor), r)).map(r => ({ ...recordSummary(r), documents: r.documentIds.length })).reverse(),
    recordFile(id, actor) {
      const r = ownRecord(id, actor);
      return { filename: r.filename, mime: r.mime, path: store.persistent ? store.filePath(r.file) : null, buffer: store.persistent ? null : buffers.get(id) };
    },
    async recordPreview(id, actor) {
      const r = ownRecord(id, actor);
      const url = `/api/records/${id}/file`;
      if (r.mime.startsWith('image/')) return { kind: 'image', url };
      if (r.mime === 'application/pdf') return { kind: 'pdf', url };
      if (r.filename.toLowerCase().endsWith('.docx')) return { kind: 'html', html: await docxHtml(readBuffer(r)) };
      return { kind: 'text', text: readBuffer(r).toString('utf8') };
    },
    async reprocessRecord(id, actor) {
      needBuyer(actorOf(actor));
      const r = mustGet('records', id, 'Record');
      if (r.status === 'processing') throw new HttpError(409, 'Record is still processing');
      const existing = r.documentIds.map(x => state.documents[x]).filter(Boolean);
      if (existing.some(d => d.status !== 'draft')) throw new HttpError(409, 'Documents from this record are already in approval; reprocessing would discard that work');
      existing.forEach(d => delete state.documents[d.id]);
      r.documentIds = []; r.summary = null; r.structured = null; r.note = null;
      return recordSummary(await runProcessing(r));
    },

    /* ------------------------------ parties ------------------------------ */
    listParties: kind => state.parties.filter(p => !kind || p.kind === kind),
    createParty(body, actor) {
      needBuyer(actorOf(actor));
      if (!KINDS.includes(body.kind)) throw new HttpError(400, 'kind must be employee, vendor or customer');
      if (!str(body.name)) throw new HttpError(400, 'Name is required');
      const prefix = { employee: 'EMP', vendor: 'VEN', customer: 'CUS' }[body.kind];
      const n = state.parties.filter(p => p.kind === body.kind).length + 1;
      const p = { id: `${prefix}-${String(n).padStart(3, '0')}`, kind: body.kind, aliases: [] };
      for (const k of PARTY_FIELDS) p[k] = str(body[k]);
      state.parties.push(p); persist();
      return p;
    },
    updateParty(id, body, actor) {
      needBuyer(actorOf(actor));
      const p = state.parties.find(x => x.id === id);
      if (!p) throw new HttpError(404, 'Party not found');
      for (const k of PARTY_FIELDS) if (k in body) p[k] = str(body[k]);
      if (!p.name) throw new HttpError(400, 'Name is required');
      persist(); return p;
    },

    /* ----------------------------- documents ----------------------------- */
    listDocuments: actor => docs().filter(d => ownsDoc(actorOf(actor), d)).map(summary).reverse(),
    getDocument(id, actor) {
      const a = actorOf(actor), d = mustGet('documents', id, 'Document');
      if (!ownsDoc(a, d)) throw new HttpError(404, 'Document not found');
      return isVendor(a) ? vendorView(view(d)) : view(d);
    },

    update(id, patch, actor) {
      needBuyer(actorOf(actor));
      const d = mustGet('documents', id, 'Document');
      if (d.status !== 'draft') throw new HttpError(409, 'Only draft documents can be edited');
      if (patch.header) {
        const h = patch.header;
        if ('partyId' in h && str(h.partyId) !== d.header.partyId) {
          if (str(h.partyId)) { const p = state.parties.find(x => x.id === h.partyId); if (!p) throw new HttpError(400, 'Party not found'); applyParty(d, p); }
          else { d.header.partyId = ''; d.header.partyKind = ''; }
        }
        for (const k of HEADER_KEYS) if (k in h && k !== 'partyId' && k !== 'partyKind') d.header[k] = str(h[k]);
        if ('receiptsAttached' in h) d.header.receiptsAttached = !!h.receiptsAttached;
      }
      if (patch.refs) for (const k of Object.keys(d.refs)) if (k in patch.refs) d.refs[k] = str(patch.refs[k]);
      if (Array.isArray(patch.lines)) {
        d.lines = patch.lines.map(l => {
          const old = d.lines.find(x => x.id === l.id);
          let rowIndex = old ? old.rowIndex : undefined, confidence = old ? old.confidence : 0;
          if (l.rowIndex != null && (!old || Number(l.rowIndex) !== old.rowIndex)) {
            const row = master.rows[Number(l.rowIndex)];
            if (!row || row.sourceDocument !== d.sourceDocument) throw new HttpError(400, 'Event does not belong to this source document');
            rowIndex = row.index;
            const text = l.description || (old && old.description) || '';
            const cand = matchLines([{ n: 0, text }], master.rows, d.sourceDocument)[0].candidates.find(c => c.row.index === rowIndex);
            confidence = cand ? cand.score : 0;
          }
          if (rowIndex == null) throw new HttpError(400, 'Line needs a financial event');
          const next = {
            id: old ? old.id : uid('ln'), rowIndex, confidence, description: l.description == null ? (old ? old.description : '') : str(l.description),
            evidence: old ? old.evidence : '', statedAmount: old ? old.statedAmount : null, figureSource: old ? old.figureSource : 'user',
            quantity: str(l.quantity), unitPrice: str(l.unitPrice), vat: str(l.vat), wht: str(l.wht),
          };
          if (old && ['quantity', 'unitPrice', 'vat', 'wht'].some(k => next[k] !== old[k])) next.figureSource = 'user';
          return next;
        });
      }
      if (patch.confirmFigures) d.lines.forEach(l => { if (l.figureSource === 'fictitious') l.figureSource = 'confirmed'; });
      persist();
      return view(d);
    },

    submit(id, by) {
      const a = actorOf(by), d = mustGet('documents', id, 'Document');
      needRole(a, 'Preparer');
      if (d.status !== 'draft') throw new HttpError(409, `Document is ${d.status}`);
      if (!a.name) throw new HttpError(400, 'Preparer name is required');
      d.header.preparedBy = a.name;
      const errs = assess(d, master.rows, { today: today() }).issues.submit.filter(i => i.level === 'error');
      if (errs.length) throw new HttpError(422, 'Document is not ready for approval', errs);
      d.status = 'pending_approval'; d.rejection = null; persist();
      return view(d);
    },

    approve(id, role, by) {
      const actor = actorOf(by), d = mustGet('documents', id, 'Document');
      by = actor.name;
      needRole(actor, role);
      if (d.status !== 'pending_approval') throw new HttpError(409, `Document is ${d.status}`);
      const a = assess(d, master.rows, { today: today() });
      if (!a.requiredApprovals.some(r => r.role === role)) throw new HttpError(400, `${role} is not a required approver`);
      if (d.approvals.some(x => x.role === role)) throw new HttpError(409, `${role} has already approved`);
      const err = segregationError(d, by, role);
      if (err) throw new HttpError(403, err);
      d.approvals.push({ role, by: str(by), at: now().toISOString() });
      if (a.requiredApprovals.every(r => d.approvals.some(x => x.role === r.role))) d.status = 'approved';
      persist();
      return view(d);
    },

    reject(id, by, reason) {
      const actor = actorOf(by), d = mustGet('documents', id, 'Document');
      needBuyer(actor);
      if (actor.approvalRoles && !actor.approvalRoles.some(r => r !== 'Preparer')) throw new HttpError(403, 'Only approvers and the finance reviewer can return a document');
      by = actor.name;
      if (!['pending_approval', 'approved'].includes(d.status)) throw new HttpError(409, `Document is ${d.status}`);
      if (!str(by) || !str(reason)) throw new HttpError(400, 'Name and reason are required');
      d.status = 'draft'; d.approvals = []; d.review = emptyReview();
      d.rejection = { by: str(by), reason: str(reason), at: now().toISOString() };
      persist();
      return view(d);
    },

    /** Final approval step. On success the document becomes a bill, ready for payment. */
    financeReview(id, { by: byActor, threeWay, vendorChecks, ackLowConfidence, accountOverrides } = {}) {
      const actor = actorOf(byActor), by = actor.name, d = mustGet('documents', id, 'Document');
      needRole(actor, 'Finance Reviewer');
      if (d.status !== 'approved') throw new HttpError(409, `Document is ${d.status}; Finance Review follows the approvals`);
      const err = segregationError(d, by, 'Finance Reviewer');
      if (err) throw new HttpError(403, err);
      const ov = {};
      for (const [k, v] of Object.entries(accountOverrides || {})) if (str(v)) ov[k] = str(v);
      for (const [k, v] of Object.entries(ov)) { const m = validateOverride(k, v); if (m) throw new HttpError(422, m); }
      const draft = { ...d, review: { threeWay: threeWay || {}, vendorChecks: vendorChecks || {}, ackLowConfidence: !!ackLowConfidence, accountOverrides: ov, by: null, at: null } };
      const errs = assess(draft, master.rows, { today: today() }).issues.review.filter(i => i.level === 'error');
      d.review = draft.review;
      if (errs.length) { persist(); throw new HttpError(422, 'Finance review incomplete', errs); }
      d.review.by = str(by); d.review.at = now().toISOString();
      const bill = makeBill(d);
      d.status = 'billed'; d.billId = bill.id; persist();
      return view(d);
    },

    /* -------------------------------- bills ------------------------------- */
    listBills: actor => Object.values(state.bills).filter(b => ownsBill(actorOf(actor), b)).map(b => ({
      id: b.id, number: b.number, documentNumber: b.documentNumber, sourceDocument: b.sourceDocument, counterparty: b.counterparty,
      gross: b.totals.gross, payable: b.totals.payable, glPosting: b.glPosting, paymentStatus: b.paymentStatus, amountDue: b.amountDue, createdAt: b.createdAt, intake: b.origin.intake,
    })).reverse(),
    getBill(id, actor) {
      const a = actorOf(actor), b = mustGet('bills', id, 'Bill');
      if (!ownsBill(a, b)) throw new HttpError(404, 'Bill not found');
      return isVendor(a) ? vendorBill(b) : b;
    },

    payBill(id, byActor) {
      const actor = actorOf(byActor), by = actor.name, b = mustGet('bills', id, 'Bill');
      needRole(actor, 'Payment Processor');
      if (b.paymentStatus !== 'awaiting_payment') throw new HttpError(409, b.paymentStatus === 'paid' ? 'Bill is already paid' : 'This bill does not require payment');
      const d = state.documents[b.documentId];
      const err = segregationError(d, by, 'Payment Processor');
      if (err) throw new HttpError(403, err);
      if (!str(d.header.accountNumber)) throw new HttpError(422, 'Beneficiary bank account is missing — update the party record and the document before paying', [{ level: 'error', msg: 'Beneficiary bank account is required for payment', ref: 'AP-EVT-002' }]);
      const payables = b.entries.filter(e => e.side === 'Cr' && PAYABLE_ACCOUNTS.includes(e.account));
      const entries = [
        ...payables.map(e => ({ side: 'Dr', account: e.account, code: e.code, memo: false, amount: e.amount })),
        { side: 'Cr', account: 'Bank', code: 1100, memo: false, amount: Math.round(payables.reduce((s, e) => s + e.amount, 0) * 100) / 100 },
      ];
      b.payment = { by: str(by), at: now().toISOString(), entries, reference: `PAY-${b.number.slice(5)}`, beneficiary: { name: d.header.counterparty, accountNumber: d.header.accountNumber, bankName: d.header.bankName } };
      b.paymentStatus = 'paid'; persist();
      return b;
    },

    billCsv(id, actor) {
      const a = actorOf(actor);
      needBuyer(a);
      const b = mustGet('bills', id, 'Bill');
      return toCsv([
        ['Bill', b.number], ['Source document', b.documentNumber], ['Counterparty', b.counterparty], ['Date', b.documentDate], [],
        ['Side', 'Account code', 'Account', 'Amount (NGN)'],
        ...b.entries.map(e => [e.side, e.code || '', e.account, e.amount.toFixed(2)]),
      ]);
    },
    policyChunk: id => chunks[id] || null,
    policyChunks: () => Object.values(chunks).map(({ id, title }) => ({ id, title })),
  };

  /** What a vendor may see of a document: the paper, its status and totals — no internal controls. */
  function vendorView(v) {
    return {
      id: v.id, number: v.number, sourceDocument: v.sourceDocument, status: v.status, origin: { recordId: v.origin.recordId, intake: v.origin.intake, filename: v.origin.filename },
      company: v.company, header: { ...v.header, preparedBy: undefined }, refs: v.refs, billId: v.billId, createdAt: v.createdAt,
      lines: v.lines.map(l => ({ id: l.id, description: l.description, event: l.event, phrase: l.phrase, quantity: l.quantity, figureSource: l.figureSource, figures: l.figures })),
      totals: v.totals, vendorView: true,
    };
  }
  function vendorBill(b) {
    return {
      id: b.id, number: b.number, documentNumber: b.documentNumber, sourceDocument: b.sourceDocument, counterparty: b.counterparty, documentDate: b.documentDate,
      purpose: b.purpose, currency: b.currency, totals: b.totals, paymentStatus: b.paymentStatus, amountDue: b.amountDue, createdAt: b.createdAt, vendorView: true,
      payment: b.payment ? { reference: b.payment.reference, at: b.payment.at } : null,
      lines: b.lines.map(l => ({ event: l.event, description: l.description, figures: l.figures })),
    };
  }

  /* ------------------------------ logins ------------------------------ */
  const publicUser = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, title: u.title, partyId: u.partyId, approvalRoles: u.approvalRoles });
  const makeUser = (profile, password) => ({ id: uid('usr'), ...profile, passwordHash: auth.hashPassword(password), createdAt: now().toISOString(), active: true });
  Object.assign(svc, {
    /** Creates login profiles with fresh random passwords. reset replaces every login (and ends all sessions); otherwise only missing ones are added. Passwords are returned once and never stored in clear. */
    generateLogins({ reset = true } = {}) {
      const wanted = auth.buildProfiles(state.parties);
      if (reset) { state.users = []; state.sessions = {}; }
      const have = new Set(state.users.map(u => u.username));
      const out = [];
      for (const profile of wanted) {
        if (have.has(profile.username)) continue;
        const password = auth.generatePassword();
        state.users.push(makeUser(profile, password));
        out.push({ username: profile.username, password, name: profile.name, role: profile.role, title: profile.title, partyId: profile.partyId, approvalRoles: profile.approvalRoles });
      }
      persist();
      return out;
    },
    /** Creates or resets one vendor's login (Admin only). The new password is returned once. */
    resetPartyLogin(partyId, actor) {
      needRole(actorOf(actor), 'Admin');
      const p = state.parties.find(x => x.id === partyId);
      if (!p || p.kind !== 'vendor') throw new HttpError(404, 'Vendor not found');
      const profile = auth.buildProfiles([p])[auth.BUYERS.length];
      const password = auth.generatePassword();
      const existing = state.users.find(u => u.partyId === partyId);
      if (existing) {
        existing.passwordHash = auth.hashPassword(password);
        const mine = Object.entries(state.sessions).filter(([, v]) => v.userId === existing.id).map(([k]) => k);
        mine.forEach(k => delete state.sessions[k]);
      } else state.users.push(makeUser(profile, password));
      persist();
      return { username: (existing || profile).username, password, name: p.name, role: 'vendor', partyId };
    },
    listUsersFor(actor) { needRole(actorOf(actor), 'Admin'); return state.users.map(publicUser); },
    hasUsers: () => state.users.length > 0,
    listUsers: () => state.users.map(publicUser),
    login(username, password) {
      const u = state.users.find(x => x.username === String(username || '').trim().toLowerCase() && x.active);
      // verify against a dummy hash when the user is unknown so timing does not reveal valid usernames
      const ok = auth.verifyPassword(password, u ? u.passwordHash : DUMMY_HASH);
      if (!u || !ok) return null;
      const token = require('crypto').randomBytes(32).toString('hex');
      state.sessions[auth.sha(token)] = { userId: u.id, expires: now().getTime() + auth.SESSION_TTL_MS };
      for (const [k, v] of Object.entries(state.sessions)) if (v.expires < now().getTime()) delete state.sessions[k];
      persist();
      return { token, user: publicUser(u) };
    },
    userForToken(token) {
      if (!token) return null;
      const s = state.sessions[auth.sha(token)];
      if (!s || s.expires < now().getTime()) return null;
      const u = state.users.find(x => x.id === s.userId && x.active);
      return u ? publicUser(u) : null;
    },
    logout(token) { if (token) { delete state.sessions[auth.sha(token)]; persist(); } },
  });

  function makeBill(d) {
    const a = assess(d, master.rows, { today: today() });
    const missing = a.requiredApprovals.filter(r => !d.approvals.some(x => x.role === r.role));
    if (missing.length) throw new HttpError(422, 'Mandatory approvals are incomplete', missing.map(m => ({ level: 'error', msg: `${m.role} approval missing`, ref: 'FIN-POL-001' })));
    if (!a.balanced) throw new HttpError(422, 'Journal does not balance');
    const agg = new Map();
    for (const j of a.journal) {
      const k = `${j.side}|${j.account}`;
      const cur = agg.get(k) || { side: j.side, account: j.account, code: j.code, memo: j.memo, amount: 0 };
      cur.amount = Math.round((cur.amount + j.amount) * 100) / 100; agg.set(k, cur);
    }
    const entries = [...agg.values()].sort((x, y) => (x.side === y.side ? 0 : x.side === 'Dr' ? -1 : 1));
    const amountDue = Math.round(entries.filter(e => e.side === 'Cr' && PAYABLE_ACCOUNTS.includes(e.account)).reduce((s, e) => s + e.amount, 0) * 100) / 100;
    const bill = {
      id: uid('bill'), number: `BILL-${year()}-${String(++state.seq.bill).padStart(5, '0')}`, createdAt: now().toISOString(),
      documentId: d.id, partyId: d.header.partyId, documentNumber: d.number, sourceDocument: d.sourceDocument, origin: d.origin,
      counterparty: d.header.counterparty, address: d.header.address, accountNumber: d.header.accountNumber, bankName: d.header.bankName,
      department: d.header.department, costCenter: d.header.costCenter, documentDate: d.header.documentDate, purpose: d.header.purpose, currency: 'NGN', refs: d.refs,
      totals: a.totals, entries, glPosting: entries.length ? 'Ready to post' : 'No GL posting (commitment / register only)',
      lines: a.lines.map(l => ({ event: l.row.financialEvent, phrase: l.row.phrase, description: l.description, glPosting: l.row.glPosting, figures: l.figs, confidence: l.confidence })),
      workflow: { preparedBy: d.header.preparedBy, approvals: d.approvals, financeReviewer: d.review.by, financeReviewedAt: d.review.at },
      policyRefs: policyRefsFor(d, a), status: 'billed',
      paymentStatus: amountDue > 0 ? 'awaiting_payment' : 'no_payment', amountDue, payment: null,
    };
    state.bills[bill.id] = bill;
    return bill;
  }

  persist();
  return svc;
}

module.exports = { createService, HttpError };
