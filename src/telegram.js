// src/telegram.js
const fetch = require("node-fetch");
const pdfParse = require("pdf-parse");
const { parse } = require("csv-parse/sync");

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

const ADM_CHAT_ID = Number(process.env.ADM_CHAT_ID);
const PROD_CHAT_ID = Number(process.env.PROD_CHAT_ID);

let pendingConfirmations = {};

function isAllowedChat(chatId) {
  return chatId === ADM_CHAT_ID || chatId === PROD_CHAT_ID;
}

async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// ================= BAIXAR ARQUIVO DO TELEGRAM =================
async function downloadFile(fileId) {
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  const data = await res.json();
  const filePath = data.result.file_path;

  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const fileBuffer = await fetch(fileUrl).then(r => r.buffer());

  return fileBuffer;
}

// ================= ANALISAR DOCUMENTO COM IA =================
async function analyzeDocumentWithAI(content) {
  const prompt = `
Você é a IA financeira de uma empresa.
Analise os dados abaixo (extrato, planilha ou documento financeiro) e responda de forma OBJETIVA:

1) Tipo de documento
2) Total de entradas (receitas)
3) Total de saídas (despesas)
4) Situação financeira geral
5) Ação estratégica recomendada

Dados:
${content.slice(0, 6000)}
`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      input: prompt,
    }),
  });

  const data = await response.json();
  return data.output?.[0]?.content?.[0]?.text || "Documento analisado.";
}

// ================= HANDLER PRINCIPAL =================
async function handleTelegramUpdate(update, db) {
  try {
    if (!update.message) return;

    const msg = update.message;
    const chatId = msg.chat.id;

    if (!isAllowedChat(chatId)) return;

    // ================= CONFIRMAÇÃO =================
    if (msg.text && pendingConfirmations[chatId]) {
      const text = msg.text.toLowerCase();

      if (text.includes("sim")) {
        const pending = pendingConfirmations[chatId];

        await db.exec(
          `INSERT INTO events (chat_id, text, tag) VALUES ($1,$2,$3)`,
          [chatId, pending.rawData, "FINANCEIRO_IMPORTADO"]
        );

        await db.exec(
          `INSERT INTO financial_records (type, description, amount, source)
           VALUES ($1,$2,$3,$4)`,
          ["documento", "Dados financeiros importados pela IA", 0, "csv/pdf"]
        );

        delete pendingConfirmations[chatId];

        await sendMessage(
          chatId,
          "Confirmado. Dados financeiros organizados, estruturados e salvos no sistema."
        );
        return;
      } else {
        delete pendingConfirmations[chatId];
        await sendMessage(chatId, "Operação cancelada. Nenhum dado foi salvo.");
        return;
      }
    }

    // ================= SE FOR DOCUMENTO (CSV/PDF) =================
    if (msg.document) {
      const fileName = (msg.document.file_name || "").toLowerCase();
      const mimeType = msg.document.mime_type || "";

      await sendMessage(chatId, "Documento recebido. Iniciando leitura e interpretação...");

      const buffer = await downloadFile(msg.document.file_id);

      let extractedText = "";

      // PDF
      if (fileName.endsWith(".pdf") || mimeType.includes("pdf")) {
        const pdfData = await pdfParse(buffer);
        extractedText = pdfData.text;
      }

      // CSV (CORREÇÃO CRÍTICA)
      else if (fileName.endsWith(".csv") || mimeType.includes("csv") || mimeType.includes("excel")) {
        const csvText = buffer.toString("utf-8");
        const records = parse(csvText, { skip_empty_lines: true });
        extractedText = JSON.stringify(records.slice(0, 100));
      } else {
        extractedText = buffer.toString("utf-8").slice(0, 5000);
      }

      const analysis = await analyzeDocumentWithAI(extractedText);

      pendingConfirmations[chatId] = {
        rawData: extractedText,
      };

      await sendMessage(
        chatId,
        `Análise concluída:\n\n${analysis}\n\nDeseja que eu organize e lance esses dados financeiros no sistema? (sim/não)`
      );

      return;
    }

    // ================= TEXTO NORMAL =================
    if (msg.text) {
      const text = msg.text;

      await db.exec(
        `INSERT INTO events (chat_id, text, tag) VALUES ($1,$2,$3)`,
        [chatId, text, "MENSAGEM_EMPRESARIAL"]
      );

      const prompt = `
Você é a IA gerente estratégica da empresa.
Responda sempre:
- Curto
- Inteligente
- Natural
- Estratégico
- Máximo 3 linhas
Mensagem: ${text}
`;

      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.4,
          input: prompt,
        }),
      });

      const data = await response.json();
      const reply =
        data.output?.[0]?.content?.[0]?.text ||
        "Entendido. Analisando contexto estratégico.";

      await sendMessage(chatId, reply);
    }
  } catch (err) {
    console.error("Erro IA completa:", err);
  }
}

module.exports = { handleTelegramUpdate };
