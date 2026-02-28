// src/telegram.js
const fetch = require("node-fetch");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADM_CHAT_ID = Number(process.env.ADM_CHAT_ID);
const PROD_CHAT_ID = Number(process.env.PROD_CHAT_ID);

async function sendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }),
  });
}

function isAllowedChat(chatId) {
  return chatId === ADM_CHAT_ID || chatId === PROD_CHAT_ID;
}

async function handleTelegramUpdate(update, db) {
  try {
    if (!update.message) return;

    const msg = update.message;
    const chatId = msg.chat.id;
    const text = msg.text || "";

    // Ignorar chats fora do ADM e PRODUÇÃO
    if (!isAllowedChat(chatId)) return;

    // Salvar evento no banco (memória da IA)
    await db.exec(
      `INSERT INTO events (chat_id, chat_type, from_id, from_name, message_id, text, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        chatId,
        msg.chat.type,
        msg.from?.id || null,
        msg.from?.first_name || "unknown",
        msg.message_id,
        text,
        update,
      ]
    );

    // ===== CÉREBRO SIMPLES DA IA (resposta automática) =====
    if (!text) return;

    const lower = text.toLowerCase();

    // Mensagens operacionais importantes
    if (
      lower.includes("pedido") ||
      lower.includes("cliente") ||
      lower.includes("valor") ||
      lower.includes("orçamento") ||
      lower.includes("produção")
    ) {
      await sendMessage(
        chatId,
        `🧠 Interpretação da IA:
Mensagem operacional detectada.
Estou analisando e organizando o processo.`
      );
      return;
    }

    // Teste / mensagens comuns
    if (lower.includes("teste")) {
      await sendMessage(
        chatId,
        "✅ IA online e monitorando operações da empresa."
      );
      return;
    }

    // Bom dia / conversa simples (modo gerente silencioso)
    if (lower.includes("bom dia") || lower.includes("boa tarde") || lower.includes("boa noite")) {
      await sendMessage(
        chatId,
        "📊 IA ativa. Monitorando processos e decisões."
      );
      return;
    }

    // Resposta padrão inteligente (centralização total)
    await sendMessage(
      chatId,
      `🧠 Mensagem recebida e registrada.
Nenhuma ação operacional necessária no momento.`
    );
  } catch (error) {
    console.error("Erro no Telegram handler:", error);
  }
}

module.exports = { handleTelegramUpdate };
