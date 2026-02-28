/**
 * src/cron.js - Endpoints para tarefas agendadas (Render Cron Jobs)
 * Versão 2.1 - PostgreSQL (async) + rate limiting, logs e validações
 */

const { runDailyWork, runCleanup } = require('./reports');
const { createLogger } = require('./logger');

const logger = createLogger('CRON');

// Rate limiting simples em memória
const requestLog = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minuto
const MAX_REQUESTS_PER_WINDOW = 10;

function rateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();

  for (const [key, timestamp] of requestLog.entries()) {
    if (now - timestamp > RATE_LIMIT_WINDOW) requestLog.delete(key);
  }

  const requests = Array.from(requestLog.entries())
    .filter(([key]) => key.startsWith(ip))
    .length;

  if (requests >= MAX_REQUESTS_PER_WINDOW) {
    logger.warn(`Rate limit excedido para ${ip}`);
    return res.status(429).json({
      error: 'Too Many Requests',
      message: `Máximo de ${MAX_REQUESTS_PER_WINDOW} requisições por minuto`
    });
  }

  requestLog.set(`${ip}_${now}`, now);
  next();
}

function createCronRoutes(app, { config, db }) {
  function requireCronToken(req, res, next) {
    const token = req.headers['x-cron-token'] || req.query.token;

    if (!token) {
      logger.warn('Tentativa de acesso sem token');
      return res.status(401).json({
        error: 'Autenticação obrigatória',
        message: 'Envie o token via header X-Cron-Token ou query param ?token=...'
      });
    }

    if (token !== config.cron.token) {
      logger.warn(`Token inválido recebido: ${token.substring(0, 8)}...`);
      return res.status(403).json({
        error: 'Token inválido',
        message: 'O token fornecido não é válido'
      });
    }

    next();
  }

  app.post('/cron/daily', rateLimiter, requireCronToken, async (req, res) => {
    const requestId = `daily_${Date.now()}`;
    logger.info(`[${requestId}] Iniciando tarefa diária...`);
    const startTime = Date.now();

    try {
      const bot = req.app.locals.bot;
      if (!bot) throw new Error('Bot do Telegram não disponível');

      try { await bot.getMe(); } catch (err) {
        throw new Error(`Bot não está respondendo: ${err.message}`);
      }

      const result = await runDailyWork({ config, db, bot, mode: 'cron' });
      const elapsed = Date.now() - startTime;

      if (!result.success) throw new Error(result.summary || 'Erro desconhecido');

      logger.info(`[${requestId}] ✅ Tarefa diária concluída em ${elapsed}ms`);

      await db.prepare(`
        INSERT INTO logs (created_at, level, module, message, meta_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        new Date().toISOString(),
        'info',
        'cron_daily',
        'Tarefa diária executada com sucesso',
        JSON.stringify({ elapsed_ms: elapsed, summary: result.summary })
      );

      return res.status(200).json({
        success: true,
        message: 'Relatório diário gerado com sucesso',
        summary: result.summary,
        elapsed_ms: elapsed,
        request_id: requestId
      });

    } catch (err) {
      const elapsed = Date.now() - startTime;
      logger.error(`[${requestId}] ❌ Erro na tarefa diária:`, err.message);

      try {
        await db.prepare(`
          INSERT INTO logs (created_at, level, module, message, meta_json)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          new Date().toISOString(),
          'error',
          'cron_daily',
          `Erro na tarefa diária: ${err.message}`,
          JSON.stringify({ elapsed_ms: elapsed, error: err.message, stack: err.stack })
        );
      } catch {}

      return res.status(500).json({
        success: false,
        error: err.message,
        elapsed_ms: elapsed,
        request_id: requestId
      });
    }
  });

  app.post('/cron/weekly', rateLimiter, requireCronToken, async (req, res) => {
    const requestId = `weekly_${Date.now()}`;
    logger.info(`[${requestId}] Iniciando tarefa semanal...`);
    const startTime = Date.now();

    try {
      const bot = req.app.locals.bot;
      if (!bot) throw new Error('Bot do Telegram não disponível');

      const result = await runDailyWork({ config, db, bot, mode: 'weekly' });
      const elapsed = Date.now() - startTime;

      if (!result.success) throw new Error(result.summary || 'Erro desconhecido');

      logger.info(`[${requestId}] ✅ Tarefa semanal concluída em ${elapsed}ms`);

      await db.prepare(`
        INSERT INTO logs (created_at, level, module, message, meta_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        new Date().toISOString(),
        'info',
        'cron_weekly',
        'Tarefa semanal executada com sucesso',
        JSON.stringify({ elapsed_ms: elapsed, summary: result.summary })
      );

      return res.status(200).json({
        success: true,
        message: 'Relatório semanal gerado com sucesso',
        summary: result.summary,
        elapsed_ms: elapsed,
        request_id: requestId
      });

    } catch (err) {
      const elapsed = Date.now() - startTime;
      logger.error(`[${requestId}] ❌ Erro na tarefa semanal:`, err.message);

      try {
        await db.prepare(`
          INSERT INTO logs (created_at, level, module, message, meta_json)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          new Date().toISOString(),
          'error',
          'cron_weekly',
          `Erro na tarefa semanal: ${err.message}`,
          JSON.stringify({ elapsed_ms: elapsed, error: err.message })
        );
      } catch {}

      return res.status(500).json({
        success: false,
        error: err.message,
        elapsed_ms: elapsed,
        request_id: requestId
      });
    }
  });

  app.post('/cron/cleanup', rateLimiter, requireCronToken, async (req, res) => {
    const requestId = `cleanup_${Date.now()}`;
    logger.info(`[${requestId}] Iniciando limpeza...`);
    const startTime = Date.now();

    try {
      const bot = req.app.locals.bot;
      if (!bot) throw new Error('Bot do Telegram não disponível');

      const result = await runCleanup({ config, db, bot, mode: 'cron' });
      const elapsed = Date.now() - startTime;

      logger.info(`[${requestId}] ✅ Limpeza concluída em ${elapsed}ms`);

      await db.prepare(`
        INSERT INTO logs (created_at, level, module, message, meta_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        new Date().toISOString(),
        'info',
        'cron_cleanup',
        'Limpeza executada com sucesso',
        JSON.stringify({
          elapsed_ms: elapsed,
          removed: result.removed,
          errors: result.errors,
          cache_cleared: result.cacheCleared
        })
      );

      return res.status(200).json({
        success: true,
        message: 'Limpeza executada com sucesso',
        removed: result.removed,
        errors: result.errors || 0,
        cache_cleared: result.cacheCleared || 0,
        elapsed_ms: elapsed,
        request_id: requestId
      });

    } catch (err) {
      const elapsed = Date.now() - startTime;
      logger.error(`[${requestId}] ❌ Erro na limpeza:`, err.message);

      try {
        await db.prepare(`
          INSERT INTO logs (created_at, level, module, message, meta_json)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          new Date().toISOString(),
          'error',
          'cron_cleanup',
          `Erro na limpeza: ${err.message}`,
          JSON.stringify({ elapsed_ms: elapsed, error: err.message })
        );
      } catch {}

      return res.status(500).json({
        success: false,
        error: err.message,
        elapsed_ms: elapsed,
        request_id: requestId
      });
    }
  });

  app.get('/cron/status', requireCronToken, async (req, res) => {
    try {
      const bot = req.app.locals.bot;
      const groups = (await db.kvGet('groups')) || {};

      // Telegram
      let telegramStatus = 'unknown';
      try {
        await bot.getMe();
        telegramStatus = 'ok';
      } catch (err) {
        telegramStatus = 'error';
        logger.error('Telegram health check falhou:', err.message);
      }

      // Banco
      let databaseStatus = 'unknown';
      try {
        await db.prepare('SELECT 1 as test').get();
        databaseStatus = 'ok';
      } catch (err) {
        databaseStatus = 'error';
        logger.error('Database health check falhou:', err.message);
      }

      const uploads = await db.prepare('SELECT COUNT(*)::int as count FROM uploads WHERE deleted_at IS NULL').get();
      const transactions = await db.prepare('SELECT COUNT(*)::int as count FROM bank_tx').get();
      const orders = await db.prepare('SELECT COUNT(*)::int as count FROM orders WHERE deleted_at IS NULL').get();
      const logs24 = await db.prepare(`SELECT COUNT(*)::int as count FROM logs WHERE created_at > (NOW() - INTERVAL '1 day')`).get();

      const stats = {
        uploads: uploads?.count ?? 0,
        transactions: transactions?.count ?? 0,
        orders: orders?.count ?? 0,
        logs_last_24h: logs24?.count ?? 0
      };

      const status = {
        server: 'ok',
        database: databaseStatus,
        telegram: telegramStatus,
        groups_configured: Object.keys(groups).length,
        stats,
        timestamp: new Date().toISOString(),
        uptime_seconds: Math.floor(process.uptime())
      };

      const allOk = databaseStatus === 'ok' && telegramStatus === 'ok';
      res.status(allOk ? 200 : 503).json(status);

    } catch (err) {
      logger.error('Erro no status check:', err.message);
      res.status(500).json({
        server: 'error',
        error: err.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  app.get('/cron/logs', requireCronToken, async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const level = req.query.level || null;

      let query = 'SELECT * FROM logs';
      const params = [];

      if (level) {
        query += ' WHERE level = ?';
        params.push(level);
      }

      query += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);

      const logs = await db.prepare(query).all(...params);

      res.status(200).json({
        count: logs.length,
        logs: logs.map(log => ({
          ...log,
          meta: log.meta_json || null
        }))
      });

    } catch (err) {
      logger.error('Erro ao buscar logs:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  logger.info('✅ Rotas de cron registradas:');
  logger.info('   POST /cron/daily   - Relatório diário');
  logger.info('   POST /cron/weekly  - Relatório semanal');
  logger.info('   POST /cron/cleanup - Limpeza de arquivos');
  logger.info('   GET  /cron/status  - Health check');
  logger.info('   GET  /cron/logs    - Logs do sistema');
}

module.exports = { createCronRoutes };
