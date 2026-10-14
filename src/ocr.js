// Offline OCR (tesseract.js, English data shipped via @tesseract.js-data/eng). One shared worker, jobs serialised.
const path = require('path');
const os = require('os');

let workerPromise = null;
let chain = Promise.resolve();

function langPath() {
  const pkg = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'));
  return path.join(pkg, '4.0.0_best_int');
}

function getWorker() {
  if (!workerPromise) {
    const { createWorker } = require('tesseract.js');
    workerPromise = createWorker('eng', 1, { langPath: langPath(), gzip: true, cachePath: path.join(os.tmpdir(), 'docflow-tesseract') })
      .catch(e => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

/** @returns {Promise<{text: string, confidence: number}>} confidence 0-100 */
function ocrImage(input) {
  const job = chain.then(async () => {
    const w = await getWorker();
    const { data } = await w.recognize(input);
    return { text: data.text || '', confidence: Math.round(data.confidence || 0) };
  });
  chain = job.catch(() => {});
  return job;
}

async function shutdown() {
  if (!workerPromise) return;
  const w = await workerPromise.catch(() => null);
  workerPromise = null;
  if (w) await w.terminate();
}

module.exports = { ocrImage, shutdown };
