require('dotenv').config();

const express = require('express');
const { createDb } = require('./src/db');
const { createTelegramBot } = require('./src/telegram/bot');

async function main() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Basic health
  app.get('/', (req, res) => res.status(200).send('OK'));
  app.get('/health', (req, res) => res.status(200).json({ ok: true }));

  // Cron endpoints (optional)
  const CRON_TOKEN = process.env.CRON_TOKEN || '';
  function cronAuth(req, res, next) {
    if (!CRON_TOKEN) return res.status(400).json({ ok: false, error: 'CRON_TOKEN not configured' });
    const token = req.header('x-cron-token') || req.query.token;
    if (token !== CRON_TOKEN) return res.status(401).json({ ok: false, error: 'unauthorized' });
    next();
  }

  app.get('/cron/status', cronAuth, async (req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  // DB init
  const db = await createDb();
  console.log('[DB] Schema do banco inicializado com sucesso.');

  // Telegram bot
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  if (!BOT_TOKEN) {
    console.error('FATAL: TELEGRAM_BOT_TOKEN (ou BOT_TOKEN) não configurado!');
    process.exit(1);
  }

  const bot = createTelegramBot({ token: BOT_TOKEN, db });

  // Expose bot (debug)
  app.get('/debug/bot', cronAuth, async (req, res) => {
    const me = await bot.getMe();
    res.json({ ok: true, me });
  });

  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, () => {
    console.log(`[SERVER] ✅ Web Service online na porta ${PORT}`);
  });
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
