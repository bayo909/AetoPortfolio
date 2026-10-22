// Role -> permission matrix. Seeded into the roles / permissions tables; enforced on the server by requirePerm().
const PERMS = {
  'platform.manage': 'Tenants, plans, supported countries, system health',
  'platform.kyb_review': 'Review vendor KYB cases',
  'org.members': 'Manage organisation members and staff invitations',
  'vendor.invite': 'Invite vendors into this organisation\'s workspace',
  'vendor.accept_invite': 'Accept a customer workspace invitation on behalf of a vendor',
  'storefront.manage': 'Manage storefront profile',
  'catalog.manage': 'Manage products, services and pricing rules',
  'marketplace.browse': 'Browse authorised vendor storefronts',
  'request.create': 'Create RFQs, orders and invoice requests',
  'request.respond': 'Respond to customer requests',
  'agent.use': 'Use the AI Billing Agent to prepare drafts',
  'quote.draft': 'Create and edit draft quotes',
  'quote.approve': 'Approve or reject vendor quotes',
  'quote.accept': 'Accept a quote on behalf of the customer (creates a purchase order)',
  'invoice.draft': 'Create and edit draft invoices',
  'invoice.approve': 'Approve or reject vendor invoices',
  'invoice.issue': 'Issue approved invoices to the customer',
  'chat.use': 'Use collaboration channels',
  'chat.create_channel': 'Create channels',
  'docs.upload': 'Upload source documents to RT-FEPE',
  'docs.review': 'Edit and submit documents in Billing Review',
  'docs.approve': 'Give expenditure approvals in Billing Review',
  'docs.finance_review': 'Final finance review that creates the bill',
  'docs.exception': 'Approve duplicate / quarantine exceptions',
  'bill.view': 'View bills',
  'bill.validate': 'Validate bills, set classification and submit for approval',
  'bill.approve': 'Approve expenditure (CAPEX / OPEX) within delegated authority',
  'bill.confirm_receipt': 'Confirm goods / service receipt',
  'expense.submit': 'Submit personal expenses and reimbursement claims',
  'wallet.view': 'View wallets and balances',
  'wallet.manage': 'Manage wallets and limits',
  'payment.initiate': 'Initiate payment of an eligible bill (QR or bill page)',
  'payment.execute': 'Authenticate and execute payments',
  'qr.scan': 'Scan invoice QR codes',
  'ledger.view': 'View journals, chart of accounts and reports',
  'ledger.post': 'Post, reverse and retry accounting entries; lock periods',
  'coa.manage': 'Manage chart of accounts',
  'budget.manage': 'Manage budgets and cost centres',
  'reconcile.run': 'Run and resolve reconciliation',
  'audit.view': 'View the audit trail',
  'policy.manage': 'Import and maintain finance policy',
  'events.manage': 'Import and maintain Financial Events mapping',
  'kyb.manage': 'Manage own KYB case',
  'subscription.manage': 'Manage vendor subscription',
  'integrations.manage': 'Manage ERP / integration connectors',
  'reports.view': 'View reports',
};

const EMPLOYEE = ['marketplace.browse', 'request.create', 'chat.use', 'docs.upload', 'bill.view', 'expense.submit', 'qr.scan', 'payment.initiate', 'wallet.view', 'bill.confirm_receipt'];
const FINANCE_VIEW = ['ledger.view', 'reports.view', 'wallet.view', 'bill.view'];

const ROLES = {
  platform_admin: { label: 'Platform Administrator', scope: 'platform', perms: ['platform.manage', 'platform.kyb_review', 'audit.view'] },
  org_admin: {
    label: 'Organisation Administrator', scope: 'business',
    perms: [...EMPLOYEE, 'org.members', 'vendor.invite', 'chat.create_channel', 'quote.accept', 'wallet.manage', 'policy.manage', 'events.manage', 'coa.manage', 'budget.manage',
      'integrations.manage', 'audit.view', 'docs.review', 'docs.approve', 'docs.exception', 'bill.approve', 'ledger.view', 'reports.view'],
  },
  vendor_owner: {
    label: 'Vendor Owner / Administrator', scope: 'vendor',
    perms: ['org.members', 'storefront.manage', 'catalog.manage', 'request.respond', 'agent.use', 'quote.draft', 'quote.approve', 'invoice.draft', 'invoice.approve', 'invoice.issue',
      'chat.use', 'chat.create_channel', 'vendor.accept_invite', 'kyb.manage', 'subscription.manage', 'reports.view', 'audit.view', 'marketplace.browse'],
  },
  vendor_sales: { label: 'Vendor Sales / Billing Agent', scope: 'vendor', perms: ['request.respond', 'agent.use', 'quote.draft', 'invoice.draft', 'chat.use'] },
  employee: { label: 'Employee / Requester', scope: 'business', perms: EMPLOYEE },
  procurement_officer: {
    label: 'Procurement Officer', scope: 'business',
    perms: [...EMPLOYEE, 'vendor.invite', 'quote.accept', 'bill.approve', 'docs.review', 'docs.approve', 'chat.create_channel', 'ledger.view'],
  },
  finance_officer: {
    label: 'Finance Officer / Accounts Payable', scope: 'business',
    perms: [...EMPLOYEE, ...FINANCE_VIEW, 'bill.validate', 'bill.approve', 'docs.review', 'docs.approve', 'docs.finance_review', 'payment.execute', 'reconcile.run', 'budget.manage'],
  },
  finance_approver: {
    label: 'Finance Approver / CFO', scope: 'business',
    perms: [...EMPLOYEE, ...FINANCE_VIEW, 'bill.approve', 'docs.approve', 'docs.exception', 'quote.accept', 'wallet.manage', 'audit.view', 'budget.manage'],
  },
  accountant: {
    label: 'Accountant / Auditor', scope: 'business',
    perms: ['chat.use', 'bill.view', 'wallet.view', 'ledger.view', 'ledger.post', 'coa.manage', 'reconcile.run', 'audit.view', 'reports.view', 'docs.review'],
  },
};

function seedRbac(db) {
  for (const [k, d] of Object.entries(PERMS)) db.run('INSERT OR IGNORE INTO permissions(key, description) VALUES (?,?)', k, d);
  for (const [k, r] of Object.entries(ROLES)) {
    db.run('INSERT OR IGNORE INTO roles(key, label, scope) VALUES (?,?,?)', k, r.label, r.scope);
    for (const p of r.perms) db.run('INSERT OR IGNORE INTO role_permissions(role, permission) VALUES (?,?)', k, p);
  }
}

/** Permissions of a role as read from the database (so administrators' changes apply without a deploy). */
function permsFor(db, role) {
  return new Set(db.all('SELECT permission FROM role_permissions WHERE role = ?', role).map(r => r.permission));
}

// Which membership roles may fill each FIN-POL-001 approval slot (see platform/approvals.js).
const SLOT_ROLES = {
  dept_approver: ['procurement_officer', 'org_admin'],
  finance: ['finance_officer', 'finance_approver'],
  dept_head: ['procurement_officer', 'org_admin'],
  finance_manager: ['finance_approver'],
  cfo: ['finance_approver'],
  bu_head: ['org_admin'],
  ceo: ['org_admin'],
  capex_finance: ['finance_approver'],
};

module.exports = { PERMS, ROLES, SLOT_ROLES, seedRbac, permsFor };
