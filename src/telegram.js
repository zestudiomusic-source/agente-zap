// src/telegram.js
const fetch = require("node-fetch");
const pdfParse = require("pdf-parse");
const { parse } = require("csv-parse/sync");

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

const ADM_CHAT_ID = Number(process.env.ADM_CHAT_ID);
const PROD_CHAT_ID = Number(process.env.PROD_CHAT_ID);

let pendingActions = {};

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

async function callAI(system, user) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  const data = await res.json();
  return data.output?.[0]?.content?.[0]?.text || "Análise concluída.";
}

async function extractDocument(buffer, fileName) {
  if (fileName.endsWith(".pdf")) {
    const data = await pdfParse(buffer);
    return data.text;
  }
  if (fileName.endsWith(".csv")) {
    const records = parse(buffer.toString());
    return JSON.stringify(records.slice(0, 100));
  }
  return "";
}

async function handleTelegramUpdate(update, db) {
  try {
    if (!update.message) return;

    const msg = update.message;
    const chatId = msg.chat.id;

    if (!isAllowedChat(chatId)) return;

    // Confirmação de ações inteligentes
    if (msg.text && pendingActions[chatId]) {
      if (msg.text.toLowerCase().includes("sim")) {
        const action = pendingActions[chatId];

        if (action.type === "financial") {
          await db.exec(
            `INSERT INTO financial_records (type, description, amount, source)
             VALUES ($1,$2,$3,$4)`,
            ["auto", "Dados importados por IA", 0, "documento"]
          );
        }

        if (action.type === "rule") {
          await db.exec(
            `INSERT INTO ai_rules (rule) VALUES ($1)`,
            [action.data]
          );
        }

        delete pendingActions[chatId];
        await sendMessage(chatId, "Confirmado. Organização executada e sistema atualizado.");
        return;
      } else {
        delete pendingActions[chatId];
        await sendMessage(chatId, "Entendido. Nenhuma alteração foi aplicada.");
        return;
      }
    }

    // Recebe documentos
    if (msg.document) {
      const fileId = msg.document.file_id;
      const fileRes = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`
      );
      const fileData = await fileRes.json();
      const filePath = fileData.result.file_path;

      const fileBuffer = await fetch(
        `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`
      ).then((r) => r.buffer());

      const content = await extractDocument(fileBuffer, msg.document.file_name.toLowerCase());

      const analysis = await callAI(
        "Você é uma IA empresarial que analisa documentos financeiros e administrativos.",
        `Analise este documento e identifique dados financeiros, decisões e organização necessária:\n${content}`
      );

      pendingActions[chatId] = { type: "financial", data: content };

      await sendMessage(
        chatId,
        `${analysis}\n\nDeseja que eu organize, estruture e salve os dados no sistema financeiro? (sim/não)`
      );
      return;
    }

    // Texto normal (memória + inteligência)
    if (msg.text) {
      await db.exec(
        `INSERT INTO events (chat_id, text, tag) VALUES ($1,$2,$3)`,
        [chatId, msg.text, "MEMORIA"]
      );

      const aiReply = await callAI(
        `Você é a IA autônoma da empresa.
        Pode criar ferramentas, organizar dados, aprender regras e gerir o negócio.
        Sempre responda de forma curta, humana, estratégica e inteligente.`,
        msg.text
      );

      // Detecta ordem administrativa automaticamente
      if (msg.text.toLowerCase().includes("a partir de agora") ||
          msg.text.toLowerCase().includes("ordem") ||
          msg.text.toLowerCase().includes("regra")) {

        pendingActions[chatId] = { type: "rule", data: msg.text };

        await sendMessage(
          chatId,
          `${aiReply}\n\nDeseja salvar isso como regra permanente da empresa? (sim/não)`
        );
        return;
      }

      await sendMessage(chatId, aiReply);
    }
  } catch (err) {
    console.error("Erro IA autônoma:", err);
  }
}

module.exports = { handleTelegramUpdate };
