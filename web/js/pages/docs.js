import { h, state, get, post, patch, api, route, navigate, clear, fmt, major, dt, day, cap, badge, tag, table, kv, stat, pageHead, toast, errToast, formModal, modal, confirmBox, field, can, showIssues } from '../core.js';

const conf = c => h('span', { class: `conf ${c >= .85 ? 'hi' : c >= .7 ? 'mid' : 'lo'}` }, `${Math.round((c || 0) * 100)}%`);
const SAMPLES = [
  ['Memo — admin expenses (unstructured)', 'memo_admin_expenses.txt', 'unstructured', null], ['Proposal — Q2 operations (unstructured .docx)', 'proposal_q2_operations.docx', 'unstructured', null],
  ['Invoice — Okafor & Partners (PDF)', 'invoice_okafor.pdf', 'structured', 'invoice_payable'], ['Invoice — SecureTech (scanned image, OCR)', 'invoice_securetech.png', 'structured', 'invoice_payable'],
];

/* ------------------------------------------------------------------ inbox */
async function inbox() {
  const [cfg, recs] = await Promise.all([get('/docs/config'), get('/docs/records')]);
  let intake = 'structured';
  const typeSel = h('select', { name: 'docType', 'aria-label': 'Document type' }, h('option', { value: 'auto' }, 'Auto-detect'), cfg.structuredTypes.map(t => h('option', { value: t.key }, t.label)));
  const file = h('input', { type: 'file', name: 'file', required: true, accept: '.pdf,.docx,.png,.jpg,.jpeg,.txt' });
  const upload = async (blob, name, kind, docType) => {
    const fd = new FormData(); fd.append('intake', kind); if (kind === 'structured' && docType) fd.append('docType', docType); fd.append('file', blob, name);
    try { const r = await api('POST', '/docs/upload', fd); toast(r.duplicateOf ? 'Uploaded — flagged as a duplicate of an earlier file' : 'Uploaded — processing started'); navigate(`#/e/inbox/${r.id}`); } catch (e) { errToast(e); }
  };
  const radio = (v, title, d) => h('label', { class: 'card flat row', style: { cursor: 'pointer', alignItems: 'flex-start' } }, h('input', { type: 'radio', name: 'intake', value: v, checked: v === intake, onchange: () => { intake = v; typeSel.disabled = v !== 'structured'; } }), h('div', null, h('b', null, title), h('div', { class: 'small muted' }, d)));
  const form = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); if (file.files[0]) upload(file.files[0], file.files[0].name, intake, typeSel.value); } },
    h('div', { class: 'grid c2' }, radio('structured', 'Structured financial document', 'Invoice, quote, receipt, PO… OCR / extraction → fields with confidence → validation → Billing Review.'), radio('unstructured', 'Unstructured source document', 'Memo, proposal, approval letter… summarised → matched to Financial Events → drafted financial document.')),
    h('div', { class: 'grid c2' }, h('label', { class: 'f' }, 'Document type (structured)', typeSel), h('label', { class: 'f' }, 'File (PDF, DOCX, PNG, JPEG, TXT — max 20 MB)', file)), h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Upload & process')),
    h('div', { class: 'notice info small' }, 'Uploading never pays anything. OCR is not approval: output goes to Billing Review as a draft, and a bill exists only after approvals and finance review.'));
  const body = h('div', { class: 'stack loose' }, pageHead('Document inbox', 'Upload financial documents for the RT-FEPE engine. The original is stored privately, hashed, and never modified.'), h('div', { class: 'card stack' }, form,
    h('div', null, h('div', { class: 'small', style: { fontWeight: 700, marginBottom: '6px' } }, 'Or try a sample document'), h('div', { class: 'chips' }, SAMPLES.map(([l, f, k, t]) => h('button', { class: 'chip', style: { cursor: 'pointer' }, onclick: async () => { const r = await fetch(`/samples/${f}`); upload(await r.blob(), f, k, t); } }, l))))),
    h('h2', null, 'Your uploads'), recTable(recs));
  if (recs.some(r => ['stored', 'processing'].includes(r.status))) setTimeout(() => { if (location.hash === '#/e/inbox') navigate('#/e/inbox'); }, 2500);
  return body;
}
const recTable = recs => table([{ label: 'File', render: r => h('div', null, h('b', null, r.filename), h('div', { class: 'small muted mono' }, `sha256 ${r.sha256 ? r.sha256.slice(0, 14) : ''}…`)) }, { label: 'Type', render: r => tag(r.intake) }, { label: 'Status', render: r => h('div', { class: 'row wrap' }, badge(r.status), r.duplicateOf && badge('exception', 'Duplicate file')) },
  { label: 'Method', render: r => (r.method ? `${r.method}${r.ocrConfidence != null ? ` · ${r.ocrConfidence}%` : ''}` : '—') }, { label: 'Documents', render: r => r.documents ?? r.documentIds.length }, { label: 'Uploaded', render: r => dt(r.uploadedAt) }], recs, { onRow: r => navigate(`#/e/inbox/${r.id}`), empty: 'Nothing uploaded yet.' });

/* ------------------------------------------------------------------ source viewer (left pane) */
async function sourcePane(rec, highlight) {
  const pv = await get(`/docs/records/${rec.id}/preview`);
  const pane = h('div', { class: 'pane' }); const pb = h('div'); let zoom = 1, page = 1;
  const viewer = h('div');
  const showPreview = () => {
    clear(viewer);
    if (pv.kind === 'image') { const img = h('img', { class: 'viewer-img', src: pv.url, alt: `Original document ${rec.filename}`, style: { width: `${zoom * 100}%` } }); viewer.append(h('div', { class: 'viewer-wrap' }, img)); }
    else if (pv.kind === 'pdf') viewer.append(h('iframe', { class: 'viewer', src: `${pv.url}#page=${page}&zoom=${Math.round(zoom * 100)}`, title: `Original ${rec.filename}` }));
    else if (pv.kind === 'html') viewer.append(h('iframe', { class: 'viewer', sandbox: '', srcdoc: `<base target="_blank"><style>body{font:14px system-ui;padding:14px;line-height:1.5}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}</style>${pv.html}`, title: `Original ${rec.filename}` }));
    else viewer.append(h('pre', { class: 'viewer-text' }, pv.text));
  };
  const tabs = { preview: () => { pb.replaceChildren(h('div', { class: 'row wrap small', style: { marginBottom: '8px' } }, h('button', { class: 'btn sm', 'aria-label': 'Zoom out', onclick: () => { zoom = Math.max(.4, zoom - .2); showPreview(); } }, '−'), h('button', { class: 'btn sm', onclick: () => { zoom = 1; showPreview(); } }, '100%'), h('button', { class: 'btn sm', 'aria-label': 'Zoom in', onclick: () => { zoom = Math.min(3, zoom + .2); showPreview(); } }, '+'),
      pv.kind === 'pdf' && [h('button', { class: 'btn sm', onclick: () => { page = Math.max(1, page - 1); showPreview(); } }, '‹ Page'), h('button', { class: 'btn sm', onclick: () => { page += 1; showPreview(); } }, 'Page ›')]), viewer); showPreview(); },
    text: () => { pb.replaceChildren(h('div', { class: 'small muted', style: { marginBottom: '6px' } }, `${rec.lines.length} extracted lines${rec.ocrConfidence != null ? ` · OCR confidence ${rec.ocrConfidence}%` : ''} · page/line references`), h('div', { style: { maxHeight: '62vh', overflow: 'auto' }, id: 'ocr-lines' }, rec.lines.map(l => h('div', { class: `ocr-line ${highlight && highlight.some(t => t && l.text.toLowerCase().includes(t.toLowerCase().slice(0, 28))) ? 'hl' : ''}` }, h('i', null, `${l.page ? 'p' + l.page + ':' : ''}${l.n}`), h('span', null, l.text))))); } };
  const tabBar = h('div', { class: 'tabs' }, ['preview', 'text'].map((k, i) => h('button', { class: i === 0 ? 'on' : '', onclick: e => { tabBar.querySelectorAll('button').forEach(b => b.classList.remove('on')); e.target.classList.add('on'); tabs[k](); } }, k === 'preview' ? 'Original' : 'OCR / extracted text')));
  pane.append(h('header', null, h('span', null, 'Original source document'), badge(rec.status)), h('div', { class: 'pb stack' }, h('dl', { class: 'kv', style: { gridTemplateColumns: '110px 1fr' } }, h('dt', null, 'File'), h('dd', null, rec.filename), h('dt', null, 'Uploaded'), h('dd', null, `${dt(rec.uploadedAt)} by ${rec.uploadedBy}`), h('dt', null, 'Integrity'), h('dd', { class: 'mono', style: { wordBreak: 'break-all' } }, `sha256 ${rec.sha256}`), h('dt', null, 'Size'), h('dd', null, `${(rec.size / 1024).toFixed(1)} KB · ${rec.mime}`)),
    rec.duplicateOf && h('div', { class: 'notice bad small' }, 'This exact file was uploaded before.'), tabBar, pb));
  tabs.preview();
  pane.showText = () => tabBar.querySelectorAll('button')[1].click();
  pane.refreshHighlight = h2 => { highlight = h2; };
  return pane;
}

/* ------------------------------------------------------------------ record page */
async function recordPage(ctx) {
  const rec = await get(`/docs/records/${ctx.params[0]}`);
  const src = await sourcePane(rec);
  const right = h('div', { class: 'pane' }); const pb = h('div', { class: 'pb stack' });
  right.append(h('header', null, h('span', null, rec.intake === 'structured' ? 'Parsed financial document' : 'Summary & generated documents'), badge(rec.status)), pb);
  if (['stored', 'processing'].includes(rec.status)) { pb.append(h('div', { class: 'notice info' }, 'Processing in the background (OCR / extraction / matching)…')); setTimeout(() => { if (location.hash.includes(rec.id)) navigate(location.hash); }, 2000); }
  if (rec.status === 'failed') pb.append(h('div', { class: 'notice bad' }, rec.error), can('docs.review') && h('button', { class: 'btn', onclick: async () => { await post(`/docs/records/${rec.id}/reprocess`); navigate(location.hash); } }, 'Re-run extraction'));
  if (rec.note) pb.append(h('div', { class: 'notice warn' }, rec.note));
  if (rec.summary) pb.append(h('div', null, h('h3', null, 'Key financial events'), rec.summary.events.map(e => h('div', { class: 'card flat', style: { marginBottom: '6px' } }, h('div', null, e.text), e.match && h('div', { class: 'small muted' }, `→ ${e.match.sourceDocument} / ${e.match.financialEvent} ← “${e.match.phrase}” `, conf(e.match.score))))), rec.summary.dropped != null && h('div', { class: 'small muted' }, `${rec.summary.dropped} non-financial sentence(s) were ignored.`));
  if (rec.structured && rec.structured.parsed) { const p = rec.structured.parsed; pb.append(kv([['Detected type', rec.structured.label], ['Document no.', p.docNumber], ['Date', p.date], ['Party', p.partyName], ['Net', p.totals.net != null ? major(p.totals.net) : null], ['VAT', p.totals.vat != null ? major(p.totals.vat) : null], ['WHT', p.totals.wht != null ? major(p.totals.wht) : null], ['Total', p.totals.total != null ? major(p.totals.total) : null]]), p.warnings.map(w => h('div', { class: 'notice warn small' }, w)),
    rec.fields && rec.fields.length ? h('div', { class: 'small muted' }, `${rec.fields.length} fields stored with confidence${rec.ocrConfidence != null ? ` (${rec.ocrConfidence}% OCR)` : ''}`) : null); }
  pb.append(h('h3', null, 'Documents for Billing Review'), table([{ label: 'Number', render: d => h('b', null, d.number) }, { label: 'Type', key: 'sourceDocument' }, { label: 'Counterparty', key: 'counterparty' }, { label: 'Events', render: d => d.events.join(', ') }, { label: 'Gross', right: true, render: d => fmt(Math.round(d.gross * 100)) }, { label: 'Status', render: d => badge(d.status) }], rec.documents,
    { onRow: d => navigate(`#/e/review/${d.id}`), empty: rec.status === 'processed' ? 'No billing document was generated.' : 'Nothing yet.' }));
  return h('div', { class: 'stack' }, h('a', { href: '#/e/inbox' }, '← Inbox'), pageHead(rec.filename, 'Original beside the processed result'), h('div', { class: 'review' }, src, right));
}

/* ------------------------------------------------------------------ billing review list */
async function reviewList(ctx) {
  const docs = await get('/docs/documents');
  const f = ctx.query.s;
  const rows = f ? docs.filter(d => d.status === f) : docs;
  return h('div', { class: 'stack' }, pageHead('Billing Review', 'Structured and unstructured documents converge here for correction, approval and conversion into payable bills.'),
    h('div', { class: 'row wrap' }, h('a', { class: 'chip', href: '#/e/review' }, 'All'), ['draft', 'pending_approval', 'approved', 'billed'].map(s => h('a', { class: 'chip', href: `#/e/review?s=${s}` }, cap(s)))),
    table([{ label: 'Number', render: d => h('b', null, d.number) }, { label: 'Source file', render: d => d.filename }, { label: 'Path', render: d => tag(d.intake) }, { label: 'Type', key: 'sourceDocument' }, { label: 'Counterparty', key: 'counterparty' }, { label: 'Events', render: d => d.events.join(', ') }, { label: 'Gross', right: true, render: d => fmt(Math.round(d.gross * 100)) },
      { label: 'Status', render: d => h('div', { class: 'row wrap' }, badge(d.status), d.duplicateOf && badge('exception', 'Duplicate')) }, { label: '', render: d => d.billId && h('a', { class: 'btn sm', href: `#/e/bills`, onclick: e => e.stopPropagation() }, 'Bill') }], rows, { onRow: d => navigate(`#/e/review/${d.id}`), empty: 'Nothing to review. Upload a document in the Document Inbox.' }));
}

/* ------------------------------------------------------------------ side-by-side review */
async function reviewPage(ctx) {
  const id = ctx.params[0];
  const doc = await get(`/docs/documents/${id}`);
  const [rec, parties] = await Promise.all([get(`/docs/records/${doc.origin.recordId}`), get('/docs/parties')]);
  const editable = doc.status === 'draft' && can('docs.review');
  const draft = { header: { ...doc.header }, refs: { ...doc.refs }, lines: doc.lines.map(l => ({ id: l.id, rowIndex: l.rowIndex, description: l.description, quantity: String(l.quantity ?? ''), unitPrice: String(l.unitPrice ?? ''), vat: String(l.vat ?? ''), wht: String(l.wht ?? '') })) };
  const src = await sourcePane(rec, doc.lines.map(l => l.evidence));
  const reload = () => navigate(location.hash);
  const wrap = fn => async () => { try { await fn(); } catch (e) { errToast(e); } };
  const inp = (obj, key, label, opts = {}) => h('label', { class: 'f' }, label, h('input', { value: obj[key] ?? '', disabled: !editable, oninput: e => { obj[key] = e.target.value; }, ...opts }));
  const warnings = [...doc.platformWarnings, ...doc.issues.submit.map(i => ({ level: i.level, msg: i.msg, ref: i.ref }))];
  const save = async (extra = {}) => { await patch(`/docs/documents/${id}`, { header: draft.header, refs: draft.refs, lines: draft.lines, ...extra }); };

  const headerForm = h('div', { class: 'stack' }, h('div', { class: 'grid c2' }, h('label', { class: 'f' }, 'Recipient / vendor (from master data)', h('select', { disabled: !editable, onchange: e => { draft.header.partyId = e.target.value; } }, h('option', { value: '' }, '— not in master data —'), parties.filter(p => p.kind !== 'customer' || doc.header.partyKind === 'customer').map(p => h('option', { value: p.id, selected: p.id === draft.header.partyId }, `${p.name} (${p.kind})`)))),
    inp(draft.header, 'counterparty', 'Counterparty name', { readOnly: !!doc.header.partyId }), inp(draft.header, 'department', 'Department'), inp(draft.header, 'costCenter', 'Cost centre'), inp(draft.header, 'documentDate', 'Document date', { type: 'date' }), inp(draft.header, 'purpose', 'Business purpose'),
    h('label', { class: 'f' }, 'Beneficiary account', h('input', { value: doc.header.accountNumber ? `•••• ${doc.header.accountNumber.slice(-4)} · ${doc.header.bankName}` : 'none on file', disabled: true })), h('label', { class: 'f' }, 'Tax ID', h('input', { value: doc.header.taxId || '—', disabled: true }))),
    h('h3', null, 'References'), h('div', { class: 'grid c3' }, inp(draft.refs, 'purchaseRequest', 'Purchase request'), inp(draft.refs, 'quotation', 'Quotation'), inp(draft.refs, 'quotationWaiver', 'Quotation waiver note'), inp(draft.refs, 'purchaseOrder', 'Purchase order'), inp(draft.refs, 'receipt', 'Goods / service receipt'), inp(draft.refs, 'invoice', 'Vendor invoice no.')),
    doc.sourceDocument === 'Expense Claim' && h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: !!draft.header.receiptsAttached, disabled: !editable, onchange: e => { draft.header.receiptsAttached = e.target.checked; } }), 'Supporting receipts attached'));

  const lineCard = (l, i) => {
    const dl = draft.lines[i];
    return h('div', { class: `line-card stack tight ${l.confidence < .7 ? 'low' : ''}` },
      h('div', { class: 'row between wrap' }, h('div', { class: 'row' }, h('b', null, `Line ${i + 1}`), h('span', { class: 'small' }, 'match confidence '), conf(l.confidence), l.figureSource === 'fictitious' ? tag('Illustrative figures', 'demo') : l.figureSource === 'extracted' ? tag('Extracted', 'ai') : tag(cap(l.figureSource))), editable && h('button', { class: 'btn sm danger', onclick: () => { draft.lines.splice(i, 1); wrap(async () => { await save(); reload(); })(); } }, 'Remove')),
      h('label', { class: 'f' }, 'Description / evidence', h('textarea', { rows: 2, disabled: !editable, oninput: e => { dl.description = e.target.value; } }, l.description)),
      h('div', { class: 'grid c2' }, h('label', { class: 'f' }, 'Financial event', h('select', { disabled: !editable, onchange: e => { dl.rowIndex = Number(e.target.value); } }, doc.events.map(ev => h('option', { value: ev.rowIndex, selected: ev.rowIndex === l.rowIndex }, `${ev.event} — “${ev.phrase}”`)))),
        h('div', { class: 'small' }, h('div', null, h('b', null, 'Matched phrase: '), `“${l.phrase}”`), h('div', null, h('b', null, 'Journal: '), l.journalEntry), h('div', null, h('b', null, 'GL: '), l.glPosting), l.statedAmount && h('div', null, h('b', null, 'Stated in source: '), String(l.statedAmount.raw ?? l.statedAmount)))),
      h('div', { class: 'grid c4' }, inp(dl, 'quantity', 'Quantity', { type: 'number', step: 'any' }), inp(dl, 'unitPrice', 'Unit price', { type: 'number', step: '0.01' }), inp(dl, 'vat', 'VAT', { type: 'number', step: '0.01' }), inp(dl, 'wht', 'WHT', { type: 'number', step: '0.01' })),
      h('div', { class: 'small muted' }, `Net ${major(l.figures.net)} · VAT ${major(l.figures.vat)} · WHT ${major(l.figures.wht)} · Gross ${major(l.figures.gross)}${l.figures.tax.vat ? '' : ' · VAT n/a'}${l.figures.tax.wht ? '' : ' · WHT n/a'}`));
  };
  const lines = h('div', { class: 'stack' }, doc.lines.map(lineCard));
  const addLine = () => formModal('Add line item', [{ name: 'rowIndex', label: 'Financial event (from the reference data)', type: 'select', options: doc.events.map(e => ({ value: e.rowIndex, label: `${e.event} — “${e.phrase}”` })) }, { name: 'description', label: 'Description', required: true }], async d => { draft.lines.push({ rowIndex: Number(d.rowIndex), description: d.description, quantity: '1', unitPrice: '', vat: '', wht: '' }); await save(); reload(); });

  const reqApprovals = doc.requiredApprovals;
  const approvalsBox = h('div', { class: 'stack tight' }, h('div', { class: 'small muted' }, `Amount tier up to ${doc.tier.max == null ? 'unlimited' : `₦${major(doc.tier.max)}`} (FIN-POL-001)`), reqApprovals.map(r => h('div', { class: 'row between card flat' }, h('div', null, h('b', null, r.role), h('div', { class: 'small muted' }, r.reason)), r.approval ? badge('approved', `${r.approval.by}`) : doc.status === 'pending_approval' && can('docs.approve') ? h('button', { class: 'btn ok sm', onclick: wrap(async () => { await post(`/docs/documents/${id}/approve`, { role: r.role }); toast(`${r.role} approved`); reload(); }) }, `Approve as ${r.role}`) : badge('pending'))));

  // finance review (final) section
  const review = { threeWay: { ...(doc.review.threeWay || {}) }, vendorChecks: { ...(doc.review.vendorChecks || {}) }, ack: !!doc.review.ackLowConfidence, overrides: { ...(doc.review.accountOverrides || {}) } };
  const needsTW = doc.sourceDocument === 'Vendor Invoice' && doc.totals.gross > 100000;
  const financeBox = doc.status === 'approved' && can('docs.finance_review') ? h('div', { class: 'card tint stack' }, h('h3', null, 'Finance review — final step'), h('p', { class: 'small muted' }, 'Independent of the preparer and approvers. Completing this creates the approved payable bill; it does not pay anything.'),
    needsTW && h('div', { class: 'grid c2' }, h('div', null, h('b', { class: 'small' }, 'Three-way match (PROC-CTRL-001)'), doc.checklists.threeWay.map(c => h('label', { class: 'row small' }, h('input', { type: 'checkbox', checked: !!review.threeWay[c], onchange: e => { review.threeWay[c] = e.target.checked; } }), c))), h('div', null, h('b', { class: 'small' }, 'Vendor verification (PROC-POL-001)'), doc.checklists.vendor.map(c => h('label', { class: 'row small' }, h('input', { type: 'checkbox', checked: !!review.vendorChecks[c], onchange: e => { review.vendorChecks[c] = e.target.checked; } }), c)))),
    doc.lines.some(l => l.confidence < .7) && h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: review.ack, onchange: e => { review.ack = e.target.checked; } }), 'I confirm the low-confidence event classification (RAG-CTRL-001)'),
    doc.accountsNeedingCode.map(a => h('label', { class: 'f' }, `COA code for "${a.account}" (${a.range.from}–${a.range.to}, ${a.range.label})`, h('input', { type: 'number', value: review.overrides[a.account] || '', oninput: e => { review.overrides[a.account] = e.target.value; } }))),
    doc.issues.review.length ? doc.issues.review.map(i => h('div', { class: 'notice warn small' }, i.msg)) : null,
    h('button', { class: 'btn primary', onclick: wrap(async () => { try { const r = await post(`/docs/documents/${id}/finance-review`, { threeWay: review.threeWay, vendorChecks: review.vendorChecks, ackLowConfidence: review.ack, accountOverrides: review.overrides }); toast('Bill created — approved and ready for payment'); navigate(`#/e/bills/${r.billId}`); } catch (e) { errToast(e); } }) }, 'Complete finance review & create payable bill')) : null;

  const submit = wrap(async () => {
    if (editable) await save();
    try { await post(`/docs/documents/${id}/submit`, {}); toast('Submitted for approval'); reload(); }
    catch (e) {
      if (e.body && e.body.code === 'duplicate' && can('docs.exception')) {
        formModal('Suspected duplicate', [{ name: 'reason', label: 'Exception reason (audited)', type: 'textarea', required: true }], async d => { await post(`/docs/documents/${id}/submit`, { exception: { reason: d.reason } }); toast('Submitted with exception'); reload(); }, { intro: (e.body.issues || []).map(i => i.msg).join(' '), submit: 'Submit with exception' });
      } else throw e;
    }
  });
  const actions = h('div', { class: 'row wrap' },
    editable && h('button', { class: 'btn', onclick: wrap(async () => { await save(); toast('Draft saved'); reload(); }) }, 'Save draft'), editable && h('button', { class: 'btn', onclick: addLine }, '+ Add line'),
    editable && h('button', { class: 'btn', onclick: wrap(async () => { await save(); const r = await post(`/docs/documents/${id}/rematch`); toast('Financial Event matching re-run'); reload(); void r; }) }, 'Re-run matching'),
    can('docs.review') && doc.status === 'draft' && h('button', { class: 'btn', onclick: wrap(async () => { await post(`/docs/records/${rec.id}/reprocess`); toast('Extraction re-run'); navigate('#/e/review'); }) }, 'Re-run extraction'),
    editable && doc.lines.some(l => l.figureSource === 'fictitious') && h('button', { class: 'btn', onclick: wrap(async () => { if (await confirmBox('Confirm these figures are correct and verified against the source? Illustrative figures cannot be paid until confirmed.')) { await save({ confirmFigures: true }); reload(); } }) }, 'Confirm figures'),
    can('docs.review') && ['draft'].includes(doc.status) && h('button', { class: 'btn', onclick: () => formModal('Request missing information', [{ name: 'note', label: 'What is missing?', type: 'textarea', required: true }], async d => { await post(`/docs/documents/${id}/request-info`, d); toast('Requester notified'); }) }, 'Request missing information'),
    editable && h('button', { class: 'btn primary', onclick: submit }, 'Submit for approval'),
    ['pending_approval', 'approved'].includes(doc.status) && (can('docs.approve') || can('docs.finance_review')) && h('button', { class: 'btn danger', onclick: () => formModal('Return for correction', [{ name: 'reason', label: 'Reason', type: 'textarea', required: true }], async d => { await post(`/docs/documents/${id}/reject`, d); toast('Returned to draft'); reload(); }) }, 'Return for correction'),
    can('audit.view') && h('a', { class: 'btn', href: `#/f/audit?o=${id}` }, 'Audit trail'));

  const right = h('div', { class: 'pane' }); const pb = h('div', { class: 'pb stack' });
  right.append(h('header', null, h('span', null, `Processed financial document · ${doc.number}`), h('span', { class: 'row' }, tag(doc.sourceDocument), badge(doc.status), doc.origin.intake && tag(doc.origin.intake))), pb);
  pb.append(warnings.length ? h('div', { class: 'stack tight' }, warnings.map(w => h('div', { class: `notice ${w.level === 'error' ? 'bad' : 'warn'} small` }, w.msg, w.ref && h('span', { class: 'muted' }, `  (${w.ref})`)))) : null,
    doc.rejection && h('div', { class: 'notice bad small' }, `Returned by ${doc.rejection.by}: ${doc.rejection.reason}`), doc.billId && h('div', { class: 'notice ok' }, 'Bill created. ', h('a', { href: '#/e/bills' }, 'Open bills')),
    !editable && doc.status === 'draft' && h('div', { class: 'notice info small' }, 'You can view this draft; editing needs Billing Review permission.'), doc.status !== 'draft' && h('div', { class: 'notice info small' }, 'Locked: submitted and approved documents are immutable. A material correction means returning it for correction, which creates a new version and repeats the approvals.'),
    h('h3', null, 'Header'), headerForm, h('div', { class: 'row between' }, h('h3', null, 'Financial event line items'), tag('Matches: Financial Events reference data')), lines,
    h('div', { class: 'card flat' }, h('dl', { class: 'kv', style: { gridTemplateColumns: '1fr auto' } }, h('dt', null, 'Net'), h('dd', null, major(doc.totals.net)), h('dt', null, 'VAT'), h('dd', null, major(doc.totals.vat)), h('dt', null, 'Gross'), h('dd', null, h('b', null, major(doc.totals.gross))), h('dt', null, 'Withholding tax'), h('dd', null, major(doc.totals.wht)), h('dt', null, 'Payable'), h('dd', null, h('b', null, major(doc.totals.payable))))),
    doc.journal.length ? h('div', null, h('h3', null, `Journal preview ${doc.balanced ? '' : '— UNBALANCED'}`), h('table', { class: 'journal' }, h('tbody', null, doc.journal.map(j => h('tr', null, h('td', null, j.side), h('td', null, `${j.code || '—'} ${j.account}${j.memo ? ' (memo)' : ''}`), h('td', { class: 'right' }, major(j.amount))))))) : h('div', { class: 'small muted' }, 'No GL posting (commitment / register only).'),
    h('h3', null, 'Approvals'), approvalsBox, financeBox, actions,
    doc.versions.length ? h('div', { class: 'small muted' }, 'Versions: ', doc.versions.map(v => `v${v.version} ${v.stage} (${v.content_sha256.slice(0, 8)})`).join(' · ')) : null,
    h('div', { class: 'small muted' }, doc.policyRefs.length ? ['Policy references: ', doc.policyRefs.map(p => h('a', { href: '#', onclick: async e => { e.preventDefault(); const c = await get(`/docs/policy/${p.id}`); modal(close => h('div', { class: 'stack' }, h('h2', null, `${c.id} — ${c.title}`), h('pre', { style: { whiteSpace: 'pre-wrap', fontFamily: 'inherit' } }, c.text), h('button', { class: 'btn', onclick: close }, 'Close')), { wide: true }); } }, `${p.id} `))] : null));
  // highlight evidence in OCR text when a line card is focused
  right.addEventListener('focusin', e => { const card = e.target.closest('.line-card'); if (!card) return; const i = [...lines.children].indexOf(card); if (i >= 0) { src.refreshHighlight([doc.lines[i].evidence]); } });
  return h('div', { class: 'stack' }, h('a', { href: '#/e/review' }, '← Billing Review'), pageHead('Billing Review', 'Left: the original, untouched. Right: the processed document you can correct. Every change is versioned and audited.'), h('div', { class: 'review' }, src, right));
}

/* ------------------------------------------------------------------ processing monitor */
async function monitor() {
  const [recs, docs] = await Promise.all([get('/docs/records'), get('/docs/documents')]);
  const count = s => recs.filter(r => r.status === s).length;
  return h('div', { class: 'stack loose' }, pageHead('RT-FEPE processing monitor', 'Document intake jobs, extraction quality and what is waiting for review.'),
    h('div', { class: 'grid c4' }, stat('Processed', count('processed'), 'ok'), stat('Processing', count('processing') + count('stored'), count('processing') ? 'warn' : ''), stat('Failed', count('failed'), count('failed') ? 'bad' : ''), stat('Duplicate files', recs.filter(r => r.duplicateOf).length, recs.some(r => r.duplicateOf) ? 'warn' : ''),
      stat('Low OCR (<75%)', recs.filter(r => r.ocrConfidence != null && r.ocrConfidence < 75).length, 'warn'), stat('Drafts to review', docs.filter(d => d.status === 'draft').length, 'warn', '#/e/review?s=draft'), stat('Awaiting approval', docs.filter(d => d.status === 'pending_approval').length, '', '#/e/review?s=pending_approval'), stat('Billed', docs.filter(d => d.status === 'billed').length, 'ok')),
    table([{ label: 'File', render: r => h('a', { href: `#/e/inbox/${r.id}` }, r.filename) }, { label: 'Path', render: r => tag(r.intake) }, { label: 'Status', render: r => badge(r.status) }, { label: 'Method', render: r => r.method || '—' }, { label: 'OCR', render: r => (r.ocrConfidence != null ? h('span', { class: r.ocrConfidence < 75 ? 'conf lo' : 'conf hi' }, `${r.ocrConfidence}%`) : '—') }, { label: 'Docs', render: r => r.documents ?? 0 }, { label: 'Error', render: r => r.error || '' },
      { label: '', render: r => r.status === 'failed' && can('docs.review') && h('button', { class: 'btn sm', onclick: async () => { await post(`/docs/records/${r.id}/reprocess`); navigate(location.hash); } }, 'Retry') }], recs, { empty: 'No documents processed yet.' }));
}

export function registerDocs() {
  route('/e/inbox', inbox); route('/e/inbox/:id', recordPage); route('/e/review', reviewList); route('/e/review/:id', reviewPage); route('/f/monitor', monitor);
}
