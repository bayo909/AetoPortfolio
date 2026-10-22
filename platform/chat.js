// Slack-style B2B collaboration: channels, membership (internal + invited external vendors), threads, mentions, cards.
// A user can only ever read a channel they are an explicit member of; membership is derived from relationships, never from guesses.
const { uid, iso } = require('./db');
const { bad, forbidden, notFound } = require('./errors');
const { sha256 } = require('./security');

const CUSTOMER_VENDOR_ROLES = ['org_admin', 'procurement_officer', 'finance_officer', 'finance_approver'];
const ALLOWED_MIME = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain|text\/csv|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet))$/;
const MAX_ATTACH = 10 * 1024 * 1024;

module.exports = function chatService(core) {
  const { db, now, audit } = core;

  function ensureMember(channelId, userId, orgId, external) {
    db.run('INSERT OR IGNORE INTO channel_members(channel_id, user_id, org_id, is_external, last_read_seq, joined_at) VALUES (?,?,?,?,?,?)',
      channelId, userId, orgId, external ? 1 : 0, 0, iso(now()));
  }
  const memberIds = channelId => db.all('SELECT user_id FROM channel_members WHERE channel_id = ?', channelId).map(r => r.user_id);

  function systemMessage(channelId, body, card = null) {
    return insertMessage(channelId, { userId: null, kind: card ? 'card' : 'system', body, card });
  }
  function insertMessage(channelId, { userId, kind = 'text', body = '', parentId = null, card = null, mentions = [] }) {
    const seq = db.get('SELECT COALESCE(MAX(seq),0)+1 n FROM messages WHERE channel_id = ?', channelId).n;
    const m = { id: uid(), channel_id: channelId, seq, user_id: userId, kind, body, parent_id: parentId, card_json: card ? JSON.stringify(card) : null, mentions_json: JSON.stringify(mentions), created_at: iso(now()) };
    db.insert('messages', m);
    core.bus.emit('message', { channelId, messageId: m.id, userIds: memberIds(channelId) });
    return m;
  }

  /** Desired members of a vendor relationship channel: selected customer roles + all chat-enabled vendor staff. */
  function syncVendorChannel(ch) {
    const rel = db.get("SELECT * FROM vendor_relationships WHERE customer_org_id = ? AND vendor_org_id = ? AND status = 'active'", ch.org_id, ch.vendor_org_id);
    const want = new Map();
    if (rel) {
      for (const m of db.all("SELECT user_id, role FROM organization_members WHERE org_id = ? AND status = 'active'", ch.org_id))
        if (CUSTOMER_VENDOR_ROLES.includes(m.role)) want.set(m.user_id, { org: ch.org_id, ext: 0 });
      for (const m of db.all("SELECT user_id, role FROM organization_members WHERE org_id = ? AND status = 'active'", ch.vendor_org_id))
        if (core.permsFor(m.role).has('chat.use')) want.set(m.user_id, { org: ch.vendor_org_id, ext: 1 });
    }
    reconcile(ch.id, want, ch.kind === 'transaction' ? ch : null);
  }
  function reconcile(channelId, want, txnChannel) {
    for (const cm of db.all('SELECT * FROM channel_members WHERE channel_id = ?', channelId)) {
      if (!want.has(cm.user_id)) db.run('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?', channelId, cm.user_id);
    }
    for (const [uidv, w] of want) ensureMember(channelId, uidv, w.org, w.ext);
  }

  function txnWant(ch, requesterId) {
    const want = new Map();
    const rel = db.get("SELECT 1 x FROM vendor_relationships WHERE customer_org_id = ? AND vendor_org_id = ? AND status = 'active'", ch.org_id, ch.vendor_org_id);
    if (!rel) return want;
    if (requesterId) want.set(requesterId, { org: ch.org_id, ext: 0 });
    for (const m of db.all("SELECT user_id, role FROM organization_members WHERE org_id = ? AND status = 'active'", ch.org_id))
      if (['org_admin', 'procurement_officer'].includes(m.role)) want.set(m.user_id, { org: ch.org_id, ext: 0 });
    for (const m of db.all("SELECT user_id, role FROM organization_members WHERE org_id = ? AND status = 'active'", ch.vendor_org_id))
      if (core.permsFor(m.role).has('request.respond') || m.role === 'vendor_owner') want.set(m.user_id, { org: ch.vendor_org_id, ext: 1 });
    return want;
  }

  const chView = (c, uidv) => {
    const cm = db.get('SELECT last_read_seq FROM channel_members WHERE channel_id = ? AND user_id = ?', c.id, uidv);
    const last = db.get('SELECT COALESCE(MAX(seq),0) n FROM messages WHERE channel_id = ?', c.id).n;
    const vendor = c.vendor_org_id ? db.get('SELECT name FROM organizations WHERE id = ?', c.vendor_org_id) : null;
    const owner = db.get('SELECT name FROM organizations WHERE id = ?', c.org_id);
    return { id: c.id, kind: c.kind, name: c.name, orgId: c.org_id, orgName: owner.name, vendorOrgId: c.vendor_org_id, vendorName: vendor && vendor.name, refType: c.ref_type, refId: c.ref_id, unread: Math.max(0, last - (cm ? cm.last_read_seq : 0)) };
  };

  function mustBeMember(ctx, channelId) {
    const ch = db.get('SELECT * FROM channels WHERE id = ?', channelId);
    const cm = ch && db.get('SELECT * FROM channel_members WHERE channel_id = ? AND user_id = ?', channelId, ctx.userId);
    if (!ch || !cm) throw notFound('Channel'); // never reveal that a channel exists to non-members
    return { ch, cm };
  }

  function hydrateCard(c, viewerOrgId) {
    if (!c) return null;
    const card = JSON.parse(c);
    const tbl = { quote: 'quotations', invoice: 'invoices', request: 'requests', bill: 'bills' }[card.type];
    if (tbl && card.id) {
      const r = db.get(`SELECT * FROM ${tbl} WHERE id = ?`, card.id);
      const visible = r && (r.org_id === viewerOrgId || r.vendor_org_id === viewerOrgId || r.customer_org_id === viewerOrgId);
      if (visible) { card.status = r.status; if (r.number) card.number = r.number; if (r.total_minor != null) card.totalMinor = r.total_minor; if (r.payment_status) card.paymentStatus = r.payment_status; }
    }
    return card;
  }

  const svc = {
    memberIds, systemMessage, insertMessage,

    ensureGeneral(orgId) {
      let ch = db.get("SELECT * FROM channels WHERE org_id = ? AND kind = 'general'", orgId);
      if (!ch) { ch = { id: uid(), org_id: orgId, kind: 'general', name: 'general', vendor_org_id: null, ref_type: null, ref_id: null, created_by: 'system', created_at: iso(now()) }; db.insert('channels', ch); }
      return ch;
    },
    ensureVendorChannel(customerOrgId, vendorOrgId) {
      let ch = db.get("SELECT * FROM channels WHERE org_id = ? AND kind = 'vendor' AND vendor_org_id = ?", customerOrgId, vendorOrgId);
      if (!ch) {
        const v = db.get('SELECT name FROM organizations WHERE id = ?', vendorOrgId);
        ch = { id: uid(), org_id: customerOrgId, kind: 'vendor', name: v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), vendor_org_id: vendorOrgId, ref_type: null, ref_id: null, created_by: 'system', created_at: iso(now()) };
        db.insert('channels', ch);
      }
      syncVendorChannel(ch);
      return ch;
    },
    /** Transaction channel tied to an RFQ / quote / invoice. Created with the request; members are the parties to it. */
    ensureTransactionChannel(customerOrgId, vendorOrgId, refType, refId, name, requesterId) {
      let ch = db.get('SELECT * FROM channels WHERE kind = ? AND ref_type = ? AND ref_id = ?', 'transaction', refType, refId);
      if (!ch) { ch = { id: uid(), org_id: customerOrgId, kind: 'transaction', name, vendor_org_id: vendorOrgId, ref_type: refType, ref_id: refId, created_by: requesterId || 'system', created_at: iso(now()) }; db.insert('channels', ch); }
      reconcile(ch.id, txnWant(ch, requesterId || ch.created_by), ch);
      return ch;
    },
    /** Re-derives all channel memberships for an organisation after role, status or relationship changes. */
    syncOrgChannels(orgId) {
      const gen = db.get("SELECT * FROM channels WHERE org_id = ? AND kind = 'general'", orgId);
      if (gen) {
        const want = new Map();
        for (const m of db.all("SELECT user_id, role FROM organization_members WHERE org_id = ? AND status = 'active'", orgId)) if (core.permsFor(m.role).has('chat.use')) want.set(m.user_id, { org: orgId, ext: 0 });
        reconcile(gen.id, want);
      }
      for (const ch of db.all("SELECT * FROM channels WHERE kind IN ('vendor','transaction') AND (org_id = ? OR vendor_org_id = ?)", orgId, orgId)) {
        if (ch.kind === 'vendor') syncVendorChannel(ch);
        else {
          const requester = db.get('SELECT created_by FROM channels WHERE id = ?', ch.id).created_by;
          const cur = db.all('SELECT user_id FROM channel_members WHERE channel_id = ?', ch.id).map(r => r.user_id);
          const want = txnWant(ch, requester);
          // participants from the *other* organisation are left to that organisation's own sync
          for (const u of cur) if (!want.has(u)) {
            const cm = db.get('SELECT org_id FROM channel_members WHERE channel_id = ? AND user_id = ?', ch.id, u);
            if (cm.org_id !== orgId) want.set(u, { org: cm.org_id, ext: cm.org_id === ch.org_id ? 0 : 1 });
          }
          reconcile(ch.id, want);
        }
      }
    },

    list(ctx) {
      ctx.require('chat.use');
      svc.ensureGeneral(ctx.orgId);
      svc.syncOrgChannels(ctx.orgId);
      return db.all(`SELECT c.* FROM channels c JOIN channel_members m ON m.channel_id = c.id WHERE m.user_id = ? ORDER BY c.kind, c.name`, ctx.userId).map(c => chView(c, ctx.userId));
    },
    createChannel(ctx, { name, memberUserIds = [] }) {
      ctx.require('chat.create_channel');
      const nm = String(name || '').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
      if (!nm) throw bad('Channel name is required');
      const ch = { id: uid(), org_id: ctx.orgId, kind: 'general', name: nm, vendor_org_id: null, ref_type: 'custom', ref_id: null, created_by: ctx.userId, created_at: iso(now()) };
      db.tx(() => {
        db.insert('channels', ch);
        ensureMember(ch.id, ctx.userId, ctx.orgId, false);
        for (const u of memberUserIds) if (db.get("SELECT 1 x FROM organization_members WHERE org_id = ? AND user_id = ? AND status = 'active'", ctx.orgId, u)) ensureMember(ch.id, u, ctx.orgId, false);
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'channel.created', objectType: 'channel', objectId: ch.id, next: { name: nm } });
      });
      return chView(ch, ctx.userId);
    },
    directMessage(ctx, otherUserId) {
      ctx.require('chat.use');
      const other = db.get('SELECT u.id, u.name FROM users u WHERE u.id = ?', otherUserId);
      if (!other || other.id === ctx.userId) throw bad('Choose another person');
      const sameOrg = db.get("SELECT org_id FROM organization_members WHERE user_id = ? AND status='active' AND org_id IN (SELECT org_id FROM organization_members WHERE user_id = ? AND status='active')", otherUserId, ctx.userId);
      const shared = db.get('SELECT 1 x FROM channel_members a JOIN channel_members b ON a.channel_id = b.channel_id WHERE a.user_id = ? AND b.user_id = ?', ctx.userId, otherUserId);
      if (!sameOrg && !shared) throw forbidden('You can only message people you already share a workspace or channel with');
      const key = [ctx.userId, otherUserId].sort().join(':');
      let ch = db.get("SELECT * FROM channels WHERE kind = 'dm' AND ref_id = ?", key);
      if (!ch) {
        ch = { id: uid(), org_id: ctx.orgId, kind: 'dm', name: 'dm', vendor_org_id: null, ref_type: 'dm', ref_id: key, created_by: ctx.userId, created_at: iso(now()) };
        db.tx(() => {
          db.insert('channels', ch);
          ensureMember(ch.id, ctx.userId, ctx.orgId, false);
          const oo = db.get("SELECT org_id FROM organization_members WHERE user_id = ? AND status='active' ORDER BY org_id = ? DESC LIMIT 1", otherUserId, ctx.orgId);
          ensureMember(ch.id, otherUserId, oo.org_id, oo.org_id !== ctx.orgId);
        });
      }
      return { ...chView(ch, ctx.userId), name: other.name };
    },

    messages(ctx, channelId, { parent = null, afterSeq = 0 } = {}) {
      const { ch, cm } = mustBeMember(ctx, channelId);
      const rows = parent
        ? db.all('SELECT * FROM messages WHERE channel_id = ? AND (id = ? OR parent_id = ?) ORDER BY seq', channelId, parent, parent)
        : db.all('SELECT * FROM messages WHERE channel_id = ? AND parent_id IS NULL AND seq > ? ORDER BY seq', channelId, afterSeq);
      const out = rows.map(m => {
        const u = m.user_id ? db.get('SELECT u.name, cm.org_id, cm.is_external FROM users u LEFT JOIN channel_members cm ON cm.user_id = u.id AND cm.channel_id = ? WHERE u.id = ?', channelId, m.user_id) : null;
        const org = u && u.org_id ? db.get('SELECT name FROM organizations WHERE id = ?', u.org_id) : null;
        return {
          id: m.id, seq: m.seq, kind: m.kind, body: m.body, parentId: m.parent_id, createdAt: m.created_at, userId: m.user_id,
          author: m.kind === 'agent' ? 'AI Billing Agent' : u ? u.name : 'PayUno Flow', authorOrg: org && org.name, external: !!(u && u.is_external),
          card: hydrateCard(m.card_json, ctx.orgId), replies: db.get('SELECT COUNT(*) n FROM messages WHERE parent_id = ?', m.id).n,
          reactions: db.all('SELECT emoji, COUNT(*) n, MAX(user_id = ?) mine FROM message_reactions WHERE message_id = ? GROUP BY emoji', ctx.userId, m.id).map(r => ({ emoji: r.emoji, count: r.n, mine: !!r.mine })),
          attachments: db.all('SELECT id, filename, mime, size FROM message_attachments WHERE message_id = ?', m.id),
          mentions: JSON.parse(m.mentions_json),
        };
      });
      const last = db.get('SELECT COALESCE(MAX(seq),0) n FROM messages WHERE channel_id = ?', channelId).n;
      if (!parent && last > cm.last_read_seq) db.run('UPDATE channel_members SET last_read_seq = ? WHERE channel_id = ? AND user_id = ?', last, channelId, ctx.userId);
      return { channel: chView(ch, ctx.userId), messages: out };
    },

    post(ctx, channelId, { body, parentId = null, file = null }) {
      ctx.require('chat.use');
      const { ch } = mustBeMember(ctx, channelId);
      body = String(body || '').trim();
      if (!body && !file) throw bad('Message cannot be empty');
      if (body.length > 4000) throw bad('Message is too long');
      if (parentId && !db.get('SELECT 1 x FROM messages WHERE id = ? AND channel_id = ?', parentId, channelId)) throw notFound('Thread');
      const mentions = [];
      for (const [, tag] of body.matchAll(/@([A-Za-z][\w.-]*)/g)) {
        const hit = db.get(`SELECT u.id FROM channel_members m JOIN users u ON u.id = m.user_id WHERE m.channel_id = ? AND lower(u.name) LIKE lower(?) || '%' LIMIT 1`, channelId, tag);
        if (hit && hit.id !== ctx.userId) mentions.push(hit.id);
      }
      if (file) {
        if (!ALLOWED_MIME.test(file.mime)) throw bad('Attachment type not allowed');
        if (file.buffer.length > MAX_ATTACH) throw bad('Attachment exceeds 10 MB');
      }
      const m = db.tx(() => {
        const msg = insertMessage(channelId, { userId: ctx.userId, body, parentId, mentions });
        if (file) {
          const key = `att_${uid()}`;
          core.putObject(key, file.buffer);
          db.insert('message_attachments', { id: uid(), message_id: msg.id, channel_id: channelId, filename: file.filename, mime: file.mime, size: file.buffer.length, sha256: sha256(file.buffer), storage_key: key });
        }
        return msg;
      });
      if (mentions.length) core.notify(mentions, { orgId: ctx.orgId, kind: 'mention', title: `${ctx.user.name} mentioned you in #${ch.name}`, body: body.slice(0, 140), link: `#/chat/${channelId}` });
      return { id: m.id, seq: m.seq };
    },
    react(ctx, messageId, emoji) {
      const m = db.get('SELECT * FROM messages WHERE id = ?', messageId);
      if (!m) throw notFound('Message');
      mustBeMember(ctx, m.channel_id);
      if (!/^[\p{Extended_Pictographic}✅❌]{1,4}$/u.test(emoji || '')) throw bad('Invalid reaction');
      const ex = db.get('SELECT 1 x FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', messageId, ctx.userId, emoji);
      if (ex) db.run('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', messageId, ctx.userId, emoji);
      else db.run('INSERT INTO message_reactions(message_id, user_id, emoji) VALUES (?,?,?)', messageId, ctx.userId, emoji);
      core.bus.emit('message', { channelId: m.channel_id, messageId, userIds: memberIds(m.channel_id) });
      return { on: !ex };
    },
    attachment(ctx, id) {
      const a = db.get('SELECT * FROM message_attachments WHERE id = ?', id);
      if (!a) throw notFound('Attachment');
      mustBeMember(ctx, a.channel_id);
      return { filename: a.filename, mime: a.mime, buffer: core.getObject(a.storage_key) };
    },
    search(ctx, q) {
      ctx.require('chat.use');
      q = String(q || '').trim();
      if (q.length < 2) return [];
      const like = `%${q.replace(/[%_\\]/g, m => '\\' + m)}%`;
      return db.all(
        `SELECT m.id, m.channel_id, m.body, m.created_at, c.name channel FROM messages m JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = ?
         JOIN channels c ON c.id = m.channel_id WHERE m.kind IN ('text','agent') AND m.body LIKE ? ESCAPE '\\' ORDER BY m.created_at DESC LIMIT 30`, ctx.userId, like)
        .map(r => ({ id: r.id, channelId: r.channel_id, channel: r.channel, body: r.body, createdAt: r.created_at }));
    },
    notifications(ctx) {
      return db.all('SELECT id, kind, title, body, link, created_at, read_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', ctx.userId);
    },
    readNotifications(ctx) { db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', iso(now()), ctx.userId); },
  };
  return svc;
};
