// Aeto Connect: Slack-style B2B workspaces where the end user requests source documents from vendors,
// the RT-FEPE engine turns them into balanced ledger entries, and payments are released from the chat.
const express = require('express');
const path = require('path');
const { loadMasterData } = require('./src/masterData');
const { loadRates } = require('./src/fepe/fx');
const { createChatService } = require('./src/chat/service');
const { buildRouter } = require('./src/chat/api');

async function createApp(opts = {}) {
  const master = opts.master || loadMasterData();
  const svc = opts.svc || createChatService({ dataDir: opts.dataDir === undefined ? process.env.DATA_DIR || null : opts.dataDir, master, rates: loadRates(), now: opts.now, ocr: opts.ocr });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use('/api', express.json({ limit: '1mb' }), buildRouter(svc, { secureCookie: process.env.NODE_ENV === 'production' }));
  app.use('/samples', express.static(path.join(__dirname, 'samples')));
  app.use(express.static(path.join(__dirname, 'public')));
  if (opts.docflow !== false) {
    const { createApp: createDocflow } = require('./docflow');
    const { app: docflow } = await createDocflow();
    app.use('/docflow', docflow);
  }
  return { app, svc };
}

if (require.main === module) {
  createApp().then(async ({ app, svc }) => {
    if (process.env.DEMO === '1') require('./scripts/demo').seed(svc);
    const port = process.env.PORT || 3000;
    const server = app.listen(port, () => console.log(`Aeto Connect running on http://localhost:${port}${process.env.DEMO === '1' ? ' (demo data loaded)' : ''}`));
    const stop = () => { svc.flush(); server.close(() => process.exit(0)); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  });
}

module.exports = { createApp };
