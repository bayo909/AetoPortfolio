'use strict';
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const STATUS = { draft: ['Draft', ''], pending_approval: ['Pending approval', 'warn'], approved: ['Approved', 'brand'], reviewed: ['Finance reviewed', 'brand'], billed: ['Billed', 'ok'] };

const S = { tab: 'upload', sourceDocs: [], upload: null, sourceDocument: '', preview: null, picks: {}, docs: [], current: null, currentId: null, bills: [], bill: null, ui: {} };

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body instanceof FormData) init.body = opts.body;
  else if (opts.body) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
  const res = await fetch('api' + path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { issues: data.issues });
  return data;
}
function toast(msg, issues, good) {
  const t = $('#toast');
  t.className = good ? 'good' : '';
  t.innerHTML = esc(msg) + (issues && issues.length ? '<ul>' + issues.map(i => `<li>${esc(i.msg || i)}</li>`).join('') + '</ul>' : '');
  t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), good ? 2500 : 9000);
}
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, e.issues); } };

function go(tab) { S.tab = tab; render(); }
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) go(b.dataset.tab); });

async function refreshLists() {
  [S.docs, S.bills] = await Promise.all([api('/documents'), api('/bills')]);
  $('#docCount').textContent = S.docs.length || ''; $('#billCount').textContent = S.bills.length || '';
}
async function openDoc(id) { S.currentId = id; S.current = await api('/documents/' + id); }

function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  ({ upload: viewUpload, match: viewMatch, process: viewProcess, bills: viewBills })[S.tab]();
}

/* ------------------------------ 1. Upload ------------------------------ */
function viewUpload() {
  const u = S.upload;
  $('#view').innerHTML = `
  <div class="card"><h2>Upload source document</h2>
    <p class="sub">Text is extracted into line items and held in memory. Supported: .docx, .pdf, .txt, .md, .csv.</p>
    <div class="drop" id="drop"><p>Drag a file here, or</p>
      <input type="file" id="file" accept=".docx,.pdf,.txt,.md,.csv,.tsv"> <button class="btn sec" id="sample">Use sample payables pack</button></div></div>
  ${u ? `<div class="card"><div class="row"><h2 class="sp">${esc(u.filename)} <span class="pill">${u.lines.length} line items</span></h2>
      <button class="btn" id="next">Select source document &rarr;</button></div>
    <div class="scroll"><table><thead><tr><th>#</th><th>Extracted line item</th></tr></thead><tbody>
    ${u.lines.map(l => `<tr><td class="mut">${l.n}</td><td>${esc(l.text)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}`;
  const send = guard(async file => {
    const fd = new FormData(); fd.append('file', file);
    S.upload = await api('/uploads', { method: 'POST', body: fd });
    S.preview = null; S.picks = {}; render(); toast(`Extracted ${S.upload.lines.length} line items`, null, true);
  });
  $('#file').onchange = e => e.target.files[0] && send(e.target.files[0]);
  $('#sample').onclick = guard(async () => {
    const txt = await (await fetch('samples/sample_payables_pack.txt')).text();
    await send(new File([txt], 'sample_payables_pack.txt', { type: 'text/plain' }));
  });
  const drop = $('#drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files[0] && send(e.dataTransfer.files[0]); };
  if (u) $('#next').onclick = () => go('match');
}

/* -------------------------- 2. Source documents ------------------------- */
function viewMatch() {
  if (!S.upload) { $('#view').innerHTML = '<div class="card"><h2>Upload a document first</h2><button class="btn" onclick="go(\'upload\')">Go to upload</button></div>'; return; }
  const opts = S.sourceDocs.map(d => `<option ${d.name === S.sourceDocument ? 'selected' : ''} value="${esc(d.name)}">${esc(d.name)} (${d.events} events)</option>`).join('');
  $('#view').innerHTML = `
  <div class="card"><h2>Select source document</h2>
    <p class="sub">Each line item is matched to the <b>Financial Event</b> and <b>High Frequency Phrase</b> columns of the Financial Master Data for the chosen document type. Each selected line becomes its own source document, with line items but no figures.</p>
    <div class="row"><select id="sd" style="max-width:320px"><option value="">Choose document type…</option>${opts}</select>
      <button class="btn" id="run">Match line items</button></div></div>
  <div id="matches"></div>`;
  $('#sd').onchange = e => { S.sourceDocument = e.target.value; S.preview = null; S.picks = {}; viewMatch(); };
  $('#run').onclick = guard(async () => {
    if (!S.sourceDocument) throw new Error('Choose a source document type');
    S.preview = await api(`/uploads/${S.upload.id}/matches?sourceDocument=${encodeURIComponent(S.sourceDocument)}`);
    S.picks = {};
    S.preview.matches.forEach(m => { S.picks[m.lineNo] = { on: m.matched, rowIndex: m.matched ? m.candidates[0].rowIndex : '' }; });
    renderMatches();
  });
  if (S.preview) renderMatches();
}
function renderMatches() {
  const p = S.preview, box = $('#matches');
  const matched = p.matches.filter(m => m.matched).length;
  box.innerHTML = `<div class="card"><div class="row"><h2 class="sp">${esc(p.sourceDocument)}: ${matched} of ${p.matches.length} lines matched</h2>
    <button class="btn" id="gen">Create source documents</button></div>
    <p class="sub">Override the event with the dropdown. Lines picked without textual evidence get low confidence and need explicit Finance Reviewer confirmation.</p>
    <div class="scroll"><table><thead><tr><th></th><th>#</th><th>Line item</th><th>Financial event</th><th>Match</th></tr></thead><tbody>
    ${p.matches.map(m => {
      const pk = S.picks[m.lineNo]; const c = m.candidates.find(c => c.rowIndex === Number(pk.rowIndex));
      return `<tr><td><input type="checkbox" data-on="${m.lineNo}" ${pk.on ? 'checked' : ''} ${pk.rowIndex === '' ? 'disabled' : ''}></td><td class="mut">${m.lineNo}</td><td>${esc(m.text)}</td>
      <td><select data-ev="${m.lineNo}"><option value="">— no match —</option>${p.events.map(e => `<option value="${e.rowIndex}" ${Number(pk.rowIndex) === e.rowIndex && pk.rowIndex !== '' ? 'selected' : ''}>${esc(e.event)} — ${esc(e.phrase)}</option>`).join('')}</select></td>
      <td>${c ? `<span class="pill ${c.score >= .7 ? 'ok' : 'warn'}">${Math.round(c.score * 100)}%</span>` : pk.rowIndex === '' ? '<span class="pill err">unmatched</span>' : '<span class="pill warn">manual</span>'}</td></tr>`;
    }).join('')}</tbody></table></div></div>`;
  box.querySelectorAll('[data-on]').forEach(i => i.onchange = () => { S.picks[i.dataset.on].on = i.checked; });
  box.querySelectorAll('[data-ev]').forEach(s => s.onchange = () => {
    const pk = S.picks[s.dataset.ev]; pk.rowIndex = s.value; pk.on = s.value !== ''; renderMatches();
  });
  $('#gen').onclick = guard(async () => {
    const items = Object.entries(S.picks).filter(([, v]) => v.on && v.rowIndex !== '').map(([lineNo, v]) => ({ lineNo: Number(lineNo), rowIndex: Number(v.rowIndex) }));
    const r = await api(`/uploads/${S.upload.id}/generate`, { method: 'POST', body: { sourceDocument: S.sourceDocument, items } });
    await refreshLists(); await openDoc(r.created[0].id);
    toast(`Created ${r.created.length} source document(s)`, null, true); go('process');
  });
}

/* ---------------------------- 3. Processing ---------------------------- */
async function viewProcess() {
  await refreshLists();
  if (S.currentId && !S.docs.some(d => d.id === S.currentId)) S.current = S.currentId = null;
  if (!S.current && S.docs[0]) await openDoc(S.docs[0].id);
  const list = S.docs.map(d => { const [t, c] = STATUS[d.status]; return `<div class="item ${d.id === S.currentId ? 'on' : ''}" data-id="${d.id}">
    <div class="row"><b class="sp">${esc(d.number)}</b><span class="pill ${c}">${t}</span></div>
    <small>${esc(d.sourceDocument)} · ${esc(d.events.join(', '))}</small><small>${esc(d.description)}</small>
    ${d.gross ? `<small>NGN ${money(d.gross)}</small>` : ''}</div>`; }).join('');
  $('#view').innerHTML = S.docs.length
    ? `<div class="split"><div class="list">${list}</div><div id="editor"></div></div>`
    : '<div class="card"><h2>No source documents yet</h2><p class="sub">Upload a document and generate source documents first.</p></div>';
  document.querySelectorAll('.list .item').forEach(i => i.onclick = guard(async () => { await openDoc(i.dataset.id); viewProcess(); }));
  if (S.current) renderEditor();
}

function stepper(d) {
  const order = ['draft', 'pending_approval', 'approved', 'reviewed', 'billed'];
  const idx = order.indexOf(d.status);
  const steps = [['1 · Complete figures', 0], ['2 · Approvals', 1], ['3 · Finance review', 2], ['4 · Convert to bill', 3]];
  return `<div class="steps">${steps.map(([t, i]) => `<div class="${idx > i ? 'done' : idx === i ? 'now' : ''}">${t}</div>`).join('')}</div>`;
}
const issueList = (items) => items && items.length ? `<ul class="issues">${items.map(i => `<li class="${i.level}">${esc(i.msg)} ${i.ref ? `<a class="chip" data-policy="${i.ref}">${i.ref}</a>` : ''}</li>`).join('')}</ul>` : '';

function renderEditor() {
  const d = S.current, draft = d.status === 'draft', dis = draft ? '' : 'disabled';
  const [st, sc] = STATUS[d.status];
  const f = (k, label, type = 'text') => `<div><label>${label}</label><input type="${type}" data-h="${k}" value="${esc(d.header[k])}" ${dis}></div>`;
  const r = (k, label) => `<div><label>${label}</label><input type="text" data-r="${k}" value="${esc(d.refs[k])}" ${dis}></div>`;
  const procurement = ['Purchase Order', 'Vendor Invoice'].includes(d.sourceDocument);
  $('#editor').innerHTML = `
  <div class="card"><div class="row"><h2 class="sp">${esc(d.number)} · ${esc(d.sourceDocument)}</h2><span class="pill ${sc}">${st}</span></div>
    <div class="line-src mut">Source line ${d.sourceLine.n}: ${esc(d.sourceLine.text)}</div>
    ${d.rejection ? `<ul class="issues"><li class="warning">Returned by ${esc(d.rejection.by)}: ${esc(d.rejection.reason)}</li></ul>` : ''}
    ${stepper(d)}
    <h3>Document details</h3>
    <div class="grid">${f('counterparty', 'Counterparty (vendor / customer / employee)')}${f('department', 'Department')}${f('costCenter', 'Cost center')}${f('documentDate', 'Document date', 'date')}</div>
    <div style="margin-top:10px"><label>Business purpose</label><input type="text" data-h="purpose" value="${esc(d.header.purpose)}" ${dis}></div>
    <div class="grid" style="margin-top:10px">
      ${procurement ? r('purchaseRequest', 'Purchase request ref') + r('purchaseOrder', 'Purchase order ref') + r('receipt', 'Goods/service receipt ref') + r('quotation', 'Quotation ref') + r('quotationWaiver', 'If no quotation: why not practical') : ''}
      ${d.sourceDocument === 'Payment Voucher' ? r('invoice', 'Vendor invoice ref') : ''}
      ${d.sourceDocument === 'Expense Claim' ? `<div><label>Receipts</label><label style="color:var(--ink)"><input type="checkbox" data-h="receiptsAttached" ${d.header.receiptsAttached ? 'checked' : ''} ${dis}> Supporting receipts attached</label></div>` : ''}
    </div>
    <h3>Line items <span class="mut">(figures are entered by you)</span></h3>
    <div class="scroll"><table id="lineTable"><thead><tr><th>Financial event</th><th>Qty</th><th>Unit price</th><th>VAT</th><th>WHT</th><th class="n">Net</th><th class="n">Gross</th><th></th></tr></thead><tbody>
    ${d.lines.map(l => `<tr data-line="${l.id}">
      <td style="min-width:230px"><select data-f="rowIndex" ${dis}>${d.events.map(e => `<option value="${e.rowIndex}" ${e.rowIndex === l.rowIndex ? 'selected' : ''}>${esc(e.event)}</option>`).join('')}</select>
        <small class="mut" data-meta>${metaHtml(l, d)}</small></td>
      <td style="width:80px"><input type="number" step="any" data-f="quantity" value="${esc(l.quantity)}" placeholder="1" ${dis}></td>
      <td style="width:130px"><input type="number" step="any" data-f="unitPrice" value="${esc(l.unitPrice)}" ${dis}></td>
      <td style="width:110px"><input type="number" step="any" data-f="vat" value="${esc(l.vat)}" ${dis || !l.figures.tax.vat ? 'disabled' : ''}></td>
      <td style="width:110px"><input type="number" step="any" data-f="wht" value="${esc(l.wht)}" ${dis || !l.figures.tax.wht ? 'disabled' : ''}></td>
      <td class="n" data-net>${money(l.figures.net)}</td><td class="n" data-gross>${money(l.figures.gross)}</td>
      <td>${draft && d.lines.length > 1 ? '<button class="btn sec" data-del>✕</button>' : ''}</td></tr>`).join('')}
    <tr class="tot"><td colspan="5">Total (NGN)</td><td class="n" id="totNet">${money(d.totals.net)}</td><td class="n" id="totGross">${money(d.totals.gross)}</td><td></td></tr></tbody></table></div>
    ${draft ? '<div class="row" style="margin-top:8px"><button class="btn sec" id="addLine">+ Add line item</button><button class="btn sec" id="save">Save draft</button></div>' : ''}
    <div id="journalBox">${journalHtml(d)}</div>
    <div class="row" style="margin-top:12px"><span class="mut">Policy references:</span>${d.policyRefs.map(p => `<a class="chip" data-policy="${p.id}" title="${esc(p.title)}">${p.id}</a>`).join('')}</div>
  </div>
  <div class="card noprint" id="workflow">${workflowHtml(d)}</div>`;
  wireEditor();
}

const metaHtml = (l, d) => `${esc(l.phrase)} · <span class="pill ${l.confidence >= d.checklists.lowConfidence ? 'ok' : 'warn'}">${Math.round(l.confidence * 100)}%</span>`;

/** Patch only the computed parts after a save, so typing/focus in the form is never disturbed. */
function refreshCalc() {
  const d = S.current, ed = $('#editor');
  d.lines.forEach(l => {
    const tr = ed.querySelector(`[data-line="${CSS.escape(l.id)}"]`); if (!tr) return;
    tr.querySelector('[data-net]').textContent = money(l.figures.net);
    tr.querySelector('[data-gross]').textContent = money(l.figures.gross);
    tr.querySelector('[data-meta]').innerHTML = metaHtml(l, d);
    tr.querySelector('[data-f=vat]').disabled = !l.figures.tax.vat;
    tr.querySelector('[data-f=wht]').disabled = !l.figures.tax.wht;
  });
  $('#totNet').textContent = money(d.totals.net); $('#totGross').textContent = money(d.totals.gross);
  $('#journalBox').innerHTML = journalHtml(d);
  const prep = $('#prep'), keep = prep ? prep.value : '';
  $('#workflow').innerHTML = workflowHtml(d); wireWorkflow();
  if ($('#prep')) $('#prep').value = keep || d.header.preparedBy;
}

function journalHtml(d) {
  if (!d.journal.length) return `<h3>Journal preview</h3><p class="mut">${d.totals.net ? 'This event has no GL posting (commitment / register only).' : 'Enter figures to preview the journal entry.'}</p>`;
  const agg = {};
  d.journal.forEach(j => { const k = j.side + j.account; (agg[k] ||= { ...j, amount: 0 }).amount += j.amount; });
  const rows = Object.values(agg).sort((a, b) => (a.side === b.side ? 0 : a.side === 'Dr' ? -1 : 1));
  return `<h3>Journal preview ${d.balanced ? '<span class="pill ok">balanced</span>' : '<span class="pill err">unbalanced</span>'}</h3>
  <table><thead><tr><th>Account</th><th>Code</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead><tbody>
  ${rows.map(j => `<tr><td style="padding-left:${j.side === 'Cr' ? 28 : 8}px">${esc(j.account)}${j.memo ? ' <span class="pill">memo</span>' : ''}</td><td class="mono">${j.code ?? '<span class="pill warn">needs code</span>'}</td><td class="n">${j.side === 'Dr' ? money(j.amount) : ''}</td><td class="n">${j.side === 'Cr' ? money(j.amount) : ''}</td></tr>`).join('')}</tbody></table>`;
}

function workflowHtml(d) {
  if (d.status === 'draft') {
    const blockers = d.issues.submit;
    return `<h2>Submit for approval</h2>${issueList(blockers)}
      <div class="row"><div style="max-width:260px"><label>Prepared by (your name)</label><input type="text" id="prep" value="${esc(d.header.preparedBy)}"></div>
      <button class="btn" id="submit" style="align-self:end">Save &amp; submit</button></div>`;
  }
  if (d.status === 'pending_approval') {
    return `<h2>Approvals</h2><p class="sub">Tier for NGN ${money(d.totals.gross)} (FIN-POL-001). Approvers must be different people, and cannot be the preparer or beneficiary.</p>
    <table><tbody>${d.requiredApprovals.map(r => `<tr><td><b>${esc(r.role)}</b><br><small class="mut">${esc(r.reason)}</small></td>
      <td>${r.approval ? `<span class="pill ok">Approved by ${esc(r.approval.by)}</span>` : `<div class="row"><input type="text" placeholder="Approver name" data-by="${esc(r.role)}" style="max-width:220px"><button class="btn" data-approve="${esc(r.role)}">Approve</button></div>`}</td></tr>`).join('')}</tbody></table>
    ${rejectHtml()}`;
  }
  if (d.status === 'approved') {
    const need = d.accountsNeedingCode, tw = d.issues.review.some(i => i.ref === 'PROC-CTRL-001');
    const vendor = d.sourceDocument === 'Vendor Invoice' && d.totals.gross > 100000;
    const hasLow = d.lines.some(l => l.confidence < d.checklists.lowConfidence);
    return `<h2>Finance review</h2><p class="sub">Reviewer must be independent of the preparer and approvers (FIN-POL-002).</p>
    ${vendor ? `<h3>Three-way match: PO ↔ receipt ↔ invoice <a class="chip" data-policy="PROC-CTRL-001">PROC-CTRL-001</a></h3><div class="row">${d.checklists.threeWay.map(c => `<label style="color:var(--ink)"><input type="checkbox" data-tw="${esc(c)}"> ${esc(c)} agrees</label>`).join('')}</div>
      <h3>Vendor verification <a class="chip" data-policy="PROC-POL-001">PROC-POL-001</a></h3><div class="row">${d.checklists.vendor.map(c => `<label style="color:var(--ink)"><input type="checkbox" data-vc="${esc(c)}"> ${esc(c)}</label>`).join('')}</div>` : ''}
    ${hasLow ? '<h3>Low-confidence classification</h3><label style="color:var(--ink)"><input type="checkbox" id="ack"> I confirm the financial event for low-confidence lines is correct <a class="chip" data-policy="RAG-CTRL-001">RAG-CTRL-001</a></label>' : ''}
    ${need.length ? `<h3>Chart of accounts <a class="chip" data-policy="COA-001">COA-001</a></h3><p class="sub">The policy COA has no specific account for these — assign a code in range.</p><div class="grid">${need.map(a => `<div><label>${esc(a.account)} (${a.range.from}–${a.range.to})</label><input type="number" data-ov="${esc(a.account)}" min="${a.range.from}" max="${a.range.to}"></div>`).join('')}</div>` : ''}
    <div class="row" style="margin-top:12px"><div style="max-width:260px"><label>Finance Reviewer name</label><input type="text" id="rev"></div><button class="btn" id="review" style="align-self:end">Complete review</button></div>${rejectHtml()}`;
  }
  if (d.status === 'reviewed') {
    return `<h2>Convert to bill</h2><p class="sub">Final step by the Payment Processor, who must be a different person from everyone before.</p>
    <div class="row"><div style="max-width:260px"><label>Payment Processor name</label><input type="text" id="proc"></div><button class="btn" id="convert" style="align-self:end">Convert to bill</button></div>${rejectHtml()}`;
  }
  return `<h2>Billed</h2><p>This document has been converted to a bill.</p><button class="btn" id="openBill">View bill</button>`;
}
const rejectHtml = () => '<div style="margin-top:12px"><button class="btn sec" id="reject">Return to draft…</button></div>';

function showPolicy(a) {
  return guard(async () => {
    const c = await api('/policy/' + a.dataset.policy);
    $('#policyTitle').textContent = `${c.id} — ${c.title}`; $('#policyText').textContent = c.text; $('#policyDialog').showModal();
  });
}
const collect = () => {
  const ed = $('#editor'), header = {}, refs = {};
  ed.querySelectorAll('[data-h]').forEach(i => header[i.dataset.h] = i.type === 'checkbox' ? i.checked : i.value);
  ed.querySelectorAll('[data-r]').forEach(i => refs[i.dataset.r] = i.value);
  const lines = [...ed.querySelectorAll('[data-line]')].map(tr => {
    const o = { id: tr.dataset.line };
    tr.querySelectorAll('[data-f]').forEach(i => o[i.dataset.f] = i.value); return o;
  });
  return { header, refs, lines };
};
// saves are serialised so a slow response can never overwrite a newer one
let saveChain = Promise.resolve();
const save = (extra = {}) => (saveChain = saveChain.catch(() => {}).then(async () => {
  S.current = await api('/documents/' + S.current.id, { method: 'PATCH', body: { ...collect(), ...extra } });
}));

function wireEditor() {
  const d = S.current, ed = $('#editor');
  ed.querySelectorAll('[data-policy]').forEach(a => a.onclick = showPolicy(a));
  const live = guard(async () => { await save(); refreshCalc(); });
  ed.querySelectorAll('[data-line] [data-f],[data-h],[data-r]').forEach(i => i.onchange = live);
  ed.querySelectorAll('[data-del]').forEach(b => b.onclick = guard(async () => {
    const keep = collect().lines.filter(l => l.id !== b.closest('tr').dataset.line); await save({ lines: keep }); renderEditor();
  }));
  const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
  on('addLine', guard(async () => { const c = collect().lines; c.push({ rowIndex: d.events[0].rowIndex, quantity: '', unitPrice: '', vat: '', wht: '' }); await save({ lines: c }); renderEditor(); }));
  on('save', guard(async () => { await save(); renderEditor(); toast('Draft saved', null, true); }));
  wireWorkflow();
}

function wireWorkflow() {
  const d = S.current, ed = $('#editor');
  ed.querySelectorAll('#workflow [data-policy]').forEach(a => a.onclick = showPolicy(a));
  const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
  const after = async () => { await refreshLists(); viewProcess(); };
  on('submit', guard(async () => {
    await save(); S.current = await api(`/documents/${d.id}/submit`, { method: 'POST', body: { by: $('#prep').value } }); await after();
  }));
  ed.querySelectorAll('[data-approve]').forEach(b => b.onclick = guard(async () => {
    const role = b.dataset.approve, by = ed.querySelector(`[data-by="${CSS.escape(role)}"]`).value;
    S.current = await api(`/documents/${d.id}/approve`, { method: 'POST', body: { role, by } }); await after();
  }));
  on('reject', guard(async () => {
    const by = prompt('Your name:'); if (!by) return; const reason = prompt('Reason for returning to draft:'); if (!reason) return;
    S.current = await api(`/documents/${d.id}/reject`, { method: 'POST', body: { by, reason } }); await after();
  }));
  on('review', guard(async () => {
    const threeWay = {}, vendorChecks = {}, accountOverrides = {};
    ed.querySelectorAll('[data-tw]').forEach(i => threeWay[i.dataset.tw] = i.checked);
    ed.querySelectorAll('[data-vc]').forEach(i => vendorChecks[i.dataset.vc] = i.checked);
    ed.querySelectorAll('[data-ov]').forEach(i => accountOverrides[i.dataset.ov] = i.value);
    const ack = $('#ack');
    S.current = await api(`/documents/${d.id}/finance-review`, { method: 'POST', body: { by: $('#rev').value, threeWay, vendorChecks, accountOverrides, ackLowConfidence: ack ? ack.checked : false } });
    await after();
  }));
  on('convert', guard(async () => {
    const bill = await api(`/documents/${d.id}/convert`, { method: 'POST', body: { by: $('#proc').value } });
    await refreshLists(); S.bill = bill; toast(`Created ${bill.number}`, null, true); go('bills');
  }));
  on('openBill', guard(async () => { S.bill = await api('/bills/' + d.billId); go('bills'); }));
}

/* -------------------------------- Bills -------------------------------- */
async function viewBills() {
  await refreshLists();
  if (S.bill && !S.bills.some(b => b.id === S.bill.id)) S.bill = null;
  const list = S.bills.length ? `<table><thead><tr><th>Bill</th><th>From</th><th>Counterparty</th><th class="n">Gross</th><th class="n">Payable</th><th>GL</th></tr></thead><tbody>
    ${S.bills.map(b => `<tr style="cursor:pointer" data-bill="${b.id}"><td><b>${esc(b.number)}</b></td><td>${esc(b.documentNumber)}</td><td>${esc(b.counterparty)}</td><td class="n">${money(b.gross)}</td><td class="n">${money(b.payable)}</td><td>${esc(b.glPosting)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="sub">No bills yet. Complete the payment-processing steps on a source document.</p>';
  const b = S.bill;
  $('#view').innerHTML = `<div class="card noprint"><h2>Bills</h2>${list}</div>${b ? billHtml(b) : ''}`;
  document.querySelectorAll('[data-bill]').forEach(tr => tr.onclick = guard(async () => { S.bill = await api('/bills/' + tr.dataset.bill); viewBills(); }));
  document.querySelectorAll('[data-policy]').forEach(a => a.onclick = guard(async () => {
    const c = await api('/policy/' + a.dataset.policy); $('#policyTitle').textContent = `${c.id} — ${c.title}`; $('#policyText').textContent = c.text; $('#policyDialog').showModal();
  }));
  const pr = $('#printBill'); if (pr) pr.onclick = () => window.print();
}
function billHtml(b) {
  const w = b.workflow;
  return `<div class="card"><div class="row"><h2 class="sp">${esc(b.number)} <span class="pill ok">${esc(b.glPosting)}</span></h2>
    <span class="noprint"><button class="btn sec" id="printBill">Print</button> <a class="btn" href="api/bills/${b.id}/csv" style="text-decoration:none;display:inline-block">Download CSV</a></span></div>
    <p class="sub">${esc(b.sourceDocument)} ${esc(b.documentNumber)} · ${esc(b.counterparty)} · ${esc(b.department)} / ${esc(b.costCenter)} · ${esc(b.documentDate)} · ${b.currency}</p>
    <p>${esc(b.purpose)}</p>
    <h3>Line items</h3><table><thead><tr><th>Event</th><th>Description</th><th class="n">Net</th><th class="n">VAT</th><th class="n">WHT</th><th class="n">Gross</th></tr></thead><tbody>
    ${b.lines.map(l => `<tr><td>${esc(l.event)}</td><td>${esc(l.description)}</td><td class="n">${money(l.figures.net)}</td><td class="n">${money(l.figures.vat)}</td><td class="n">${money(l.figures.wht)}</td><td class="n">${money(l.figures.gross)}</td></tr>`).join('')}
    <tr class="tot"><td colspan="2">Total</td><td class="n">${money(b.totals.net)}</td><td class="n">${money(b.totals.vat)}</td><td class="n">${money(b.totals.wht)}</td><td class="n">${money(b.totals.gross)}</td></tr>
    <tr><td colspan="5">Net payable after WHT</td><td class="n"><b>${money(b.totals.payable)}</b></td></tr></tbody></table>
    <h3>Journal entry</h3>${b.entries.length ? `<table><thead><tr><th>Account</th><th>Code</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead><tbody>
    ${b.entries.map(e => `<tr><td style="padding-left:${e.side === 'Cr' ? 28 : 8}px">${esc(e.account)}</td><td class="mono">${e.code ?? ''}${e.memo ? ' memo' : ''}</td><td class="n">${e.side === 'Dr' ? money(e.amount) : ''}</td><td class="n">${e.side === 'Cr' ? money(e.amount) : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="mut">No GL posting for this event.</p>'}
    <h3>Control trail</h3><table><tbody>
    <tr><td>Prepared by</td><td>${esc(w.preparedBy)}</td></tr>
    ${w.approvals.map(a => `<tr><td>${esc(a.role)}</td><td>${esc(a.by)} · ${new Date(a.at).toLocaleString()}</td></tr>`).join('')}
    <tr><td>Finance Reviewer</td><td>${esc(w.financeReviewer)}</td></tr><tr><td>Payment Processor</td><td>${esc(w.paymentProcessor)} · ${new Date(w.convertedAt).toLocaleString()}</td></tr></tbody></table>
    <div class="row noprint" style="margin-top:10px"><span class="mut">Policy:</span>${b.policyRefs.map(p => `<a class="chip" data-policy="${p.id}">${p.id}</a>`).join('')}</div></div>`;
}

(async function init() {
  window.go = go;
  try { S.sourceDocs = await api('/source-documents'); await refreshLists(); } catch (e) { toast(e.message); }
  render();
})();
