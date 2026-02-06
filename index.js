require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json());

// =====================
// 1) CONFIG BÁSICA
// =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('ERRO: BOT_TOKEN não encontrado. Configure no .env ou no Render.');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;

// =====================
// 2) BANCO (SQLite)
// =====================
const dbDir = path.join(__dirname, 'db');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const dbPath = path.join(dbDir, 'bot.db');
const db = new Database(dbPath);

// Tabelas básicas (você pode evoluir depois)
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER,
  text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_user_time ON messages(telegram_user_id, created_at);
`);

const upsertUser = db.prepare(`
INSERT INTO users (telegram_user_id, username, first_name, last_name)
VALUES (@telegram_user_id, @username, @first_name, @last_name)
ON CONFLICT(telegram_user_id) DO UPDATE SET
  username=excluded.username,
  first_name=excluded.first_name,
  last_name=excluded.last_name
`);

const insertMessage = db.prepare(`
INSERT INTO messages (telegram_user_id, chat_id, message_id, text)
VALUES (@telegram_user_id, @chat_id, @message_id, @text)
`);

// =====================
// 3) FUNÇÃO: ENVIAR MSG
// =====================
async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('Erro sendMessage:', res.status, body);
    return false;
  }
  return true;
}

// =====================
// 4) ROTAS
// =====================

// Healthcheck (para você testar no browser)
app.get('/', (req, res) => {
  res.status(200).send('OK - bot rodando');
});

// IMPORTANTE:
// O Telegram envia UPDATE via POST no webhook.
// Se você abrir no navegador, vai dar "Cannot GET /telegram/webhook" (isso é normal).
app.post('/telegram/webhook', async (req, res) => {
  try {
    const update = req.body;

    // Responde rápido pro Telegram (boa prática)
    res.sendStatus(200);

    // Só processa mensagens de texto
    const msg = update.message;
    if (!msg || !msg.text) return;

    const chatId = msg.chat.id;
    const from = msg.from || {};

    // Salva/atualiza usuário
    upsertUser.run({
      telegram_user_id: from.id,
      username: from.username || null,
      first_name: from.first_name || null,
      last_name: from.last_name || null
    });

    // Salva mensagem
    insertMessage.run({
      telegram_user_id: from.id,
      chat_id: chatId,
      message_id: msg.message_id || null,
      text: msg.text
    });

    // Resposta simples (teste)
    // Depois trocamos por "menu" / financeiro / produção / vendas
    if (msg.text.toLowerCase() === '/start') {
      await sendTelegramMessage(chatId, 'Oi! Eu sou o ADM. Envie uma mensagem e eu registro no banco.');
      return;
    }

    await sendTelegramMessage(chatId, `Recebi: ${msg.text}`);
  } catch (err) {
    console.error('Erro no webhook:', err);
    // Mesmo com erro, a resposta pro Telegram já foi enviada.
  }
});

// =====================
// 5) START
// =====================
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log('DB em:', dbPath);
});


