const { processMessage } = require("./workflow");

function envInt(name, required = true) {
  const v = process.env[name];
  if (!v && required) throw new Error(`${name} não configurado`);
  if (!v) return null;
  return Number(v);
}

function envStr(name, required = true) {
  const v = process.env[name];
  if (!v && required) throw new Error(`${name} não configurado`);
  return v || null;
}

function makeTelegram({ db }) {
  const BOT_TOKEN = envStr("BOT_TOKEN");
  const TELEGRAM_ADMIN_ID = envInt("TELEGRAM_ADMIN_ID");
  const ADM_CHAT_ID = envInt("ADM_CHAT_ID");
  const PROD_CHAT_ID = envInt("PROD_CHAT_ID");

  const apiBase = `https://api.telegram.org/bot${BOT_TOKEN}`;

  async function api(method, body) {
    const r = await fetch(`${apiBase}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Telegram API ${method} ${r.status}: ${t}`);
    }
    return r.json();
  }

  async function sendMessage(chatId, text, extra = {}) {
    return api("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    });
  }

  async function getFileLink(fileId) {
    const data = await api("getFile", { file_id: fileId });
    const filePath = data?.result?.file_path;
    if (!filePath) throw new Error("Não consegui pegar file_path do Telegram");
    return `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  }

  function isOurChat(chatId) {
    return chatId === ADM_CHAT_ID || chatId === PROD_CHAT_ID;
  }

  function chatLabel(chatId) {
    return chatId === ADM_CHAT_ID ? "ADM" : chatId === PROD_CHAT_ID ? "PRODUÇÃO" : "OUTRO";
  }

  async function handleUpdate(update) {
    const msg = update.message || update.edited_message;
    if (!msg) return;

    const chatId = msg.chat?.id;
    if (!chatId || !isOurChat(chatId)) return;

    const fromId = msg.from?.id;
    const fromName =
      [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ").trim() ||
      (msg.from?.username ? `@${msg.from.username}` : "desconhecido");
    const text = msg.text || msg.caption || "";

    await processMessage({
      db,
      tg: { sendMessage, getFileLink },
      message: {
        chatId,
        chatLabel: chatLabel(chatId),
        fromId,
        fromName,
        messageId: msg.message_id,
        text,
        doc: msg.document || null,
      },
      context: { TELEGRAM_ADMIN_ID, ADM_CHAT_ID, PROD_CHAT_ID },
    });
  }

  return { handleUpdate, sendMessage, ADM_CHAT_ID, PROD_CHAT_ID };
}

module.exports = { makeTelegram };
