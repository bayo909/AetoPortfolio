// Collaboration + payments domain logic. Everything is authorised here, never in the UI:
//  * a workspace belongs to its OWNER org (the "end user" who pays); other orgs join it as VENDORS
//  * only owner-org members can request documents; vendors can only answer requests addressed to their org
//  * vendors only see channels their org participates in
const crypto = require('crypto');
const { EventEmitter } = require('events');
const engine = require('../fepe/engine');
const audit = require('../fepe/audit');
const coa = require('../fepe/coa');
const { builtIns } = require('../fepe/templates');
const { r2 } = require('../fepe/fx');
const { createStore } = require('./store');
const { toCsv } = require('../csv');

class HttpError extends Error {
  constructor(status, message, issues) { super(message); this.status = status; this.issues = issues; }
}
const rid = p => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const code = () => crypto.randomBytes(4).toString('hex').toUpperCase();
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'vendor';
const clean = (s, max, what) => {
  const v = String(s == null ? '' : s).trim();
  if (!v) throw new HttpError(400, `${what} is required`);
  if (v.length > max) throw new HttpError(400, `${what} must be at most ${max} characters`);
  return v;
};
const deepFreeze = o => { Object.values(o).forEach(v => v && typeof v === 'object' && !Object.isFrozen(v) && deepFreeze(v)); return Object.freeze(o); };
const ROLES = ['admin', 'approver', 'member'];

function createChatService({ dataDir = null, master = null, rates, now = () => new Date(), ocr = null } = {}) {
  const store = createStore(dataDir);
  const S = store.state;
  const bus = new EventEmitter(); bus.setMaxListeners(0);
  const today = () => now().toISOString().slice(0, 10);
  const stamp = () => now().toISOString();
  const touch = () => store.saveSoon();
  const emit = (ws, ev) => bus.emit(ws.id, { ...ev, at: stamp() });

  // ---------- passwords & sessions ----------
  const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
  const tokenHash = t => crypto.createHash('sha256').update(t).digest('hex');
  const newSession = user => {
    const token = crypto.randomBytes(24).toString('base64url');
    S.sessions[tokenHash(token)] = { userId: user.id, at: stamp() };
    touch();
    return token;
  };

  function register({ email, name, password, orgName, orgJoinCode }) {
    email = clean(email, 120, 'Email').toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
    name = clean(name, 80, 'Name');
    if (String(password || '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    if (Object.values(S.users).some(u => u.email === email)) throw new HttpError(409, 'An account with this email already exists');
    let org, role = 'member';
    if (orgJoinCode) {
      org = Object.values(S.orgs).find(o => o.joinCode === String(orgJoinCode).trim().toUpperCase());
      if (!org) throw new HttpError(404, 'That company join code is not valid');
    } else {
      org = { id: rid('org'), name: clean(orgName, 80, 'Company name'), joinCode: code(), createdAt: stamp() };
      if (Object.values(S.orgs).some(o => o.name.toLowerCase() === org.name.toLowerCase())) throw new HttpError(409, 'A company with this name already exists. Ask its admin for the join code.');
      S.orgs[org.id] = org; role = 'admin';
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const user = { id: rid('usr'), email, name, orgId: org.id, role, salt, pw: hashPw(password, salt), createdAt: stamp() };
    S.users[user.id] = user;
    return { user: publicUser(user), token: newSession(user) };
  }

  function login({ email, password }) {
    const user = Object.values(S.users).find(u => u.email === String(email || '').trim().toLowerCase());
    const given = Buffer.from(hashPw(String(password || ''), user ? user.salt : 'x'.repeat(32)), 'hex');
    const real = Buffer.from(user ? user.pw : '0'.repeat(64), 'hex');
    if (!user || !crypto.timingSafeEqual(given, real)) throw new HttpError(401, 'Incorrect email or password');
    return { user: publicUser(user), token: newSession(user) };
  }
  const logout = token => { delete S.sessions[tokenHash(token || '')]; touch(); };
  const authenticate = token => {
    const s = token && S.sessions[tokenHash(token)];
    return s ? S.users[s.userId] || null : null;
  };

  const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, orgId: u.orgId, orgName: S.orgs[u.orgId].name });
  const authorView = id => { const u = S.users[id]; return u ? { id: u.id, name: u.name, role: u.role, orgId: u.orgId, orgName: S.orgs[u.orgId].name } : null; };

  // ---------- workspace access ----------
  const mustGet = (map, id, what) => { const v = map[id]; if (!v) throw new HttpError(404, `${what} not found`); return v; };
  const sideOf = (ws, user) => (ws.ownerOrgId === user.orgId ? 'owner' : ws.vendorOrgIds.includes(user.orgId) ? 'vendor' : null);
  function access(user, wsId) {
    const ws = mustGet(S.workspaces, wsId, 'Workspace');
    const side = sideOf(ws, user);
    if (!side) throw new HttpError(404, 'Workspace not found');
    return { ws, side };
  }
  const canSee = (ws, side, user, ch) => side === 'owner' || ch.orgIds.includes(user.orgId);
  function channelAccess(user, channelId) {
    const ch = mustGet(S.channels, channelId, 'Channel');
    const { ws, side } = access(user, ch.workspaceId);
    if (!canSee(ws, side, user, ch)) throw new HttpError(404, 'Channel not found');
    return { ch, ws, side };
  }
  const needOwner = (side, msg) => { if (side !== 'owner') throw new HttpError(403, msg); };
  const needRole = (user, roles, msg) => { if (!roles.includes(user.role)) throw new HttpError(403, msg); };

  // ---------- audit & messages ----------
  const chain = ws => (S.audit[ws.id] = S.audit[ws.id] || []);
  const log = (ws, actor, action, subject, data) => audit.append(chain(ws), { at: stamp(), actor: actor ? (actor.id || actor) : 'system', action, subject, data });

  function addMessage(ws, ch, { user = null, kind = 'text', text = '', parentId = null, fileIds = [], ref = null }) {
    const m = { id: rid('msg'), seq: ++S.seq, workspaceId: ws.id, channelId: ch.id, userId: user ? user.id : null, kind, text, parentId, fileIds, ref, createdAt: stamp() };
    S.messages[m.id] = m;
    log(ws, user, 'message.posted', m.id, { channelId: ch.id, kind, textSha256: audit.sha(text), fileIds });
    emit(ws, { type: 'message', channelId: ch.id, messageId: m.id, parentId });
    touch();
    return m;
  }
  const system = (ws, ch, text, extra = {}) => addMessage(ws, ch, { kind: 'system', text, ...extra });

  function messageView(m) {
    const v = { id: m.id, seq: m.seq, channelId: m.channelId, kind: m.kind, text: m.text, parentId: m.parentId, createdAt: m.createdAt, author: m.userId ? authorView(m.userId) : null };
    v.files = m.fileIds.map(id => fileView(S.files[id])).filter(Boolean);
    if (m.ref) {
      if (m.ref.type === 'request') v.request = requestView(S.requests[m.ref.id]);
      if (m.ref.type === 'submission') v.submission = submissionView(S.submissions[m.ref.id]);
      if (m.ref.type === 'payment') v.payment = paymentView(S.payments[m.ref.id]);
    }
    v.replyCount = Object.values(S.messages).filter(x => x.parentId === m.id).length;
    return v;
  }
  // A request thread (request, submission, review notes, payment) is private to the owner org and the vendor it was sent to,
  // even when other vendors share the channel.
  function visible(user, m) {
    const root = m.parentId ? S.messages[m.parentId] : m;
    if (!root || !root.ref || root.ref.type !== 'request') return true;
    const r = S.requests[root.ref.id];
    return r.workspaceId && (S.workspaces[r.workspaceId].ownerOrgId === user.orgId || r.vendorOrgId === user.orgId);
  }
  const fileView = f => f && { id: f.id, name: f.name, size: f.size, mime: f.mime, sha256: f.sha256 };

  // ---------- workspaces & channels ----------
  function createWorkspace(user, { name }) {
    needRole(user, ['admin'], 'Only a company admin can create a workspace');
    const ws = {
      id: rid('ws'), name: clean(name, 80, 'Workspace name'), ownerOrgId: user.orgId, vendorOrgIds: [], inviteCode: code(), createdAt: stamp(),
      settings: { autoPost: false, segregationOfDuties: true, largeAmountUsd: 50000 }, entrySeq: 0,
    };
    S.workspaces[ws.id] = ws;
    for (const t of builtIns()) S.templates[`${ws.id}:${t.id}`] = { ...t, id: `${ws.id}:${t.id}`, workspaceId: ws.id };
    log(ws, user, 'workspace.created', ws.id, { name: ws.name, ownerOrgId: ws.ownerOrgId });
    const ch = newChannel(ws, 'general', [], 'Internal channel for your own team. Vendors cannot see it.');
    system(ws, ch, `Workspace "${ws.name}" created. Share the vendor invite code from Settings so vendors can join.`);
    return workspaceView(user, ws);
  }

  function newChannel(ws, name, vendorOrgIds, topic = '') {
    const ch = { id: rid('ch'), workspaceId: ws.id, name: slug(name), topic, orgIds: [ws.ownerOrgId, ...vendorOrgIds], kind: vendorOrgIds.length ? 'shared' : 'internal', createdAt: stamp() };
    S.channels[ch.id] = ch;
    emit(ws, { type: 'channel', channelId: ch.id });
    touch();
    return ch;
  }

  function joinWorkspace(user, { code: inviteCode }) {
    needRole(user, ['admin'], 'Only your company admin can join a workspace on its behalf');
    const ws = Object.values(S.workspaces).find(w => w.inviteCode === String(inviteCode || '').trim().toUpperCase());
    if (!ws) throw new HttpError(404, 'That invite code is not valid');
    if (ws.ownerOrgId === user.orgId) throw new HttpError(400, 'Your company owns this workspace');
    if (ws.vendorOrgIds.includes(user.orgId)) throw new HttpError(409, 'Your company has already joined this workspace');
    ws.vendorOrgIds.push(user.orgId);
    const org = S.orgs[user.orgId];
    const ch = newChannel(ws, `pay-${slug(org.name)}`, [user.orgId], `Payments and documents between ${S.orgs[ws.ownerOrgId].name} and ${org.name}`);
    log(ws, user, 'vendor.joined', user.orgId, { orgName: org.name, channelId: ch.id });
    system(ws, ch, `${org.name} joined the workspace as a vendor. ${S.orgs[ws.ownerOrgId].name} can request documents here; ${org.name} can reply with files or fill in a template.`);
    return workspaceView(user, ws);
  }

  function workspaceView(user, ws) {
    const side = sideOf(ws, user);
    const v = {
      id: ws.id, name: ws.name, side, owner: { id: ws.ownerOrgId, name: S.orgs[ws.ownerOrgId].name },
      vendors: ws.vendorOrgIds.map(id => ({ id, name: S.orgs[id].name })),
      channels: Object.values(S.channels).filter(c => c.workspaceId === ws.id && canSee(ws, side, user, c))
        .map(c => ({ id: c.id, name: c.name, topic: c.topic, kind: c.kind, orgs: c.orgIds.map(id => ({ id, name: S.orgs[id].name })) })),
    };
    if (side === 'owner') { v.settings = ws.settings; if (user.role === 'admin') v.inviteCode = ws.inviteCode; }
    return v;
  }
  const listWorkspaces = user => Object.values(S.workspaces).filter(w => sideOf(w, user)).map(w => ({ id: w.id, name: w.name, side: sideOf(w, user), owner: S.orgs[w.ownerOrgId].name }));
  const getWorkspace = (user, id) => workspaceView(user, access(user, id).ws);

  function updateSettings(user, wsId, patch) {
    const { ws, side } = access(user, wsId);
    needOwner(side, 'Only the workspace owner can change settings'); needRole(user, ['admin'], 'Only an admin can change settings');
    const s = ws.settings;
    if (typeof patch.autoPost === 'boolean') s.autoPost = patch.autoPost;
    if (typeof patch.segregationOfDuties === 'boolean') s.segregationOfDuties = patch.segregationOfDuties;
    if (patch.largeAmountUsd != null) { const n = Number(patch.largeAmountUsd); if (!(n > 0)) throw new HttpError(400, 'Threshold must be a positive number'); s.largeAmountUsd = n; }
    log(ws, user, 'settings.updated', ws.id, { ...s });
    touch();
    return workspaceView(user, ws);
  }
  function rotateInvite(user, wsId) {
    const { ws, side } = access(user, wsId);
    needOwner(side, 'Only the workspace owner can do this'); needRole(user, ['admin'], 'Only an admin can do this');
    ws.inviteCode = code(); log(ws, user, 'invite.rotated', ws.id, {}); touch();
    return workspaceView(user, ws);
  }

  function createChannel(user, wsId, { name, vendorOrgIds = [], topic = '' }) {
    const { ws, side } = access(user, wsId);
    needOwner(side, 'Only the workspace owner can create channels');
    name = slug(clean(name, 40, 'Channel name'));
    if (Object.values(S.channels).some(c => c.workspaceId === ws.id && c.name === name)) throw new HttpError(409, 'A channel with this name already exists');
    for (const id of vendorOrgIds) if (!ws.vendorOrgIds.includes(id)) throw new HttpError(400, 'Only vendors that joined this workspace can be added');
    const ch = newChannel(ws, name, vendorOrgIds, String(topic).slice(0, 200));
    log(ws, user, 'channel.created', ch.id, { name, vendorOrgIds });
    return workspaceView(user, ws).channels.find(c => c.id === ch.id);
  }

  // ---------- chat ----------
  function listMessages(user, channelId, { limit = 100 } = {}) {
    const { ch } = channelAccess(user, channelId);
    return Object.values(S.messages).filter(m => m.channelId === ch.id && !m.parentId).filter(m => visible(user, m)).sort((a, b) => a.seq - b.seq).slice(-Math.min(Number(limit) || 100, 300)).map(messageView);
  }
  function listThread(user, messageId) {
    const root = mustGet(S.messages, messageId, 'Message');
    channelAccess(user, root.channelId);
    if (!visible(user, root)) throw new HttpError(404, 'Message not found');
    return [messageView(root), ...Object.values(S.messages).filter(m => m.parentId === root.id).sort((a, b) => a.seq - b.seq).map(messageView)];
  }
  function postMessage(user, channelId, { text = '', parentId = null, fileIds = [] }) {
    const { ch, ws } = channelAccess(user, channelId);
    text = String(text).trim();
    if (text.length > 4000) throw new HttpError(400, 'Message is too long (4000 characters max)');
    if (!text && !fileIds.length) throw new HttpError(400, 'Write a message or attach a file');
    for (const id of fileIds) { const f = S.files[id]; if (!f || f.channelId !== ch.id || f.messageId) throw new HttpError(400, 'Attachment is not available'); }
    if (parentId) { const p = mustGet(S.messages, parentId, 'Thread'); if (p.channelId !== ch.id || p.parentId) throw new HttpError(400, 'Cannot reply there'); }
    const m = addMessage(ws, ch, { user, text, parentId, fileIds });
    fileIds.forEach(id => { S.files[id].messageId = m.id; });
    return messageView(m);
  }

  function storeFile(user, channelId, { name, mime, buffer }) {
    const { ch, ws } = channelAccess(user, channelId);
    return saveFile(ws, ch, user, { name, mime, buffer });
  }
  function saveFile(ws, ch, user, { name, mime, buffer }) {
    if (!buffer || !buffer.length) throw new HttpError(400, 'The file is empty');
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    store.putBlob(sha256, buffer);
    const f = { id: rid('file'), workspaceId: ws.id, channelId: ch.id, name: String(name || 'file').replace(/[\\/\0]/g, '_').slice(0, 160), mime: String(mime || 'application/octet-stream').slice(0, 100), size: buffer.length, sha256, uploadedBy: user.id, createdAt: stamp(), messageId: null };
    S.files[f.id] = f;
    touch();
    return fileView(f);
  }
  function readFile(user, fileId) {
    const f = mustGet(S.files, fileId, 'File');
    channelAccess(user, f.channelId);
    if (f.messageId && !visible(user, S.messages[f.messageId])) throw new HttpError(404, 'File not found');
    return { meta: f, buffer: store.getBlob(f.sha256) };
  }

  // ---------- templates ----------
  const templatesOf = ws => Object.values(S.templates).filter(t => t.workspaceId === ws.id);
  function listTemplates(user, wsId) {
    const { ws } = access(user, wsId);
    return templatesOf(ws).map(t => ({ id: t.id, name: t.name, description: t.description, posting: t.posting, hasLines: t.hasLines, fields: t.fields, builtIn: !!t.builtIn }));
  }
  function createTemplate(user, wsId, { name, baseTemplateId, extraFields = [], description = '' }) {
    const { ws, side } = access(user, wsId);
    needOwner(side, 'Only the workspace owner can create templates'); needRole(user, ['admin', 'approver'], 'Only admins and approvers can create templates');
    const base = mustGet(S.templates, baseTemplateId, 'Base template');
    if (base.workspaceId !== ws.id) throw new HttpError(404, 'Base template not found');
    if (!Array.isArray(extraFields) || extraFields.length > 20) throw new HttpError(400, 'Add at most 20 extra fields');
    const fields = extraFields.map(f => {
      const key = slug(clean(f.label, 40, 'Field label')).replace(/-/g, '_');
      if (base.fields.some(b => b.key === key)) throw new HttpError(400, `Field "${f.label}" already exists in the base template`);
      return { key, label: String(f.label).trim(), type: ['text', 'number', 'date'].includes(f.type) ? f.type : 'text', required: !!f.required, custom: true };
    });
    const t = { ...base, id: `${ws.id}:tpl-${rid('c')}`, name: clean(name, 60, 'Template name'), description: String(description).slice(0, 300) || `Custom template based on ${base.name}`, builtIn: false, workspaceId: ws.id, baseTemplateId: base.id, fields: [...base.fields, ...fields] };
    S.templates[t.id] = t;
    log(ws, user, 'template.created', t.id, { name: t.name, base: base.name });
    touch();
    return listTemplates(user, wsId).find(x => x.id === t.id);
  }

  // ---------- document requests (end user only) ----------
  const requestView = r => {
    if (!r) return null;
    const t = S.templates[r.templateId];
    const subs = Object.values(S.submissions).filter(s => s.requestId === r.id).sort((a, b) => a.seq - b.seq);
    return { id: r.id, channelId: r.channelId, messageId: r.messageId, title: r.title, note: r.note, dueDate: r.dueDate, status: r.status, template: { id: t.id, name: t.name, posting: t.posting }, vendor: { id: r.vendorOrgId, name: S.orgs[r.vendorOrgId].name }, requestedBy: authorView(r.requestedBy), createdAt: r.createdAt, latestSubmissionId: subs.length ? subs[subs.length - 1].id : null, submissionCount: subs.length,
      latest: subs.length ? (x => ({ id: x.id, status: x.status, number: x.extracted.number, total: x.extracted.total, currency: x.extracted.currency, blockers: x.flags.filter(f => f.severity === 'block').length, warnings: x.flags.filter(f => f.severity === 'warn').length }))(subs[subs.length - 1]) : null };
  };

  function createRequest(user, channelId, { templateId, title, note = '', dueDate = null, vendorOrgId = null }) {
    const { ch, ws, side } = channelAccess(user, channelId);
    needOwner(side, 'Only the end user (workspace owner) can request documents from a vendor');
    const t = mustGet(S.templates, templateId, 'Template');
    if (t.workspaceId !== ws.id) throw new HttpError(404, 'Template not found');
    const vendors = ch.orgIds.filter(id => id !== ws.ownerOrgId);
    if (!vendors.length) throw new HttpError(400, 'This channel has no vendor to request a document from');
    if (vendorOrgId == null) { if (vendors.length > 1) throw new HttpError(400, 'Choose which vendor to ask'); vendorOrgId = vendors[0]; }
    if (!vendors.includes(vendorOrgId)) throw new HttpError(400, 'That vendor is not in this channel');
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new HttpError(400, 'Due date must look like 2026-12-31');
    const r = { id: rid('req'), workspaceId: ws.id, channelId: ch.id, templateId: t.id, vendorOrgId, requestedBy: user.id, title: clean(title || t.name, 120, 'Title'), note: String(note).slice(0, 1000), dueDate: dueDate || null, status: 'open', createdAt: stamp(), messageId: null };
    S.requests[r.id] = r;
    const m = addMessage(ws, ch, { user, kind: 'request', text: r.note, ref: { type: 'request', id: r.id } });
    r.messageId = m.id;
    log(ws, user, 'request.created', r.id, { template: t.name, vendorOrgId, dueDate: r.dueDate });
    return requestView(r);
  }

  function cancelRequest(user, requestId) {
    const r = mustGet(S.requests, requestId, 'Request');
    const { ch, ws, side } = channelAccess(user, r.channelId);
    needOwner(side, 'Only the end user can cancel a request');
    if (r.status !== 'open') throw new HttpError(409, 'Only open requests can be cancelled');
    r.status = 'cancelled'; log(ws, user, 'request.cancelled', r.id, {});
    system(ws, ch, `${user.name} cancelled the request "${r.title}".`, { parentId: r.messageId });
    emit(ws, { type: 'update', channelId: ch.id }); touch();
    return requestView(r);
  }

  // ---------- submissions ----------
  const submissionView = s => {
    if (!s) return null;
    const r = S.requests[s.requestId], u = S.users[s.submittedBy];
    return {
      id: s.id, requestId: s.requestId, version: s.version, status: s.status, method: s.method, confidence: s.confidence,
      fileName: s.fileName, fileId: s.fileId, sha256: s.sha256, extracted: s.extracted, journal: s.journal, base: s.base, event: s.event, flags: s.flags,
      submittedBy: u && authorView(u.id), submittedAt: s.createdAt, acceptedBy: s.acceptedBy && authorView(s.acceptedBy), autoPosted: !!s.autoPosted,
      overrideReason: s.overrideReason || null, rejectionReason: s.rejectionReason || null, entryId: s.entryId || null, paymentId: s.paymentId || null,
      template: { id: r.templateId, name: S.templates[r.templateId].name, posting: S.templates[r.templateId].posting }, vendor: { id: s.vendorOrgId, name: S.orgs[s.vendorOrgId].name },
    };
  };

  async function submit(user, requestId, { file = null, form = null }) {
    const r = mustGet(S.requests, requestId, 'Request');
    const { ch, ws, side } = channelAccess(user, r.channelId);
    if (side !== 'vendor' || user.orgId !== r.vendorOrgId) throw new HttpError(403, 'Only the vendor this request was sent to can respond to it');
    if (!['open', 'submitted'].includes(r.status) || Object.values(S.submissions).some(s => s.requestId === r.id && ['ready', 'flagged', 'posted', 'accepted', 'paid'].includes(s.status))) throw new HttpError(409, 'This request already has a submission under review or processed');
    if (!file && !form) throw new HttpError(400, 'Upload a file or fill in the template form');
    const t = S.templates[r.templateId];
    const history = Object.values(S.submissions).filter(s => s.vendorOrgId === r.vendorOrgId && s.workspaceId === ws.id && s.status !== 'rejected' && s.status !== 'needs_data')
      .map(s => ({ number: s.extracted.number, totalBase: s.base && s.base.total, date: s.extracted.date, sha256: s.sha256 }));
    const input = file ? { kind: 'file', name: file.name, buffer: file.buffer } : { kind: 'form', form };
    let res;
    try {
      res = await engine.process({ template: t, input, today: today(), rates, history, ocr, master, vendorOrgName: S.orgs[r.vendorOrgId].name, largeAmountUsd: ws.settings.largeAmountUsd });
    } catch (e) {
      if (e.status) throw new HttpError(e.status, e.message);
      throw e;
    }
    let fileMeta = null;
    if (file) fileMeta = saveFile(ws, ch, user, { name: file.name, mime: file.mime, buffer: file.buffer });
    const s = {
      id: rid('sub'), seq: ++S.seq, workspaceId: ws.id, requestId: r.id, vendorOrgId: r.vendorOrgId, submittedBy: user.id, createdAt: stamp(),
      version: Object.values(S.submissions).filter(x => x.requestId === r.id).length + 1, method: res.method, confidence: res.confidence,
      fileId: fileMeta && fileMeta.id, fileName: fileMeta ? fileMeta.name : null, sha256: res.sha256, extracted: res.extracted, journal: res.journal, base: res.base, event: res.event, flags: res.flags,
      status: res.method === 'image-no-ocr' ? 'needs_data' : engine.blocking(res.flags).length ? 'flagged' : 'ready',
    };
    S.submissions[s.id] = s;
    r.status = 'submitted';
    const parent = r.messageId;
    const m = addMessage(ws, ch, { user, kind: 'submission', text: '', parentId: parent, fileIds: fileMeta ? [fileMeta.id] : [], ref: { type: 'submission', id: s.id } });
    if (fileMeta) S.files[fileMeta.id].messageId = m.id;
    s.messageId = m.id;
    log(ws, user, 'document.submitted', s.id, { requestId: r.id, method: s.method, sha256: s.sha256, flags: s.flags.map(f => f.code), total: s.extracted.total, currency: s.extracted.currency });
    emit(ws, { type: 'update', channelId: ch.id });
    if (s.status === 'ready' && ws.settings.autoPost && t.posting !== 'memo') postEntry(ws, ch, s, r, t, null, 'RT-FEPE auto-post');
    touch();
    return submissionView(s);
  }

  function ownerReviewer(user, s) {
    const r = S.requests[s.requestId];
    const { ch, ws, side } = channelAccess(user, r.channelId);
    needOwner(side, 'Only the end user can review documents'); needRole(user, ['admin', 'approver'], 'Only admins and approvers can review documents');
    return { r, ch, ws, t: S.templates[r.templateId] };
  }

  const OVERRIDABLE = new Set(['duplicate_invoice', 'possible_duplicate', 'total_mismatch', 'unauthorized_mapping', 'wht_exceeds']);

  function accept(user, subId, { lineAccounts = {}, overrideReason = '', note = '' } = {}) {
    const s = mustGet(S.submissions, subId, 'Submission');
    const { r, ch, ws, t } = ownerReviewer(user, s);
    if (!['ready', 'flagged'].includes(s.status)) throw new HttpError(409, `This document is ${s.status} and cannot be accepted`);
    if (ws.settings.segregationOfDuties && r.requestedBy === user.id) throw new HttpError(403, 'Segregation of duties: the person who requested the document cannot also accept it');
    if (t.posting !== 'memo') {
      if (!s.journal && Object.keys(lineAccounts).length === 0) throw new HttpError(409, 'The engine could not draft a journal for this document. Ask the vendor to resubmit a corrected one.');
      if (Object.keys(lineAccounts).length) {
        const lines = JSON.parse(JSON.stringify(s.extracted.lines));
        for (const [i, c] of Object.entries(lineAccounts)) {
          if (!lines[i]) throw new HttpError(400, `There is no line ${Number(i) + 1}`);
          lines[i].account = Number(c);
        }
        const ex = { ...s.extracted, lines };
        const rebuilt = engine.rebuildJournal(ex, t, s.base.rate);
        const bad = rebuilt.flags.find(f => f.code === 'unauthorized_mapping');
        if (bad) throw new HttpError(400, bad.message);
        s.extracted = ex; s.journal = rebuilt.journal;
        s.flags = s.flags.filter(f => f.code !== 'unauthorized_mapping' && f.code !== 'low_confidence_classification');
        log(ws, user, 'document.reclassified', s.id, { lineAccounts });
      }
      const hard = s.flags.filter(f => f.severity === 'block' && !OVERRIDABLE.has(f.code));
      if (hard.length) throw new HttpError(409, `This document cannot be accepted: ${hard[0].message}`);
    }
    const blockers = s.flags.filter(f => f.severity === 'block');
    if (blockers.length) {
      overrideReason = String(overrideReason).trim();
      if (overrideReason.length < 8) throw new HttpError(400, `Flagged: ${blockers.map(f => f.message).join(' ')} Give a reason (8+ characters) to override.`);
      s.overrideReason = overrideReason;
    }
    s.acceptedBy = user.id;
    const review = system(ws, ch, `${user.name} accepted this document${blockers.length ? ` with an override: "${s.overrideReason}"` : ''}${note ? `. Note: ${String(note).slice(0, 300)}` : ''}.`, { parentId: r.messageId });
    s.reviewMessageId = review.id;
    if (t.posting === 'memo') {
      s.status = 'accepted'; r.status = 'accepted';
      log(ws, user, 'document.accepted', s.id, { override: s.overrideReason || null, sha256: s.sha256 });
    } else postEntry(ws, ch, s, r, t, user, user.name);
    emit(ws, { type: 'update', channelId: ch.id }); touch();
    return submissionView(s);
  }

  function postEntry(ws, ch, s, r, t, user, who) {
    const ex = s.extracted;
    const lines = s.journal.map(l => ({ code: l.code, name: l.name, memo: l.memo, debit: l.debit, credit: l.credit }));
    const dr = r2(lines.reduce((a, l) => a + l.debit, 0)), cr = r2(lines.reduce((a, l) => a + l.credit, 0));
    if (dr !== cr || dr <= 0) throw new HttpError(500, 'Refusing to post an unbalanced entry');
    const doc = ex.date && ex.date <= today() ? ex.date : today();
    const e = {
      id: rid('je'), workspaceId: ws.id, number: `JE-${String(++ws.entrySeq).padStart(5, '0')}`, type: 'accrual', date: doc, postedAt: stamp(), postedBy: who,
      submissionId: s.id, requestId: r.id, vendorOrgId: s.vendorOrgId, memo: `${t.name} ${ex.number || ''} from ${S.orgs[s.vendorOrgId].name}`.trim(),
      docCurrency: ex.currency, fxRate: s.base.rate, docTotal: ex.total, lines, totalDebit: dr, totalCredit: cr, sourceFileId: s.fileId, sourceSha256: s.sha256,
      trail: { requestMessageId: r.messageId, submissionMessageId: s.messageId, reviewMessageId: s.reviewMessageId || null },
    };
    s.autoPosted = !user;
    const rec = log(ws, user || 'rt-fepe', 'entry.posted', e.id, { number: e.number, submissionId: s.id, entrySha256: audit.sha(audit.canonical(e)), totalBase: dr, auto: !user });
    e.auditSeq = rec.seq;
    S.entries[e.id] = deepFreeze(e);
    s.entryId = e.id; s.status = 'posted'; r.status = 'accepted';
    const note = system(ws, ch, `Posted ${e.number}: Dr ${dr.toFixed(2)} = Cr ${cr.toFixed(2)} USD (${ex.currency} ${Number(ex.total).toLocaleString('en-US')} @ ${s.base.rate}). ${user ? '' : 'Auto-posted by RT-FEPE because no validation flags were raised. '}Open the voucher to see the full trail.`, { parentId: r.messageId });
    if (!s.reviewMessageId) { s.reviewMessageId = note.id; }
    return e;
  }

  function reject(user, subId, { reason }) {
    const s = mustGet(S.submissions, subId, 'Submission');
    const { r, ch, ws } = ownerReviewer(user, s);
    if (!['ready', 'flagged', 'needs_data'].includes(s.status)) throw new HttpError(409, `This document is ${s.status} and cannot be rejected`);
    reason = clean(reason, 500, 'A reason');
    s.status = 'rejected'; s.rejectionReason = reason; r.status = 'open';
    log(ws, user, 'document.rejected', s.id, { reason });
    system(ws, ch, `${user.name} sent this back to ${S.orgs[s.vendorOrgId].name}: ${reason}`, { parentId: r.messageId });
    emit(ws, { type: 'update', channelId: ch.id }); touch();
    return submissionView(s);
  }

  // ---------- payments ----------
  const paymentView = p => p && { id: p.id, submissionId: p.submissionId, entryId: p.entryId, entryNumber: S.entries[p.entryId].number, amountBase: p.amountBase, amountDoc: p.amountDoc, currency: p.currency, reference: p.reference, rail: p.rail, status: p.status, paidBy: authorView(p.paidBy), paidAt: p.paidAt };

  function pay(user, subId, { reference = '' } = {}) {
    const s = mustGet(S.submissions, subId, 'Submission');
    const { r, ch, ws, t } = ownerReviewer(user, s);
    if (s.status !== 'posted' || !s.entryId) throw new HttpError(409, s.status === 'paid' ? 'This document has already been paid' : 'Only accepted and posted documents can be paid');
    if (ws.settings.segregationOfDuties && [s.acceptedBy, r.requestedBy].includes(user.id)) throw new HttpError(403, 'Segregation of duties: the person who requested or accepted this document cannot also release payment');
    const e = S.entries[s.entryId];
    const liab = e.lines.find(l => l.code === (t.posting === 'payable' ? coa.AP : coa.EMPLOYEE_PAYABLE));
    const ex = s.extracted;
    const amountDoc = r2((ex.lines.reduce((a, l) => a + l.amount, 0) + (ex.vat || 0)) - (t.posting === 'payable' ? ex.wht || 0 : 0));
    const pe = {
      id: rid('je'), workspaceId: ws.id, number: `JE-${String(++ws.entrySeq).padStart(5, '0')}`, type: 'payment', date: today(), postedAt: stamp(), postedBy: user.name,
      submissionId: s.id, requestId: r.id, vendorOrgId: s.vendorOrgId, memo: `Payment of ${t.name} ${ex.number || ''} to ${S.orgs[s.vendorOrgId].name}`.trim(), docCurrency: ex.currency, fxRate: s.base.rate, docTotal: amountDoc,
      lines: [{ code: liab.code, name: liab.name, memo: 'Settle payable', debit: liab.credit, credit: 0 }, { code: coa.BANK, name: coa.account(coa.BANK).name, memo: 'Cash paid', debit: 0, credit: liab.credit }],
      totalDebit: liab.credit, totalCredit: liab.credit, sourceFileId: s.fileId, sourceSha256: s.sha256, trail: { requestMessageId: r.messageId, submissionMessageId: s.messageId, reviewMessageId: s.reviewMessageId },
    };
    const p = { id: rid('pay'), workspaceId: ws.id, submissionId: s.id, entryId: pe.id, amountBase: liab.credit, amountDoc, currency: ex.currency, reference: String(reference).slice(0, 80) || `PAY-${pe.number}`, rail: 'simulated', status: 'settled', paidBy: user.id, paidAt: stamp() };
    const rec = log(ws, user, 'payment.made', p.id, { entryId: pe.id, entrySha256: audit.sha(audit.canonical(pe)), amountBase: p.amountBase, submissionId: s.id, rail: p.rail });
    pe.auditSeq = rec.seq;
    S.entries[pe.id] = deepFreeze(pe); S.payments[p.id] = p;
    s.status = 'paid'; s.paymentId = p.id; r.status = 'paid';
    addMessage(ws, ch, { user, kind: 'payment', text: '', parentId: r.messageId, ref: { type: 'payment', id: p.id } });
    emit(ws, { type: 'update', channelId: ch.id }); touch();
    return paymentView(p);
  }

  // ---------- ledger & reporting (owner side only) ----------
  function ownerWs(user, wsId) {
    const { ws, side } = access(user, wsId);
    needOwner(side, 'The ledger belongs to the workspace owner');
    return ws;
  }
  const entriesOf = ws => Object.values(S.entries).filter(e => e.workspaceId === ws.id).sort((a, b) => a.number.localeCompare(b.number));
  function trialBalance(user, wsId) {
    const ws = ownerWs(user, wsId);
    const by = new Map();
    for (const e of entriesOf(ws)) for (const l of e.lines) {
      const row = by.get(l.code) || { code: l.code, name: l.name, debit: 0, credit: 0 };
      row.debit = r2(row.debit + l.debit); row.credit = r2(row.credit + l.credit); by.set(l.code, row);
    }
    const rows = [...by.values()].sort((a, b) => a.code - b.code).map(r => ({ ...r, balance: r2(r.debit - r.credit) }));
    const debit = r2(rows.reduce((a, r) => a + r.debit, 0)), credit = r2(rows.reduce((a, r) => a + r.credit, 0));
    return { currency: 'USD', rows, totalDebit: debit, totalCredit: credit, balanced: debit === credit, entryCount: entriesOf(ws).length, asOf: stamp() };
  }
  const entryView = e => ({ ...e, vendor: S.orgs[e.vendorOrgId].name });
  const listEntries = (user, wsId) => entriesOf(ownerWs(user, wsId)).map(entryView).reverse();

  function voucher(user, wsId, entryId) {
    const ws = ownerWs(user, wsId);
    const e = S.entries[entryId];
    if (!e || e.workspaceId !== ws.id) throw new HttpError(404, 'Entry not found');
    const s = S.submissions[e.submissionId], r = S.requests[e.requestId];
    const transcript = Object.values(S.messages).filter(m => m.id === r.messageId || m.parentId === r.messageId).sort((a, b) => a.seq - b.seq).map(messageView);
    const rec = chain(ws).find(a => a.seq === e.auditSeq);
    const intact = !!rec && rec.data.entrySha256 === audit.sha(audit.canonical((({ auditSeq, ...rest }) => rest)(e)));
    return { entry: entryView(e), submission: submissionView(s), request: requestView(r), transcript, auditRecord: rec || null, entryIntact: intact, sourceFile: s.fileId ? fileView(S.files[s.fileId]) : null };
  }

  function auditLog(user, wsId, { limit = 200 } = {}) {
    const ws = ownerWs(user, wsId);
    return chain(ws).slice(-Math.min(Number(limit) || 200, 1000)).reverse();
  }
  function auditVerify(user, wsId) {
    const ws = ownerWs(user, wsId);
    const res = audit.verify(chain(ws));
    const tampered = entriesOf(ws).filter(e => { const rec = chain(ws).find(a => a.seq === e.auditSeq); return !rec || rec.data.entrySha256 !== audit.sha(audit.canonical((({ auditSeq, ...rest }) => rest)(e))); }).map(e => e.number);
    return { ...res, ok: res.ok && !tampered.length, tamperedEntries: tampered };
  }

  function payables(user, wsId) {
    const { ws, side } = access(user, wsId);
    const rows = Object.values(S.submissions).filter(s => s.workspaceId === ws.id && (side === 'owner' || s.vendorOrgId === user.orgId)).sort((a, b) => b.seq - a.seq)
      .map(s => ({ ...submissionView(s), requestTitle: S.requests[s.requestId].title, channelId: S.requests[s.requestId].channelId, messageId: S.requests[s.requestId].messageId }));
    return rows;
  }
  function openRequests(user, wsId) {
    const { ws, side } = access(user, wsId);
    return Object.values(S.requests).filter(r => r.workspaceId === ws.id && (side === 'owner' || r.vendorOrgId === user.orgId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(requestView);
  }
  function payablesCsv(user, wsId) {
    const ws = ownerWs(user, wsId);
    const rows = [['Entry', 'Type', 'Date', 'Vendor', 'Memo', 'Account', 'Account name', 'Debit USD', 'Credit USD', 'Doc currency', 'FX rate', 'Source SHA-256']];
    for (const e of entriesOf(ws)) for (const l of e.lines) rows.push([e.number, e.type, e.date, S.orgs[e.vendorOrgId].name, e.memo, l.code, l.name, l.debit.toFixed(2), l.credit.toFixed(2), e.docCurrency, e.fxRate, e.sourceSha256 || '']);
    return toCsv(rows);
  }

  function members(user) {
    return Object.values(S.users).filter(u => u.orgId === user.orgId).map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role }));
  }
  function setRole(user, userId, role) {
    needRole(user, ['admin'], 'Only a company admin can change roles');
    if (!ROLES.includes(role)) throw new HttpError(400, 'Role must be admin, approver or member');
    const target = S.users[userId];
    if (!target || target.orgId !== user.orgId) throw new HttpError(404, 'Member not found');
    if (target.role === 'admin' && role !== 'admin' && Object.values(S.users).filter(u => u.orgId === user.orgId && u.role === 'admin').length < 2) throw new HttpError(400, 'A company needs at least one admin');
    target.role = role; touch();
    return members(user);
  }
  const orgInfo = user => { const o = S.orgs[user.orgId]; return { id: o.id, name: o.name, joinCode: user.role === 'admin' ? o.joinCode : undefined }; };

  return {
    HttpError, bus, store, state: S, register, login, logout, authenticate, publicUser, orgInfo, members, setRole,
    createWorkspace, joinWorkspace, listWorkspaces, getWorkspace, updateSettings, rotateInvite, createChannel,
    listMessages, listThread, postMessage, storeFile, readFile, listTemplates, createTemplate,
    createRequest, cancelRequest, submit, accept, reject, pay, openRequests, payables, payablesCsv,
    trialBalance, listEntries, voucher, auditLog, auditVerify, access,
    submission: (user, id) => { const s = mustGet(S.submissions, id, 'Submission'); channelAccess(user, S.requests[s.requestId].channelId); if (!visible(user, S.messages[s.messageId])) throw new HttpError(404, 'Submission not found'); return submissionView(s); },
    flush: () => store.flush(),
  };
}

module.exports = { createChatService, HttpError };
