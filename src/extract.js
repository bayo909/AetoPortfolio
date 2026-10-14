// Text extraction for uploaded files: text/docx/pdf natively, images and scanned PDFs through OCR.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { ocrImage } = require('./ocr');

const execFileP = promisify(execFile);
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.bmp', '.webp'];
const TEXT_EXT = ['.txt', '.md', '.csv', '.tsv', '.log', ''];
const MAX_OCR_PAGES = 6;

const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
const strip = s => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

async function docxHtml(buffer) {
  const mammoth = require('mammoth');
  return (await mammoth.convertToHtml({ buffer })).value;
}

function htmlToLines(html) {
  const out = [];
  const re = /<(p|h[1-6]|li|tr)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] === 'tr') {
      const cells = m[2].split(/<\/t[dh]>/).map(strip).filter(Boolean);
      if (cells.length) out.push(cells.join(' | '));
    } else m[2].split(/<br\s*\/?>/).map(strip).forEach(t => t && out.push(t));
  }
  return out;
}

/** Text layer of a PDF, rebuilt into lines from text-item positions (pdf.js). */
async function pdfText(buffer) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false, verbosity: 0 }).promise;
  const out = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const { items } = await page.getTextContent();
      const rows = [];
      for (const it of items) {
        if (!it.str || !it.str.trim()) continue;
        const y = Math.round(it.transform[5]);
        const row = rows.find(r => Math.abs(r.y - y) <= 2);
        if (row) row.items.push(it); else rows.push({ y, items: [it] });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) out.push(r.items.sort((a, b) => a.transform[4] - b.transform[4]).map(i => i.str).join(' ').replace(/\s+/g, ' ').trim());
    }
  } finally { await doc.destroy(); }
  return out.join('\n');
}

/** Scanned PDF -> PNG pages with poppler's pdftoppm (if installed) -> OCR. */
async function ocrPdf(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docflow-pdf-'));
  try {
    fs.writeFileSync(path.join(dir, 'in.pdf'), buffer);
    try {
      await execFileP('pdftoppm', ['-png', '-r', '200', '-l', String(MAX_OCR_PAGES), path.join(dir, 'in.pdf'), path.join(dir, 'page')]);
    } catch (e) {
      throw Object.assign(new Error('This PDF has no text layer and pdftoppm (poppler-utils) is not installed to render it for OCR.'), { status: 422 });
    }
    const pages = fs.readdirSync(dir).filter(f => f.startsWith('page') && f.endsWith('.png')).sort();
    const texts = []; const confs = [];
    for (const f of pages) { const r = await ocrImage(path.join(dir, f)); texts.push(r.text); confs.push(r.confidence); }
    return { text: texts.join('\n'), confidence: confs.length ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length) : 0 };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const isNoise = t => t.length < 3 || /^[\W_\d\s]+$/.test(t) || /^page \d+( of \d+)?$/i.test(t);
function clean(rawLines) {
  const lines = [];
  for (const r of rawLines) {
    const text = r.replace(/\s+/g, ' ').trim().replace(/^[-•*●▪◦]\s*/, '');
    if (!isNoise(text)) lines.push({ n: lines.length + 1, text });
  }
  return lines;
}

/** @returns {Promise<{lines: {n:number,text:string}[], method: 'text'|'ocr', ocrConfidence: number|null}>} */
async function extractDocument(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  let raw, method = 'text', ocrConfidence = null;
  if (ext === '.docx') raw = htmlToLines(await docxHtml(buffer));
  else if (ext === '.pdf') {
    const text = await pdfText(buffer);
    if (text.replace(/\s+/g, '').length >= 30) raw = text.split(/\r?\n/);
    else { const r = await ocrPdf(buffer); raw = r.text.split(/\r?\n/); method = 'ocr'; ocrConfidence = r.confidence; }
  } else if (IMAGE_EXT.includes(ext)) {
    const r = await ocrImage(buffer); raw = r.text.split(/\r?\n/); method = 'ocr'; ocrConfidence = r.confidence;
  } else if (TEXT_EXT.includes(ext)) raw = buffer.toString('utf8').split(/\r?\n/);
  else throw Object.assign(new Error(`Unsupported file type "${ext}". Upload .pdf, .docx, an image (.png/.jpg), .txt, .md or .csv.`), { status: 415 });
  return { lines: clean(raw), method, ocrConfidence };
}

const MIME = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.txt': 'text/plain', '.md': 'text/plain', '.csv': 'text/plain', '.tsv': 'text/plain' };
const mimeFor = filename => MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream';

module.exports = { extractDocument, docxHtml, mimeFor, IMAGE_EXT };
