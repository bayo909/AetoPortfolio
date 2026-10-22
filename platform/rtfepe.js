// RT-FEPE integration: one isolated document engine per tenant (src/service.js), the Financial Events reference data in the
// database, document intake with hashing / duplicate detection, side-by-side review actions and the hand-over to payable bills.
const fs = require('fs');
const path = require('path');
const { uid, iso } = require('./db');
const { sha256 } = require('./security');
const { bad, forbidden, notFound, conflict, unprocessable, HttpError } = require('./errors');
const { parseCsvObjects } = require('../src/csv');
const { createService } = require('../src/service');
const { matchLines } = require('../src/matcher');
const { SLOT_ROLES } = require('./rbac');

const DEMO_CSV = path.join(__dirname, '..', 'data', 'Financial_Master_Data.csv');
const SUPPLEMENTAL = path.join(__dirname, '..', 'data', 'Supplemental_Financial_Events.csv');
const REQUIRED_HEADERS = ['Source Document', 'Financial Event', 'High Frequency Phrase', 'Journal Entry', 'Debit Account', 'Credit Account'];
const OPTIONAL_HEADERS = ['Accounting Impact', 'Ledger Effect', 'General Ledger Posting', 'Financial Statement Impact', 'Expense Code'];
const ALLOWED_EXT = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.txt': 'text/plain' };
const MAGIC = { '.pdf': b => b.slice(0, 4).toString() === '%PDF', '.png': b => b.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), '.jpg': b => b[0] === 0xff && b[1] === 0xd8, '.jpeg': b => b[0] === 0xff && b[1] === 0xd8, '.docx': b => b[0] === 0x50 && b[1] === 0x4b, '.txt': b => !b.includes(0) };
// FIN-POL-001 approver labels used by the Billing Review workflow -> membership roles allowed to give that approval
const LABEL_ROLES = {
  'Department Manager': SLOT_ROLES.dept_approver, 'Finance': SLOT_ROLES.finance, 'Head of Department': SLOT_ROLES.dept_head, 'Finance Manager': SLOT_ROLES.finance_manager,
  'CFO': SLOT_ROLES.cfo, 'Business Unit Head': SLOT_ROLES.bu_head, 'CEO / Executive Committee': SLOT_ROLES.ceo, 'Additional Approver': ['finance_approver', 'org_admin'],
};
const LOW_CONF = 0.7;

module.exports = function rtfepeService(core) {
  const { db, now, audit } = core;
  const engines = new Map();
  const pending = new Set();
  let actor = null; // ctx of the request currently running a synchronous hand-over (single-threaded, so safe)

  /* ---------------------------- Financial Events ---------------------------- */
  function parseEvents(buffer) {
    let rows;
    try { rows = parseCsvObjects(buffer.toString('utf8')); } catch { throw bad('Could not read the CSV file'); }
    if (!rows.length) throw bad('The CSV has no data rows');
    const headers = Object.keys(rows[0]);
    const missing = REQUIRED_HEADERS.filter(h => !headers.includes(h));
    if (missing.length) throw unprocessable(`CSV is missing required column(s): ${missing.join(', ')}`, missing.map(h => ({ level: 'error', msg: `Missing column "${h}"` })), 'bad_headers');
    const issues = [], seen = new Set();
    rows.forEach((r, i) => {
      if (!r['Source Document'] || !r['Financial Event'] || !r['High Frequency Phrase']) issues.push({ level: 'error', msg: `Row ${i + 2}: Source Document, Financial Event and High Frequency Phrase are required` });
      const k = `${r['Source Document']}|${r['Financial Event']}|${r['High Frequency Phrase']}`.toLowerCase();
      if (seen.has(k)) issues.push({ level: 'warning', msg: `Row ${i + 2}: duplicate of an earlier row` });
      seen.add(k);
    });
    if (issues.some(x => x.level === 'error')) throw unprocessable('CSV validation failed', issues, 'bad_rows');
    return { rows, issues, extraColumns: headers.filter(h => ![...REQUIRED_HEADERS, ...OPTIONAL_HEADERS].includes(h)) };
  }

  function loadMaster(orgId) {
    const rows = db.all('SELECT * FROM financial_events WHERE org_id = ? ORDER BY position', orgId).map(r => ({
      index: r.position, dbId: r.id, supplemental: false, inactive: !r.active, sourceDocument: r.source_document, financialEvent: r.financial_event, accountingImpact: r.accounting_impact, ledgerEffect: r.ledger_effect,
      phrase: r.phrase, journalEntry: r.journal_entry, debitAccount: r.debit_account, creditAccount: r.credit_account, glPosting: r.gl_posting, statementImpact: r.statement_impact, expenseCode: r.expense_code,
    }));
    return { rows, sourceDocuments: [...new Set(rows.filter(r => !r.inactive).map(r => r.sourceDocument))] };
  }
  function insertEvents(orgId, filename, buffer, rows, isDemo, userId) {
    const batch = { id: uid(), org_id: orgId, filename, sha256: sha256(buffer), rows_count: rows.length, is_demo: isDemo, imported_by: userId, active: 1, created_at: iso(now()) };
    db.run('UPDATE financial_event_batches SET active = 0 WHERE org_id = ?', orgId);
    db.run('UPDATE financial_events SET active = 0 WHERE org_id = ?', orgId);
    db.insert('financial_event_batches', batch);
    let pos = db.get('SELECT COALESCE(MAX(position), -1) + 1 n FROM financial_events WHERE org_id = ?', orgId).n;
    for (const r of rows) db.insert('financial_events', {
      id: uid(), org_id: orgId, batch_id: batch.id, position: pos++, source_document: r['Source Document'], financial_event: r['Financial Event'], phrase: r['High Frequency Phrase'],
      accounting_impact: r['Accounting Impact'] || '', ledger_effect: r['Ledger Effect'] || '', journal_entry: r['Journal Entry'] || '', debit_account: r['Debit Account'] || '', credit_account: r['Credit Account'] || '',
      gl_posting: r['General Ledger Posting'] || '', statement_impact: r['Financial Statement Impact'] || '', expense_code: r['Expense Code'] || '', active: 1, is_demo: isDemo,
    });
    return batch;
  }
  /** Demo organisations get the supplied reference CSV automatically (clearly labelled demo). Production organisations must import their own. */
  function ensureEvents(orgId) {
    if (db.get('SELECT 1 x FROM financial_events WHERE org_id = ? AND active = 1', orgId)) return;
    const o = db.get('SELECT is_demo FROM organizations WHERE id = ?', orgId);
    if (!o.is_demo) throw new HttpError(409, 'Import the Financial Events CSV (Enterprise Finance → Financial Events Mapping) before processing documents.', undefined, 'events_not_configured');
    const buf = fs.readFileSync(DEMO_CSV);
    const rows = [...parseCsvObjects(buf.toString('utf8')), ...(fs.existsSync(SUPPLEMENTAL) ? parseCsvObjects(fs.readFileSync(SUPPLEMENTAL, 'utf8')) : [])];
    insertEvents(orgId, 'Financial_Master_Data.csv (demo dataset)', buf, rows, 1, null);
  }

  /* ------------------------------- parties ------------------------------- */
  function buildParties(orgId) {
    const out = [];
    for (const v of db.all(`SELECT o.id, o.name, vp.legal_name, vp.bank_name, vp.account_number_enc, vp.tax_id_enc FROM vendor_relationships r JOIN organizations o ON o.id = r.vendor_org_id JOIN vendor_profiles vp ON vp.org_id = o.id WHERE r.customer_org_id = ? AND r.status <> 'revoked'`, orgId))
      out.push({ id: `v:${v.id}`, kind: 'vendor', name: v.legal_name || v.name, aliases: [v.name], address: '', email: '', accountNumber: core.cipher.decrypt(v.account_number_enc), bankName: v.bank_name, taxId: core.cipher.decrypt(v.tax_id_enc), department: '', costCenter: '' });
    for (const m of db.all(`SELECT u.id, u.name, u.email, m.department, m.cost_center, ep.bank_name, ep.account_number_enc, ep.address FROM organization_members m JOIN users u ON u.id = m.user_id LEFT JOIN employee_profiles ep ON ep.org_id = m.org_id AND ep.user_id = u.id WHERE m.org_id = ? AND m.status = 'active'`, orgId))
      out.push({ id: `e:${m.id}`, kind: 'employee', name: m.name, aliases: [], address: m.address || '', email: m.email, accountNumber: core.cipher.decrypt(m.account_number_enc), bankName: m.bank_name || '', taxId: '', department: m.department, costCenter: m.cost_center });
    for (const c of db.all(`SELECT o.id, o.name FROM vendor_relationships r JOIN organizations o ON o.id = r.customer_org_id WHERE r.vendor_org_id = ? AND r.status = 'active'`, orgId))
      out.push({ id: `c:${c.id}`, kind: 'customer', name: c.name, aliases: [], address: '', email: '', accountNumber: '', bankName: '', taxId: '', department: '', costCenter: '' });
    return out;
  }

  /* ------------------------------- engine ------------------------------- */
  function engine(orgId) {
    ensureEvents(orgId);
    let e = engines.get(orgId);
    if (e) return e.svc;
    const master = loadMaster(orgId);
    const policyChunks = core.svc.policy.chunksFor(orgId) || {};
    const svc = createService({
      master, chunks: policyChunks, now, parties: buildParties(orgId),
      storageDir: core.storageDir ? path.join(core.storageDir, 'docflow', orgId) : null,
      hooks: { onBill: ({ doc, bill }) => handOver(orgId, doc, bill) },
    });
    e = { svc, master };
    engines.set(orgId, e);
    return svc;
  }
  const masterOf = orgId => { engine(orgId); return engines.get(orgId).master; };

  const userByName = (orgId, name) => db.get(`SELECT u.id FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND lower(u.name) = lower(?)`, orgId, name || '');

  function handOver(orgId, doc, bill) {
    const sd = db.get('SELECT id FROM source_documents WHERE org_id = ? AND docflow_record_id = ?', orgId, doc.origin.recordId);
    const approvals = (doc.approvals || []).map(a => ({ role: a.role, userId: (userByName(orgId, a.by) || {}).id, at: a.at })).filter(a => a.userId);
    if (doc.review && doc.review.by) { const r = userByName(orgId, doc.review.by); if (r) approvals.push({ role: 'Finance Review', userId: r.id, at: doc.review.at }); }
    const b = core.svc.bills.createFromDocflow(orgId, { doc, bill, approvals, sourceDocumentId: sd && sd.id, reviewer: actor && actor.userId });
    snapshot(orgId, doc, 'billed', actor && actor.userId);
    return b;
  }
  function snapshot(orgId, doc, stage, userId) {
    const v = db.get('SELECT COALESCE(MAX(version),0)+1 n FROM document_versions WHERE org_id = ? AND docflow_doc_id = ?', orgId, doc.id).n;
    const content = JSON.stringify({ header: doc.header, refs: doc.refs, lines: doc.lines.map(l => ({ description: l.description, event: l.event, phrase: l.phrase, figures: l.figures, confidence: l.confidence })), totals: doc.totals, status: doc.status });
    db.insert('document_versions', { id: uid(), org_id: orgId, docflow_doc_id: doc.id, version: v, stage, content_json: content, content_sha256: sha256(content), created_by: userId || null, created_at: iso(now()) });
  }

  const fingerprintOf = (doc) => {
    const ref = doc.refs.invoice || doc.refs.quotation || doc.refs.receipt || '';
    if (!ref) return null;
    return require('crypto').createHash('sha256').update([doc.header.counterparty, ref, Math.round(doc.totals.gross * 100), 'NGN', doc.header.documentDate].join('|').toLowerCase()).digest('hex');
  };
  const billFingerprint = (doc) => {
    const ref = doc.refs.invoice || doc.refs.quotation || doc.refs.receipt || doc.number;
    return require('crypto').createHash('sha256').update([String(doc.header.counterparty).toLowerCase(), String(ref).toLowerCase(), Math.round(doc.totals.gross * 100), 'NGN', doc.header.documentDate].join('|')).digest('hex');
  };

  const canView = ctx => ['docs.upload', 'docs.review', 'docs.approve', 'docs.finance_review', 'ledger.view'].some(p => ctx.can(p));
  const privileged = ctx => ['docs.review', 'docs.approve', 'docs.finance_review', 'ledger.view'].some(p => ctx.can(p));
  const mustSource = (ctx, recordId) => {
    const s = db.get('SELECT * FROM source_documents WHERE org_id = ? AND docflow_record_id = ?', ctx.orgId, recordId);
    if (!s || (!privileged(ctx) && s.uploaded_by !== ctx.userId)) throw notFound('Record');
    return s;
  };
  const docRecordId = (ctx, docId) => engine(ctx.orgId).getDocument(docId).origin.recordId;
  const mustDoc = (ctx, docId) => {
    if (!canView(ctx)) throw forbidden();
    let d; try { d = engine(ctx.orgId).getDocument(docId); } catch { throw notFound('Document'); }
    const s = db.get('SELECT * FROM source_documents WHERE org_id = ? AND docflow_record_id = ?', ctx.orgId, d.origin.recordId);
    if (!s || (!privileged(ctx) && s.uploaded_by !== ctx.userId)) throw notFound('Document');
    return d;
  };

  function writeExtracted(orgId, sdId, rec) {
    db.run('DELETE FROM extracted_fields WHERE source_document_id = ?', sdId);
    const p = rec.structured && rec.structured.parsed;
    const conf = rec.ocrConfidence != null ? rec.ocrConfidence / 100 : null;
    if (p) for (const [k, v] of Object.entries({ document_number: p.docNumber, date: p.date, party: p.partyName, po_number: p.poNumber, subtotal: p.totals.net, vat: p.totals.vat, wht: p.totals.wht, total: p.totals.total }))
      if (v != null) db.insert('extracted_fields', { id: uid(), org_id: orgId, source_document_id: sdId, field: k, value: String(v), confidence: conf, page: 1, corrected_value: null, corrected_by: null, corrected_at: null });
  }

  const svc = {
    LABEL_ROLES, engine, masterOf, buildParties, idle: () => Promise.all([...pending]),

    syncParties(orgId) { if (engines.has(orgId)) engines.get(orgId).svc.setParties(buildParties(orgId)); },

    /* ----------------------- Financial Events admin ----------------------- */
    async importEvents(ctx, { filename, buffer, isDemo = false }) {
      ctx.require('events.manage');
      const { rows, issues, extraColumns } = parseEvents(buffer);
      const batch = db.tx(() => {
        const b = insertEvents(ctx.orgId, filename, buffer, rows, isDemo ? 1 : 0, ctx.userId);
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'events.imported', objectType: 'financial_event_batch', objectId: b.id, next: { filename, rows: rows.length, isDemo } });
        return b;
      });
      const live = engines.get(ctx.orgId);
      if (live) { const m = loadMaster(ctx.orgId); live.master.rows.length = 0; live.master.rows.push(...m.rows); live.master.sourceDocuments = m.sourceDocuments; } // in place: rows are append-only so earlier documents keep their references
      return { batchId: batch.id, rows: rows.length, warnings: issues, ignoredColumns: extraColumns };
    },
    listEvents(ctx, { q = '', sourceDocument = '' } = {}) {
      ctx.require('events.manage');
      const like = `%${q}%`;
      return db.all(`SELECT e.*, b.filename, b.is_demo batch_demo FROM financial_events e JOIN financial_event_batches b ON b.id = e.batch_id WHERE e.org_id = ? AND e.active = 1 AND (e.financial_event LIKE ? OR e.phrase LIKE ?) AND (? = '' OR e.source_document = ?) ORDER BY e.position LIMIT 500`, ctx.orgId, like, like, sourceDocument, sourceDocument)
        .map(e => ({ id: e.id, sourceDocument: e.source_document, financialEvent: e.financial_event, phrase: e.phrase, journalEntry: e.journal_entry, debitAccount: e.debit_account, creditAccount: e.credit_account, glPosting: e.gl_posting, expenseCode: e.expense_code, batch: e.filename, isDemo: !!e.is_demo }));
    },
    eventsStatus(ctx) {
      ctx.require('events.manage');
      const b = db.get('SELECT * FROM financial_event_batches WHERE org_id = ? AND active = 1', ctx.orgId);
      return { configured: !!b, batch: b && { id: b.id, filename: b.filename, rows: b.rows_count, isDemo: !!b.is_demo, importedAt: b.created_at }, requiredHeaders: REQUIRED_HEADERS, optionalHeaders: OPTIONAL_HEADERS };
    },
    updateEvent(ctx, id, patch) {
      ctx.require('events.manage');
      const e = db.get('SELECT * FROM financial_events WHERE id = ? AND org_id = ?', id, ctx.orgId);
      if (!e) throw notFound('Financial event');
      const n = { phrase: patch.phrase ?? e.phrase, debit_account: patch.debitAccount ?? e.debit_account, credit_account: patch.creditAccount ?? e.credit_account, expense_code: patch.expenseCode ?? e.expense_code, active: patch.active === false ? 0 : e.active };
      if (!String(n.phrase).trim()) throw bad('Phrase is required');
      db.tx(() => {
        db.run('UPDATE financial_events SET phrase=?, debit_account=?, credit_account=?, expense_code=?, active=? WHERE id=?', n.phrase, n.debit_account, n.credit_account, n.expense_code, n.active, id);
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'events.corrected', objectType: 'financial_event', objectId: id, prior: { phrase: e.phrase, debit: e.debit_account, credit: e.credit_account }, next: n });
      });
      const m = engines.get(ctx.orgId);
      if (m) { const row = m.master.rows.find(r => r.dbId === id); if (row) { row.phrase = n.phrase; row.debitAccount = n.debit_account; row.creditAccount = n.credit_account; row.expenseCode = n.expense_code; row.inactive = !n.active; } }
      return { ok: true };
    },

    /* ------------------------------- intake ------------------------------- */
    upload(ctx, { buffer, filename, intake, docType }) {
      ctx.require('docs.upload');
      const ext = path.extname(filename || '').toLowerCase();
      if (!ALLOWED_EXT[ext]) throw new HttpError(415, 'Unsupported file type. Upload PDF, DOCX, PNG, JPEG or TXT.');
      if (!buffer || !buffer.length) throw bad('The file is empty');
      if (!MAGIC[ext](buffer)) throw new HttpError(415, 'The file content does not match its extension');
      const e = engine(ctx.orgId);
      const rec = e.createRecord({ buffer, filename, intake, docType, uploadedBy: ctx.user.name });
      const hash = sha256(buffer);
      const dupe = db.get('SELECT id FROM source_documents WHERE org_id = ? AND sha256 = ? ORDER BY created_at LIMIT 1', ctx.orgId, hash);
      const sd = { id: uid(), org_id: ctx.orgId, docflow_record_id: rec.id, filename, mime: ALLOWED_EXT[ext], size: buffer.length, sha256: hash, intake, uploaded_by: ctx.userId, duplicate_of: dupe ? dupe.id : null, is_demo: ctx.org.is_demo, created_at: iso(now()) };
      db.tx(() => {
        db.insert('source_documents', sd);
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'document.uploaded', objectType: 'source_document', objectId: sd.id, next: { filename, intake, sha256: hash, duplicateOf: sd.duplicate_of }, refs: { recordId: rec.id } });
      });
      // background job: OCR / extraction / matching. Retried through "re-run extraction".
      const p = e.processRecord(rec.id).then(r => { const full = e.getRecord(rec.id); writeExtracted(ctx.orgId, sd.id, full); audit.record(ctx.orgId, { action: full.status === 'processed' ? 'document.processed' : 'document.processing_failed', objectType: 'source_document', objectId: sd.id, next: { status: full.status, method: full.method, ocr: full.ocrConfidence }, reason: full.error || '' }); })
        .catch(err => console.error('RT-FEPE processing failed', err)).finally(() => pending.delete(p));
      pending.add(p);
      return { ...rec, sourceDocumentId: sd.id, sha256: hash, duplicateOf: sd.duplicate_of };
    },
    listRecords(ctx) {
      if (!canView(ctx)) throw forbidden();
      const e = engine(ctx.orgId);
      const mine = new Map(db.all('SELECT * FROM source_documents WHERE org_id = ?', ctx.orgId).map(s => [s.docflow_record_id, s]));
      return e.listRecords().filter(r => mine.has(r.id) && (privileged(ctx) || mine.get(r.id).uploaded_by === ctx.userId)).map(r => ({ ...r, sourceDocumentId: mine.get(r.id).id, sha256: mine.get(r.id).sha256, duplicateOf: mine.get(r.id).duplicate_of }));
    },
    getRecord(ctx, id) {
      if (!canView(ctx)) throw forbidden();
      const s = mustSource(ctx, id);
      audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'sensitive.document_viewed', objectType: 'source_document', objectId: s.id });
      return { ...engine(ctx.orgId).getRecord(id), sourceDocumentId: s.id, sha256: s.sha256, size: s.size, uploadedById: s.uploaded_by,
        fields: db.all('SELECT field, value, confidence, page, corrected_value FROM extracted_fields WHERE source_document_id = ?', s.id) };
    },
    recordFile(ctx, id) { if (!canView(ctx)) throw forbidden(); mustSource(ctx, id); return engine(ctx.orgId).recordFile(id); },
    recordPreview(ctx, id) { if (!canView(ctx)) throw forbidden(); mustSource(ctx, id); return engine(ctx.orgId).recordPreview(id); },
    async reprocess(ctx, id) {
      ctx.require('docs.review');
      const s = mustSource(ctx, id);
      const r = await engine(ctx.orgId).reprocessRecord(id);
      writeExtracted(ctx.orgId, s.id, engine(ctx.orgId).getRecord(id));
      audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'document.reprocessed', objectType: 'source_document', objectId: s.id });
      return r;
    },

    /* --------------------------- billing review --------------------------- */
    listDocuments(ctx) {
      if (!canView(ctx)) throw forbidden();
      const mine = new Map(db.all('SELECT * FROM source_documents WHERE org_id = ?', ctx.orgId).map(s => [s.docflow_record_id, s]));
      return engine(ctx.orgId).listDocuments().filter(d => mine.has(d.recordId) && (privileged(ctx) || mine.get(d.recordId).uploaded_by === ctx.userId))
        .map(d => ({ ...d, sourceDocumentId: mine.get(d.recordId).id, duplicateOf: mine.get(d.recordId).duplicate_of }));
    },
    getDocument(ctx, id) {
      const d = mustDoc(ctx, id);
      const sd = db.get('SELECT * FROM source_documents WHERE org_id = ? AND docflow_record_id = ?', ctx.orgId, d.origin.recordId);
      const lowConf = d.lines.filter(l => (l.confidence ?? 1) < LOW_CONF).map(l => l.id);
      const warnings = [];
      if (sd && sd.duplicate_of) warnings.push({ level: 'error', code: 'duplicate_file', msg: 'This exact file was uploaded before — possible duplicate document.' });
      if (d.origin.ocrConfidence != null && d.origin.ocrConfidence < 75) warnings.push({ level: 'warning', code: 'low_ocr', msg: `Low OCR confidence (${d.origin.ocrConfidence}%) — verify every figure against the original.` });
      if (lowConf.length) warnings.push({ level: 'warning', code: 'low_match', msg: `${lowConf.length} line(s) have low Financial Event match confidence and need human confirmation.` });
      const ambiguous = d.lines.filter(l => { const c = matchLines([{ n: 0, text: l.description }], masterOf(ctx.orgId).rows, d.sourceDocument)[0].candidates; return c[1] && c[0] && c[0].score - c[1].score < 0.05 && c[0].row.index !== c[1].row.index; });
      if (ambiguous.length) warnings.push({ level: 'warning', code: 'ambiguous_match', msg: `${ambiguous.length} line(s) match more than one Financial Event almost equally — review the selected event.` });
      const unmapped = d.lines.filter(l => !l.event);
      if (unmapped.length) warnings.push({ level: 'error', code: 'missing_event', msg: 'Some lines have no Financial Event mapping.' });
      const versions = db.all('SELECT version, stage, content_sha256, created_at FROM document_versions WHERE org_id = ? AND docflow_doc_id = ? ORDER BY version', ctx.orgId, id);
      return { ...d, sourceDocumentId: sd && sd.id, sourceSha256: sd && sd.sha256, duplicateOf: sd && sd.duplicate_of, platformWarnings: warnings, lowConfidenceLines: lowConf, versions };
    },
    updateDocument(ctx, id, patch) {
      ctx.require('docs.review');
      mustDoc(ctx, id);
      const before = engine(ctx.orgId).getDocument(id);
      const after = engine(ctx.orgId).update(id, patch);
      audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'document.corrected', objectType: 'generated_document', objectId: id, prior: { gross: before.totals.gross, lines: before.lines.length }, next: { gross: after.totals.gross, lines: after.lines.length } });
      return svc.getDocument(ctx, id);
    },
    rematch(ctx, id) {
      ctx.require('docs.review'); mustDoc(ctx, id);
      const r = engine(ctx.orgId).rematch(id);
      audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'document.rematched', objectType: 'generated_document', objectId: id });
      return { report: r.report, document: svc.getDocument(ctx, id) };
    },
    requestInfo(ctx, id, note) {
      ctx.require('docs.review');
      const d = mustDoc(ctx, id);
      if (!String(note || '').trim()) throw bad('Say what information is missing');
      const sd = db.get('SELECT uploaded_by FROM source_documents WHERE org_id = ? AND docflow_record_id = ?', ctx.orgId, d.origin.recordId);
      core.notify(sd.uploaded_by, { orgId: ctx.orgId, kind: 'document', title: `Information needed for ${d.number}`, body: note, link: `#/e/review/${id}` });
      audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'document.info_requested', objectType: 'generated_document', objectId: id, reason: note });
      return { ok: true };
    },
    /** Submit for approval: platform checks (duplicates, vendor verification) run before the engine's own policy validation. */
    submitDocument(ctx, id, { exception } = {}) {
      ctx.require('docs.review');
      const d = mustDoc(ctx, id);
      const e = engine(ctx.orgId);
      const sd = db.get('SELECT * FROM source_documents WHERE org_id = ? AND docflow_record_id = ?', ctx.orgId, d.origin.recordId);
      const blocks = [];
      if (sd.duplicate_of) blocks.push({ level: 'error', code: 'duplicate_file', msg: 'This exact file was already uploaded.' });
      const fp = billFingerprint(d);
      const dupBill = db.get("SELECT number FROM bills WHERE org_id = ? AND fingerprint = ? AND status NOT IN ('cancelled','superseded','rejected')", ctx.orgId, fp);
      if (dupBill) blocks.push({ level: 'error', code: 'duplicate_invoice', msg: `Duplicate: a bill with the same vendor, document number, amount and date already exists (${dupBill.number}).` });
      const other = e.listDocuments().find(x => x.id !== id && ['pending_approval', 'approved', 'billed'].includes(x.status) && x.counterparty === d.header.counterparty && Math.abs(x.gross - d.totals.gross) < 0.005 && d.refs.invoice && e.getDocument(x.id).refs.invoice === d.refs.invoice);
      if (other) blocks.push({ level: 'error', code: 'duplicate_invoice', msg: `Duplicate: ${other.number} has the same vendor, invoice number and amount.` });
      if (d.header.partyId && d.header.partyId.startsWith('v:')) {
        const vid = d.header.partyId.slice(2);
        if (!core.svc.vendor.vendorKybVerified(vid)) blocks.push({ level: 'error', code: 'vendor_not_verified', msg: 'Vendor identity verification (KYB) is not complete; this vendor cannot be paid yet.' });
        else if (!core.svc.vendor.activeRelationship(ctx.orgId, vid)) blocks.push({ level: 'error', code: 'no_relationship', msg: 'This vendor has no active relationship with your workspace.' });
      }
      const dupes = blocks.filter(b => b.code.startsWith('duplicate'));
      const hard = blocks.filter(b => !b.code.startsWith('duplicate'));
      if (hard.length) throw unprocessable('Document cannot be submitted for approval', hard, hard[0].code);
      if (dupes.length) {
        if (!exception || !String(exception.reason || '').trim()) throw unprocessable('Possible duplicate — submit with a documented exception or discard it', dupes, 'duplicate');
        if (!ctx.can('docs.exception')) throw forbidden('Only a user with exception authority can submit a suspected duplicate', 'exception_required');
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'document.duplicate_exception', objectType: 'generated_document', objectId: id, reason: exception.reason, refs: { duplicates: dupes.map(x => x.code) } });
      }
      // record Financial Event matches with reasons (for the audit trail and the "needs review" queue)
      db.run('DELETE FROM financial_event_matches WHERE org_id = ? AND document_id = ?', ctx.orgId, id);
      for (const l of d.lines) {
        const c = matchLines([{ n: 0, text: l.description }], masterOf(ctx.orgId).rows, d.sourceDocument)[0].candidates;
        db.insert('financial_event_matches', { id: uid(), org_id: ctx.orgId, document_id: id, line_ref: l.id, financial_event: l.event, matched_phrase: l.phrase, confidence: l.confidence, reasons_json: JSON.stringify(c.slice(0, 3).map(x => ({ event: x.row.financialEvent, phrase: x.row.phrase, score: x.score }))),
          needs_review: (l.confidence ?? 0) < LOW_CONF || (c[1] && c[0] && c[0].score - c[1].score < 0.05 && c[0].row.index !== c[1].row.index) ? 1 : 0, created_at: iso(now()) });
      }
      const out = e.submit(id, ctx.user.name);
      snapshot(ctx.orgId, out, 'submitted', ctx.userId);
      audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'document.submitted', objectType: 'generated_document', objectId: id, prior: { status: 'draft' }, next: { status: 'pending_approval', gross: out.totals.gross }, refs: { sourceDocumentId: sd.id } });
      return svc.getDocument(ctx, id);
    },
    approveDocument(ctx, id, role) {
      ctx.require('docs.approve');
      const d = mustDoc(ctx, id);
      const allowed = LABEL_ROLES[role];
      if (!allowed) throw bad('Unknown approval role');
      if (!allowed.includes(ctx.role)) throw forbidden(`${role} approval needs one of: ${allowed.join(', ')}`);
      if (ctx.member.approval_limit_minor < Math.round(d.totals.gross * 100)) throw forbidden(`Amount exceeds your delegated approval authority`, 'limit');
      const out = engine(ctx.orgId).approve(id, role, ctx.user.name);
      audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'document.approved_step', objectType: 'generated_document', objectId: id, next: { role, status: out.status } });
      if (out.status === 'approved') snapshot(ctx.orgId, out, 'approved', ctx.userId);
      return svc.getDocument(ctx, id);
    },
    rejectDocument(ctx, id, reason) {
      if (!ctx.can('docs.approve') && !ctx.can('docs.finance_review')) throw forbidden();
      mustDoc(ctx, id);
      const out = engine(ctx.orgId).reject(id, ctx.user.name, reason);
      snapshot(ctx.orgId, out, 'returned', ctx.userId);
      audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'document.returned', objectType: 'generated_document', objectId: id, reason });
      return svc.getDocument(ctx, id);
    },
    /** Final finance review: creates the payable bill (approved, ready for payment) via the hand-over hook. */
    financeReview(ctx, id, body) {
      ctx.require('docs.finance_review');
      mustDoc(ctx, id);
      actor = ctx;
      try { engine(ctx.orgId).financeReview(id, { ...body, by: ctx.user.name }); } finally { actor = null; }
      const bill = db.get('SELECT * FROM bills WHERE org_id = ? AND docflow_doc_id = ?', ctx.orgId, id);
      audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'document.finance_reviewed', objectType: 'generated_document', objectId: id, next: { billId: bill && bill.id, billStatus: bill && bill.status } });
      return { document: svc.getDocument(ctx, id), billId: bill && bill.id };
    },
    config(ctx) { if (!canView(ctx)) throw forbidden(); return engine(ctx.orgId).config(); },
    parties(ctx) { if (!canView(ctx)) throw forbidden(); return engine(ctx.orgId).listParties().map(p => ({ id: p.id, kind: p.kind, name: p.name, department: p.department, costCenter: p.costCenter, hasBank: !!p.accountNumber })); },
    policyRef(ctx, chunkId) { if (!canView(ctx)) throw forbidden(); const c = engine(ctx.orgId).policyChunk(chunkId); if (!c) throw notFound('Policy rule'); return c; },
  };
  return svc;
};
module.exports.LABEL_ROLES = LABEL_ROLES;
