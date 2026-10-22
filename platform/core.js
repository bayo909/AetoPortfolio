// Shared services container: database, audit chain, secrets, clock, notifications and the event bus.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { openDb, uid, iso } = require('./db');
const { createAudit } = require('./audit');
const { makeCipher, randomToken } = require('./security');
const { seedRbac, permsFor } = require('./rbac');
const { HttpError, forbidden } = require('./errors');

function createCore({ dbFile = ':memory:', storageDir = null, now = () => new Date(), env = process.env } = {}) {
  const db = openDb(dbFile);
  seedRbac(db);
  const setting = (key, make) => {
    const row = db.get('SELECT value FROM system_settings WHERE key = ?', key);
    if (row) return row.value;
    const v = make();
    db.run('INSERT INTO system_settings(key, value) VALUES (?,?)', key, v);
    return v;
  };
  // Secrets come from the environment in production; otherwise they are generated once and stored in the database.
  const secrets = {
    qr: env.QR_SIGNING_SECRET || setting('qr_secret', () => randomToken(32)),
    provider: env.PROVIDER_WEBHOOK_SECRET || setting('provider_secret', () => randomToken(32)),
    field: env.FIELD_ENCRYPTION_KEY || setting('field_key', () => crypto.randomBytes(32).toString('base64')),
  };
  const files = storageDir ? (fs.mkdirSync(path.join(storageDir, 'objects'), { recursive: true }), path.join(storageDir, 'objects')) : null;
  const memFiles = new Map();
  const core = {
    db, now, env, secrets, storageDir, uid, iso: () => iso(now()),
    today: () => iso(now()).slice(0, 10),
    audit: createAudit(db, now),
    cipher: makeCipher(secrets.field),
    bus: new EventEmitter(),
    svc: {},
    // Private object storage: files live outside the web root and are only served through authorised routes.
    putObject(key, buffer) { if (files) fs.writeFileSync(path.join(files, key), buffer); else memFiles.set(key, buffer); return key; },
    getObject(key) { return files ? fs.readFileSync(path.join(files, key)) : memFiles.get(key); },
    notify(userIds, { orgId, kind, title, body = '', link = '' }) {
      for (const userId of new Set([].concat(userIds).filter(Boolean))) {
        const n = { id: uid(), user_id: userId, org_id: orgId, kind, title, body, link, created_at: iso(now()), read_at: null };
        db.insert('notifications', n);
        core.bus.emit('notify', n);
      }
    },
    permsFor: role => permsFor(db, role),
  };
  core.HttpError = HttpError;
  return core;
}

/** Request context: authenticated user + the organisation they are currently acting in. */
function makeCtx(core, user, member, org) {
  const perms = member ? core.permsFor(member.role) : new Set();
  if (user.is_platform_admin && org && org.kind === 'platform') for (const p of core.permsFor('platform_admin')) perms.add(p);
  const ctx = {
    user, member, org, orgId: org && org.id, userId: user.id, perms, role: member && member.role,
    can: p => perms.has(p),
    require(p) { if (!perms.has(p)) throw forbidden(`Missing permission: ${p}`, 'missing_permission'); return ctx; },
  };
  return ctx;
}

module.exports = { createCore, makeCtx };
