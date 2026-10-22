import { h, state, get, post, api, route, navigate, clear, dt, fmt, initials, badge, tag, toast, errToast, formModal, can, pageHead, loading } from '../core.js';
import { refreshBadges } from '../app.js';

const cardLink = c => ({ quote: '#/e/requests', invoice: '#/e/bills', request: '#/e/requests', bill: '#/e/bills' }[c.type]);
function cardView(c) {
  if (!c) return null;
  const label = { quote: 'Quotation', invoice: 'Invoice', request: 'Request', bill: 'Bill', payment: 'Payment' }[c.type] || 'Item';
  return h('div', { class: 'msg-card' }, h('div', { class: 'grow' }, h('div', { style: { fontWeight: 800 } }, `${label} ${c.number || ''}`), c.title && h('div', { class: 'small' }, c.title), c.totalMinor != null && h('div', { class: 'small' }, fmt(c.totalMinor, c.currency || 'NGN'))), c.status && badge(c.status), h('span', { class: 'small muted' }, c.type === 'request' ? '' : ''));
}

export function registerChat() {
  route('/chat', () => chatPage(null));
  route('/chat/:id', ctx => chatPage(ctx.params[0]));
}

async function chatPage(initial) {
  const root = h('div', { class: 'chat no-thread' });
  let channels = await get('/channels'), current = null, thread = null, last = 0;
  const wrapper = h('div', null, pageHead('Collaboration', 'Private channels per vendor relationship and per transaction. Vendors only see channels they were invited to.', [
    can('chat.create_channel') && h('button', { class: 'btn', onclick: () => formModal('New channel', [{ name: 'name', label: 'Channel name', required: true }], async d => { const c = await post('/channels', d); channels = await get('/channels'); open(c.id); }) }, 'New channel')]), root);
  const list = h('div', { class: 'ch-list' }), main = h('div', { class: 'ch-main' }), side = h('div', { class: 'thread' });
  root.append(list, main);
  const groups = () => [['Workspace', channels.filter(c => c.kind === 'general')], ['Vendor relationships', channels.filter(c => c.kind === 'vendor')], ['Transactions', channels.filter(c => c.kind === 'transaction')], ['Direct messages', channels.filter(c => c.kind === 'dm')]];
  const drawList = () => { clear(list); groups().forEach(([t, cs]) => { if (!cs.length) return; list.append(h('h4', null, t)); cs.forEach(c => list.append(h('button', { class: `ch-item ${current && current.id === c.id ? 'on' : ''}`, onclick: () => open(c.id) },
    h('span', null, c.kind === 'transaction' ? '↳' : c.kind === 'dm' ? '@' : '#'), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, c.kind === 'vendor' ? (c.vendorName || c.name) + (c.orgName ? ` · ${c.orgName.split(' ')[0]}` : '') : c.name), c.unread ? h('span', { class: 'u' }, c.unread) : null))); }); };

  async function open(id) {
    current = channels.find(c => c.id === id); thread = null; root.classList.add('no-thread'); side.remove(); root.classList.remove('show-list');
    await render();
  }
  async function render() {
    const id = current && current.id;
    if (!id) { clear(main); main.append(h('div', { class: 'empty' }, channels.length ? 'Select a channel' : 'No channels yet')); return; }
    const data = await get(`/channels/${id}/messages`);
    channels = await get('/channels'); drawList();
    clear(main);
    const ch = data.channel;
    main.append(h('div', { class: 'ch-head' }, h('button', { class: 'btn sm ghost', onclick: () => root.classList.toggle('show-list') }, '☰'), h('h2', { style: { margin: 0 } }, ch.kind === 'transaction' ? `Transaction · ${ch.name}` : `# ${ch.name}`),
      ch.vendorName && h('span', { class: 'chip' }, `Vendor: ${ch.vendorName}`), ch.vendorName && tag('Invitation-only', 'ext'), h('span', { class: 'small muted' }, `${ch.orgName}`)));
    const box = h('div', { class: 'msgs', 'aria-live': 'polite' });
    data.messages.forEach(m => box.append(msgView(m)));
    if (!data.messages.length) box.append(h('div', { class: 'empty' }, 'No messages yet — say hello.'));
    main.append(box);
    const ta = h('textarea', { placeholder: ch.kind === 'vendor' || ch.kind === 'transaction' ? 'Message… use @agent to ask the vendor\'s AI Billing Agent about catalogue prices' : 'Message…', rows: 1, 'aria-label': 'Message', onkeydown: e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } });
    const file = h('input', { type: 'file', style: { display: 'none' }, id: 'att', onchange: () => { attach.textContent = file.files[0] ? `📎 ${file.files[0].name}` : '📎'; } });
    const attach = h('label', { class: 'btn', for: 'att', title: 'Attach a file' }, '📎');
    const send = async () => { const fd = new FormData(); fd.append('body', ta.value); if (file.files[0]) fd.append('file', file.files[0]); if (thread) fd.append('parentId', thread);
      try { await api('POST', `/channels/${id}/messages`, fd); ta.value = ''; file.value = ''; attach.textContent = '📎'; await render(); if (thread) await openThread(thread); } catch (e) { errToast(e); } };
    main.append(h('div', { class: 'composer' }, attach, file, ta, h('button', { class: 'btn primary', onclick: send }, 'Send')));
    box.scrollTop = box.scrollHeight;
  }
  function msgView(m) {
    const cls = m.kind === 'agent' ? 'ai' : m.kind === 'system' || m.kind === 'card' ? 'sys' : m.external ? 'ext' : '';
    return h('div', { class: `msg ${m.kind === 'system' || m.kind === 'card' ? 'sys' : ''}` }, h('div', { class: `avatar ${cls}` }, m.kind === 'agent' ? 'AI' : m.userId ? initials(m.author) : '•'),
      h('div', { class: 'bubble grow' }, h('div', { class: 'meta' }, h('b', null, m.author), ' ', m.authorOrg && h('span', null, `· ${m.authorOrg} `), m.external && tag('External vendor', 'ext'), m.kind === 'agent' && tag('AI · drafts need human approval', 'ai'), ' ', h('span', null, dt(m.createdAt))),
        m.body && h('div', { class: 'body' }, m.body), cardView(m.card),
        m.attachments.length ? h('div', { class: 'row wrap' }, m.attachments.map(a => h('a', { class: 'chip', href: `/api/attachments/${a.id}`, target: '_blank', rel: 'noopener' }, `📎 ${a.filename}`))) : null,
        h('div', { class: 'row wrap', style: { marginTop: '4px' } }, ...m.reactions.map(r => h('button', { class: `react ${r.mine ? 'mine' : ''}`, onclick: async () => { await post(`/messages/${m.id}/react`, { emoji: r.emoji }); render(); } }, `${r.emoji} ${r.count}`)),
          ['👍', '✅'].filter(e => !m.reactions.some(r => r.emoji === e)).map(e => h('button', { class: 'react', 'aria-label': `React ${e}`, style: { opacity: .5 }, onclick: async () => { await post(`/messages/${m.id}/react`, { emoji: e }); render(); } }, e)),
          !m.parentId && h('button', { class: 'btn sm ghost', onclick: () => openThread(m.id) }, m.replies ? `${m.replies} ${m.replies === 1 ? 'reply' : 'replies'}` : 'Reply in thread'))));
  }
  async function openThread(pid) {
    thread = pid; const data = await get(`/channels/${current.id}/messages?parent=${pid}`);
    root.classList.remove('no-thread'); clear(side);
    side.append(h('div', { class: 'ch-head' }, h('b', { class: 'grow' }, 'Thread'), h('button', { class: 'btn sm', onclick: () => { thread = null; root.classList.add('no-thread'); side.remove(); } }, '✕')),
      h('div', { class: 'msgs' }, data.messages.map(msgView)));
    if (!side.isConnected) root.append(side);
  }
  const onMsg = e => { if (current && e.detail.channelId === current.id) render(); else get('/channels').then(c => { channels = c; drawList(); }); };
  document.addEventListener('pf-message', onMsg);
  const cleanup = () => { document.removeEventListener('pf-message', onMsg); window.removeEventListener('hashchange', cleanup); };
  window.addEventListener('hashchange', cleanup);

  const first = (initial && channels.find(c => c.id === initial)) || [...channels].sort((a, b) => b.unread - a.unread)[0];
  if (first) current = first;
  drawList(); await render(); refreshBadges();
  return wrapper;
}
