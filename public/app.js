'use strict';
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const STATUS = { draft: ['Draft · corrections', ''], pending_approval: ['Pending approval', 'warn'], approved: ['Awaiting finance review', 'brand'], billed: ['Billed', 'ok'] };
const REC_STATUS = { stored: ['Stored', ''], processing: ['Processing…', 'warn'], processed: ['Processed', 'ok'], failed: ['Failed', 'err'] };
const store = { get: k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

const S = { me: null, tab: 'upload', config: null, intake: 'structured', docType: 'auto', records: [], docs: [], bills: [], parties: [], recordId: null, current: null, currentId: null, bill: null, showOriginal: false, billFilter: 'all' };

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body instanceof FormData) init.body = opts.body;
  else if (opts.body) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
  const res = await fetch('/api' + path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) { S.me = null; viewLogin('Your session has ended. Please sign in again.'); }
    throw Object.assign(new Error(data.error || res.statusText), { issues: data.issues, status: res.status });
  }
  return data;
}
const isVendor = () => S.me && S.me.role === 'vendor';
const hasRole = r => S.me && S.me.role === 'buyer' && (S.me.approvalRoles || []).includes(r);
function toast(msg, issues, good) {
  const t = $('#toast');
  t.className = good ? 'good' : '';
  t.innerHTML = esc(msg) + (issues && issues.length ? '<ul>' + issues.map(i => `<li>${esc(i.msg || i)}</li>`).join('') + '</ul>' : '');
  t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), good ? 2500 : 9000);
}
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { if (e.status !== 401) toast(e.message, e.issues); } };
const pill = (text, cls = '') => `<span class="pill ${cls}">${esc(text)}</span>`;
const intakePill = i => pill(i === 'structured' ? 'Structured' : 'Unstructured', i === 'structured' ? 'brand' : '');

function go(tab) { S.tab = tab; render(); }
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { if (b.dataset.tab === 'records') S.recordId = null; go(b.dataset.tab); } });
window.go = go;

async function refreshLists() {
  [S.records, S.docs, S.bills] = await Promise.all([api('/records'), api('/documents'), api('/bills')]);
  $('#recCount').textContent = S.records.length || '';
  $('#docCount').textContent = S.docs.filter(d => d.status !== 'billed').length || '';
  $('#billCount').textContent = S.bills.length || '';
}
async function openDoc(id) { S.currentId = id; S.current = await api('/documents/' + id); }
function applyChrome() {
  const vendor = isVendor();
  document.querySelectorAll('#tabs button').forEach(b => { b.hidden = !S.me || (vendor && ['billing', 'parties'].includes(b.dataset.tab)); });
  const label = { records: vendor ? 'My invoices' : 'Records', bills: vendor ? 'My bills' : 'Bills' };
  document.querySelectorAll('#tabs button').forEach(b => { const t = label[b.dataset.tab]; if (t) b.firstChild.textContent = t + ' '; });
  $('#user').innerHTML = S.me ? `<span class="who"><b>${esc(S.me.name)}</b><small>${esc(S.me.title)}</small></span><button class="btn sec" id="logout">Sign out</button>` : '';
  const lo = $('#logout'); if (lo) lo.onclick = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); S.me = null; S.tab = 'upload'; S.current = S.currentId = S.bill = null; viewLogin(); };
}
function render() {
  if (!S.me) return viewLogin();
  applyChrome();
  if (isVendor() && ['billing', 'parties'].includes(S.tab)) S.tab = 'upload';
  const active = S.tab === 'record' ? 'records' : S.tab;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === active));
  ({ upload: viewUpload, records: viewRecords, record: viewRecord, billing: viewBilling, bills: viewBills, parties: viewParties })[S.tab]();
}
const showPolicy = a => guard(async () => {
  const c = await api('/policy/' + a.dataset.policy);
  $('#policyTitle').textContent = `${c.id} — ${c.title}`; $('#policyText').textContent = c.text; $('#policyDialog').showModal();
});
const wirePolicy = root => root.querySelectorAll('[data-policy]').forEach(a => { a.onclick = showPolicy(a); });

/* ------------------------------- Upload -------------------------------- */
function viewUpload() {
  const vendor = isVendor();
  if (vendor) { S.intake = 'structured'; if (!['invoice_payable', 'quote'].includes(S.docType)) S.docType = 'invoice_payable'; }
  const types = S.config.structuredTypes.filter(t => !vendor || ['invoice_payable', 'quote'].includes(t.key));
  $('#view').innerHTML = `
  <div class="card"><h2>Upload a document</h2>
    <p class="sub">Every upload is stored as a record first, then processed. Choose how it should be processed:</p>
    <div class="cards">${isVendor() ? '' : `
      <div class="choice ${S.intake === 'structured' ? 'on' : ''}" data-intake="structured"><h3>Structured</h3><p>Invoices, quotes and receipts. They already are source documents: OCR reads them, the data is posted as structured fields and line items, and they go to Billing.</p></div>
      <div class="choice ${S.intake === 'unstructured' ? 'on' : ''}" data-intake="unstructured"><h3>Unstructured</h3><p>Approved source documents, proposals, notes and memos. Key financial events are summarised and matched to the Financial Events to generate source documents (employee expenses, vendor payments, admin expenses…) with illustrative figures.</p></div>`}
    </div>
    <div class="grid2" style="margin-top:14px">
      ${S.intake === 'structured' ? `<div><label>Document type</label><select id="docType">${vendor ? '' : '<option value="auto">Auto-detect</option>'}${types.map(t => `<option value="${t.key}" ${S.docType === t.key ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></div>` : ''}
      <div><label>Uploaded by</label><input type="text" value="${esc(S.me.name)}" disabled></div>
    </div>
    <div class="drop" id="drop" style="margin-top:14px"><p>Drag a file here, or choose one (.pdf, .docx, .png, .jpg, .txt)</p>
      <input type="file" id="file" accept=".pdf,.docx,.png,.jpg,.jpeg,.webp,.bmp,.txt,.md,.csv"></div>
    <div class="row" style="margin-top:10px"><span class="hint">Try a sample:</span>
      <button class="btn sec" data-sample="structured|invoice_securetech.png|invoice_payable">Invoice image (structured, OCR)</button>
      <button class="btn sec" data-sample="structured|invoice_okafor.pdf|${vendor ? 'invoice_payable' : 'auto'}">Invoice PDF (structured)</button>
      ${vendor ? '' : `<button class="btn sec" data-sample="unstructured|memo_admin_expenses.txt|">Memo (unstructured)</button>
      <button class="btn sec" data-sample="unstructured|proposal_q2_operations.docx|">Proposal .docx (unstructured)</button>`}</div>${vendor ? '<p class="hint">Invoices you upload are matched to your own vendor account and sent to the company for processing.</p>' : ''}
  </div>`;
  document.querySelectorAll('[data-intake]').forEach(c => c.onclick = () => { S.intake = c.dataset.intake; viewUpload(); });
  const dt = $('#docType'); if (dt) dt.onchange = () => { S.docType = dt.value; };
  const send = guard(async (file, intake = S.intake, docType = S.docType) => {
    const fd = new FormData(); fd.append('intake', intake);
    if (intake === 'structured') fd.append('docType', docType); fd.append('file', file);
    const rec = await api('/records', { method: 'POST', body: fd });
    await refreshLists(); S.recordId = rec.id; go('record');
  });
  $('#file').onchange = e => e.target.files[0] && send(e.target.files[0]);
  document.querySelectorAll('[data-sample]').forEach(b => b.onclick = guard(async () => {
    const [intake, name, docType] = b.dataset.sample.split('|');
    const blob = await (await fetch('/samples/' + name)).blob();
    await send(new File([blob], name), intake, docType || 'auto');
  }));
  const drop = $('#drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files[0] && send(e.dataTransfer.files[0]); };
}

/* ------------------------------- Records ------------------------------- */
async function viewRecords() {
  await refreshLists();
  $('#view').innerHTML = `<div class="card"><h2>Records</h2><p class="sub">Every uploaded document is stored with its processing result.</p>
    ${S.records.length ? `<div class="scroll"><table><thead><tr><th>File</th><th>Type</th><th>Status</th><th>Documents</th><th>Uploaded by</th><th>When</th></tr></thead><tbody>
    ${S.records.map(r => `<tr style="cursor:pointer" data-rec="${r.id}"><td><b>${esc(r.filename)}</b></td><td>${intakePill(r.intake)}</td><td>${pill(...REC_STATUS[r.status])}</td><td>${r.documents}</td><td>${esc(r.uploadedBy)}</td><td class="mut">${new Date(r.uploadedAt).toLocaleString()}</td></tr>`).join('')}</tbody></table></div>` : '<p class="mut">Nothing uploaded yet.</p>'}</div>`;
  document.querySelectorAll('[data-rec]').forEach(tr => tr.onclick = () => { S.recordId = tr.dataset.rec; go('record'); });
}

/* ------- Record page: source preview (left) | processed document (right) ------- */
function paperDoc(d) {
  const h = d.header, c = d.company;
  const anyFict = d.lines.some(l => l.figureSource === 'fictitious');
  const refs = Object.entries(d.refs).filter(([k, v]) => v && k !== 'quotationWaiver').map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${esc(v)}`).join(' · ');
  return `<article class="paper">
    <div class="p-head"><div><b>${esc(c.name)}</b><br><small>${esc(c.address)}</small></div><div class="p-title">${esc(d.sourceDocument.toUpperCase())}<br><small>${esc(d.number)}</small></div></div>
    <div class="p-meta">
      <div><label>${h.partyKind === 'employee' ? 'Employee' : h.partyKind === 'customer' ? 'Customer' : 'Recipient / counterparty'}</label>
        <b>${esc(h.counterparty) || '<span class="fict">not identified</span>'}</b>${h.partyId ? ` <span class="tag">${esc(h.partyId)}</span>` : ''}<br>
        ${esc(h.address) || '<span class="tag">address —</span>'}<br>
        ${h.accountNumber ? `Account ${esc(h.accountNumber)}${h.bankName ? ' · ' + esc(h.bankName) : ''}` : '<span class="tag">account number —</span>'}${h.taxId ? `<br>${esc(h.taxId)}` : ''}</div>
      <div><label>Date</label><b>${esc(h.documentDate)}</b><br><label>Department / cost centre</label>${esc(h.department) || '—'} / ${esc(h.costCenter) || '—'}${refs ? `<br><span class="tag">${refs}</span>` : ''}</div>
    </div>
    <div class="p-note" style="margin:0 0 8px">${esc(h.purpose)}</div>
    <table><thead><tr><th>Description</th><th class="n">Qty</th><th class="n">Unit price</th><th class="n">VAT</th><th class="n">Net</th></tr></thead><tbody>
    ${d.lines.map(l => `<tr><td>${esc(l.description)}<br><span class="tag">${esc(l.event)} · ${esc(l.phrase)}</span></td><td class="n">${esc(l.quantity)}</td><td class="n">${money(l.figures.net / (Number(l.quantity) || 1))}</td><td class="n">${money(l.figures.vat)}</td>
      <td class="n">${money(l.figures.net)} ${l.figureSource === 'fictitious' ? '<br><span class="fict">illustrative</span>' : ''}</td></tr>`).join('')}
    <tr class="tot"><td colspan="4">Total (NGN)${d.totals.wht ? ` <span class="tag">· WHT ${money(d.totals.wht)}</span>` : ''}</td><td class="n">${money(d.totals.gross)}</td></tr></tbody></table>
    ${anyFict ? '<div class="p-note"><span class="fict">illustrative</span> figures are placeholders for demonstration — correct or confirm them in Billing before approval.</div>' : ''}
  </article>`;
}

async function previewPane(recordId) {
  const p = await api(`/records/${recordId}/preview`);
  if (p.kind === 'image') return `<img class="src" src="${p.url}" alt="source document">`;
  if (p.kind === 'pdf') return `<iframe src="${p.url}" title="source document"></iframe>`;
  if (p.kind === 'html') return `<iframe sandbox srcdoc="${esc('<style>body{font:14px/1.5 system-ui;padding:16px;color:#1b2430}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}</style>' + p.html)}" title="source document"></iframe>`;
  return `<pre>${esc(p.text)}</pre>`;
}

let pollTimer;
async function viewRecord() {
  clearTimeout(pollTimer);
  const id = S.recordId;
  const r = await api('/records/' + id);
  const [st, sc] = REC_STATUS[r.status];
  const busy = r.status === 'stored' || r.status === 'processing';
  $('#view').innerHTML = `
  <div class="card"><div class="row"><h2 class="sp">${esc(r.filename)} ${intakePill(r.intake)} ${pill(st, sc)}</h2>
    ${isVendor() ? '' : `<button class="btn sec" id="reproc" ${busy ? 'disabled' : ''}>Reprocess</button>`}
    ${isVendor() ? '' : `<button class="btn" id="toBilling" ${r.documents.length ? '' : 'disabled'}>Go to Billing &rarr;</button>`}</div>
    <p class="sub">${r.intake === 'structured' ? 'Structured: parsed into fields and line items' : 'Unstructured: summarised, matched to Financial Events, source documents generated'}
      ${r.method ? ` · text read by <b>${r.method === 'ocr' ? 'OCR' : 'direct extraction'}</b>${r.ocrConfidence != null ? ` (confidence ${r.ocrConfidence}%)` : ''}` : ''} · uploaded by ${esc(r.uploadedBy) || '—'}</p></div>
  <div class="split2">
    <div class="pane"><h3>Source document</h3><div class="body" id="srcPane"><span class="spin"></span>Loading preview…</div></div>
    <div class="pane"><h3>Processed document</h3><div class="body" id="outPane"></div></div>
  </div>`;
  previewPane(id).then(h => { const el = $('#srcPane'); if (el) el.innerHTML = h; }).catch(e => { const el = $('#srcPane'); if (el) el.textContent = e.message; });
  if ($('#reproc')) $('#reproc').onclick = guard(async () => { await api(`/records/${id}/reprocess`, { method: 'POST' }); viewRecord(); });
  if ($('#toBilling')) $('#toBilling').onclick = guard(async () => { await refreshLists(); await openDoc(r.documents[0].id); go('billing'); });
  const out = $('#outPane');
  if (busy) {
    out.innerHTML = `<p><span class="spin"></span>${r.intake === 'structured' ? 'Reading the document (OCR if needed) and posting structured data…' : 'Extracting text, summarising key financial events and matching Financial Events…'}</p>`;
    const poll = async () => {
      if (S.tab !== 'record' || S.recordId !== id) return;
      try { const cur = await api('/records/' + id); if (cur.status === 'stored' || cur.status === 'processing') pollTimer = setTimeout(poll, 800); else viewRecord(); } catch { pollTimer = setTimeout(poll, 2000); }
    };
    pollTimer = setTimeout(poll, 800); return;
  }
  if (r.status === 'failed') { out.innerHTML = `<ul class="issues"><li class="error">${esc(r.error)}</li></ul>`; return; }
  const docs = await Promise.all(r.documents.map(d => api('/documents/' + d.id)));
  let html = '';
  if (r.summary) {
    html += `<h3 style="margin-top:0">Summary of key financial events</h3><p>${esc(r.summary.headline)} <span class="tag">(${r.summary.considered} sentences read)</span></p>
      ${r.summary.events.map(e => `<div class="event">${esc(e.text)}<br><small>${e.match ? `${pill(e.match.event, 'brand')} ${pill(e.match.sourceDocument)} match ${Math.round(e.match.score * 100)}%` : pill('no Financial Event match', 'warn')}
        ${e.parties.map(p => ' · ' + esc(p.name)).join('')}${e.amounts.length ? ' · mentions ' + esc(e.amounts.join(', ')) : ''}</small></div>`).join('')}
      <h3>Generated source documents</h3>`;
  } else if (r.structured) {
    const s = r.structured;
    html += `<h3 style="margin-top:0">Posted as structured data</h3><p class="sub">${esc(s.label || '')}${s.parsed.docNumber ? ' · ' + esc(s.parsed.docNumber) : ''}</p>`;
  }
  if (r.note) html += `<ul class="issues"><li class="warning">${esc(r.note)}</li></ul>`;
  html += docs.map(d => `${paperDoc(d)}${((d.issues || {}).submit || []).filter(i => i.level === 'warning').slice(0, 4).map(i => `<ul class="issues"><li class="warning">${esc(i.msg)}</li></ul>`).join('')}
    ${isVendor() ? `<p class="hint">Status: ${esc(STATUS[d.status][0])}${d.billId ? ' — see My bills for payment status.' : ''}</p>` : `<div class="row" style="margin-bottom:14px"><button class="btn sec" data-open="${d.id}">Open ${esc(d.number)} in Billing</button></div>`}`).join('');
  out.innerHTML = html;
  document.querySelectorAll('[data-open]').forEach(b => b.onclick = guard(async () => { await refreshLists(); await openDoc(b.dataset.open); go('billing'); }));
}

/* ------------------------------- Billing -------------------------------- */
async function viewBilling() {
  await refreshLists();
  if (S.currentId && !S.docs.some(d => d.id === S.currentId)) S.current = S.currentId = null;
  const shown = S.docs.filter(d => S.billFilter === 'all' || d.intake === S.billFilter);
  if (shown.length && !shown.some(d => d.id === S.currentId)) await openDoc(shown[0].id);
  if (!shown.length) S.current = S.currentId = null;
  const list = shown.map(d => { const [t, c] = STATUS[d.status]; return `<div class="item ${d.id === S.currentId ? 'on' : ''}" data-id="${d.id}">
    <div class="row"><b class="sp">${esc(d.number)}</b>${pill(t, c)}</div>
    <small>${esc(d.sourceDocument)} · ${esc(d.counterparty) || 'no counterparty'}</small><small>${intakePill(d.intake).replace(/<[^>]+>/g, '')} · ${esc(d.filename)}</small>
    ${d.gross ? `<small>NGN ${money(d.gross)}</small>` : ''}</div>`; }).join('');
  $('#view').innerHTML = S.docs.length
    ? `<div class="split"><div class="list"><select id="bf" style="margin-bottom:8px">${[['all', 'All documents'], ['structured', 'Structured'], ['unstructured', 'Unstructured']].map(([v, t]) => `<option value="${v}" ${S.billFilter === v ? 'selected' : ''}>${t}</option>`).join('')}</select>${list || '<p class="mut">None in this filter.</p>'}</div><div id="editor"></div></div>`
    : '<div class="card"><h2>Nothing in billing yet</h2><p class="sub">Upload a structured or unstructured document; the documents it produces land here for corrections and approval.</p></div>';
  const bf = $('#bf'); if (bf) bf.onchange = () => { S.billFilter = bf.value; viewBilling(); };
  document.querySelectorAll('.list .item').forEach(i => i.onclick = guard(async () => { await openDoc(i.dataset.id); viewBilling(); }));
  if (S.current) renderEditor();
}

function stepper(d) {
  const idx = ['draft', 'pending_approval', 'approved', 'billed'].indexOf(d.status);
  return `<div class="steps">${[['1 · Corrections', 0], ['2 · Approvals', 1], ['3 · Finance review', 2], ['4 · Billed', 3]].map(([t, i]) => `<div class="${idx > i || (idx === 3 && i === 3) ? 'done' : idx === i ? 'now' : ''}">${t}</div>`).join('')}</div>`;
}
const issueList = items => items && items.length ? `<ul class="issues">${items.map(i => `<li class="${i.level}">${esc(i.msg)} ${i.ref ? `<a class="chip" data-policy="${i.ref}">${i.ref}</a>` : ''}</li>`).join('')}</ul>` : '';
const metaHtml = (l, d) => `${esc(l.event)} · ${esc(l.phrase)} · <span class="pill ${l.confidence >= d.checklists.lowConfidence ? 'ok' : 'warn'}">${Math.round(l.confidence * 100)}%</span>`;
const figBadge = l => l.figureSource === 'fictitious' ? '<span class="fict">illustrative</span>' : l.figureSource === 'extracted' ? '<span class="ok-tag">from document</span>' : '<span class="ok-tag">confirmed</span>';

function renderEditor() {
  const d = S.current, draft = d.status === 'draft', dis = draft ? '' : 'disabled';
  const [st, sc] = STATUS[d.status];
  const h = d.header;
  const f = (k, label, type = 'text') => `<div><label>${label}</label><input type="${type}" data-h="${k}" value="${esc(h[k])}" ${dis}></div>`;
  const r = (k, label) => `<div><label>${label}</label><input type="text" data-r="${k}" value="${esc(d.refs[k])}" ${dis}></div>`;
  const procurement = ['Purchase Order', 'Vendor Invoice', 'Quote'].includes(d.sourceDocument);
  const partyOptions = S.parties.filter(p => !h.partyKind || p.kind === h.partyKind || !h.partyId).map(p => `<option value="${p.id}" ${p.id === h.partyId ? 'selected' : ''}>${esc(p.name)} (${p.kind})</option>`).join('');
  const hasFict = d.lines.some(l => l.figureSource === 'fictitious');
  $('#editor').innerHTML = `
  <div class="card"><div class="row"><h2 class="sp">${esc(d.number)} · ${esc(d.sourceDocument)}</h2>${intakePill(d.origin.intake)} ${pill(st, sc)}</div>
    <p class="sub">From <a href="#" id="viewRec">${esc(d.origin.filename)}</a> · <a href="#" id="toggleOrig">${S.showOriginal ? 'hide' : 'show'} original</a>${d.origin.ocrConfidence != null ? ` · OCR ${d.origin.ocrConfidence}%` : ''}</p>
    <div id="origBox">${S.showOriginal ? '<div class="pane" style="margin-bottom:12px"><div class="body" id="origPane"><span class="spin"></span>Loading…</div></div>' : ''}</div>
    ${d.rejection ? `<ul class="issues"><li class="warning">Returned by ${esc(d.rejection.by)}: ${esc(d.rejection.reason)}</li></ul>` : ''}
    ${stepper(d)}
    <h3>Source header</h3>
    <div class="grid"><div><label>Pull from employee / vendor / customer master</label><select data-h="partyId" ${dis}><option value="">— not in master —</option>${partyOptions}</select></div>
      ${f('counterparty', 'Name / company')}${f('address', 'Address')}${f('accountNumber', 'Account number')}${f('bankName', 'Bank')}${f('taxId', 'Tax ID')}
      ${f('department', 'Department')}${f('costCenter', 'Cost center')}${f('documentDate', 'Document date', 'date')}</div>
    <div style="margin-top:10px"><label>Business purpose</label><input type="text" data-h="purpose" value="${esc(h.purpose)}" ${dis}></div>
    <div class="grid" style="margin-top:10px">
      ${procurement ? r('purchaseRequest', 'Purchase request ref') + r('purchaseOrder', 'Purchase order ref') + r('receipt', 'Goods/service receipt ref') + r('invoice', 'Vendor invoice no.') + r('quotation', 'Quotation ref') + r('quotationWaiver', 'If no quotation: why not practical') : ''}
      ${d.sourceDocument === 'Payment Voucher' ? r('invoice', 'Vendor invoice ref') : ''}
      ${d.sourceDocument === 'Expense Claim' ? `<div><label>Receipts</label><label style="color:var(--ink)"><input type="checkbox" data-h="receiptsAttached" ${h.receiptsAttached ? 'checked' : ''} ${dis}> Supporting receipts attached</label></div>` : ''}
    </div>
    <h3>Line items</h3>
    <div class="scroll"><table><thead><tr><th>Financial event</th><th>Qty</th><th>Unit price</th><th>VAT</th><th>WHT</th><th class="n">Net</th><th class="n">Gross</th><th></th></tr></thead><tbody>
    ${d.lines.map(l => `<tr data-line="${l.id}">
      <td style="min-width:240px"><select data-f="rowIndex" ${dis}>${d.events.map(e => `<option value="${e.rowIndex}" ${e.rowIndex === l.rowIndex ? 'selected' : ''}>${esc(e.event)}</option>`).join('')}</select>
        <input type="text" data-f="description" value="${esc(l.description)}" ${dis} style="margin-top:4px" title="Description / evidence from the source">
        <small class="mut" data-meta>${metaHtml(l, d)}</small>${l.statedAmount ? `<br><small class="hint">Source mentions ${esc(l.statedAmount)}</small>` : ''}</td>
      <td style="width:80px"><input type="number" step="any" data-f="quantity" value="${esc(l.quantity)}" placeholder="1" ${dis}></td>
      <td style="width:130px"><input type="number" step="any" data-f="unitPrice" value="${esc(l.unitPrice)}" ${dis}><span data-fig>${figBadge(l)}</span></td>
      <td style="width:110px"><input type="number" step="any" data-f="vat" value="${esc(l.vat)}" ${dis || !l.figures.tax.vat ? 'disabled' : ''}></td>
      <td style="width:110px"><input type="number" step="any" data-f="wht" value="${esc(l.wht)}" ${dis || !l.figures.tax.wht ? 'disabled' : ''}></td>
      <td class="n" data-net>${money(l.figures.net)}</td><td class="n" data-gross>${money(l.figures.gross)}</td>
      <td>${draft && d.lines.length > 1 ? '<button class="btn sec" data-del>✕</button>' : ''}</td></tr>`).join('')}
    <tr class="tot"><td colspan="5">Total (NGN)</td><td class="n" id="totNet">${money(d.totals.net)}</td><td class="n" id="totGross">${money(d.totals.gross)}</td><td></td></tr></tbody></table></div>
    ${draft ? `<div class="row" style="margin-top:8px"><button class="btn sec" id="addLine">+ Add line item</button><button class="btn sec" id="save">Save draft</button>
      <button class="btn sec" id="confirmFig" ${hasFict ? '' : 'hidden'}>Confirm illustrative figures</button></div>` : ''}
    <div id="journalBox">${journalHtml(d)}</div>
    <div class="row" style="margin-top:12px"><span class="mut">Policy references:</span>${d.policyRefs.map(p => `<a class="chip" data-policy="${p.id}" title="${esc(p.title)}">${p.id}</a>`).join('')}</div>
  </div>
  <div class="card noprint" id="workflow">${workflowHtml(d)}</div>`;
  wireEditor();
}

function journalHtml(d) {
  if (!d.journal.length) return `<h3>Journal preview</h3><p class="mut">${d.totals.net ? 'This event has no GL posting (commitment / register only).' : 'Enter figures to preview the journal entry.'}</p>`;
  const agg = {};
  d.journal.forEach(j => { const k = j.side + j.account; (agg[k] ||= { ...j, amount: 0 }).amount += j.amount; });
  const rows = Object.values(agg).sort((a, b) => (a.side === b.side ? 0 : a.side === 'Dr' ? -1 : 1));
  return `<h3>Journal preview ${d.balanced ? pill('balanced', 'ok') : pill('unbalanced', 'err')}</h3>
  <table><thead><tr><th>Account</th><th>Code</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead><tbody>
  ${rows.map(j => `<tr><td style="padding-left:${j.side === 'Cr' ? 28 : 8}px">${esc(j.account)}${j.memo ? ' ' + pill('memo') : ''}</td><td class="mono">${j.code ?? pill('needs code', 'warn')}</td><td class="n">${j.side === 'Dr' ? money(j.amount) : ''}</td><td class="n">${j.side === 'Cr' ? money(j.amount) : ''}</td></tr>`).join('')}</tbody></table>`;
}
const rejectHtml = () => (S.me.approvalRoles || []).some(r => r !== 'Preparer') ? '<div style="margin-top:12px"><button class="btn sec" id="reject">Return for corrections…</button></div>' : '';

function workflowHtml(d) {
  if (d.status === 'draft') {
    return `<h2>Corrections &amp; submission</h2><p class="sub">Correct anything the extraction got wrong, then submit for approval.</p>${issueList(d.issues.submit)}
      ${hasRole('Preparer') ? `<div class="row"><span class="mut">Submitting as <b>${esc(S.me.name)}</b></span><button class="btn" id="submit">Save &amp; submit for approval</button></div>`
        : `<p class="hint">Only a login with the Preparer role can submit. You can still make corrections (${esc(S.me.title)}).</p>`}`;
  }
  if (d.status === 'pending_approval') {
    return `<h2>Approvals</h2><p class="sub">Tier for NGN ${money(d.totals.gross)} (FIN-POL-001). Approvers must be different people, and cannot be the preparer or beneficiary.</p>
    <table><tbody>${d.requiredApprovals.map(r => `<tr><td><b>${esc(r.role)}</b><br><small class="mut">${esc(r.reason)}</small></td>
      <td>${r.approval ? pill('Approved by ' + r.approval.by, 'ok') : hasRole(r.role) ? `<button class="btn" data-approve="${esc(r.role)}">Approve as ${esc(r.role)}</button>` : `<span class="mut">Waiting for ${esc(r.role)}</span>`}</td></tr>`).join('')}</tbody></table>${rejectHtml()}`;
  }
  if (d.status === 'approved') {
    const need = d.accountsNeedingCode;
    const vendor = d.sourceDocument === 'Vendor Invoice' && d.totals.gross > 100000;
    const hasLow = d.lines.some(l => l.confidence < d.checklists.lowConfidence);
    return `<h2>Finance review — final approval</h2><p class="sub">On completion the document becomes a bill, ready for payment. The reviewer must be independent of the preparer and approvers (FIN-POL-002).</p>
    ${vendor ? `<h3>Three-way match: PO ↔ receipt ↔ invoice <a class="chip" data-policy="PROC-CTRL-001">PROC-CTRL-001</a></h3><div class="row">${d.checklists.threeWay.map(c => `<label style="color:var(--ink)"><input type="checkbox" data-tw="${esc(c)}"> ${esc(c)} agrees</label>`).join('')}</div>
      <h3>Vendor verification <a class="chip" data-policy="PROC-POL-001">PROC-POL-001</a></h3><div class="row">${d.checklists.vendor.map(c => `<label style="color:var(--ink)"><input type="checkbox" data-vc="${esc(c)}"> ${esc(c)}</label>`).join('')}</div>` : ''}
    ${hasLow ? '<h3>Low-confidence classification</h3><label style="color:var(--ink)"><input type="checkbox" id="ack"> I confirm the financial event for low-confidence lines is correct <a class="chip" data-policy="RAG-CTRL-001">RAG-CTRL-001</a></label>' : ''}
    ${need.length ? `<h3>Chart of accounts <a class="chip" data-policy="COA-001">COA-001</a></h3><p class="sub">The policy COA has no specific account for these — assign a code in range.</p><div class="grid">${need.map(a => `<div><label>${esc(a.account)} (${a.range.from}–${a.range.to})</label><input type="number" data-ov="${esc(a.account)}" min="${a.range.from}" max="${a.range.to}"></div>`).join('')}</div>` : ''}
    ${hasRole('Finance Reviewer') ? `<div class="row" style="margin-top:12px"><span class="mut">Reviewing as <b>${esc(S.me.name)}</b></span><button class="btn" id="review">Approve &amp; create bill</button></div>` : '<p class="hint" style="margin-top:12px">Waiting for the Finance Reviewer login.</p>'}${rejectHtml()}`;
  }
  return `<h2>Billed</h2><p>Approved and sent to the bills section for payment.</p><button class="btn" id="openBill">View bill</button>`;
}

const collect = () => {
  const ed = $('#editor'), header = {}, refs = {};
  ed.querySelectorAll('[data-h]').forEach(i => { header[i.dataset.h] = i.type === 'checkbox' ? i.checked : i.value; });
  ed.querySelectorAll('[data-r]').forEach(i => { refs[i.dataset.r] = i.value; });
  const lines = [...ed.querySelectorAll('[data-line]')].map(tr => { const o = { id: tr.dataset.line }; tr.querySelectorAll('[data-f]').forEach(i => { o[i.dataset.f] = i.value; }); return o; });
  return { header, refs, lines };
};
let saveChain = Promise.resolve(); // serialise saves so a slow response never overwrites a newer one
const save = (extra = {}) => (saveChain = saveChain.catch(() => {}).then(async () => { S.current = await api('/documents/' + S.current.id, { method: 'PATCH', body: { ...collect(), ...extra } }); }));

/** Patch only computed parts after a save so typing and focus are never disturbed. */
function refreshCalc() {
  const d = S.current, ed = $('#editor');
  d.lines.forEach(l => {
    const tr = ed.querySelector(`[data-line="${CSS.escape(l.id)}"]`); if (!tr) return;
    tr.querySelector('[data-net]').textContent = money(l.figures.net);
    tr.querySelector('[data-gross]').textContent = money(l.figures.gross);
    tr.querySelector('[data-meta]').innerHTML = metaHtml(l, d);
    tr.querySelector('[data-fig]').innerHTML = figBadge(l);
    tr.querySelector('[data-f=vat]').disabled = !l.figures.tax.vat;
    tr.querySelector('[data-f=wht]').disabled = !l.figures.tax.wht;
  });
  $('#totNet').textContent = money(d.totals.net); $('#totGross').textContent = money(d.totals.gross);
  const cf = $('#confirmFig'); if (cf) cf.hidden = !d.lines.some(l => l.figureSource === 'fictitious');
  $('#journalBox').innerHTML = journalHtml(d);
  $('#workflow').innerHTML = workflowHtml(d); wireWorkflow();
}

function wireEditor() {
  const d = S.current, ed = $('#editor');
  wirePolicy(ed);
  $('#viewRec').onclick = e => { e.preventDefault(); S.recordId = d.origin.recordId; go('record'); };
  $('#toggleOrig').onclick = guard(async e => {
    e.preventDefault(); S.showOriginal = !S.showOriginal; renderEditor();
    if (S.showOriginal) { const el = $('#origPane'); if (el) el.innerHTML = await previewPane(d.origin.recordId); }
  });
  if (S.showOriginal) previewPane(d.origin.recordId).then(h => { const el = $('#origPane'); if (el) el.innerHTML = h; });
  const live = guard(async () => { await save(); refreshCalc(); });
  ed.querySelectorAll('[data-line] [data-f],[data-h],[data-r]').forEach(i => { i.onchange = i.dataset.h === 'partyId' ? guard(async () => { await save(); renderEditor(); }) : live; });
  ed.querySelectorAll('[data-del]').forEach(b => { b.onclick = guard(async () => { await save({ lines: collect().lines.filter(l => l.id !== b.closest('tr').dataset.line) }); renderEditor(); }); });
  const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
  on('addLine', guard(async () => { const c = collect().lines; c.push({ rowIndex: d.events[0].rowIndex, description: '', quantity: '', unitPrice: '', vat: '', wht: '' }); await save({ lines: c }); renderEditor(); }));
  on('save', guard(async () => { await save(); renderEditor(); toast('Draft saved', null, true); }));
  on('confirmFig', guard(async () => { await save({ confirmFigures: true }); renderEditor(); toast('Figures confirmed', null, true); }));
  wireWorkflow();
}

function wireWorkflow() {
  const d = S.current, ed = $('#editor');
  wirePolicy($('#workflow'));
  const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
  const after = async () => { await refreshLists(); viewBilling(); };
  on('submit', guard(async () => {
    await save(); S.current = await api(`/documents/${d.id}/submit`, { method: 'POST', body: {} }); await after();
  }));
  ed.querySelectorAll('[data-approve]').forEach(b => { b.onclick = guard(async () => {
    S.current = await api(`/documents/${d.id}/approve`, { method: 'POST', body: { role: b.dataset.approve } }); await after();
  }); });
  on('reject', guard(async () => {
    const reason = prompt('Reason for returning for corrections:'); if (!reason) return;
    S.current = await api(`/documents/${d.id}/reject`, { method: 'POST', body: { reason } }); await after();
  }));
  on('review', guard(async () => {
    const threeWay = {}, vendorChecks = {}, accountOverrides = {};
    ed.querySelectorAll('[data-tw]').forEach(i => { threeWay[i.dataset.tw] = i.checked; });
    ed.querySelectorAll('[data-vc]').forEach(i => { vendorChecks[i.dataset.vc] = i.checked; });
    ed.querySelectorAll('[data-ov]').forEach(i => { accountOverrides[i.dataset.ov] = i.value; });
    const ack = $('#ack');
    S.current = await api(`/documents/${d.id}/finance-review`, { method: 'POST', body: { threeWay, vendorChecks, accountOverrides, ackLowConfidence: ack ? ack.checked : false } });
    await refreshLists(); S.bill = await api('/bills/' + S.current.billId); toast(`Created ${S.bill.number}`, null, true); go('bills');
  }));
  on('openBill', guard(async () => { S.bill = await api('/bills/' + d.billId); go('bills'); }));
}

/* -------------------------------- Bills --------------------------------- */
const PAY = { awaiting_payment: ['Awaiting payment', 'warn'], paid: ['Paid', 'ok'], no_payment: ['No payment due', ''] };
async function viewBills() {
  await refreshLists();
  if (S.bill) S.bill = S.bills.some(b => b.id === S.bill.id) ? await api('/bills/' + S.bill.id) : null;
  const list = S.bills.length ? `<div class="scroll"><table><thead><tr><th>Bill</th><th>From</th><th>Counterparty</th><th class="n">Gross</th><th class="n">Due</th><th>Payment</th></tr></thead><tbody>
    ${S.bills.map(b => `<tr style="cursor:pointer" data-bill="${b.id}"><td><b>${esc(b.number)}</b></td><td>${esc(b.documentNumber)} ${intakePill(b.intake)}</td><td>${esc(b.counterparty)}</td><td class="n">${money(b.gross)}</td><td class="n">${money(b.amountDue)}</td><td>${pill(...PAY[b.paymentStatus])}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="sub">No bills yet. A document becomes a bill when finance review (the final approval) is complete.</p>';
  $('#view').innerHTML = `<div class="card noprint"><h2>Bills</h2>${list}</div>${S.bill ? billHtml(S.bill) : ''}`;
  document.querySelectorAll('[data-bill]').forEach(tr => { tr.onclick = guard(async () => { S.bill = await api('/bills/' + tr.dataset.bill); viewBills(); }); });
  wirePolicy($('#view'));
  const pr = $('#printBill'); if (pr) pr.onclick = () => window.print();
  const pay = $('#pay'); if (pay) pay.onclick = guard(async () => { S.bill = await api(`/bills/${S.bill.id}/pay`, { method: 'POST', body: {} }); toast('Payment processed', null, true); viewBills(); });
  const so = $('#billSrc'); if (so) so.onclick = e => { e.preventDefault(); S.recordId = S.bill.origin.recordId; go('record'); };
}
function vendorBillHtml(b) {
  const [ps, pc] = PAY[b.paymentStatus];
  return `<div class="card"><div class="row"><h2 class="sp">${esc(b.number)} ${pill(ps, pc)}</h2></div>
    <p class="sub">${esc(b.sourceDocument)} ${esc(b.documentNumber)} · ${esc(b.documentDate)} · ${b.currency}</p><p>${esc(b.purpose)}</p>
    <table><thead><tr><th>Description</th><th class="n">Net</th><th class="n">VAT</th><th class="n">WHT</th><th class="n">Gross</th></tr></thead><tbody>
    ${b.lines.map(l => `<tr><td>${esc(l.description)}</td><td class="n">${money(l.figures.net)}</td><td class="n">${money(l.figures.vat)}</td><td class="n">${money(l.figures.wht)}</td><td class="n">${money(l.figures.gross)}</td></tr>`).join('')}
    <tr class="tot"><td>Total</td><td class="n">${money(b.totals.net)}</td><td class="n">${money(b.totals.vat)}</td><td class="n">${money(b.totals.wht)}</td><td class="n">${money(b.totals.gross)}</td></tr>
    <tr><td colspan="4">Net payable after WHT</td><td class="n"><b>${money(b.totals.payable)}</b></td></tr></tbody></table>
    <p>${b.paymentStatus === 'paid' ? `Paid on ${new Date(b.payment.at).toLocaleString()} · reference ${esc(b.payment.reference)}` : b.paymentStatus === 'awaiting_payment' ? `Awaiting payment of NGN ${money(b.amountDue)}.` : 'No payment due on this document.'}</p></div>`;
}
function billHtml(b) {
  if (b.vendorView) return vendorBillHtml(b);
  const w = b.workflow, [ps, pc] = PAY[b.paymentStatus];
  return `<div class="card"><div class="row"><h2 class="sp">${esc(b.number)} ${pill(b.glPosting, 'ok')} ${pill(ps, pc)}</h2>
    <span class="noprint"><button class="btn sec" id="printBill">Print</button> <a class="btn" href="/api/bills/${b.id}/csv" style="text-decoration:none;display:inline-block">Download CSV</a></span></div>
    <p class="sub">${esc(b.sourceDocument)} ${esc(b.documentNumber)} · <a href="#" id="billSrc">${esc(b.origin.filename)}</a> · ${esc(b.counterparty)} · ${esc(b.department)} / ${esc(b.costCenter)} · ${esc(b.documentDate)} · ${b.currency}</p>
    <p>${esc(b.purpose)}</p>
    <h3>Line items</h3><table><thead><tr><th>Event</th><th>Description</th><th class="n">Net</th><th class="n">VAT</th><th class="n">WHT</th><th class="n">Gross</th></tr></thead><tbody>
    ${b.lines.map(l => `<tr><td>${esc(l.event)}</td><td>${esc(l.description)}</td><td class="n">${money(l.figures.net)}</td><td class="n">${money(l.figures.vat)}</td><td class="n">${money(l.figures.wht)}</td><td class="n">${money(l.figures.gross)}</td></tr>`).join('')}
    <tr class="tot"><td colspan="2">Total</td><td class="n">${money(b.totals.net)}</td><td class="n">${money(b.totals.vat)}</td><td class="n">${money(b.totals.wht)}</td><td class="n">${money(b.totals.gross)}</td></tr>
    <tr><td colspan="5">Net payable after WHT</td><td class="n"><b>${money(b.totals.payable)}</b></td></tr></tbody></table>
    <h3>Journal entry</h3>${b.entries.length ? `<table><thead><tr><th>Account</th><th>Code</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead><tbody>
    ${b.entries.map(e => `<tr><td style="padding-left:${e.side === 'Cr' ? 28 : 8}px">${esc(e.account)}</td><td class="mono">${e.code ?? ''}${e.memo ? ' memo' : ''}</td><td class="n">${e.side === 'Dr' ? money(e.amount) : ''}</td><td class="n">${e.side === 'Cr' ? money(e.amount) : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="mut">No GL posting for this event.</p>'}
    <h3>Payment</h3>${b.paymentStatus === 'awaiting_payment' ? `<p class="sub">Amount due NGN ${money(b.amountDue)} to ${esc(b.counterparty)}${b.accountNumber ? ` · ${esc(b.accountNumber)} ${esc(b.bankName)}` : ''}. The Payment Processor must be independent of everyone who handled this document (FIN-POL-002).</p>
      ${hasRole('Payment Processor') ? `<div class="row noprint"><span class="mut">Paying as <b>${esc(S.me.name)}</b></span><button class="btn" id="pay">Process payment</button></div>` : '<p class="hint">Waiting for the Payment Processor login.</p>'}`
      : b.paymentStatus === 'paid' ? `<p>${esc(b.payment.reference)} · paid by ${esc(b.payment.by)} on ${new Date(b.payment.at).toLocaleString()} to ${esc(b.payment.beneficiary.name)} (${esc(b.payment.beneficiary.accountNumber)}, ${esc(b.payment.beneficiary.bankName)})</p>
      <table><tbody>${b.payment.entries.map(e => `<tr><td style="padding-left:${e.side === 'Cr' ? 28 : 8}px">${esc(e.account)}</td><td class="mono">${e.code ?? ''}</td><td class="n">${e.side === 'Dr' ? money(e.amount) : ''}</td><td class="n">${e.side === 'Cr' ? money(e.amount) : ''}</td></tr>`).join('')}</tbody></table>`
      : '<p class="mut">This document does not create a payable (commitment, receivable or register-only event).</p>'}
    <h3>Control trail</h3><table><tbody>
    <tr><td>Prepared by</td><td>${esc(w.preparedBy)}</td></tr>
    ${w.approvals.map(a => `<tr><td>${esc(a.role)}</td><td>${esc(a.by)} · ${new Date(a.at).toLocaleString()}</td></tr>`).join('')}
    <tr><td>Finance Reviewer</td><td>${esc(w.financeReviewer)} · ${new Date(w.financeReviewedAt).toLocaleString()}</td></tr>
    ${b.paymentStatus === 'paid' ? `<tr><td>Payment Processor</td><td>${esc(b.payment.by)}</td></tr>` : ''}</tbody></table>
    <div class="row noprint" style="margin-top:10px"><span class="mut">Policy:</span>${b.policyRefs.map(p => `<a class="chip" data-policy="${p.id}">${p.id}</a>`).join('')}</div></div>`;
}

/* ------------------------------- Parties -------------------------------- */
let partyKind = 'employee';
async function viewParties() {
  S.parties = await api('/parties');
  const list = S.parties.filter(p => p.kind === partyKind);
  $('#view').innerHTML = `<div class="card"><h2>Employee, vendor &amp; customer information</h2>
    <p class="sub">Source headers (name, address, account number, department) are pulled from here when a document is generated, and names found in documents are matched against it.</p>
    <div class="row">${['employee', 'vendor', 'customer'].map(k => `<button class="btn ${k === partyKind ? '' : 'sec'}" data-kind="${k}">${k}s</button>`).join('')}</div>
    <div class="scroll" style="margin-top:10px"><table><thead><tr><th>ID</th><th>Name</th><th>Address</th><th>Account</th><th>Bank</th><th>Dept / cost centre</th>${partyKind === 'vendor' && hasRole('Admin') ? '<th>Login</th>' : ''}</tr></thead><tbody>
    ${list.map(p => `<tr><td class="mono">${esc(p.id)}</td><td><b>${esc(p.name)}</b></td><td>${esc(p.address)}</td><td class="mono">${esc(p.accountNumber)}</td><td>${esc(p.bankName)}</td><td>${esc(p.department)} ${esc(p.costCenter)}</td>${partyKind === 'vendor' && hasRole('Admin') ? `<td><button class="btn sec" data-login="${p.id}">New login / reset</button></td>` : ''}</tr>`).join('')}</tbody></table></div>
    <div id="newLogin"></div>
    <h3>Add ${partyKind}</h3><div class="grid">${[['name', 'Name'], ['address', 'Address'], ['accountNumber', 'Account number'], ['bankName', 'Bank'], ['taxId', 'Tax ID'], ['department', 'Department'], ['costCenter', 'Cost center']].map(([k, l]) => `<div><label>${l}</label><input type="text" data-p="${k}"></div>`).join('')}</div>
    <div style="margin-top:10px"><button class="btn" id="addParty">Add</button></div></div>`;
  document.querySelectorAll('[data-kind]').forEach(b => { b.onclick = () => { partyKind = b.dataset.kind; viewParties(); }; });
  document.querySelectorAll('[data-login]').forEach(b => { b.onclick = guard(async () => {
    const c = await api(`/parties/${b.dataset.login}/login`, { method: 'POST' });
    $('#newLogin').innerHTML = `<ul class="issues"><li class="warning"><b>${esc(c.name)}</b> — username <code>${esc(c.username)}</code> · password <code>${esc(c.password)}</code><br>Shown once. Any previous password for this vendor no longer works.</li></ul>`;
  }); });
  $('#addParty').onclick = guard(async () => {
    const body = { kind: partyKind }; document.querySelectorAll('[data-p]').forEach(i => { body[i.dataset.p] = i.value; });
    await api('/parties', { method: 'POST', body }); toast('Added', null, true); viewParties();
  });
}

function viewLogin(msg) {
  S.me = null; applyChrome();
  $('#view').innerHTML = `<div class="card" style="max-width:420px;margin:48px auto"><h2>Sign in</h2>
    <p class="sub">Buyers (company staff) and vendors each have their own login. Logins are issued by your administrator.</p>
    ${msg ? `<ul class="issues"><li class="warning">${esc(msg)}</li></ul>` : ''}
    <form id="login"><div><label>Username</label><input type="text" id="u" autocomplete="username" autofocus required></div>
    <div style="margin-top:10px"><label>Password</label><input type="password" id="pw" autocomplete="current-password" required></div>
    <div id="lerr" class="issues" style="margin-top:10px"></div>
    <button class="btn" style="margin-top:6px;width:100%">Sign in</button></form></div>`;
  $('#login').onsubmit = async e => {
    e.preventDefault();
    try {
      const r = await api('/auth/login', { method: 'POST', body: { username: $('#u').value, password: $('#pw').value } });
      S.me = r.user; await bootData(); S.tab = 'upload'; render();
    } catch (err) { $('#lerr').innerHTML = `<li class="error">${esc(err.message)}</li>`; $('#pw').value = ''; }
  };
}
async function bootData() {
  S.config = await api('/config');
  if (!isVendor()) S.parties = await api('/parties');
  await refreshLists();
}

(async function init() {
  try { const r = await api('/auth/me'); S.me = r.user; await bootData(); } catch (e) { S.me = null; }
  render();
})();
