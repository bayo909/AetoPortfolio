// Extracts text from an uploaded file and splits it into line items (kept in memory only).
const path = require('path');

const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
const strip = s => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

async function docxToLines(buffer) {
  const mammoth = require('mammoth');
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const out = [];
  const re = /<(p|h[1-6]|li|tr)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] === 'tr') {
      const cells = m[2].split(/<\/t[dh]>/).map(strip).filter(Boolean);
      if (cells.length) out.push(cells.join(' | '));
    } else {
      // <br /> inside a paragraph is a line break
      m[2].split(/<br\s*\/?>/).map(strip).forEach(t => t && out.push(t));
    }
  }
  return out;
}

async function pdfToLines(buffer) {
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  const { text } = await pdfParse(buffer);
  return text.split(/\r?\n/);
}

function isNoise(t) {
  return t.length < 3 || /^[\W_\d\s]+$/.test(t) || /^page \d+( of \d+)?$/i.test(t);
}

async function extractLines(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  let raw;
  if (ext === '.docx') raw = await docxToLines(buffer);
  else if (ext === '.pdf') raw = await pdfToLines(buffer);
  else if (['.txt', '.md', '.csv', '.tsv', '.log', ''].includes(ext)) raw = buffer.toString('utf8').split(/\r?\n/);
  else throw Object.assign(new Error(`Unsupported file type "${ext}". Upload .docx, .pdf, .txt, .md or .csv.`), { status: 415 });
  const lines = [];
  for (const r of raw) {
    const text = r.replace(/\s+/g, ' ').trim().replace(/^[-•*●▪◦]\s*/, '');
    if (isNoise(text)) continue;
    lines.push({ n: lines.length + 1, text });
  }
  return lines;
}

module.exports = { extractLines };
