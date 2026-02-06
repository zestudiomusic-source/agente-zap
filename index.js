const express = require("express");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

// ============
// 1) CONFIG
// ============
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("ERRO: BOT_TOKEN não encontrado. Configure no Render (Environment).");
  process.exit(1);
}

const ADMIN_ID = Number(process.env.TELEGRAM_ADMIN_ID || 0);
if (!ADMIN_ID) {
  console.error("ERRO: TELEGRAM_ADMIN_ID não encontrado. Configure no Render (Environment).");
  process.exit(1);
}

const PORT = process.env.PORT || 3000;

// Base path: em produção (Render) prefira /tmp (gravável). Local pode usar ./db
const isRender = !!process.env.RENDER;
const dbPath = isRender
  ? path.join("/tmp", "bot.db")
  : path.join(__dirname, "db", "bot.db");

if (!isRender) {
  const dbDir = path.join(__dirname, "db");
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// ============
// 2) BANCO
// ============
db.exec(`
CREATE TABLE IF NOT EXISTS chat_state (
  chat_id INTEGER PRIMARY KEY,
  category TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  telegram_user_id INTEGER NOT NULL,
  username TEXT,
  first_name TEXT,
  text TEXT,
  category TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_id, created_at);
`);

const upsertChatState = db.prepare(`
INSERT INTO chat_state (chat_id, category)
VALUES (@chat_id, @category)
ON CONFLICT(chat_id) DO UPDATE SET
  category = excluded.category,
  updated_at = datetime('now')
`);

const getChatState = db.prepare(`SELECT category FROM chat_state WHERE chat_id = ?`);

const insertMessage = db.prepare(`
INSERT INTO messages (chat_id, telegram_user_id, username, first_name, text, category)
VALUES (@chat_id, @telegram_user_id, @username, @first_name, @text, @category)
`);

const getLastMessages = db.prepare(`
SELECT created_at, category, text
FROM messages
WHERE chat_id = ?
ORDER BY id DESC
LIMIT ?
`);

// ============
// 3) TELEGRAM HELPERS
// ============
async function tgSendMessage(chatId, text, extra = {}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
    ...extra,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("Erro sendMessage:", res.status, body);
    return false;
  }
  return true;
}

function adminOnly(fromId) {
  return Number(fromId) === ADMIN_ID;
}

function menuKeyboard() {
  return {
    keyboard: [
      [{ text: "Financeiro" }, { text: "Produção" }, { text: "Vendas" }],
      [{ text: "/status" }, { text: "/ultimas" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

// ============
// 4) APP / ROTAS
// ============
const app = express();
app.use(express.json());

// Healthcheck
app.get("/", (req, res) => res.status(200).send("OK - bot rodando"));

// Webhook (Telegram manda UPDATE via POST aqui)
app.post("/telegram/webhook", async (req, res) => {
  try {
    const update = req.body;
    res.sendStatus(200); // responde rápido pro Telegram

    const msg = update.message;
    if (!msg || !msg.text) return;

    const chatId = msg.chat?.id;
    const from = msg.from || {};
    const fromId = from.id;

    // ✅ Opção A: só admin usa
    if (!adminOnly(fromId)) {
      return;
    }

    const text = String(msg.text || "").trim();

    if (text === "/start") {
      await tgSendMessage(
        chatId,
        "Oi! Eu sou seu ADM. Use /menu para escolher Financeiro, Produção ou Vendas."
      );
      return;
    }

    if (text === "/menu") {
      await tgSendMessage(chatId, "Escolha uma área:", {
        reply_markup: menuKeyboard(),
      });
      return;
    }

    if (text === "/status") {
      const state = getChatState.get(chatId);
      const current = state?.category || "Nenhuma (use /menu)";
      await tgSendMessage(chatId, `Categoria atual: ${current}`);
      return;
    }

    if (text === "/ultimas") {
      const rows = getLastMessages.all(chatId, 10);
      if (!rows.length) {
        await tgSendMessage(chatId, "Ainda não tem mensagens salvas.");
        return;
      }
      const lines = rows
        .map((r) => `• [${r.created_at}] (${r.category || "Sem categoria"}) ${r.text}`)
        .join("\n");
      await tgSendMessage(chatId, `Últimas 10:\n${lines}`);
      return;
    }

    const lower = text.toLowerCase();
    if (lower === "financeiro" || lower === "produção" || lower === "producao" || lower === "vendas") {
      const cat =
        lower === "producao" ? "Produção" :
        lower === "produção" ? "Produção" :
        lower === "financeiro" ? "Financeiro" :
        "Vendas";

      upsertChatState.run({ chat_id: chatId, category: cat });
      await tgSendMessage(chatId, `Categoria definida: ${cat}`);
      return;
    }

    const state = getChatState.get(chatId);
    const category = state?.category || null;

    insertMessage.run({
      chat_id: chatId,
      telegram_user_id: fromId,
      username: from.username || null,
      first_name: from.first_name || null,
      text,
      category,
    });

    await tgSendMessage(chatId, `Salvo (${category || "Sem categoria"})`);
  } catch (err) {
    console.error("Erro no webhook:", err);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`DB em: ${dbPath}`);
  console.log(`ADMIN_ID: ${ADMIN_ID}`);
});
