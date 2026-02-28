/**
 * src/config.js - Sistema de Configuração
 * Versão 2.1 - PostgreSQL (DATABASE_URL) + validações robustas e fallbacks
 */

const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const logger = createLogger('CONFIG');

// Constantes de configuração
const CONFIG_DEFAULTS = {
  MAX_FILE_SIZE_MB: 10,
  MAX_TRANSACTIONS_IN_REPORT: 400,
  MAX_ORDERS_IN_REPORT: 200,
  OPENAI_MAX_TOKENS: 900,
  RATE_LIMIT_WINDOW_MS: 15 * 60 * 1000,
  RATE_LIMIT_MAX_REQUESTS: 100,
  FILE_UPLOAD_TIMEOUT_MS: 30000
};

/**
 * Carrega arquivo JSON de forma segura
 */
function loadJsonFile(filepath) {
  try {
    if (fs.existsSync(filepath)) {
      const content = fs.readFileSync(filepath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    logger.warn(`Não foi possível carregar ${filepath}:`, err.message);
  }
  return {};
}

/**
 * Valida e retorna inteiro
 */
function getInt(value, defaultValue) {
  const parsed = parseInt(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Valida string não vazia
 */
function getString(value, defaultValue = '') {
  return (typeof value === 'string' && value.trim().length > 0) 
    ? value.trim() 
    : defaultValue;
}

/**
 * Carrega e valida configurações do sistema
 * @returns {Object} Configuração completa e validada
 * @throws {Error} Se configurações obrigatórias estiverem faltando
 */
function loadConfig() {
  // Carrega JSONs (se existirem)
  const coreConfig = loadJsonFile(path.join(__dirname, '..', 'core_config.json'));
  const addonsConfig = loadJsonFile(path.join(__dirname, '..', 'addons_config.json'));

  // Monta configuração final (ENV vars têm prioridade)
  const config = {
    // Informações da empresa
    company: {
      name: getString(
        process.env.COMPANY_NAME || coreConfig.company?.name,
        'Ambiente Decorações'
      )
    },

    // Banco (PostgreSQL)
    db: {
      // Render normalmente expõe DATABASE_URL
      url: getString(
        process.env.DATABASE_URL ||
        process.env.POSTGRES_URL ||
        process.env.POSTGRES_PRISMA_URL ||
        coreConfig.db?.url
      )
    },

    // Telegram
    telegram: {
      botToken: getString(
        process.env.TELEGRAM_BOT_TOKEN || coreConfig.telegram?.botToken
      ),
      adminId: getInt(
        process.env.TELEGRAM_ADMIN_ID || coreConfig.telegram?.adminId,
        0
      ),
      groups: coreConfig.telegram?.groups || {},
      useWebhook: process.env.TELEGRAM_USE_WEBHOOK === 'true',
      webhookPath: getString(
        process.env.TELEGRAM_WEBHOOK_PATH,
        '/telegram/webhook'
      )
    },

    // OpenAI
    openai: {
      apiKey: getString(
        process.env.OPENAI_API_KEY || coreConfig.openai?.apiKey
      ),
      model: getString(
        process.env.OPENAI_MODEL || coreConfig.openai?.model,
        'gpt-4o-mini'
      ),
      maxTokens: getInt(
        process.env.OPENAI_MAX_TOKENS,
        CONFIG_DEFAULTS.OPENAI_MAX_TOKENS
      )
    },

    // Cron
    cron: {
      token: getString(
        process.env.CRON_TOKEN || coreConfig.cron?.token
      )
    },

    // Retenção de dados
    retention: {
      files_days: getInt(
        process.env.RETENTION_FILES_DAYS || coreConfig.retention?.files_days,
        120
      ),
      finance_months: getInt(
        process.env.RETENTION_FINANCE_MONTHS || coreConfig.retention?.finance_months,
        12
      ),
      yearly_summary_months: getInt(
        process.env.RETENTION_YEARLY_SUMMARY_MONTHS || coreConfig.retention?.yearly_summary_months,
        12
      ),
      report_consider_old_days: getInt(
        process.env.RETENTION_REPORT_OLD_DAYS || coreConfig.retention?.report_consider_old_days,
        60
      )
    },

    // URL pública
    publicBaseUrl: getString(
      process.env.PUBLIC_BASE_URL || coreConfig.publicBaseUrl
    ),

    // Features (addons)
    features: {
      finance: addonsConfig.features?.finance || { source: 'nubank_only' },
      deep_analysis: addonsConfig.features?.deep_analysis ?? true,
      order_scheduler: addonsConfig.features?.order_scheduler ?? true,
      report_style: getString(
        addonsConfig.features?.report_style,
        'curto_estruturado_pratico'
      )
    },

    // Constantes
    constants: CONFIG_DEFAULTS
  };

  // ========================================
  // VALIDAÇÕES OBRIGATÓRIAS
  // ========================================
  const errors = [];

  if (!config.db.url) {
    errors.push('DATABASE_URL (PostgreSQL) não configurado (obrigatório)');
  }

  if (!config.telegram.botToken) {
    errors.push('TELEGRAM_BOT_TOKEN não configurado (obrigatório)');
  }

  if (!config.telegram.adminId || config.telegram.adminId === 0) {
    errors.push('TELEGRAM_ADMIN_ID não configurado (obrigatório)');
  }

  if (!config.openai.apiKey) {
    errors.push('OPENAI_API_KEY não configurado (obrigatório)');
  }

  if (!config.cron.token) {
    errors.push('CRON_TOKEN não configurado (obrigatório)');
  }

  if (errors.length > 0) {
    logger.error('Configurações obrigatórias faltando:');
    errors.forEach(err => logger.error(`  ❌ ${err}`));
    throw new Error(`Configurações inválidas. ${errors.length} erro(s) encontrado(s).`);
  }

  // ========================================
  // AVISOS (não bloqueiam execução)
  // ========================================
  const warnings = [];

  if (!config.publicBaseUrl) {
    warnings.push('PUBLIC_BASE_URL não configurado - webhooks não funcionarão');
  }

  if (process.env.NODE_ENV === 'production') {
    if (config.publicBaseUrl && !config.publicBaseUrl.startsWith('https://')) {
      warnings.push('PUBLIC_BASE_URL deveria usar HTTPS em produção');
    }

    if (config.telegram.useWebhook && !config.publicBaseUrl) {
      warnings.push('Webhook habilitado mas PUBLIC_BASE_URL não configurado');
    }
  }

  if (warnings.length > 0) {
    warnings.forEach(w => logger.warn(`⚠️ ${w}`));
  }

  return config;
}

module.exports = { loadConfig, CONFIG_DEFAULTS };
