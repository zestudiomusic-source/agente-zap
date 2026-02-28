/**
 * src/telegram.js - Bot do Telegram
 * Versão 2.1 - PostgreSQL (async) + validações de segurança e tratamento robusto de erros
 */

const TelegramBot = require("node-telegram-bot-api");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");

const { parseNubankCsvBuffer } = require("./utils_nubank");
const { runDailyWork } = require("./reports");
const { createLogger } = require("./logger");
const { CONFIG_DEFAULTS } = require("./config");

const logger = createLogger('TELEGRAM');

// Constantes de segurança
const MAX_FILE_SIZE = CONFIG_DEFAULTS.MAX_FILE_SIZE_MB * 1024 * 1024; // 10MB em bytes
const ALLOWED_MIME_TYPES = [
  'text/csv',
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
];

const FILE_UPLOAD_TIMEOUT = CONFIG_DEFAULTS.FILE_UPLOAD_TIMEOUT_MS;

// ========================================
// FUNÇÕES AUXILIARES
// ========================================

function nowIso() { 
  return new Date().toISOString(); 
}

function isAdmin(config, msg) { 
  const userId = Number(msg?.from?.id);
  const adminId = Number(config.telegram.adminId);
  return userId === adminId && userId > 0;
}

function normalizeGroupName(s) { 
  return String(s || "").trim().toLowerCase(); 
}

function getGroupNameByChatId(groups, chatId) {
  for (const [name, g] of Object.entries(groups)) {
    if (Number(g.chat_id) === Number(chatId)) return name;
  }
  return null;
}

// ========================================
// MENUS
// ========================================

function buildMainMenu() {
  return {
    reply_markup: { 
      inline_keyboard: [
        [
          { text: "💰 Vendas (CRM)", callback_data: "m:crm" }, 
          { text: "📦 Pedidos", callback_data: "m:orders" }
        ],
        [
          { text: "🏭 Produção", callback_data: "m:prod" }, 
          { text: "🧾 Financeiro", callback_data: "m:fin" }
        ],
        [
          { text: "🛒 Compras", callback_data: "m:buy" }, 
          { text: "📊 Relatórios", callback_data: "m:rep" }
        ],
        [
          { text: "🤖 IA", callback_data: "m:ai" }, 
          { text: "⚙️ Sistema", callback_data: "m:sys" }
        ],
      ]
    }
  };
}

function buildGroupMenu(groupName) {
  const menus = {
    producao: [[{ text: "📅 Ordem do Dia", callback_data: "g:prod:today" }]],
    compras: [[{ text: "🛒 Lista de Compras", callback_data: "g:buy:today" }]],
    financeiro: [[{ text: "🧾 Enviar Extrato CSV", callback_data: "g:fin:upload" }]],
    relatorios: [[{ text: "📊 Gerar Relatório IA", callback_data: "g:rep:ai" }]],
    vendas: [[{ text: "💰 CRM", callback_data: "g:crm:leads" }]],
    backups: [[{ text: "🗂️ Status dos Backups", callback_data: "g:bkp:info" }]],
  };

  return { 
    reply_markup: { 
      inline_keyboard: menus[groupName] || [] 
    } 
  };
}

// ========================================
// DOWNLOAD DE ARQUIVOS (com timeout e validação)
// ========================================

async function downloadTo(localPath, url, maxSize = MAX_FILE_SIZE) {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(localPath);
    let downloaded = 0;

    const timeout = setTimeout(() => {
      stream.destroy();
      try { fs.unlinkSync(localPath); } catch {}
      reject(new Error('Timeout: download demorou mais que 30 segundos'));
    }, FILE_UPLOAD_TIMEOUT);

    const request = https.get(url, (res) => {
      const contentLength = parseInt(res.headers['content-length'] || '0');
      if (contentLength > maxSize) {
        clearTimeout(timeout);
        stream.destroy();
        try { fs.unlinkSync(localPath); } catch {}
        reject(new Error(`Arquivo muito grande: ${(contentLength / 1024 / 1024).toFixed(2)}MB (máx: ${MAX_FILE_SIZE / 1024 / 1024}MB)`));
        return;
      }

      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (downloaded > maxSize) {
          clearTimeout(timeout);
          stream.destroy();
          try { fs.unlinkSync(localPath); } catch {}
          reject(new Error('Arquivo excedeu tamanho máximo durante download'));
        }
      });

      res.pipe(stream);

      stream.on('finish', () => {
        clearTimeout(timeout);
        stream.close(() => resolve(downloaded));
      });
    });

    request.on('error', (err) => {
      clearTimeout(timeout);
      try { fs.unlinkSync(localPath); } catch {}
      reject(err);
    });
  });
}

// ========================================
// CRIAÇÃO DO BOT
// ========================================

async function createTelegramBot({ config, db }) {
  if (!config.telegram.botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN não configurado');
  }

  const useWebhook = !!config.telegram.useWebhook;

  // Importante: para Web Service, recomendamos Express receber o webhook.
  // Aqui, quando useWebhook=true, desativamos polling e NÃO iniciamos servidor interno do node-telegram-bot-api.
  const bot = new TelegramBot(config.telegram.botToken, { polling: !useWebhook });

  // Se useWebhook=true, o server.js vai chamar bot.processUpdate() no endpoint configurado.

  // Cria bot
  // (instância já criada acima)

  //
  //(config.telegram.botToken, botOptions);

  // Valida token
  let botInfo;
  try {
    botInfo = await bot.getMe();
    logger.info(`✅ Bot conectado: @${botInfo.username} (${botInfo.first_name})`);
    bot.botInfo = botInfo;
  } catch (err) {
    throw new Error(`Token inválido ou erro de rede: ${err.message}`);
  }

  // Configura webhook se necessário
  if (config.telegram.useWebhook && config.publicBaseUrl) {
    const webhookUrl = `${config.publicBaseUrl}${config.telegram.webhookPath}`;
    try {
      await bot.setWebHook(webhookUrl);
      logger.info(`✅ Webhook configurado: ${webhookUrl}`);
    } catch (err) {
      logger.error('❌ Erro ao configurar webhook:', err.message);
    }
  }

  // ========================================
  // COMANDOS
  // ========================================

  bot.onText(/^\/start$/, async (msg) => {
    try {
      await bot.sendMessage(
        msg.chat.id, 
        "✅ ERP Bot ativo!\n\nUse /menu para abrir o painel de controle.\nUse /id para ver informações do chat."
      );
    } catch (err) {
      logger.error('Erro no comando /start:', err.message);
    }
  });

  bot.onText(/^\/id$/, async (msg) => {
    try {
      if (!isAdmin(config, msg) && msg.chat.type === 'private') {
        return bot.sendMessage(msg.chat.id, "❌ Comando restrito ao administrador.");
      }

      const info = [
        `📌 Informações do Chat`,
        ``,
        `Chat ID: \`${msg.chat.id}\``,
        `Tipo: ${msg.chat.type}`,
        `User ID: \`${msg.from.id}\``,
        msg.chat.title ? `Título: ${msg.chat.title}` : '',
        msg.chat.is_forum ? `Forum: Sim` : ''
      ].filter(Boolean).join('\n');

      await bot.sendMessage(msg.chat.id, info, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error('Erro no comando /id:', err.message);
    }
  });

  bot.onText(/^\/setgroup(?:\s+(.+))?$/i, async (msg, match) => {
    try {
      if (!isAdmin(config, msg)) {
        return bot.sendMessage(msg.chat.id, "❌ Sem permissão. Este comando é restrito ao administrador.");
      }

      const gName = normalizeGroupName(match?.[1]);
      const validGroups = ['vendas', 'producao', 'compras', 'financeiro', 'relatorios', 'backups'];

      if (!gName) {
        return bot.sendMessage(
          msg.chat.id, 
          `❌ Uso: /setgroup <nome>\n\nGrupos válidos:\n${validGroups.map(g => `• ${g}`).join('\n')}`
        );
      }

      if (!validGroups.includes(gName)) {
        return bot.sendMessage(
          msg.chat.id,
          `❌ Grupo "${gName}" inválido.\n\nGrupos válidos:\n${validGroups.map(g => `• ${g}`).join('\n')}`
        );
      }

      const isForum = msg.chat?.is_forum === true || msg.is_forum === true;
      const groups = (await db.kvGet("groups")) || {};

      groups[gName] = { 
        chat_id: msg.chat.id, 
        title: msg.chat?.title || gName, 
        is_forum: !!isForum, 
        updated_at: nowIso() 
      };

      await db.kvSet("groups", groups);

      return bot.sendMessage(
        msg.chat.id, 
        `✅ Grupo registrado com sucesso!\n\n` +
        `Nome: ${gName}\n` +
        `Chat ID: \`${msg.chat.id}\`\n` +
        `Fórum/Tópicos: ${isForum ? "✅ Sim" : "❌ Não"}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      logger.error('Erro no comando /setgroup:', err.message);
      bot.sendMessage(msg.chat.id, `❌ Erro ao registrar grupo: ${err.message}`);
    }
  });

  bot.onText(/^\/menu$/i, async (msg) => {
    try {
      const groups = (await db.kvGet("groups")) || {};
      const groupName = getGroupNameByChatId(groups, msg.chat.id);

      if (msg.chat.type === "private") {
        if (!isAdmin(config, msg)) {
          return bot.sendMessage(msg.chat.id, "❌ Sem permissão.");
        }
        return bot.sendMessage(
          msg.chat.id, 
          "📊 Painel Administrativo\n\nEscolha um módulo:", 
          buildMainMenu()
        );
      }

      if (!groupName) {
        return bot.sendMessage(
          msg.chat.id, 
          "⚠️ Este grupo não está registrado.\n\nO administrador deve usar:\n/setgroup <nome>"
        );
      }

      return bot.sendMessage(
        msg.chat.id, 
        `📌 Menu do grupo: *${groupName}*`, 
        { 
          ...buildGroupMenu(groupName),
          parse_mode: 'Markdown'
        }
      );
    } catch (err) {
      logger.error('Erro no comando /menu:', err.message);
    }
  });

  bot.onText(/^\/runreport$/i, async (msg) => {
    try {
      if (!isAdmin(config, msg)) {
        return bot.sendMessage(msg.chat.id, "❌ Sem permissão.");
      }

      await bot.sendMessage(msg.chat.id, "⏳ Gerando relatório...");
      const result = await runDailyWork({ config, db, bot, mode: "manual" });
      return bot.sendMessage(msg.chat.id, `✅ Relatório gerado!\n\n${result.summary}`);
    } catch (err) {
      logger.error('Erro no comando /runreport:', err.message);
      bot.sendMessage(msg.chat.id, `❌ Erro ao gerar relatório: ${err.message}`);
    }
  });

  bot.onText(/^\/stats$/i, async (msg) => {
    try {
      if (!isAdmin(config, msg)) {
        return bot.sendMessage(msg.chat.id, "❌ Sem permissão.");
      }

      const groups = (await db.kvGet("groups")) || {};
      const uploadsCount = (await db.prepare('SELECT COUNT(*)::int as count FROM uploads WHERE deleted_at IS NULL').get()).count;
      const txCount = (await db.prepare('SELECT COUNT(*)::int as count FROM bank_tx').get()).count;
      const ordersCount = (await db.prepare('SELECT COUNT(*)::int as count FROM orders WHERE deleted_at IS NULL').get()).count;

      const stats = [
        `📊 *Estatísticas do Sistema*`,
        ``,
        `👥 Grupos: ${Object.keys(groups).length}`,
        `📁 Uploads: ${uploadsCount}`,
        `💰 Transações: ${txCount}`,
        `📦 Pedidos: ${ordersCount}`,
        ``,
        `🕐 ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`
      ].join('\n');

      await bot.sendMessage(msg.chat.id, stats, { parse_mode: 'Markdown' });
    } catch (err) {
      logger.error('Erro no comando /stats:', err.message);
      bot.sendMessage(msg.chat.id, `❌ Erro: ${err.message}`);
    }
  });

  // ========================================
  // HANDLER DE DOCUMENTOS/ARQUIVOS
  // ========================================

  bot.on("document", async (msg) => {
    const doc = msg.document;

    try {
      logger.info(`Arquivo recebido: ${doc.file_name} (${doc.file_size} bytes)`);

      if (doc.file_size > MAX_FILE_SIZE) {
        return bot.sendMessage(
          msg.chat.id, 
          `❌ Arquivo muito grande: ${(doc.file_size / 1024 / 1024).toFixed(2)}MB\n\nTamanho máximo: ${MAX_FILE_SIZE / 1024 / 1024}MB`
        );
      }

      if (!ALLOWED_MIME_TYPES.includes(doc.mime_type)) {
        return bot.sendMessage(
          msg.chat.id, 
          `❌ Tipo de arquivo não permitido: ${doc.mime_type}\n\nPermitidos: CSV, PDF, Excel`
        );
      }

      const groups = (await db.kvGet("groups")) || {};
      const groupName = getGroupNameByChatId(groups, msg.chat.id);

      const fileLink = await bot.getFileLink(doc.file_id);

      const folder = path.join(__dirname, "..", "storage");
      if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

      const safeFileName = (doc.file_name || "file")
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .substring(0, 200);
      const safeName = `${Date.now()}_${doc.file_unique_id}_${safeFileName}`;
      const localPath = path.join(folder, safeName);

      logger.info(`Baixando arquivo de: ${fileLink}`);
      const downloadedSize = await downloadTo(localPath, fileLink);
      logger.info(`Download concluído: ${downloadedSize} bytes`);

      const buf = fs.readFileSync(localPath);
      const sha = crypto.createHash("sha256").update(buf).digest("hex");

      const lower = (doc.file_name || "").toLowerCase();
      const kind = lower.endsWith(".csv") ? "bank_csv" :
                   lower.endsWith(".pdf") ? "order_pdf" : 
                   "other";

      await db.prepare(`
        INSERT INTO uploads(
          created_at, kind, filename, telegram_file_id, telegram_chat_id, 
          telegram_message_id, local_path, sha256, file_size, meta_json
        )
        VALUES(?,?,?,?,?,?,?,?,?,?)
      `).run(
        nowIso(), 
        kind, 
        doc.file_name || safeName, 
        doc.file_id, 
        msg.chat.id, 
        msg.message_id, 
        localPath, 
        sha,
        doc.file_size,
        JSON.stringify({ groupName, from_id: msg.from.id, mime: doc.mime_type })
      );

      logger.info(`Arquivo salvo no banco: ${doc.file_name}`);

      // Auto-import CSV do Nubank (apenas admin e grupos específicos)
      if (kind === "bank_csv" && isAdmin(config, msg) && (groupName === "financeiro" || groupName === "backups")) {
        logger.info('Iniciando importação de CSV Nubank...');
        const parsed = parseNubankCsvBuffer(buf);

        const insSql = `
          INSERT INTO bank_tx(
            created_at, source, tx_date, description, category, 
            amount_cents, direction, account, counterparty, raw_json
          )
          VALUES(?,?,?,?,?,?,?,?,?,?)
        `;

        let imported = 0;

        await db.transaction(async (tx) => {
          for (const t of parsed) {
            await tx.prepare(insSql).run(
              nowIso(),
              "nubank_csv",
              t.tx_date || null,
              t.description || null,
              t.category || null,
              t.amount_cents || 0,
              t.direction || null,
              null,
              null,
              JSON.stringify(t.raw || {})
            );
            imported += 1;
          }
        });

        await bot.sendMessage(
          msg.chat.id,
          `✅ CSV Nubank importado com sucesso!\n\nTransações importadas: ${imported}`
        );
      } else {
        await bot.sendMessage(msg.chat.id, `✅ Arquivo recebido e registrado: ${doc.file_name}`);
      }

    } catch (err) {
      logger.error('Erro ao processar arquivo:', err.message);
      try { await bot.sendMessage(msg.chat.id, `❌ Erro ao processar arquivo: ${err.message}`); } catch {}
    }
  });

  return bot;
}

module.exports = { createTelegramBot };
