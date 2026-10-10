// Loads Financial Master Data (Source Document / Financial Event / High Frequency Phrase / accounts).
const fs = require('fs');
const path = require('path');
const { parseCsvObjects } = require('./csv');

function loadMasterData(file = path.join(__dirname, '..', 'data', 'Financial_Master_Data.csv')) {
  const rows = parseCsvObjects(fs.readFileSync(file, 'utf8')).map((r, index) => ({
    index,
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
