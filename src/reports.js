/**
 * src/reports.js - Geração de Relatórios com IA
 * Versão 2.1 - PostgreSQL (async) + cache em JSONB
 */

const { chatComplete } = require("./openai");
const { createLogger } = require("./logger");
const { CONFIG_DEFAULTS } = require("./config");

const logger = createLogger('REPORTS');

// Constantes
const MAX_TRANSACTIONS = CONFIG_DEFAULTS.MAX_TRANSACTIONS_IN_REPORT;
const MAX_ORDERS = CONFIG_DEFAULTS.MAX_ORDERS_IN_REPORT;
const MAX_TOKENS = CONFIG_DEFAULTS.OPENAI_MAX_TOKENS;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora

/**
 * Formata centavos para BRL
 */
function brl(cents) {
  const v = (cents || 0) / 100;
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/**
 * Retorna data N dias atrás (YYYY-MM-DD)
 */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Monta prompt para análise financeira
 */
function buildFinancePrompt({ companyName, txs }) {
  const lines = txs.slice(0, MAX_TRANSACTIONS).map((t) => {
    const sign = t.direction === "out" ? "-" : "+";
    return `${t.tx_date || ""} | ${sign}${brl(t.amount_cents)} | ${t.description || ""} | ${t.category || ""}`;
  });

  return [
    { 
      role: "system", 
      content:
        `Você é analista financeiro e consultor de gestão da empresa "${companyName}". ` +
        `Faça análise profunda porém MUITO resumida, estruturada e prática. ` +
        `Sempre inclua: ` +
        `(1) Resumo executivo em 2 frases, ` +
        `(2) Gastos por categoria (top 3), ` +
        `(3) Anomalias ou alertas, ` +
        `(4) Ações imediatas (máx 3), ` +
        `(5) Plano próximos 7 dias.`
    },
    { 
      role: "user", 
      content: `Transações recentes (últimos 30 dias):\n\n${lines.join("\n")}\n\nResponda em português, formato conciso.` 
    }
  ];
}

/**
 * Monta prompt para ordem de produção
 */
function buildOpsPrompt({ companyName, orders }) {
  const lines = orders.slice(0, MAX_ORDERS).map((o) =>
    `#${o.id} | status=${o.status}/${o.production_status} | entrega=${o.delivery_date || "sem data"} | desc=${(o.description || "").substring(0, 100)}`
  );

  return [
    { 
      role: "system", 
      content:
        `Você é gerente de operações da empresa "${companyName}". ` +
        `Entregue duas seções separadas:\n\n` +
        `ORDEM DO DIA\n` +
        `(Lista objetiva dos pedidos priorizados para hoje, numerada)\n\n` +
        `MOTIVOS\n` +
        `(Breve justificativa da priorização)`
    },
    { 
      role: "user", 
      content: `Pedidos atuais:\n${lines.join("\n")}\n\nGere ORDEM DO DIA e MOTIVOS separadamente.` 
    }
  ];
}

/**
 * Busca ou gera relatório com cache
 */
async function getCachedReport(db, cacheKey, reportType, generator) {
  try {
    const cached = await db.prepare(`
      SELECT content, created_at, expires_at 
      FROM reports_cache 
      WHERE cache_key = ? AND expires_at > ?
    `).get(cacheKey, new Date().toISOString());

    if (cached) {
      logger.info(`Cache hit para: ${cacheKey}`);
      // content é JSONB no PG
      return cached.content;
    }

    logger.info(`Cache miss para: ${cacheKey}, gerando...`);
    const result = await generator();

    const expiresAt = new Date(Date.now() + CACHE_TTL_MS).toISOString();

    await db.prepare(`
      INSERT INTO reports_cache (cache_key, report_type, content, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        content = EXCLUDED.content,
        created_at = EXCLUDED.created_at,
        expires_at = EXCLUDED.expires_at
    `).run(
      cacheKey,
      reportType,
      JSON.stringify(result),
      new Date().toISOString(),
      expiresAt
    );

    return result;

  } catch (err) {
    logger.error('Erro no cache:', err.message);
    return await generator();
  }
}

/**
 * Executa trabalho diário (relatórios)
 */
async function runDailyWork({ config, db, bot, mode = "cron" }) {
  logger.info(`Iniciando trabalho diário (modo: ${mode})...`);

  try {
    const groups = (await db.kvGet("groups")) || {};
    const chatRel = groups?.relatorios?.chat_id;
    const chatProd = groups?.producao?.chat_id;
    const chatBuy = groups?.compras?.chat_id;

    // Busca dados
    const since = daysAgo(30);
    const txs = await db.prepare(`
      SELECT * FROM bank_tx 
      WHERE tx_date >= ? 
      ORDER BY tx_date DESC, id DESC
    `).all(since);

    const orders = await db.prepare(`
      SELECT * FROM orders 
      WHERE deleted_at IS NULL
      ORDER BY 
        CASE WHEN delivery_date IS NULL THEN 1 ELSE 0 END,
        delivery_date ASC, 
        id DESC
      LIMIT ?
    `).all(MAX_ORDERS);

    const companyName = config.company?.name || "Ambiente Decorações";

    logger.info(`Dados carregados: ${txs.length} transações, ${orders.length} pedidos`);

    // Gera relatórios (cache somente em modo cron)
    const cacheKeyFin = `finance_${since}_${txs.length}`;
    const cacheKeyOps = `ops_${orders.length}_${orders[0]?.updated_at || 'empty'}`;

    const finGenerator = async () => {
      logger.info('Gerando relatório financeiro...');
      return await chatComplete({ 
        apiKey: config.openai.apiKey, 
        model: config.openai.model, 
        messages: buildFinancePrompt({ companyName, txs }), 
        maxTokens: MAX_TOKENS 
      });
    };

    const opsGenerator = async () => {
      logger.info('Gerando relatório operacional...');
      return await chatComplete({ 
        apiKey: config.openai.apiKey, 
        model: config.openai.model, 
        messages: buildOpsPrompt({ companyName, orders }), 
        maxTokens: MAX_TOKENS 
      });
    };

    const fin = mode === 'cron' 
      ? await getCachedReport(db, cacheKeyFin, 'finance', finGenerator)
      : await finGenerator();

    const ops = mode === 'cron'
      ? await getCachedReport(db, cacheKeyOps, 'ops', opsGenerator)
      : await opsGenerator();

    if (!fin.ok) logger.error('Erro no relatório financeiro:', fin.error);
    if (!ops.ok) logger.error('Erro no relatório operacional:', ops.error);

    // Processa saída de operações
    const opsText = ops.text || "";
    const parts = opsText.split(/MOTIVOS?:/i);
    const ordem = (parts[0] || opsText).replace(/ORDEM DO DIA/i, '').trim();
    const motivos = parts.length >= 2 
      ? ("MOTIVOS:\n" + parts.slice(1).join("MOTIVOS:")).trim() 
      : "MOTIVOS:\n(não separado pela IA)";

    // Monta mensagens
    const timestamp = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    const header = `📊 Relatório IA — ${companyName}\n🕒 ${timestamp}\n📍 Modo: ${mode}`;

    const messages = {
      producao: chatProd ? `📅 *ORDEM DO DIA*\n\n${ordem}` : null,
      compras: chatBuy ? `🛒 *LISTA DE COMPRAS*\n\n(Derivada da ordem do dia + análise de estoque)\n\nDetalhes completos no grupo Relatórios.` : null,
      relatorios: chatRel ? `${header}\n\n` +
        `🏭 *OPERAÇÕES*\n\n${motivos}\n\n` +
        `💰 *FINANCEIRO*\n\n${fin.text || "(erro ao gerar)"}\n\n` +
        `💡 *DICAS DE CRESCIMENTO*\n` +
        `• Aumente ticket médio com upsell\n` +
        `• Corte gastos recorrentes desnecessários\n` +
        `• Padronize processos para ganhar escala` : null
    };

    for (const [key, chatId] of Object.entries({ producao: chatProd, compras: chatBuy, relatorios: chatRel })) {
      if (chatId && messages[key]) {
        try {
          await bot.sendMessage(chatId, messages[key], { parse_mode: 'Markdown' });
          logger.info(`✅ Mensagem enviada para: ${key}`);
        } catch (err) {
          logger.error(`Erro ao enviar para ${key}:`, err.message);
        }
      }
    }

    const summary = `Ops=${ops.ok ? "✅" : "❌"} Fin=${fin.ok ? "✅" : "❌"} | Txs=${txs.length} Orders=${orders.length}`;
    logger.info(`Trabalho diário concluído: ${summary}`);

    return { summary, success: true };

  } catch (err) {
    logger.error('Erro no trabalho diário:', err.message);
    return { summary: `Erro: ${err.message}`, success: false };
  }
}

/**
 * Executa limpeza de arquivos antigos
 */
async function runCleanup({ config, db, bot, mode = "cron" }) {
  logger.info(`Iniciando limpeza (modo: ${mode})...`);

  try {
    const groups = (await db.kvGet("groups")) || {};
    const chatRel = groups?.relatorios?.chat_id;

    const keepFilesDays = config.retention?.files_days ?? 120;
    const keepFinanceMonths = config.retention?.finance_months ?? 12;

    const cutoffFiles = new Date();
    cutoffFiles.setDate(cutoffFiles.getDate() - keepFilesDays);

    const cutoffFinance = new Date();
    cutoffFinance.setMonth(cutoffFinance.getMonth() - keepFinanceMonths);

    const rows = await db.prepare("SELECT * FROM uploads WHERE deleted_at IS NULL").all();
    let removed = 0;
    let errors = 0;

    for (const f of rows) {
      try {
        const created = new Date(f.created_at);
        const cutoff = (f.kind === "bank_csv") ? cutoffFinance : cutoffFiles;

        if (created < cutoff && f.local_path) {
          const fs = require("fs");
          if (fs.existsSync(f.local_path)) fs.unlinkSync(f.local_path);

          await db.prepare("UPDATE uploads SET deleted_at = ? WHERE id = ?")
            .run(new Date().toISOString(), f.id);

          removed += 1;
        }
      } catch (err) {
        logger.error(`Erro ao limpar arquivo ${f.id}:`, err.message);
        errors += 1;
      }
    }

    // Limpa cache expirado
    const expiredCache = await db.prepare("DELETE FROM reports_cache WHERE expires_at < ?")
      .run(new Date().toISOString());

    logger.info(`Limpeza concluída: ${removed} arquivos, ${expiredCache.changes} caches`);

    if (chatRel) {
      const message = 
        `🧹 *Limpeza Automática*\n\n` +
        `Modo: ${mode}\n` +
        `Arquivos removidos: ${removed}\n` +
        `Erros: ${errors}\n` +
        `Cache limpo: ${expiredCache.changes} entradas\n\n` +
        `Retenção:\n` +
        `• Arquivos: ${keepFilesDays} dias\n` +
        `• Financeiro: ${keepFinanceMonths} meses`;

      await bot.sendMessage(chatRel, message, { parse_mode: 'Markdown' });
    }

    return { removed, errors, cacheCleared: expiredCache.changes };

  } catch (err) {
    logger.error('Erro na limpeza:', err.message);
    return { removed: 0, errors: 1 };
  }
}

module.exports = { runDailyWork, runCleanup };
