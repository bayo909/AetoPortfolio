// Core helpers: DOM builder (text-safe by construction), API client, router, toasts, modals, formatting, icons.
// Native append() would print "null"/"false" for falsy conditionals; skip them so `cond && node` is safe everywhere.
{ const native = Element.prototype.append; Element.prototype.append = function (...c) { return native.apply(this, c.flat().filter(x => x != null && x !== false)); }; }
export const state = { me: null, config: null, unread: 0, pendingApprovals: 0, channels: [] };

/** h('div', {class:'x', onclick}, 'text', [children]) — strings always become text nodes, so data can never inject markup. */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'readOnly') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = c => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) return c.forEach(add);
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export class ApiError extends Error { constructor(status, message, body) { super(message); this.status = status; this.body = body || {}; } }
export async function api(method, url, body) {
  const isForm = body instanceof FormData;
  const res = await fetch(`/api${url}`, {
    method, credentials: 'same-origin',
    headers: { 'x-pf-csrf': '1', ...(body && !isForm ? { 'content-type': 'application/json' } : {}) },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json = {}; try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text }; }
  if (!res.ok) {
    if (res.status === 401 && !/^\/auth\//.test(url) && state.me) { state.me = null; navigate('#/login'); }
    throw new ApiError(res.status, json.error || `Request failed (${res.status})`, json);
  }
  return json;
}
export const get = u => api('GET', u), post = (u, b) => api('POST', u, b || {}), patch = (u, b) => api('PATCH', u, b), put = (u, b) => api('PUT', u, b), del = u => api('DELETE', u);

/* ---------- formatting ---------- */
const SYMBOL = { NGN: '₦', USD: '$', GBP: '£', GHS: 'GH₵', AUD: 'A$', EUR: '€' };
export const fmt = (minor, ccy = 'NGN') => (minor == null ? '—' : `${minor < 0 ? '-' : ''}${SYMBOL[ccy] || ccy + ' '}${(Math.abs(minor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const major = n => (n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const dt = s => (s ? new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const day = s => (s ? new Date(s.length === 10 ? s + 'T00:00:00' : s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const cap = s => String(s || '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
export const bp = n => `${(n / 100).toFixed(n % 100 ? 2 : 0)}%`;

const OK = ['paid', 'approved', 'issued', 'verified', 'matched', 'active', 'posted', 'succeeded', 'accepted', 'processed', 'billed', 'normal', 'clear', 'reviewed', 'validated', 'standard'];
const WARN = ['pending_approval', 'submitted', 'received', 'open', 'processing', 'pending_kyb', 'awaiting_authorization', 'pending', 'trialing', 'quoted', 'draft', 'in_progress', 'awaiting_payment', 'imported', 'past_due', 'elevated', 'unpaid', 'stored', 'cancelling', 'pending_compliance_validation', 'not_started', 'potential_match'];
const BAD = ['rejected', 'failed', 'disputed', 'quarantined', 'overdue', 'expired', 'posting_failed', 'exception', 'cancelled', 'declined', 'suspended', 'frozen', 'high', 'trial_expired', 'flagged'];
export function badge(status, label) {
  const s = String(status || '');
  const cls = OK.includes(s) ? 'ok' : BAD.includes(s) ? 'bad' : WARN.includes(s) ? 'warn' : s === 'superseded' ? '' : 'info';
  return h('span', { class: `badge ${cls}` }, label || cap(s));
}
export const tag = (text, kind = '') => h('span', { class: `tag ${kind}` }, text);
export const initials = n => String(n || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

/* ---------- toasts & modals ---------- */
export function toast(msg, err = false) {
  let box = $('.toasts'); if (!box) { box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: `toast ${err ? 'err' : ''}` }, msg); box.append(t); setTimeout(() => t.remove(), err ? 7000 : 3800);
}
export function errToast(e) { toast(e.message || String(e), true); if (e.body && e.body.issues && e.body.issues.length) showIssues(e.message, e.body.issues); }
export function showIssues(title, issues) {
  modal(close => h('div', { class: 'stack' }, h('h2', null, title), h('ul', null, issues.map(i => h('li', null, i.msg || String(i)))), h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: close }, 'OK'))));
}
export function modal(build, { wide = false } = {}) {
  const ov = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' });
  const close = () => { ov.remove(); document.removeEventListener('keydown', esc); };
  const esc = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
  ov.append(h('div', { class: `modal ${wide ? 'wide' : ''}` }, build(close)));
  document.body.append(ov);
  const f = ov.querySelector('input,select,textarea,button'); if (f) f.focus();
  return close;
}
/** Small form modal: fields = [{name,label,type,options,required,value,help}] */
export function formModal(title, fields, onSubmit, { submit = 'Save', intro } = {}) {
  return modal(close => {
    const form = h('form', { class: 'stack', onsubmit: async e => {
      e.preventDefault();
      const data = {}; for (const f of fields) { const el = form.elements[f.name]; data[f.name] = f.type === 'checkbox' ? el.checked : el.value; }
      const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
      try { await onSubmit(data); close(); } catch (err) { errToast(err); btn.disabled = false; }
    } },
    h('h2', null, title), intro && h('p', { class: 'muted' }, intro),
    fields.map(f => field(f)),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, submit), h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel')));
    return form;
  });
}
export function field(f) {
  const common = { name: f.name, id: `f_${f.name}`, required: f.required, placeholder: f.placeholder, autocomplete: f.autocomplete || 'off' };
  let input;
  if (f.type === 'select') input = h('select', common, (f.options || []).map(o => h('option', { value: o.value ?? o, selected: String(o.value ?? o) === String(f.value) }, o.label ?? o)));
  else if (f.type === 'textarea') input = h('textarea', { ...common, rows: f.rows || 3 }, f.value || '');
  else if (f.type === 'checkbox') return h('label', { class: 'row' }, h('input', { type: 'checkbox', name: f.name, checked: !!f.value }), f.label);
  else input = h('input', { ...common, type: f.type || 'text', value: f.value ?? '', min: f.min, max: f.max, step: f.step, minlength: f.minlength });
  return h('label', { class: 'f' }, f.label, input, f.help && h('span', { class: 'small muted', style: { fontWeight: 400 } }, f.help));
}
export const confirmBox = (msg, ok = 'Confirm') => new Promise(res => modal(close => h('div', { class: 'stack' }, h('p', null, msg), h('div', { class: 'row' },
  h('button', { class: 'btn primary', onclick: () => { close(); res(true); } }, ok), h('button', { class: 'btn', onclick: () => { close(); res(false); } }, 'Cancel')))));

/* ---------- generic table ---------- */
export function table(cols, rows, { onRow, empty = 'Nothing here yet.' } = {}) {
  if (!rows || !rows.length) return h('div', { class: 'card flat empty' }, empty);
  return h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, cols.map(c => h('th', { class: c.right ? 'right' : '' }, c.label)))),
    h('tbody', null, rows.map(r => h('tr', { class: onRow ? 'click' : '', tabindex: onRow ? 0 : null, onclick: onRow ? () => onRow(r) : null, onkeydown: onRow ? e => { if (e.key === 'Enter') onRow(r); } : null },
      cols.map(c => h('td', { class: `${c.right ? 'right' : ''} ${c.nowrap ? 'nowrap' : ''}` }, c.render ? c.render(r) : r[c.key])))))));
}
export const kv = (pairs) => h('dl', { class: 'kv' }, pairs.filter(p => p && p[1] != null && p[1] !== '').flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
export const stat = (label, n, kind = '', href) => h(href ? 'a' : 'div', { class: `stat ${kind}`, href, style: href ? { color: 'inherit', textDecoration: 'none' } : null }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, label));
export const pageHead = (title, sub, actions) => h('div', { class: 'page-h' }, h('div', null, h('h1', null, title), sub && h('p', null, sub)), actions && h('div', { class: 'row wrap' }, actions));
export const loading = () => h('div', { class: 'empty' }, 'Loading…');
export const can = p => state.me && state.me.permissions.includes(p);

/* ---------- router ---------- */
const routes = [];
export const route = (pattern, handler) => routes.push([new RegExp(`^${pattern.replace(/:[a-z]+/gi, '([^/?]+)')}$`), handler]);
export function navigate(hash) { if (location.hash === hash) renderRoute(); else location.hash = hash; }
export function parseHash() { const raw = location.hash.slice(1) || '/'; const [path, qs] = raw.split('?'); return { path, query: Object.fromEntries(new URLSearchParams(qs || '')) }; }
let rendering = 0;
export async function renderRoute() {
  const root = $('#view') || $('#root');
  const { path, query } = parseHash();
  const ticket = ++rendering;
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (!m) continue;
    try {
      const out = await fn({ params: m.slice(1), query, path });
      if (ticket !== rendering) return;
      clear(root); if (out) root.append(out);
      window.scrollTo(0, 0);
    } catch (e) { if (ticket === rendering) { clear(root); root.append(h('div', { class: 'card' }, h('h2', null, e.status === 403 ? 'Access restricted' : 'Something went wrong'), h('p', null, e.status === 403 ? 'Your role does not include this area. Permissions are enforced on the server.' : e.message))); } }
    return;
  }
  clear(root); root.append(h('div', { class: 'card empty' }, 'Page not found. ', h('a', { href: '#/' }, 'Go home')));
}
export function refresh() { return renderRoute(); }

/* ---------- icons & logo (inline SVG, no external assets) ---------- */
const P = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z', store: 'M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9h16M9 20v-6h6v6', box: 'M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8', inbox: 'M3 13h5l1 3h6l1-3h5M5 5h14l2 8v6H3v-6z', chat: 'M4 5h16v11H9l-5 4z', users: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3 3-5 6-5s6 2 6 5M17 11a2.5 2.5 0 1 0 0-5M21 19c0-2-1.5-3.6-4-4.2',
  bot: 'M12 3v3M5 8h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM8 14h.01M16 14h.01M9 18h6', doc: 'M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6', wallet: 'M4 7h15a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h12M16 14h.01',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', chart: 'M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3', gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-2-4-2 .5-1.5-1L15 4h-4l-.5 2.5L9 7.5 7 7 5 11l2 1v1l-2 1 2 4 2-.5 1.5 1L11 20h4l.5-2.5 1.5-1 2 .5 2-4-2-1z',
  scan: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10', check: 'M5 12l5 5 9-10', list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01', book: 'M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zM5 18a2 2 0 0 1 2-2h12', card: 'M3 6h18v12H3zM3 10h18',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6', link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1', clip: 'M21 12l-8.5 8.5a5 5 0 0 1-7-7L14 5a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7', menu: 'M4 6h16M4 12h16M4 18h16', bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4', globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
};
export const icon = (name) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', P[name] || P.doc); s.append(p); return s; };

/** Logo: a document and a wallet joined by one continuous flow line. */
export function logo(size = 34, light = true) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 48 48'); s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('role', 'img'); s.setAttribute('aria-label', 'PayUno Flow');
  const el = (t, a) => { const e = document.createElementNS(NS, t); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); return e; };
  s.append(el('rect', { width: 48, height: 48, rx: 13, fill: light ? '#14a373' : '#0b3d2e' }),
    el('path', { d: 'M10 12h11l5 5v9a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V14a2 2 0 0 1 2-2z', fill: '#fff', opacity: .95 }), el('path', { d: 'M21 12v5h5', fill: 'none', stroke: '#0b3d2e', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }),
    el('path', { d: 'M12 21h8M12 24.5h5', stroke: '#0b3d2e', 'stroke-width': 1.6, 'stroke-linecap': 'round' }),
    el('rect', { x: 24, y: 26, width: 18, height: 13, rx: 3.5, fill: '#0b3d2e', stroke: '#fff', 'stroke-width': 1.8 }), el('circle', { cx: 37.2, cy: 32.5, r: 1.8, fill: '#7ff0c4' }),
    el('path', { d: 'M20 30c4 0 2.5 5 8 5', fill: 'none', stroke: '#7ff0c4', 'stroke-width': 2.4, 'stroke-linecap': 'round', opacity: 0 }),
    el('path', { d: 'M18 31c2.5 3.5 4 3 6 3', fill: 'none', stroke: '#fff', 'stroke-width': 2, 'stroke-linecap': 'round' }), el('circle', { cx: 18, cy: 31, r: 2, fill: '#7ff0c4' }));
  return s;
}
export const brand = (light = false) => h('span', { class: 'row', style: { gap: '9px' } }, logo(32, !light), h('span', null, 'PayUno ', h('span', { style: { color: light ? '#7ff0c4' : 'var(--forest-600)' } }, 'Flow')));
