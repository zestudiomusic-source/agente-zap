/**
 * server.js - Entry point do Web Service (Render)
 * - Inicializa config
 * - Conecta no PostgreSQL
 * - Inicializa Bot Telegram (polling ou webhook)
 * - Sobe Express para endpoints /cron/*
 */

const express = require('express');
const { loadConfig } = require('./src/config');
const { createDb } = require('./src/db');
const { createTelegramBot } = require('./src/telegram');
const { createCronRoutes } = require('./src/cron');
const { createLogger } = require('./src/logger');

const logger = createLogger('SERVER');

async function main() {
  const config = loadConfig();
  const db = await createDb(config);

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Bot
  const bot = await createTelegramBot({ config, db });
  app.locals.bot = bot;

  // Webhook (opcional)
  if (config.telegram.useWebhook) {
    const webhookPath = config.telegram.webhookPath || '/telegram/webhook';
    app.post(webhookPath, (req, res) => {
      try {
        bot.processUpdate(req.body);
        res.sendStatus(200);
      } catch (err) {
        logger.error('Erro no webhook do Telegram:', err.message);
        res.sendStatus(500);
      }
    });
    logger.info(`Webhook Telegram ativo em: ${webhookPath}`);
  } else {
    logger.info('Telegram em modo polling (recomendado para início).');
  }

  // Rotas CRON
  createCronRoutes(app, { config, db });

  // Health simples
  app.get('/', (req, res) => res.status(200).send('OK'));

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    logger.info(`✅ Web Service online na porta ${port}`);
  });
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
