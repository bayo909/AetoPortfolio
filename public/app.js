'use strict';
// Aeto Connect UI. Plain DOM, no build step. All text goes through textContent, never innerHTML.
const root = document.getElementById('app');
// replaceChildren that accepts nested arrays / null / strings, like h() does (the native one would print "null").
const nativeReplace = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...kids) {
  return nativeReplace.apply(this, kids.flat(9).filter(k => k != null && k !== false).map(k => (k.nodeType ? k : document.createTextNode(String(k)))));
};

// ---------- helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(9)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const money = (n, cur) => (cur ? cur + ' ' : '') + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = iso => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const pill = (s, label) => h('span', { class: `pill ${s}` }, (label || s).replace('_', ' '));
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
}
async function api(method, path, body) {
  const init = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch('/api' + path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
  return data;
}
async function guard(fn, errBox) {
  try { return await fn(); } catch (e) {
    if (e.status === 401) { state.me = null; return renderAuth(); }
    if (errBox) errBox.textContent = e.message; else toast(e.message);
  }
}
function openModal(title, content, { onClose } = {}) {
  const m = document.getElementById('modal');
  const close = () => { m.hidden = true; m.replaceChildren(); onClose && onClose(); };
  m.replaceChildren(h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'row' }, h('h2', { class: 'grow' }, title), h('button', { class: 'btn sec sm', onclick: close, 'aria-label': 'Close' }, '✕')), content));
  m.hidden = false;
  m.onclick = e => { if (e.target === m) close(); };
  const first = m.querySelector('input,select,textarea,button.btn:not(.sec)'); if (first) first.focus();
  return close;
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') { const m = document.getElementById('modal'); if (!m.hidden) { m.hidden = true; m.replaceChildren(); } } });

const COA_CHOICES = [[6200, 'Office Supplies & Printing'], [6300, 'Utilities'], [6400, 'Travel'], [6500, 'Professional Fees'], [6600, 'IT, Software & Security'], [6700, 'Rent & Leases'], [6750, 'Marketing'], [6800, 'Repairs & Maintenance'], [6900, 'General & Administrative'], [1300, 'Prepaid Expenses'], [1400, 'Inventory'], [1500, 'Property, Plant & Equipment']];

// ---------- state ----------
const state = { me: null, org: null, members: [], workspaces: [], wsId: null, ws: null, view: 'channel', channelId: null, messages: [], panel: null, templates: [], draft: '', pending: [], es: null };
const isOwner = () => state.ws && state.ws.side === 'owner';
const canReview = () => isOwner() && ['admin', 'approver'].includes(state.me.role);

// ---------- auth ----------
function renderAuth() {
  closeEvents();
  let mode = 'login';
  const err = h('p', { class: 'err', role: 'alert' });
  const form = h('form', { onsubmit: submit });
  const draw = () => {
    const f = n => form.elements[n] && form.elements[n].value;
    form.replaceChildren(
      mode === 'register' ? [h('label', {}, 'Your name'), h('input', { name: 'name', required: true, autocomplete: 'name' })] : null,
      h('label', {}, 'Work email'), h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' }),
      h('label', {}, 'Password'), h('input', { name: 'password', type: 'password', required: true, minlength: 8, autocomplete: mode === 'login' ? 'current-password' : 'new-password' }),
      mode === 'register' ? [
        h('label', {}, 'Company name (creates a new company)'), h('input', { name: 'orgName' }),
        h('label', {}, 'or company join code (join a colleague\'s company)'), h('input', { name: 'orgJoinCode', placeholder: 'e.g. 9F3A1C2B' }),
      ] : null,
      err, h('p', {}, h('button', { class: 'btn', type: 'submit' }, mode === 'login' ? 'Sign in' : 'Create account')));
  };
  async function submit(e) {
    e.preventDefault(); err.textContent = '';
    const d = Object.fromEntries(new FormData(form));
    if (mode === 'register' && !d.orgName && !d.orgJoinCode) { err.textContent = 'Enter a company name or a join code'; return; }
    if (d.orgJoinCode) delete d.orgName; else delete d.orgJoinCode;
    await guard(async () => { await api('POST', `/auth/${mode}`, d); await boot(); }, err);
  }
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const drawTabs = () => tabs.replaceChildren(...[['login', 'Sign in'], ['register', 'Create account']].map(([m, l]) =>
    h('button', { class: 'tab' + (mode === m ? ' on' : ''), role: 'tab', 'aria-selected': mode === m, onclick: () => { mode = m; err.textContent = ''; drawTabs(); draw(); } }, l)));
  drawTabs(); draw();
  root.replaceChildren(h('main', { class: 'auth' }, h('h1', {}, 'Aeto Connect'),
    h('p', { class: 'muted' }, 'B2B workspaces where buyers request documents from vendors and pay them from the chat.'),
    h('div', { class: 'card' }, tabs, form),
    h('p', { class: 'muted small' }, 'Local demo? Start the server with DEMO=1 and sign in as ada@northwind.test / kemi@northwind.test (buyer) or tunde@securetech.test (vendor), password demo-pass-123.')));
}

async function boot() {
  const me = await api('GET', '/me').catch(() => null);
  if (!me) return renderAuth();
  Object.assign(state, { me: me.user, org: me.org, members: me.members, workspaces: me.workspaces });
  const saved = localStorage.getItem('ws');
  const pick = state.workspaces.find(w => w.id === saved) || state.workspaces[0];
  if (pick) await selectWorkspace(pick.id); else { state.ws = null; state.wsId = null; render(); }
}

async function selectWorkspace(id) {
  state.wsId = id; localStorage.setItem('ws', id);
  state.ws = await api('GET', `/workspaces/${id}`);
  state.templates = await api('GET', `/workspaces/${id}/templates`);
  state.panel = null; state.view = 'channel';
  const first = state.ws.channels.find(c => c.id === state.channelId) || state.ws.channels.find(c => c.kind === 'shared') || state.ws.channels[0];
  state.channelId = first && first.id;
  openEvents();
  await loadMessages(); render();
}

function openEvents() {
  closeEvents();
  let t;
  state.es = new EventSource(`/api/workspaces/${state.wsId}/events`);
  state.es.onmessage = () => { clearTimeout(t); t = setTimeout(refresh, 150); };
}
function closeEvents() { if (state.es) { state.es.close(); state.es = null; } }

async function loadMessages() {
  state.messages = state.channelId && state.view === 'channel' ? await api('GET', `/channels/${state.channelId}/messages`) : [];
}
async function refresh() {
  if (!state.me || !state.ws) return;
  try {
    state.ws = await api('GET', `/workspaces/${state.wsId}`);
    await loadMessages();
    renderMain(); renderPanel();
  } catch (e) { if (e.status === 401) renderAuth(); }
}

// ---------- shell ----------
function render() {
  if (!state.me) return renderAuth();
  const side = h('nav', { class: 'side', 'aria-label': 'Workspace' });
  const wsSel = h('select', { 'aria-label': 'Workspace', onchange: e => { if (e.target.value === '+') { e.target.value = state.wsId || ''; return workspaceModal(); } guard(() => selectWorkspace(e.target.value)); } },
    state.workspaces.map(w => h('option', { value: w.id, selected: w.id === state.wsId }, `${w.name} ${w.side === 'vendor' ? '(vendor)' : ''}`)),
    h('option', { value: '+' }, '＋ Create or join a workspace…'));
  const nav = (key, label, extra) => h('button', { class: 'nav' + (state.view === key ? ' on' : ''), onclick: () => guard(() => go(key)) }, label, extra);
  side.append(h('div', { style: 'padding:12px' }, wsSel));
  if (state.ws) {
    side.append(h('div', { class: 'scroll' },
      h('div', { class: 'sect' }, 'Channels'),
      state.ws.channels.map(c => h('button', { class: 'nav' + (state.view === 'channel' && c.id === state.channelId ? ' on' : ''), onclick: () => guard(() => go('channel', c.id)) },
        h('span', { class: 'hash' }, '#'), c.name, c.kind === 'shared' && isOwner() ? h('span', { class: 'tag' }, 'vendor') : null)),
      isOwner() ? h('button', { class: 'nav', onclick: channelModal }, h('span', { class: 'hash' }, '＋'), 'Add channel') : null,
      h('div', { class: 'sect' }, 'Money & documents'),
      nav('payables', isOwner() ? 'Requests & payables' : 'My requests & payments'),
      isOwner() ? nav('ledger', 'Ledger & audit') : null,
      nav('templates', 'Document templates'),
      nav('settings', isOwner() ? 'Settings & people' : 'Company & people')));
  } else side.append(h('div', { class: 'scroll' }));
  side.append(h('div', { class: 'me' }, h('div', {}, h('b', {}, state.me.name)), h('div', { class: 'muted' }, `${state.me.orgName} · ${state.me.role}`), h('button', { onclick: logout }, 'Sign out')));
  root.replaceChildren(h('div', { class: 'shell' }, side, h('section', { class: 'main', id: 'main' }), h('aside', { class: 'panel', id: 'panel', hidden: true, 'aria-label': 'Details' })));
  renderMain(); renderPanel();
}

async function go(view, channelId) {
  state.view = view; if (channelId) state.channelId = channelId;
  state.panel = null;
  await loadMessages(); render();
}
async function logout() { await api('POST', '/auth/logout').catch(() => {}); closeEvents(); Object.assign(state, { me: null, ws: null, wsId: null }); renderAuth(); }

function renderMain() {
  const m = document.getElementById('main'); if (!m) return;
  if (!state.ws) {
    m.replaceChildren(h('div', { class: 'view' }, h('div', { class: 'empty' }, h('h2', {}, 'Welcome, ' + state.me.name),
      h('p', {}, state.me.role === 'admin' ? 'Create a workspace to start requesting documents from vendors, or join a customer\'s workspace with the invite code they gave you.' : 'Ask your company admin to create or join a workspace.'),
      state.me.role === 'admin' ? h('button', { class: 'btn', onclick: workspaceModal }, 'Create or join a workspace') : null)));
    return;
  }
  const v = { channel: viewChannel, payables: viewPayables, ledger: viewLedger, templates: viewTemplates, settings: viewSettings }[state.view];
  Promise.resolve(v(m)).catch(e => { if (e.status === 401) renderAuth(); else m.replaceChildren(h('div', { class: 'view' }, h('p', { class: 'err' }, e.message))); });
}
function renderPanel() {
  const p = document.getElementById('panel'); if (!p) return;
  if (!state.panel) { p.hidden = true; p.replaceChildren(); return; }
  p.hidden = false;
  const close = h('button', { class: 'btn sec sm', onclick: () => { state.panel = null; renderPanel(); }, 'aria-label': 'Close panel' }, '✕');
  const body = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  p.replaceChildren(h('div', { class: 'row' }, h('h3', { class: 'grow' }, state.panel.type === 'voucher' ? 'Voucher & audit trail' : 'Thread'), close), body);
  const job = state.panel.type === 'voucher' ? voucherPanel(body, state.panel.entryId) : threadPanel(body, state.panel.messageId);
  Promise.resolve(job).catch(e => body.replaceChildren(h('p', { class: 'err' }, e.message)));
}
const openPanel = panel => { state.panel = panel; renderPanel(); };

// ---------- channel ----------
async function viewChannel(m) {
  const ch = state.ws.channels.find(c => c.id === state.channelId);
  if (!ch) return m.replaceChildren(h('div', { class: 'view' }, h('div', { class: 'empty' }, 'No channels yet.')));
  const list = h('div', { class: 'msgs', id: 'msgs', role: 'log', 'aria-live': 'polite' });
  const vendors = ch.orgs.filter(o => o.id !== state.ws.owner.id);
  const head = h('div', { class: 'head' }, h('h2', {}, '# ' + ch.name), h('span', { class: 'muted small grow' }, ch.topic || ch.orgs.map(o => o.name).join(' · ')),
    isOwner() && vendors.length ? h('button', { class: 'btn', onclick: () => requestModal(ch) }, 'Request a document') : null);
  const ta = h('textarea', { rows: 2, placeholder: `Message #${ch.name}`, 'aria-label': 'Message', value: state.draft, oninput: e => { state.draft = e.target.value; }, onkeydown: e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } });
  const chips = h('div', {}); const drawChips = () => chips.replaceChildren(...state.pending.map(f => h('span', { class: 'chip' }, '📎 ' + f.name, h('button', { class: 'btn sec sm', 'aria-label': 'Remove ' + f.name, onclick: () => { state.pending = state.pending.filter(x => x !== f); drawChips(); } }, '✕'))));
  drawChips();
  const pick = h('input', { type: 'file', hidden: true, onchange: async e => { const f = e.target.files[0]; if (!f) return; const fd = new FormData(); fd.append('file', f); await guard(async () => { state.pending.push(await api('POST', `/channels/${ch.id}/files`, fd)); drawChips(); }); e.target.value = ''; } });
  async function send() {
    const text = ta.value.trim(); if (!text && !state.pending.length) return;
    await guard(async () => { await api('POST', `/channels/${ch.id}/messages`, { text, fileIds: state.pending.map(f => f.id) }); state.draft = ''; state.pending = []; ta.value = ''; drawChips(); await refresh(); });
  }
  const composer = h('div', { class: 'composer' }, chips, h('div', { class: 'box' }, ta, h('div', { class: 'row' }, pick, h('button', { class: 'btn sec sm', onclick: () => pick.click() }, '📎 Attach soft copy'), h('span', { class: 'grow' }), h('button', { class: 'btn sm', onclick: send }, 'Send'))),
    !isOwner() ? h('p', { class: 'muted small' }, 'Only the buyer can request documents. When they do, a request card appears here and you can upload a file or fill in the template.') : null);
  const atBottom = !document.getElementById('msgs') || (() => { const e = document.getElementById('msgs'); return e.scrollHeight - e.scrollTop - e.clientHeight < 80; })();
  list.append(...(state.messages.length ? state.messages.map(msgNode) : [h('div', { class: 'empty' }, 'No messages yet. Say hello 👋')]));
  m.replaceChildren(head, list, composer);
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function msgNode(msg) {
  if (msg.kind === 'system') return h('div', { class: 'sys' }, msg.text);
  const a = msg.author;
  const vendorSide = a && state.ws && a.orgId !== state.ws.owner.id;
  const content = [];
  if (msg.kind === 'request') content.push(requestCard(msg.request, msg));
  else if (msg.kind === 'submission') content.push(submissionCard(msg.submission));
  else if (msg.kind === 'payment') content.push(paymentCard(msg.payment));
  if (msg.text && msg.kind !== 'request') content.push(h('div', { class: 'body' }, msg.text));
  if (msg.files && msg.files.length && msg.kind === 'text') content.push(msg.files.map(fileChip));
  return h('div', { class: 'msg' }, h('div', { class: 'av' + (vendorSide ? ' vendor' : ''), 'aria-hidden': 'true' }, a ? a.name[0].toUpperCase() : '·'),
    h('div', { class: 'grow' }, h('div', { class: 'who' }, a ? a.name : 'System', h('span', { class: 'org' }, a ? `${a.orgName}${vendorSide ? ' · vendor' : ''}` : ''), h('span', { class: 'muted small', style: 'margin-left:8px;font-weight:400' }, when(msg.createdAt))), content,
      msg.kind === 'text' ? h('div', {}, h('button', { class: 'btn sec sm', style: 'margin-top:4px', onclick: () => openPanel({ type: 'thread', messageId: msg.id }) }, msg.replyCount ? `${msg.replyCount} replies` : 'Reply in thread')) : null));
}
const fileChip = f => h('a', { class: 'chip', href: `/api/files/${f.id}`, download: f.name }, '📄 ' + f.name, f.size ? h('span', { class: 'muted' }, ` ${(f.size / 1024).toFixed(1)} KB`) : null);

function requestCard(r, msg) {
  const mine = state.me.orgId === r.vendor.id;
  const l = r.latest;
  return h('div', { class: 'card' },
    h('div', { class: 'row wrap' }, h('h3', { class: 'grow' }, '📥 Document request: ' + r.title), pill(r.status)),
    h('div', { class: 'small muted' }, `${r.template.name} · from ${r.vendor.name}${r.dueDate ? ' · due ' + r.dueDate : ''}`),
    msg && msg.text ? h('div', { class: 'body' }, msg.text) : null,
    l ? h('div', { class: 'small', style: 'margin-top:4px' }, `Latest submission ${l.number || ''} ${l.total != null ? '· ' + money(l.total, l.currency) : ''} · `, pill(l.status), l.blockers ? ` ${l.blockers} blocking flag(s)` : '', l.warnings ? ` ${l.warnings} warning(s)` : '') : null,
    h('div', { class: 'row wrap', style: 'margin-top:8px' },
      mine && r.status === 'open' ? h('button', { class: 'btn sm', onclick: () => submitModal(r) }, 'Submit document') : null,
      h('button', { class: 'btn sec sm', onclick: () => openPanel({ type: 'thread', messageId: r.messageId }) }, r.submissionCount ? 'Review / details' : 'Open thread'),
      isOwner() && r.status === 'open' ? h('button', { class: 'btn sec sm', onclick: () => guard(async () => { await api('POST', `/requests/${r.id}/cancel`); await refresh(); }) }, 'Cancel request') : null));
}

function paymentCard(p) {
  return h('div', { class: 'card pay' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, '💸 Payment released'), pill('paid', p.status)),
    h('div', {}, `${money(p.amountDoc, p.currency)} (USD ${money(p.amountBase)}) · ref ${p.reference}`),
    h('div', { class: 'small muted' }, `Paid by ${p.paidBy.name} · ${when(p.paidAt)} · journal ${p.entryNumber} · rail: ${p.rail} (no real funds move in this build)`));
}

function submissionCard(s) {
  const ex = s.extracted, reviewable = canReview() && ['ready', 'flagged'].includes(s.status), memo = s.template.posting === 'memo';
  const overrides = {}; let reason;
  const blockers = s.flags.filter(f => f.severity === 'block');
  const card = h('div', { class: 'card sub' },
    h('div', { class: 'row wrap' }, h('h3', { class: 'grow' }, `📎 ${s.fileName || 'Template form'} · v${s.version}`), pill(s.status)),
    h('div', { class: 'small muted' }, `Read by RT-FEPE via ${s.method} · confidence ${Math.round(s.confidence * 100)}% · submitted by ${s.submittedBy.name} (${s.vendor.name})`),
    h('dl', { class: 'kv', style: 'margin:8px 0' },
      h('dt', {}, 'Number'), h('dd', {}, ex.number || '—'), h('dt', {}, 'Date'), h('dd', {}, ex.date || '—'), h('dt', {}, 'Issued by'), h('dd', {}, ex.vendorName || '—'),
      Object.entries(ex.custom || {}).map(([k, v]) => [h('dt', {}, (state.templates.find(t => t.id === s.template.id)?.fields.find(f => f.key === k)?.label) || k), h('dd', {}, v)]),
      !memo ? [h('dt', {}, 'Total'), h('dd', {}, ex.total != null ? money(ex.total, ex.currency) : '—'), ex.vat ? [h('dt', {}, 'VAT'), h('dd', {}, money(ex.vat))] : null, ex.wht ? [h('dt', {}, 'WHT'), h('dd', {}, money(ex.wht))] : null,
        s.base && s.base.total ? [h('dt', {}, 'In USD'), h('dd', {}, `${money(s.base.total)} @ ${s.base.rate}`)] : null] : null),
    s.flags.length ? h('ul', { class: 'flags' }, s.flags.map(f => h('li', { class: f.severity }, (f.severity === 'block' ? '⛔ ' : f.severity === 'warn' ? '⚠️ ' : 'ℹ️ ') + f.message))) : (s.status !== 'needs_data' ? h('p', { class: 'small', style: 'color:var(--ok)' }, '✔ No validation flags') : null),
    ex.lines.length && !memo ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Line'), h('th', { class: 'n' }, 'Amount'), reviewable ? h('th', {}, 'Account') : null)),
      h('tbody', {}, ex.lines.map((l, i) => h('tr', {}, h('td', {}, l.description), h('td', { class: 'n' }, money(l.amount)),
        reviewable ? h('td', {}, h('select', { 'aria-label': `Account for line ${i + 1}`, onchange: e => { if (+e.target.value === l.mappedAccount) delete overrides[i]; else overrides[i] = +e.target.value; } },
          COA_CHOICES.map(([c, n]) => h('option', { value: c, selected: c === l.mappedAccount }, `${c} ${n}`)))) : null)))) : null,
    s.journal ? h('details', { style: 'margin-top:8px' }, h('summary', {}, 'Proposed journal (USD)'), journalTable(s.journal)) : null);
  if (s.overrideReason) card.append(h('p', { class: 'small' }, '⚠️ Accepted with override: ' + s.overrideReason));
  if (s.rejectionReason) card.append(h('p', { class: 'small' }, 'Sent back: ' + s.rejectionReason));
  if (s.fileId) card.append(fileChip({ id: s.fileId, name: s.fileName, size: 0 }));
  if (reviewable) {
    reason = h('input', { placeholder: 'Reason for overriding the flags (required)', 'aria-label': 'Override reason' });
    card.append(h('div', { style: 'margin-top:8px' }, blockers.length ? [h('p', { class: 'small', style: 'color:var(--bad)' }, 'Blocking flags need a written override reason, which is recorded in the audit log.'), reason] : null,
      h('div', { class: 'row', style: 'margin-top:6px' },
        h('button', { class: 'btn ok sm', onclick: () => guard(async () => { await api('POST', `/submissions/${s.id}/accept`, { lineAccounts: overrides, overrideReason: reason && reason.value }); toast(memo ? 'Accepted' : 'Accepted and posted to the ledger'); await refresh(); }) }, memo ? 'Accept' : 'Accept & post'),
        h('button', { class: 'btn danger sm', onclick: () => rejectModal(s) }, 'Send back'))));
  }
  if (s.status === 'posted' && canReview()) {
    const ref = h('input', { placeholder: 'Payment reference (optional)', 'aria-label': 'Payment reference' });
    card.append(h('div', { class: 'row', style: 'margin-top:8px' }, ref, h('button', { class: 'btn sm', onclick: () => guard(async () => { await api('POST', `/submissions/${s.id}/pay`, { reference: ref.value }); toast('Payment released'); await refresh(); }) }, 'Release payment')));
  }
  if (s.entryId && isOwner()) card.append(h('p', { style: 'margin:6px 0 0' }, h('button', { class: 'btn sec sm', onclick: () => openPanel({ type: 'voucher', entryId: s.entryId }) }, 'Open voucher')));
  return card;
}
const journalTable = j => h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Account'), h('th', { class: 'n' }, 'Debit'), h('th', { class: 'n' }, 'Credit'))),
  h('tbody', {}, j.map(l => h('tr', {}, h('td', {}, `${l.code} ${l.name}`), h('td', { class: 'n' }, l.debit ? money(l.debit) : ''), h('td', { class: 'n' }, l.credit ? money(l.credit) : '')))),
  h('tfoot', {}, h('tr', {}, h('th', {}, 'Total'), h('th', { class: 'n' }, money(j.reduce((a, l) => a + l.debit, 0))), h('th', { class: 'n' }, money(j.reduce((a, l) => a + l.credit, 0))))));

async function threadPanel(body, messageId) {
  const thread = await api('GET', `/messages/${messageId}/thread`);
  const root = thread[0];
  const input = h('textarea', { rows: 2, placeholder: 'Reply in thread', 'aria-label': 'Reply' });
  body.replaceChildren(...thread.map(msgNode).map(n => n), h('div', { class: 'box', style: 'margin-top:10px' }, input,
    h('button', { class: 'btn sm', onclick: () => guard(async () => { if (!input.value.trim()) return; await api('POST', `/channels/${root.channelId}/messages`, { text: input.value, parentId: root.id }); input.value = ''; await refresh(); }) }, 'Reply')));
}

async function voucherPanel(body, entryId) {
  const v = await api('GET', `/workspaces/${state.wsId}/ledger/entries/${entryId}/voucher`);
  const e = v.entry;
  body.replaceChildren(
    h('div', { class: 'row wrap' }, h('h3', { class: 'grow' }, `${e.number} · ${e.type}`), pill(v.entryIntact ? 'ok' : 'block', v.entryIntact ? 'intact' : 'ALTERED')),
    h('p', { class: 'muted small' }, e.memo),
    h('dl', { class: 'kv' }, h('dt', {}, 'Date'), h('dd', {}, e.date), h('dt', {}, 'Posted by'), h('dd', {}, `${e.postedBy} · ${when(e.postedAt)}`), h('dt', {}, 'Document'), h('dd', {}, `${e.docCurrency} ${money(e.docTotal)} @ ${e.fxRate}`),
      h('dt', {}, 'Source file'), h('dd', {}, v.sourceFile ? [fileChip(v.sourceFile), h('div', { class: 'mono small' }, 'sha256 ' + e.sourceSha256.slice(0, 24) + '…')] : 'Entered via template form'),
      h('dt', {}, 'Audit record'), h('dd', { class: 'mono small' }, v.auditRecord ? `#${v.auditRecord.seq} ${v.auditRecord.hash.slice(0, 24)}…` : 'missing')),
    h('h3', { style: 'margin-top:12px' }, 'Journal (USD)'), journalTable(e.lines),
    v.submission ? [h('h3', { style: 'margin-top:12px' }, 'Source document as read'), submissionCard({ ...v.submission, status: 'posted' })] : null,
    h('h3', { style: 'margin-top:12px' }, 'Chat transcript behind this entry'), ...v.transcript.map(msgNode));
}

// ---------- modals ----------
function requestModal(ch) {
  const vendors = ch.orgs.filter(o => o.id !== state.ws.owner.id);
  const err = h('p', { class: 'err' });
  const tpl = h('select', { name: 'templateId' }, state.templates.map(t => h('option', { value: t.id }, t.name)));
  const desc = h('p', { class: 'muted small' }); const sync = () => { desc.textContent = (state.templates.find(t => t.id === tpl.value) || {}).description || ''; };
  tpl.onchange = sync; sync();
  const f = h('form', { onsubmit: async e => { e.preventDefault(); err.textContent = ''; const d = Object.fromEntries(new FormData(f)); if (!d.dueDate) delete d.dueDate;
    await guard(async () => { await api('POST', `/channels/${ch.id}/requests`, d); close(); await refresh(); toast('Request sent to the vendor'); }, err); } },
    h('label', {}, 'Document template'), tpl, desc,
    vendors.length > 1 ? [h('label', {}, 'Vendor'), h('select', { name: 'vendorOrgId' }, vendors.map(v => h('option', { value: v.id }, v.name)))] : null,
    h('label', {}, 'Title'), h('input', { name: 'title', required: true, placeholder: 'e.g. September cybersecurity invoice' }),
    h('label', {}, 'Message to the vendor'), h('textarea', { name: 'note', rows: 3 }),
    h('label', {}, 'Due date (optional)'), h('input', { name: 'dueDate', type: 'date' }), err,
    h('p', {}, h('button', { class: 'btn', type: 'submit' }, 'Send request')));
  const close = openModal('Request a document', f);
}

function submitModal(r) {
  const t = state.templates.find(x => x.id === r.template.id);
  const err = h('p', { class: 'err' });
  let mode = 'file', file = null;
  const body = h('div', {});
  const tabs = h('div', { class: 'tabs' });
  const draw = () => {
    tabs.replaceChildren(...[['file', 'Upload a file'], ['form', 'Fill in the template']].map(([k, l]) => h('button', { class: 'tab' + (mode === k ? ' on' : ''), onclick: () => { mode = k; draw(); } }, l)));
    body.replaceChildren(mode === 'file' ? fileTab() : formTab());
  };
  function fileTab() {
    const inp = h('input', { type: 'file', accept: '.pdf,.docx,.txt,.md,.csv,.json,.png,.jpg,.jpeg', onchange: () => { file = inp.files[0]; name.textContent = file ? file.name : ''; } });
    const name = h('p', { class: 'small' }, file ? file.name : '');
    const drop = h('div', { class: 'drop', ondragover: e => { e.preventDefault(); drop.classList.add('over'); }, ondragleave: () => drop.classList.remove('over'), ondrop: e => { e.preventDefault(); drop.classList.remove('over'); file = e.dataTransfer.files[0]; name.textContent = file ? file.name : ''; } },
      h('p', {}, 'Drop a soft copy here, or choose one'), inp,
      h('p', { class: 'small' }, 'Unstructured: PDF, Word, text. Structured: CSV, JSON. Images are stored as evidence, but need an OCR engine to be read.'));
    return [drop, name, h('p', {}, h('button', { class: 'btn', onclick: send }, 'Submit for processing'))];
  }
  const vals = {}, lines = [{ description: '', quantity: 1, unitPrice: '' }];
  function formTab() {
    const box = h('div', {});
    const inputFor = fld => h('div', {}, h('label', {}, fld.label + (fld.required ? ' *' : '')), h('input', { type: fld.type === 'currency' ? 'text' : fld.type, step: fld.type === 'number' ? 'any' : null, maxlength: fld.type === 'currency' ? 3 : null, placeholder: fld.type === 'currency' ? 'NGN, USD, EUR…' : null, value: vals[fld.key] ?? (fld.default ?? ''), oninput: e => { vals[fld.key] = fld.type === 'currency' ? e.target.value.toUpperCase() : e.target.value; } }));
    box.append(h('div', { class: 'grid2' }, t.fields.map(inputFor)));
    if (t.hasLines) {
      const tb = h('tbody', {});
      const drawLines = () => tb.replaceChildren(...lines.map((l, i) => h('tr', {},
        h('td', {}, h('input', { value: l.description, 'aria-label': 'Description', oninput: e => { l.description = e.target.value; } })),
        h('td', { style: 'width:70px' }, h('input', { type: 'number', min: 0, step: 'any', value: l.quantity, 'aria-label': 'Quantity', oninput: e => { l.quantity = e.target.value; } })),
        h('td', { style: 'width:110px' }, h('input', { type: 'number', min: 0, step: 'any', value: l.unitPrice, 'aria-label': 'Unit price', oninput: e => { l.unitPrice = e.target.value; } })),
        h('td', {}, lines.length > 1 ? h('button', { class: 'btn sec sm', 'aria-label': 'Remove line', onclick: () => { lines.splice(i, 1); drawLines(); } }, '✕') : null))));
      drawLines();
      box.append(h('h3', { style: 'margin-top:12px' }, 'Line items'), h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Description'), h('th', {}, 'Qty'), h('th', {}, 'Unit price'), h('th', {}))), tb),
        h('p', {}, h('button', { class: 'btn sec sm', onclick: () => { lines.push({ description: '', quantity: 1, unitPrice: '' }); drawLines(); } }, '＋ Add line')));
    }
    box.append(h('p', {}, h('button', { class: 'btn', onclick: send }, 'Submit for processing')));
    return box;
  }
  async function send() {
    err.textContent = '';
    let payload;
    if (mode === 'file') { if (!file) { err.textContent = 'Choose a file first'; return; } payload = new FormData(); payload.append('file', file); }
    else payload = { form: { fields: { ...vals, ...(t.fields.find(f => f.key === 'vatRate') && vals.vatRate == null ? { vatRate: 7.5 } : {}) }, lines: t.hasLines ? lines.filter(l => l.description.trim()).map(l => ({ description: l.description, quantity: l.quantity, unit_price: l.unitPrice, amount: Number(l.quantity || 1) * Number(l.unitPrice || 0) })) : [] } };
    await guard(async () => { const s = await api('POST', `/requests/${r.id}/submissions`, payload); close(); toast(s.flags.some(f => f.severity === 'block') ? 'Submitted. The buyer will see some flags to check.' : 'Submitted and validated'); await refresh(); }, err);
  }
  draw();
  const close = openModal(`Respond: ${r.title}`, h('div', {}, h('p', { class: 'muted small' }, `Template: ${r.template.name}. Your submission is read and validated immediately; ${state.ws.owner.name} reviews it before it reaches their ledger.`), tabs, body, err));
}

function rejectModal(s) {
  const err = h('p', { class: 'err' });
  const ta = h('textarea', { rows: 3, placeholder: 'What should the vendor fix?' });
  const close = openModal('Send back to vendor', h('div', {}, ta, err, h('p', {}, h('button', { class: 'btn danger', onclick: () => guard(async () => { await api('POST', `/submissions/${s.id}/reject`, { reason: ta.value }); close(); await refresh(); }, err) }, 'Send back'))));
}

function channelModal() {
  const err = h('p', { class: 'err' });
  const name = h('input', { placeholder: 'e.g. procurement', required: true });
  const checks = state.ws.vendors.map(v => h('label', { style: 'font-weight:400' }, h('input', { type: 'checkbox', value: v.id, style: 'width:auto' }), ' ' + v.name));
  const close = openModal('Add a channel', h('div', {}, h('label', {}, 'Name'), name, h('label', {}, 'Vendors in this channel (none = internal)'), checks, err,
    h('p', {}, h('button', { class: 'btn', onclick: () => guard(async () => { const c = await api('POST', `/workspaces/${state.wsId}/channels`, { name: name.value, vendorOrgIds: checks.map(c => c.querySelector('input')).filter(i => i.checked).map(i => i.value) }); close(); state.channelId = c.id; await selectWorkspace(state.wsId); }, err) }, 'Create'))));
}

function workspaceModal() {
  const err = h('p', { class: 'err' });
  const name = h('input', { placeholder: 'e.g. Northwind Finance' }), code = h('input', { placeholder: 'Invite code from the buyer' });
  const done = async w => { close(); const me = await api('GET', '/me'); state.workspaces = me.workspaces; await selectWorkspace(w.id); };
  const close = openModal('Create or join a workspace', h('div', {},
    state.me.role !== 'admin' ? h('p', { class: 'muted' }, 'Only a company admin can create or join workspaces on behalf of the company.') : null,
    h('div', { class: 'box' }, h('h3', {}, 'Create a workspace (you are the buyer)'), h('p', { class: 'muted small' }, 'Your company becomes the end user: you request documents from vendors and release payments.'), name,
      h('p', {}, h('button', { class: 'btn', onclick: () => guard(async () => done(await api('POST', '/workspaces', { name: name.value })), err) }, 'Create workspace'))),
    h('div', { class: 'box' }, h('h3', {}, 'Join as a vendor'), h('p', { class: 'muted small' }, 'Your company joins another company\'s workspace and gets a private payment channel with them.'), code,
      h('p', {}, h('button', { class: 'btn', onclick: () => guard(async () => done(await api('POST', '/workspaces/join', { code: code.value })), err) }, 'Join workspace'))), err));
}

// ---------- full-page views ----------
async function viewPayables(m) {
  const rows = await api('GET', `/workspaces/${state.wsId}/payables`);
  const reqs = await api('GET', `/workspaces/${state.wsId}/requests`);
  const open = reqs.filter(r => r.status === 'open');
  m.replaceChildren(h('div', { class: 'head' }, h('h2', {}, isOwner() ? 'Requests & payables' : 'My requests & payments')),
    h('div', { class: 'view' },
      h('div', { class: 'box' }, h('h3', {}, `Waiting on ${isOwner() ? 'vendors' : 'you'} (${open.length})`),
        open.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Request'), h('th', {}, 'Vendor'), h('th', {}, 'Template'), h('th', {}, 'Due'), h('th', {}))),
          h('tbody', {}, open.map(r => h('tr', {}, h('td', {}, r.title), h('td', {}, r.vendor.name), h('td', {}, r.template.name), h('td', {}, r.dueDate || '—'),
            h('td', {}, state.me.orgId === r.vendor.id ? h('button', { class: 'btn sm', onclick: () => submitModal(r) }, 'Respond') : h('button', { class: 'btn sec sm', onclick: () => guard(() => go('channel', r.channelId)) }, 'Open')))))) : h('p', { class: 'muted' }, 'Nothing is waiting.')),
      h('div', { class: 'box' }, h('h3', {}, 'Submitted documents'),
        rows.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Request'), h('th', {}, 'Vendor'), h('th', {}, 'Doc no.'), h('th', { class: 'n' }, 'Total'), h('th', {}, 'Status'), h('th', {}, 'Flags'))),
          h('tbody', {}, rows.map(s => h('tr', { class: 'click', tabindex: 0, onclick: () => guard(async () => { state.view = 'channel'; state.channelId = s.channelId; await loadMessages(); render(); openPanel({ type: 'thread', messageId: s.messageId }); }) },
            h('td', {}, s.requestTitle), h('td', {}, s.vendor.name), h('td', {}, s.extracted.number || '—'), h('td', { class: 'n' }, s.extracted.total != null ? money(s.extracted.total, s.extracted.currency) : '—'), h('td', {}, pill(s.status)), h('td', {}, s.flags.filter(f => f.severity !== 'info').length || '')))))
          : h('p', { class: 'muted' }, 'No documents submitted yet.'))));
}

async function viewLedger(m) {
  if (!isOwner()) return;
  const [tb, entries] = await Promise.all([api('GET', `/workspaces/${state.wsId}/ledger/trial-balance`), api('GET', `/workspaces/${state.wsId}/ledger/entries`)]);
  const verifyOut = h('span', { class: 'small' });
  m.replaceChildren(h('div', { class: 'head' }, h('h2', {}, 'Ledger & audit'), h('span', { class: 'grow' }), verifyOut,
    h('button', { class: 'btn sec sm', onclick: () => guard(async () => { const v = await api('GET', `/workspaces/${state.wsId}/audit/verify`); verifyOut.textContent = v.ok ? `✔ Audit chain intact (${v.length} records)` : `✖ Tampering detected${v.brokenAt ? ' at record ' + v.brokenAt : ''}${v.tamperedEntries.length ? ' in ' + v.tamperedEntries.join(', ') : ''}`; verifyOut.style.color = v.ok ? 'var(--ok)' : 'var(--bad)'; }) }, 'Verify audit chain'),
    h('a', { class: 'btn sec sm', href: `/api/workspaces/${state.wsId}/ledger/export.csv`, style: 'text-decoration:none' }, 'Export journal CSV')),
    h('div', { class: 'view' },
      h('div', { class: 'box' }, h('h3', {}, 'Live trial balance (USD)'), h('p', { class: 'muted small' }, 'Updates the moment a document is posted or paid. No month-end batch.'),
        tb.rows.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Account'), h('th', { class: 'n' }, 'Debit'), h('th', { class: 'n' }, 'Credit'), h('th', { class: 'n' }, 'Balance'))),
          h('tbody', {}, tb.rows.map(r => h('tr', {}, h('td', {}, `${r.code} ${r.name}`), h('td', { class: 'n' }, money(r.debit)), h('td', { class: 'n' }, money(r.credit)), h('td', { class: 'n' }, money(r.balance))))),
          h('tfoot', {}, h('tr', {}, h('th', {}, tb.balanced ? 'Totals ✔ balanced' : 'Totals ✖ OUT OF BALANCE'), h('th', { class: 'n' }, money(tb.totalDebit)), h('th', { class: 'n' }, money(tb.totalCredit)), h('th', {})))) : h('p', { class: 'muted' }, 'No entries posted yet.')),
      h('div', { class: 'box' }, h('h3', {}, 'Journal entries'),
        entries.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'No.'), h('th', {}, 'Date'), h('th', {}, 'Memo'), h('th', { class: 'n' }, 'USD'))),
          h('tbody', {}, entries.map(e => h('tr', { class: 'click', tabindex: 0, onclick: () => openPanel({ type: 'voucher', entryId: e.id }) }, h('td', {}, e.number), h('td', {}, e.date), h('td', {}, e.memo), h('td', { class: 'n' }, money(e.totalDebit)))))) : h('p', { class: 'muted' }, 'Nothing posted yet.'))));
}

function viewTemplates(m) {
  const canMake = isOwner() && ['admin', 'approver'].includes(state.me.role);
  m.replaceChildren(h('div', { class: 'head' }, h('h2', {}, 'Document templates'), h('span', { class: 'grow' }), canMake ? h('button', { class: 'btn', onclick: templateModal }, 'New template') : null),
    h('div', { class: 'view' }, state.templates.map(t => h('div', { class: 'box' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, t.name), pill(t.posting === 'memo' ? 'info' : 'ok', t.posting === 'memo' ? 'supporting only' : 'posts to ledger'), t.builtIn ? null : pill('info', 'custom')),
      h('p', { class: 'muted' }, t.description), h('p', { class: 'small' }, 'Fields: ' + t.fields.map(f => f.label + (f.required ? '*' : '')).join(', ') + (t.hasLines ? ', line items' : ''))))));
}
function templateModal() {
  const err = h('p', { class: 'err' });
  const base = h('select', {}, state.templates.filter(t => t.builtIn).map(t => h('option', { value: t.id }, t.name)));
  const name = h('input', { placeholder: 'e.g. Invoice with project code' }), fieldsBox = h('div', {}); const extra = [];
  const add = () => { const l = h('input', { placeholder: 'Field label' }), r = h('input', { type: 'checkbox', style: 'width:auto' }); extra.push({ l, r }); fieldsBox.append(h('div', { class: 'row' }, l, h('label', { style: 'font-weight:400;white-space:nowrap;margin:0' }, r, ' required'))); };
  add();
  const close = openModal('New template', h('div', {}, h('label', {}, 'Based on'), base, h('label', {}, 'Name'), name, h('label', {}, 'Extra fields vendors must fill in'), fieldsBox,
    h('p', {}, h('button', { class: 'btn sec sm', onclick: add }, '＋ Add field')), err,
    h('p', {}, h('button', { class: 'btn', onclick: () => guard(async () => { await api('POST', `/workspaces/${state.wsId}/templates`, { name: name.value, baseTemplateId: base.value, extraFields: extra.filter(x => x.l.value.trim()).map(x => ({ label: x.l.value, required: x.r.checked })) }); state.templates = await api('GET', `/workspaces/${state.wsId}/templates`); close(); renderMain(); }, err) }, 'Create'))));
}

function viewSettings(m) {
  const ws = state.ws, admin = state.me.role === 'admin';
  const setting = (key, label, hint) => h('div', { class: 'row', style: 'margin:8px 0' }, h('input', { type: 'checkbox', style: 'width:auto', checked: ws.settings[key], disabled: !admin, id: key, onchange: e => guard(async () => { state.ws = await api('PATCH', `/workspaces/${state.wsId}/settings`, { [key]: e.target.checked }); renderMain(); }) }),
    h('label', { for: key, style: 'margin:0' }, label, h('div', { class: 'muted small', style: 'font-weight:400' }, hint)));
  m.replaceChildren(h('div', { class: 'head' }, h('h2', {}, isOwner() ? 'Settings & people' : 'Company & people')),
    h('div', { class: 'view' },
      isOwner() ? h('div', { class: 'box' }, h('h3', {}, `Workspace: ${ws.name}`),
        admin ? h('p', {}, 'Vendor invite code: ', h('b', { class: 'mono' }, ws.inviteCode), ' ', h('button', { class: 'btn sec sm', onclick: () => guard(async () => { state.ws = await api('POST', `/workspaces/${state.wsId}/invite/rotate`); renderMain(); }) }, 'Generate a new code')) : null,
        h('p', { class: 'muted small' }, 'Vendors: ' + (ws.vendors.map(v => v.name).join(', ') || 'none yet')),
        setting('autoPost', 'Auto-post clean documents', 'Documents with zero blocking flags post to the ledger without waiting for an approver. Flagged ones always wait.'),
        setting('segregationOfDuties', 'Segregation of duties', 'The requester cannot accept their own request; the requester and accepter cannot release the payment.'),
        h('p', { class: 'small muted' }, `Large-amount review threshold: USD ${ws.settings.largeAmountUsd.toLocaleString('en-US')}`)) : null,
      h('div', { class: 'box' }, h('h3', {}, `${state.org.name}: people`),
        admin && state.org.joinCode ? h('p', { class: 'small' }, 'Colleague join code: ', h('b', { class: 'mono' }, state.org.joinCode)) : null,
        h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Email'), h('th', {}, 'Role'))),
          h('tbody', {}, state.members.map(p => h('tr', {}, h('td', {}, p.name), h('td', {}, p.email), h('td', {}, admin ? h('select', { 'aria-label': 'Role for ' + p.name, onchange: e => guard(async () => { state.members = await api('PATCH', `/members/${p.id}`, { role: e.target.value }); toast('Role updated'); }) },
            ['admin', 'approver', 'member'].map(r => h('option', { value: r, selected: r === p.role }, r))) : p.role))))),
        h('p', { class: 'small muted' }, 'Approvers can accept documents and release payments. Members can chat and, on the buyer side, request documents.'))));
}

boot();
