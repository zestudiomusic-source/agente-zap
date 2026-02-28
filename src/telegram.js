// src/telegram.js
const fetch = require("node-fetch");
const pdfParse = require("pdf-parse");
const { parse } = require("csv-parse/sync");

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

const ADM_CHAT_ID = Number(process.env.ADM_CHAT_ID);
const PROD_CHAT_ID = Number(process.env.PROD_CHAT_ID);

let pendingConfirmations = {}; // memória temporária de confirmações

async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

function isAllowedChat(chatId) {
  return chatId === ADM_CHAT_ID || chatId === PROD_CHAT_ID;
}

// ================= BAIXAR ARQUIVO DO TELEGRAM =================
async function downloadFile(fileId) {
  const fileRes = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  const fileData = await fileRes.json();
  const filePath = fileData.result.file_path;

  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const fileBuffer = await fetch(fileUrl).then((res) => res.buffer());
  return { buffer: fileBuffer, filePath };
}

// ================= INTERPRETAR DOCUMENTO =================
async function interpretDocument(text) {
  const prompt = `
Você é uma IA financeira e administrativa de uma empresa.
Analise o documento abaixo e identifique:
- Se é extrato bancário
- Entradas (receitas)
- Saídas (despesas)
- Totais financeiros
- Ações recomendadas

Documento:
${text}

Responda de forma curta e estratégica.
`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      input: prompt,
      temperature: 0.2,
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

    // ================= CONFIRMAÇÃO DE AÇÕES =================
    if (msg.text && pendingConfirmations[chatId]) {
      const lower = msg.text.toLowerCase();
      if (lower.includes("sim")) {
        const action = pendingConfirmations[chatId];

        await db.exec(
          `INSERT INTO events (chat_id, text, tag)
           VALUES ($1,$2,$3)`,
          [chatId, action.data, action.tag]
        );

        delete pendingConfirmations[chatId];
        await sendMessage(chatId, "Confirmado. Dados organizados e salvos no sistema.");
        return;
      } else {
        delete pendingConfirmations[chatId];
        await sendMessage(chatId, "Ação cancelada. Nenhum dado foi salvo.");
        return;
      }
    }

    // ================= RECEBE DOCUMENTOS (PDF/CSV) =================
    if (msg.document) {
      const fileName = msg.document.file_name.toLowerCase();
      const { buffer } = await downloadFile(msg.document.file_id);

      let extractedText = "";

      if (fileName.endsWith(".pdf")) {
        const data = await pdfParse(buffer);
        extractedText = data.text;
      }

      if (fileName.endsWith(".csv")) {
        const records = parse(buffer.toString(), { columns: false });
        extractedText = JSON.stringify(records.slice(0, 50));
      }

      const analysis = await interpretDocument(extractedText);

      pendingConfirmations[chatId] = {
        data: extractedText.substring(0, 5000),
        tag: "DOCUMENTO_FINANCEIRO",
      };

      await sendMessage(
        chatId,
        `Documento analisado.\n\n${analysis}\n\nConfirmar organização e lançamento dos dados no sistema? (sim/não)`
      );
      return;
    }

    // ================= MENSAGEM TEXTO NORMAL =================
    if (msg.text) {
      await db.exec(
        `INSERT INTO events (chat_id, text, tag)
         VALUES ($1,$2,$3)`,
        [chatId, msg.text, "MENSAGEM"]
      );

      const aiPrompt = `
Você é a IA gerente completa da empresa.
Responda sempre:
- Curta
- Inteligente
- Estratégica
- Humana (não robótica)
- Máximo 3 linhas

Mensagem do dono:
${msg.text}
`;

      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          input: aiPrompt,
          temperature: 0.4,
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
