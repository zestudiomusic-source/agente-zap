const pdf = require("pdf-parse");
const { parse } = require("csv-parse/sync");

async function downloadToBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Falha ao baixar arquivo: ${r.status}`);
  const arr = await r.arrayBuffer();
  return Buffer.from(arr);
}

function safeSlice(s, max = 40000) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "\n...[cortado]" : s;
}

async function extractTextFromFile({ fileUrl, fileName, mimeType }) {
  const buf = await downloadToBuffer(fileUrl);

  if (mimeType === "application/pdf" || (fileName && fileName.toLowerCase().endsWith(".pdf"))) {
    const data = await pdf(buf);
    return safeSlice(data.text || "");
  }

  if (mimeType === "text/csv" || (fileName && fileName.toLowerCase().endsWith(".csv"))) {
    const text = buf.toString("utf8");
    const records = parse(text, { columns: true, skip_empty_lines: true });
    const headers = records[0] ? Object.keys(records[0]) : [];
    const preview = records.slice(0, 30);
    return safeSlice(
      `CSV HEADERS: ${headers.join(", ")}\nCSV PREVIEW (até 30 linhas):\n` +
        preview.map((row, i) => `${i + 1}. ` + headers.map((h) => `${h}=${String(row[h] ?? "")}`).join(" | ")).join("\n")
    );
  }

  return safeSlice(buf.toString("utf8"));
}

module.exports = { extractTextFromFile };
