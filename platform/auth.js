// Users, sessions, organisations, memberships and invitations.
const { uid, iso } = require('./db');
const { hashPassword, verifyPassword, randomToken, sha256 } = require('./security');
const { bad, forbidden, notFound, conflict, HttpError } = require('./errors');
const { makeCtx } = require('./core');
const { ROLES } = require('./rbac');

const SESSION_HOURS = 12;
const INVITE_DAYS = 7;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COUNTRIES = ['NG', 'US', 'GH', 'GB', 'AU'];
const CURRENCY_OF = { NG: 'NGN', US: 'USD', GH: 'GHS', GB: 'GBP', AU: 'AUD' };

module.exports = function authService(core) {
  const { db, now, audit } = core;
  const attempts = new Map(); // email -> {n, until}: simple brute-force throttle

  const publicUser = u => ({ id: u.id, name: u.name, email: u.email, isPlatformAdmin: !!u.is_platform_admin });
  const publicOrg = o => ({ id: o.id, name: o.name, kind: o.kind, isVendor: !!o.is_vendor, isCustomer: !!o.is_customer, country: o.country, currency: o.currency, isDemo: !!o.is_demo, status: o.status });

  function createOrg({ name, country = 'NG', isVendor = false, isCustomer = true, isDemo = false, kind = 'business', currency }) {
    if (!String(name || '').trim()) throw bad('Organisation name is required');
    if (!COUNTRIES.includes(country)) throw bad(`Unsupported country ${country}`);
    const id = uid();
    db.insert('organizations', {
      id, name: String(name).trim(), kind, is_customer: isCustomer, is_vendor: isVendor, country, currency: currency || CURRENCY_OF[country],
      status: 'active', is_demo: isDemo, settings_json: '{}', created_at: iso(now()),
    });
    if (kind === 'business') {
      if (isCustomer && core.svc.ledger) core.svc.ledger.seedChart(id);
      if (isVendor && core.svc.vendor) core.svc.vendor.setupVendor(id, { legalName: String(name).trim() });
    }
    return db.get('SELECT * FROM organizations WHERE id = ?', id);
  }

  function addMember(orgId, userId, role, extra = {}) {
    if (!ROLES[role]) throw bad(`Unknown role ${role}`);
    const org = db.get('SELECT * FROM organizations WHERE id = ?', orgId);
    const scope = ROLES[role].scope;
    if (scope === 'platform' ? org.kind !== 'platform' : (scope === 'vendor' && !org.is_vendor) || (scope === 'business' && !org.is_customer))
      throw bad(`Role ${role} is not valid in this kind of organisation`);
    const row = {
      id: uid(), org_id: orgId, user_id: userId, role, approval_limit_minor: extra.approvalLimitMinor || 0, department: extra.department || '',
      cost_center: extra.costCenter || '', status: 'active', created_at: iso(now()),
    };
    db.insert('organization_members', row);
    return row;
  }

  function createUser({ name, email, password, isPlatformAdmin = false }) {
    if (!String(name || '').trim()) throw bad('Name is required');
    if (!EMAIL.test(email || '')) throw bad('A valid email is required');
    if (String(password || '').length < 10) throw bad('Password must be at least 10 characters');
    if (db.get('SELECT 1 x FROM users WHERE email = ?', email)) throw conflict('An account with this email already exists', 'email_taken');
    const u = { id: uid(), email: email.trim(), name: String(name).trim(), pw_hash: hashPassword(password), is_platform_admin: isPlatformAdmin, status: 'active', created_at: iso(now()) };
    db.insert('users', u);
    return db.get('SELECT * FROM users WHERE id = ?', u.id);
  }

  function startSession(userId, orgId) {
    const token = randomToken(32);
    const exp = new Date(now().getTime() + SESSION_HOURS * 3600e3);
    db.insert('sessions', { token_hash: sha256(token), user_id: userId, active_org_id: orgId, created_at: iso(now()), expires_at: iso(exp) });
    return { token, expiresAt: iso(exp) };
  }

  const memberships = userId => db.all(
    `SELECT m.*, o.name org_name, o.kind org_kind, o.is_demo FROM organization_members m JOIN organizations o ON o.id = m.org_id
     WHERE m.user_id = ? AND m.status = 'active' AND o.deleted_at IS NULL AND o.status <> 'suspended' ORDER BY m.created_at`, userId);

  const svc = {
    publicUser, publicOrg, createOrg, addMember, createUser, startSession, memberships, COUNTRIES, CURRENCY_OF,

    register({ name, email, password, orgName, country = 'NG', type = 'business' }) {
      return db.tx(() => {
        const user = createUser({ name, email, password });
        const isVendor = type === 'vendor';
        const org = createOrg({ name: orgName, country, isVendor, isCustomer: !isVendor });
        addMember(org.id, user.id, isVendor ? 'vendor_owner' : 'org_admin', { approvalLimitMinor: isVendor ? 0 : 10_000_000_00 });
        audit.record(org.id, { actorId: user.id, actorOrgId: org.id, action: 'org.created', objectType: 'organization', objectId: org.id, next: { name: org.name, country, type } });
        return { user: publicUser(user), org: publicOrg(org), session: startSession(user.id, org.id) };
      });
    },

    login(email, password) {
      const key = String(email || '').toLowerCase();
      const a = attempts.get(key);
      if (a && a.n >= 5 && a.until > now().getTime()) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
      const u = db.get("SELECT * FROM users WHERE email = ? AND status = 'active' AND deleted_at IS NULL", email || '');
      if (!u || !verifyPassword(String(password || ''), u.pw_hash)) {
        const n = (a && a.until > now().getTime() ? a.n : 0) + 1;
        attempts.set(key, { n, until: now().getTime() + 15 * 60e3 });
        throw new HttpError(401, 'Invalid email or password');
      }
      attempts.delete(key);
      const ms = memberships(u.id);
      if (!ms.length) throw new HttpError(403, 'Your account has no active organisation membership');
      const session = startSession(u.id, ms[0].org_id);
      audit.record(ms[0].org_id, { actorId: u.id, actorOrgId: ms[0].org_id, action: 'auth.login', objectType: 'user', objectId: u.id });
      return { user: publicUser(u), session };
    },

    logout(token) { db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token || '')); },

    /** Resolves a bearer/cookie token into a request context or null. */
    authenticate(token) {
      if (!token) return null;
      const s = db.get('SELECT * FROM sessions WHERE token_hash = ?', sha256(token));
      if (!s) return null;
      if (s.expires_at < iso(now())) { db.run('DELETE FROM sessions WHERE token_hash = ?', s.token_hash); return null; }
      const user = db.get("SELECT * FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL", s.user_id);
      const org = db.get("SELECT * FROM organizations WHERE id = ? AND deleted_at IS NULL AND status <> 'suspended'", s.active_org_id);
      if (!user || !org) return null;
      const member = db.get("SELECT * FROM organization_members WHERE org_id = ? AND user_id = ? AND status = 'active'", org.id, user.id);
      if (!member) return null;
      return makeCtx(core, user, member, org);
    },

    switchOrg(token, ctx, orgId) {
      const m = db.get("SELECT 1 x FROM organization_members WHERE org_id = ? AND user_id = ? AND status = 'active'", orgId, ctx.userId);
      if (!m) throw forbidden('You are not a member of that organisation');
      db.run('UPDATE sessions SET active_org_id = ? WHERE token_hash = ?', orgId, sha256(token));
    },

    me(ctx) {
      return {
        user: publicUser(ctx.user), org: publicOrg(ctx.org), role: ctx.role, roleLabel: ROLES[ctx.role].label,
        permissions: [...ctx.perms].sort(), approvalLimitMinor: ctx.member.approval_limit_minor,
        department: ctx.member.department, costCenter: ctx.member.cost_center,
        memberships: memberships(ctx.userId).map(m => ({ orgId: m.org_id, orgName: m.org_name, role: m.role, isDemo: !!m.is_demo })),
        unreadNotifications: db.get('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL', ctx.userId).n,
      };
    },

    /* ----------------------------- members ----------------------------- */
    listMembers(ctx) {
      ctx.require('org.members');
      return db.all(
        `SELECT m.id, m.role, m.status, m.approval_limit_minor, m.department, m.cost_center, u.id user_id, u.name, u.email
         FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.name`, ctx.orgId);
    },
    /** Directory of colleagues (names only) for mentions and approver pickers: no org.members permission needed. */
    directory(ctx) {
      return db.all(`SELECT u.id user_id, u.name, m.role, m.department FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.status = 'active' ORDER BY u.name`, ctx.orgId);
    },
    updateMember(ctx, memberId, patch) {
      ctx.require('org.members');
      const m = db.get('SELECT * FROM organization_members WHERE id = ? AND org_id = ?', memberId, ctx.orgId);
      if (!m) throw notFound('Member');
      if (patch.role && patch.role !== m.role) {
        if (!ROLES[patch.role] || ROLES[patch.role].scope === 'platform') throw bad('Invalid role');
        if (m.user_id === ctx.userId) throw forbidden('You cannot change your own role');
      }
      const next = {
        role: patch.role || m.role,
        approval_limit_minor: patch.approvalLimitMinor != null ? Number(patch.approvalLimitMinor) : m.approval_limit_minor,
        department: patch.department ?? m.department, cost_center: patch.costCenter ?? m.cost_center, status: patch.status || m.status,
      };
      if (!Number.isInteger(next.approval_limit_minor) || next.approval_limit_minor < 0) throw bad('Approval limit must be a non-negative whole number of minor units');
      db.tx(() => {
        db.run('UPDATE organization_members SET role=?, approval_limit_minor=?, department=?, cost_center=?, status=? WHERE id=?',
          next.role, next.approval_limit_minor, next.department, next.cost_center, next.status, memberId);
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'member.updated', objectType: 'member', objectId: memberId, prior: { role: m.role, limit: m.approval_limit_minor, status: m.status }, next });
        if (core.svc.chat) core.svc.chat.syncOrgChannels(ctx.orgId);
      });
      return { ok: true };
    },

    /* --------------------------- invitations --------------------------- */
    createInvitation(ctx, { kind, email, vendorName = '', role }) {
      if (!EMAIL.test(email || '')) throw bad('A valid email is required');
      if (kind === 'vendor') {
        ctx.require('vendor.invite');
        if (!ctx.org.is_customer) throw forbidden('Only customer organisations invite vendors');
        role = 'vendor_owner';
        if (!String(vendorName).trim()) throw bad('Vendor name is required');
      } else if (kind === 'staff') {
        ctx.require('org.members');
        if (!ROLES[role] || ROLES[role].scope === 'platform') throw bad('Invalid role');
        const sc = ROLES[role].scope;
        if ((sc === 'vendor' && !ctx.org.is_vendor) || (sc === 'business' && !ctx.org.is_customer)) throw bad('That role does not exist in this organisation');
      } else throw bad('Invitation kind must be vendor or staff');
      const token = randomToken(32);
      const exp = new Date(now().getTime() + INVITE_DAYS * 86400e3);
      const row = {
        id: uid(), kind, org_id: ctx.orgId, email: email.trim(), invited_org_name: String(vendorName).trim(), role, token_hash: sha256(token),
        status: 'pending', expires_at: iso(exp), invited_by: ctx.userId, created_at: iso(now()),
      };
      db.tx(() => {
        db.insert('invitations', row);
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'invitation.created', objectType: 'invitation', objectId: row.id, next: { kind, email, role, expiresAt: row.expires_at } });
      });
      // The token is returned once; only its hash is stored. In production it is emailed, never logged.
      return { id: row.id, token, expiresAt: row.expires_at, link: `/#/invite/${token}` };
    },
    listInvitations(ctx) {
      if (!ctx.can('org.members') && !ctx.can('vendor.invite')) throw forbidden();
      const t = iso(now());
      return db.all('SELECT id, kind, email, invited_org_name, role, status, expires_at, created_at FROM invitations WHERE org_id = ? ORDER BY created_at DESC', ctx.orgId)
        .map(i => (i.status === 'pending' && i.expires_at < t ? { ...i, status: 'expired' } : i));
    },
    revokeInvitation(ctx, id) {
      const inv = db.get('SELECT * FROM invitations WHERE id = ? AND org_id = ?', id, ctx.orgId);
      if (!inv) throw notFound('Invitation');
      ctx.require(inv.kind === 'vendor' ? 'vendor.invite' : 'org.members');
      if (inv.status !== 'pending') throw conflict(`Invitation is already ${inv.status}`);
      db.tx(() => {
        db.run("UPDATE invitations SET status = 'revoked' WHERE id = ?", id);
        audit.record(ctx.orgId, { actorId: ctx.userId, actorOrgId: ctx.orgId, action: 'invitation.revoked', objectType: 'invitation', objectId: id });
      });
    },
    loadInvitation(token) {
      const inv = db.get('SELECT * FROM invitations WHERE token_hash = ?', sha256(String(token || '')));
      if (!inv) throw new HttpError(404, 'This invitation link is not valid');
      if (inv.status !== 'pending') throw new HttpError(410, `This invitation has been ${inv.status}`);
      if (inv.expires_at < iso(now())) { db.run("UPDATE invitations SET status = 'expired' WHERE id = ?", inv.id); throw new HttpError(410, 'This invitation has expired'); }
      return inv;
    },
    previewInvitation(token) {
      const inv = svc.loadInvitation(token);
      const org = db.get('SELECT name FROM organizations WHERE id = ?', inv.org_id);
      return { kind: inv.kind, inviter: org.name, email: inv.email, invitedOrgName: inv.invited_org_name, role: inv.role, expiresAt: inv.expires_at };
    },
    /**
     * Accepts an invitation. The accepting identity must own the invited email address.
     *  - staff:  joins the inviting organisation with the invited role.
     *  - vendor: the accepting user's own *vendor* organisation is linked to the customer. The relationship is active only
     *            when that vendor's KYB is verified; otherwise it waits (pending_kyb) and grants no channel access.
     */
    acceptInvitation(token, { ctx = null, name, password, orgName, country }) {
      const inv = svc.loadInvitation(token);
      return db.tx(() => {
        let user;
        if (ctx) {
          user = ctx.user;
          if (user.email.toLowerCase() !== inv.email.toLowerCase()) throw forbidden('This invitation was sent to a different email address', 'invite_email_mismatch');
        } else {
          user = db.get('SELECT * FROM users WHERE email = ?', inv.email);
          if (user) throw new HttpError(401, 'An account already exists for this email — sign in first, then open the invitation link again', undefined, 'login_required');
          user = createUser({ name, email: inv.email, password });
        }
        let org, result;
        if (inv.kind === 'staff') {
          addMember(inv.org_id, user.id, inv.role);
          org = db.get('SELECT * FROM organizations WHERE id = ?', inv.org_id);
          if (core.svc.chat) core.svc.chat.syncOrgChannels(org.id);
          result = { orgId: org.id };
        } else {
          let vendorOrg = ctx && ctx.org.is_vendor && ctx.can('vendor.accept_invite') ? ctx.org : null;
          if (!vendorOrg) {
            const own = db.get(
              `SELECT o.* FROM organization_members m JOIN organizations o ON o.id = m.org_id
               WHERE m.user_id = ? AND m.role = 'vendor_owner' AND m.status = 'active' AND o.is_vendor = 1 LIMIT 1`, user.id);
            vendorOrg = own || null;
          }
          if (!vendorOrg) {
            vendorOrg = createOrg({ name: orgName || inv.invited_org_name, country: country || 'NG', isVendor: true, isCustomer: false });
            addMember(vendorOrg.id, user.id, 'vendor_owner');
            audit.record(vendorOrg.id, { actorId: user.id, actorOrgId: vendorOrg.id, action: 'org.created', objectType: 'organization', objectId: vendorOrg.id, next: { via: 'invitation' } });
          }
          if (vendorOrg.id === inv.org_id) throw bad('An organisation cannot be its own vendor');
          org = vendorOrg;
          const rel = core.svc.vendor.linkVendor(inv.org_id, vendorOrg.id, inv.id);
          result = { orgId: vendorOrg.id, relationship: rel.status };
        }
        db.run("UPDATE invitations SET status='accepted', accepted_by=?, accepted_org_id=? WHERE id=?", user.id, org.id, inv.id);
        audit.record([inv.org_id, org.id], { actorId: user.id, actorOrgId: org.id, action: 'invitation.accepted', objectType: 'invitation', objectId: inv.id, next: { kind: inv.kind, ...result } });
        const session = ctx ? null : startSession(user.id, org.id);
        return { user: publicUser(user), org: publicOrg(org), ...result, session };
      });
    },
  };
  return svc;
};
module.exports.COUNTRIES = COUNTRIES;
