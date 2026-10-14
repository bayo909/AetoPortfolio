// Loads Financial Master Data (Source Document / Financial Event / High Frequency Phrase / accounts).
const fs = require('fs');
const path = require('path');
const { parseCsvObjects } = require('./csv');

const DATA = path.join(__dirname, '..', 'data');

/**
 * Financial_Master_Data.csv is the business-owned file. Rows for document types it does not
 * cover (e.g. Quote) live in Supplemental_Financial_Events.csv so the original stays untouched.
 */
function loadMasterData(file = path.join(DATA, 'Financial_Master_Data.csv'), supplemental = path.join(DATA, 'Supplemental_Financial_Events.csv')) {
  const raw = parseCsvObjects(fs.readFileSync(file, 'utf8'));
  const extra = supplemental && fs.existsSync(supplemental) ? parseCsvObjects(fs.readFileSync(supplemental, 'utf8')) : [];
  const rows = [...raw, ...extra].map((r, index) => ({
    index,
    supplemental: index >= raw.length,
    sourceDocument: r['Source Document'],
    financialEvent: r['Financial Event'],
    accountingImpact: r['Accounting Impact'],
    ledgerEffect: r['Ledger Effect'],
    phrase: r['High Frequency Phrase'],
    journalEntry: r['Journal Entry'],
    debitAccount: r['Debit Account'],
    creditAccount: r['Credit Account'],
    glPosting: r['General Ledger Posting'],
    statementImpact: r['Financial Statement Impact'],
  }));
  const sourceDocuments = [...new Set(rows.map(r => r.sourceDocument))];
  return { rows, sourceDocuments };
}

module.exports = { loadMasterData };
