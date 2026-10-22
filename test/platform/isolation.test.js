const test = require('node:test');
const assert = require('node:assert');
const { seeded, denies } = require('./helpers');

test('tenant isolation: a customer never sees another customer\'s bills, requests, wallets or ledger', async () => {
  const w = await seeded();
  const { svc } = w;
  const apexBills = svc.bills.list(w.as('tunde'));
  assert.ok(apexBills.length >= 5);
  // Greenfield (a different tenant) has none of them and cannot open them by id
  assert.strictEqual(svc.bills.list(w.as('hauwa')).length, 0);
  denies(assert, () => svc.bills.get(w.as('hauwa'), w.bills.paid), 404);
  denies(assert, () => svc.bills.get(w.as('emeka'), w.bills.approved), 404);
  assert.strictEqual(svc.payments.listWallets(w.as('hauwa')).length, 0);
  assert.strictEqual(svc.ledger.journal(w.as('emeka')).length, 0);
  const apexReq = svc.commerce.listRequests(w.as('funmi'))[0];
  denies(assert, () => svc.commerce.getRequest(w.as('emeka'), apexReq.id), 404);
  // audit trail is per organisation too
  assert.ok(svc.admin.auditTrail(w.as('adaeze')).length > 20);
  assert.strictEqual(svc.admin.auditTrail(w.as('emeka')).filter(e => e.objectId === w.bills.paid).length, 0);
});

test('vendors only see relationships they were invited into and only the documents addressed to them', async () => {
  const w = await seeded();
  const { svc } = w;
  const customers = svc.vendor.listCustomers(w.as('seyi')).map(c => c.name);
  assert.deepStrictEqual(customers.sort(), ['Apex Insurance & Financial Services Ltd.', 'Greenfield Foods Plc']);
  // a vendor has no way into a customer's finance data
  denies(assert, () => svc.bills.list(w.as('seyi')), 403);
  denies(assert, () => svc.payments.listWallets(w.as('seyi')), 403);
  denies(assert, () => svc.ledger.journal(w.as('seyi')), 403);
  // Okafor is not connected to Greenfield: it is invisible there
  const gfVendors = svc.vendor.listVendors(w.as('emeka')).map(v => v.name);
  assert.deepStrictEqual(gfVendors, ['SecureTech Nigeria Ltd']);
  denies(assert, () => svc.vendor.storefront(w.as('emeka'), w.orgs.vendors.okafor.id), 404);
  // Greenfield cannot raise an RFQ against a vendor it has no relationship with
  denies(assert, () => svc.commerce.createRequest(w.as('zainab'), { vendorOrgId: w.orgs.vendors.okafor.id, title: 'x', items: [{ description: 'y', qty: 1 }] }), 403, 'no_relationship');
});

test('collaboration channels: members only; external vendors see only the channels they were granted', async () => {
  const w = await seeded();
  const { svc } = w;
  const seyiChannels = svc.chat.list(w.as('seyi'));
  assert.ok(seyiChannels.length >= 2);
  assert.ok(seyiChannels.every(c => c.kind !== 'general' || c.orgName === 'SecureTech Nigeria Ltd'), 'a vendor must not be in a customer\'s general channel');
  assert.ok(seyiChannels.every(c => ['Apex Insurance & Financial Services Ltd.', 'Greenfield Foods Plc', 'SecureTech Nigeria Ltd'].includes(c.orgName)));
  const apexGeneral = svc.chat.list(w.as('chidi')).find(c => c.kind === 'general');
  denies(assert, () => svc.chat.messages(w.as('seyi'), apexGeneral.id), 404);        // vendor cannot read internal channel
  denies(assert, () => svc.chat.messages(w.as('zainab'), apexGeneral.id), 404);      // other tenant cannot either
  const apexSec = seyiChannels.find(c => c.orgName.startsWith('Apex') && c.kind === 'vendor');
  denies(assert, () => svc.chat.messages(w.as('zainab'), apexSec.id), 404);
  denies(assert, () => svc.chat.post(w.as('emeka'), apexSec.id, { body: 'hi' }), 404);
  // an employee without a place in the vendor channel is not a member
  assert.ok(!svc.chat.list(w.as('bola')).some(c => c.id === apexSec.id));
  // revoking the relationship removes vendor access immediately
  const rel = svc.vendor.listCustomers(w.as('seyi')).find(c => c.name.startsWith('Apex'));
  svc.vendor.revokeRelationship(w.as('funmi'), rel.id);
  denies(assert, () => svc.chat.messages(w.as('seyi'), apexSec.id), 404);
});

test('role permissions are enforced on the backend', async () => {
  const w = await seeded();
  const { svc } = w;
  denies(assert, () => svc.commerce.approveQuote(w.as('chidi'), 'x'), 403);                    // employee cannot approve vendor docs
  denies(assert, () => svc.bills.validate(w.as('chidi'), w.bills.received, { costCenter: 'CC-IT-40' }), 403);
  denies(assert, () => svc.bills.decide(w.as('chidi'), 'x'), 403);
  denies(assert, () => svc.payments.execute(w.as('chidi'), 'x', { password: w.PASSWORD }), 403);
  denies(assert, () => svc.ledger.setPeriod(w.as('chidi'), '2026-01', true), 403);
  denies(assert, () => svc.auth.createInvitation(w.as('chidi'), { kind: 'vendor', email: 'a@b.co', vendorName: 'X' }), 403);   // employees do not invite vendors
  denies(assert, () => svc.auth.listMembers(w.as('chidi')), 403);
  denies(assert, () => svc.admin.auditTrail(w.as('chidi')), 403);
  denies(assert, () => svc.vendor.saveProduct(w.as('kemi'), null, { sku: 'X', name: 'X', unitPrice: '1' }), 403);  // sales agent cannot change catalogue
  denies(assert, () => svc.commerce.issueInvoice(w.as('kemi'), 'x'), 403);
  denies(assert, () => svc.policy.list(w.as('chidi')), 403);
  // accountant may post but not pay; finance officer may pay but not approve own submissions
  denies(assert, () => svc.payments.createIntent(w.as('ibrahim'), { billId: w.bills.approved, walletId: w.wallets.wOpex.id, idempotencyKey: 'abcdefgh1' }), 403);
  // platform admin has no tenant data access
  const pa = w.as('platform');
  denies(assert, () => svc.bills.list(pa), 403);
  denies(assert, () => svc.payments.listWallets(pa), 403);
  assert.ok(svc.admin.tenants(pa).length >= 9);
  // only platform admins review KYB / manage plans
  denies(assert, () => svc.compliance.queue(w.as('seyi')), 403);
  denies(assert, () => svc.subscriptions.savePlan(w.as('seyi'), { key: 'growth' }), 403);
});

test('approval authority is delegated: limits, slot roles, and nobody approves what they requested or benefit from', async () => {
  const w = await seeded();
  const { svc } = w;
  const pending = svc.bills.get(w.as('tunde'), w.bills.capexPending);
  assert.strictEqual(pending.status, 'pending_approval');
  assert.deepStrictEqual(pending.workflow.steps.map(s => s.slot), ['cfo', 'bu_head', 'capex_finance'], '₦3.7m CAPEX: CFO + Business Unit Head (FIN-POL-001) + CAPEX finance approval');
  const step = s => pending.workflow.steps.find(x => x.slot === s).id;
  // the submitter, the requester and the wrong roles are all refused
  denies(assert, () => svc.bills.decide(w.as('tunde'), step('cfo'), { decision: 'approved' }), 403);
  denies(assert, () => svc.bills.decide(w.as('chidi'), step('bu_head'), { decision: 'approved' }), 403);
  denies(assert, () => svc.bills.decide(w.as('funmi'), step('cfo'), { decision: 'approved' }), 403);
  denies(assert, () => svc.bills.decide(w.as('kunle'), step('capex_finance'), { decision: 'approved' }), 403);
  // rejection needs a reason
  denies(assert, () => svc.bills.decide(w.as('ngozi'), step('cfo'), { decision: 'rejected' }), 400);
  // each step needs a different person
  svc.bills.decide(w.as('ngozi'), step('cfo'), { decision: 'approved' });
  denies(assert, () => svc.bills.decide(w.as('ngozi'), step('capex_finance'), { decision: 'approved' }), 403, 'segregation');
  svc.bills.decide(w.as('adaeze'), step('bu_head'), { decision: 'approved' });
  assert.strictEqual(svc.bills.get(w.as('tunde'), w.bills.capexPending).status, 'pending_approval', 'one step outstanding');
  svc.bills.decide(w.as('seun'), step('capex_finance'), { decision: 'approved' });
  const done = svc.bills.get(w.as('tunde'), w.bills.capexPending);
  assert.strictEqual(done.status, 'approved');
  assert.strictEqual(done.accountingStatus, 'posted');
  assert.strictEqual(done.paymentStatus, 'unpaid', 'approval never moves money');
});

test('database constraints back up the application rules', async () => {
  const w = await seeded();
  const { db } = w;
  // posted journal rows and audit events cannot be edited or deleted, even with raw SQL
  assert.throws(() => db.run('UPDATE journal_lines SET amount_minor = amount_minor + 1'), /immutable/);
  assert.throws(() => db.run('DELETE FROM journal_entries'), /immutable/);
  assert.throws(() => db.run("UPDATE audit_events SET reason = 'x'"), /append-only/);
  assert.throws(() => db.run('DELETE FROM audit_events'), /append-only/);
  // an issued invoice keeps its total
  const inv = db.get("SELECT id FROM invoices WHERE status = 'issued' LIMIT 1");
  assert.throws(() => db.run('UPDATE invoices SET total_minor = total_minor - 1000 WHERE id = ?', inv.id), /no longer a draft/);
  // an approved bill keeps its total
  assert.throws(() => db.run('UPDATE bills SET total_minor = 1 WHERE id = ?', w.bills.approved), /frozen/);
  // wallets cannot go negative or reserve more than they hold; two live payments for one bill are impossible
  assert.throws(() => db.run('UPDATE wallets SET balance_minor = -1'), /constraint/i);
  assert.throws(() => db.run('UPDATE wallets SET reserved_minor = balance_minor + 1 WHERE id = ?', w.wallets.wOpex.id), /constraint/i);
  // foreign keys are enforced
  assert.throws(() => db.run("INSERT INTO organization_members(id, org_id, user_id, role, created_at) VALUES ('x','nope','nope','employee','t')"), /FOREIGN KEY/i);
});
