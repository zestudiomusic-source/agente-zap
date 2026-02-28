// src/pdf.js (PDF simples local)
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

async function generateSimplePDF(title, lines = []) {
  const outDir = path.join(process.cwd(), "tmp");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const filePath = path.join(outDir, `doc_${Date.now()}.pdf`);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const stream = fs.createWriteStream(filePath);

    doc.pipe(stream);
    doc.fontSize(18).text(title);
    doc.moveDown();

    doc.fontSize(12);
    for (const l of lines) doc.text(String(l));

    doc.end();

    stream.on("finish", () => resolve(filePath));
    stream.on("error", reject);
  });
}

module.exports = { generateSimplePDF };
