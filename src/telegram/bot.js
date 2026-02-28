const TelegramBot = require('node-telegram-bot-api');
const {
  createOrder,
  listTodayOrders,
  listOpenOrders,
  formatOrderLine,
  formatMoneyBRL
} = require('../services/orders');
const { planProduction } = require('../services/ai');

const GROUP_KEYS = ['vendas', 'producao', 'financeiro', 'compras', 'relatorios', 'backups'];

function logger(scope = 'TELEGRAM') {
  return {
    info: (...a) => console.log(new Date().toISOString(), `[${scope}]`, ...a),
    warn: (...a) => console.warn(new Date().toISOString(), `[${scope}]`, ...a),
    error: (...a) => console.error(new Date().toISOString(), `[${scope}]`, ...a)
  };
}

const log = logger('TELEGRAM');

async function upsertGroup(db, { key, chat_id, has_topics, title }) {
  const q = `
    INSERT INTO groups (key, chat_id, has_topics, title)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (key) DO UPDATE SET
      chat_id = EXCLUDED.chat_id,
      has_topics = EXCLUDED.has_topics,
      title = EXCLUDED.title,
      updated_at = NOW()
    RETURNING *
  `;
  const r = await db.exec(q, [key, chat_id, !!has_topics, title || null]);
  return r.rows[0];
}

async function getGroups(db) {
  const r = await db.exec('SELECT * FROM groups');
  const map = new Map();
  for (const row of r.rows) map.set(row.key, row);
  return map;
}

async function kvSet(db, key, value) {
  const q = `
    INSERT INTO kv_store (key, value)
    VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
  await db.exec(q, [key, value]);
}

async function kvGet(db, key) {
  const r = await db.exec('SELECT value FROM kv_store WHERE key = $1', [key]);
  return r.rows[0]?.value ?? null;
}

async function kvDel(db, key) {
  await db.exec('DELETE FROM kv_store WHERE key = $1', [key]);
}

function isTriggerForDailyServices(text) {
  const t = (text || '').toLowerCase();
  return (
    t.includes('serviços de hoje') ||
    t.includes('servicos de hoje') ||
    t.includes('pedidos de hoje') ||
    t.includes('fila de produção') ||
    t.includes('fila de producao') ||
    t === 'serviços do dia' ||
    t === 'servicos do dia' ||
    t === 'pedidos do dia'
  );
}

function isMenu(text) {
  const t = (text || '').trim().toLowerCase();
  return t === 'menu' || t === '/menu';
}

function shouldHandleAsAI({ msg, botUsername }) {
  if (!msg?.text) return false;
  const text = msg.text.trim();

  // commands handled elsewhere
  if (text.startsWith('/')) {
    // allow /menu
    if (text === '/menu') return true;
    return false;
  }

  // If bot is mentioned
  if (botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) return true;

  // If user is replying to bot
  if (msg.reply_to_message?.from?.is_bot) return true;

  // Explicit triggers
  if (isTriggerForDailyServices(text)) return true;

  return false;
}

function buildMenuKeyboard(groupKey) {
  const rows = [];

  // Universal shortcuts
  rows.push([{ text: '🧠 Serviços do dia', callback_data: 'ai:services_today' }]);

  if (groupKey === 'vendas') {
    rows.push([{ text: '➕ Nova venda (atalho)', callback_data: 'crm:new_sale_hint' }]);
  }

  if (groupKey === 'producao') {
    rows.push([{ text: '📌 Fila de produção', callback_data: 'ai:open_orders' }]);
  }

  rows.push([{ text: 'ℹ️ Ajuda', callback_data: 'help' }]);

  return { reply_markup: { inline_keyboard: rows } };
}

function safeMarkdownV2(text) {
  return String(text).replace(/([_\*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

async function sendInChat(bot, msg, text, opts = {}) {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;
  const base = { ...opts, message_thread_id: threadId };
  return bot.sendMessage(chatId, text, base);
}

function parseBRLValue(text) {
  const t = String(text || '');
  const m = t.match(/(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:,\d{2})?)/g);
  if (!m || !m.length) return null;
  const raw = m[m.length - 1];
  const normalized = raw.replace(/\./g, '').replace(',', '.');
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return n;
}

function parseSaleText(text) {
  const t = String(text || '').trim();
  const lower = t.toLowerCase();
  if (!(lower.startsWith('venda') || lower.startsWith('cliente') || lower.includes('venda:'))) return null;

  const value = parseBRLValue(t);

  // client
  let client = null;
  const mPara = t.match(/\bpara\s+([A-Za-zÀ-ÿ0-9_\- ]{2,})/i);
  if (mPara) client = mPara[1].trim();
  const mCliente = t.match(/\bcliente\s+([A-Za-zÀ-ÿ0-9_\- ]{2,})/i);
  if (!client && mCliente) client = mCliente[1].trim();

  // description
  let desc = t.replace(/^venda\s*[:\-]?\s*/i, '').replace(/^cliente\s+/i, '').trim();
  if (mPara) {
    desc = t.split(/\bpara\b/i)[0].replace(/^venda\s*[:\-]?\s*/i, '').trim();
  }

  return {
    client_name: client,
    description: desc || null,
    value
  };
}

function createTelegramBot({ token, db }) {
  const bot = new TelegramBot(token, { polling: true });

  bot.getMe()
    .then((me) => log.info(`✅ Bot conectado: @${me.username} (${me.first_name || 'bot'})`))
    .catch(() => log.info('✅ Bot iniciado (getMe indisponível no momento)'));

  const globalAI = String(process.env.TELEGRAM_GLOBAL_AI || '1') === '1';
  log.info(globalAI ? '🤖 IA global ativada (todos os grupos)' : '🤖 IA restrita (apenas grupos alvo)');

  bot.onText(/\/start/, async (msg) => {
    const txt = [
      '✅ ERP Bot ativo!',
      '',
      'Use *menu* para abrir o painel.',
      'Para registrar um grupo: /setgroup vendas|producao|financeiro|compras|relatorios|backups',
      '',
      'No grupo de vendas, você pode mandar:',
      '`Venda: reforma sofá 3 lugares para Maria 3600`'
    ].join('\n');
    await sendInChat(bot, msg, txt, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/setgroup\s+(.+)/i, async (msg, match) => {
    const keyRaw = (match?.[1] || '').trim().toLowerCase();
    const key = keyRaw.replace(/^#/, '');

    if (!GROUP_KEYS.includes(key)) {
      await sendInChat(bot, msg, `❌ Chave inválida. Use: ${GROUP_KEYS.join(' | ')}`);
      return;
    }

    const has_topics = !!msg.is_topic_message || !!msg.message_thread_id;
    const chat_id = msg.chat.id;
    const title = msg.chat.title || msg.chat.username || null;

    await upsertGroup(db, { key, chat_id, has_topics, title });

    await sendInChat(
      bot,
      msg,
      `✅ Grupo registrado com sucesso!\n\nNome: *${safeMarkdownV2(key)}*\nChat ID: *${chat_id}*\nTópicos (forum): *${has_topics ? 'SIM' : 'NÃO'}*`,
      { parse_mode: 'MarkdownV2' }
    );
  });

  bot.on('message', async (msg) => {
    try {
      if (!msg.text) return;

      const groups = await getGroups(db);
      const groupKey = [...groups.values()].find((g) => String(g.chat_id) === String(msg.chat.id))?.key;

      // MENU
      if (isMenu(msg.text)) {
        await sendInChat(bot, msg, `📌 Menu do grupo: *${safeMarkdownV2(groupKey || 'não registrado')}*`, {
          parse_mode: 'MarkdownV2',
          ...buildMenuKeyboard(groupKey)
        });
        return;
      }

      // VENDAS (confirmação)
      if (groupKey === 'vendas') {
        const draftKey = `draft_sale:${msg.chat.id}:${msg.from?.id}`;
        const existingDraft = await kvGet(db, draftKey);

        // waiting value
        if (existingDraft && existingDraft.value == null) {
          const v = parseBRLValue(msg.text);
          if (v == null) {
            await sendInChat(bot, msg, 'Me mande só o valor (ex: 3600) 🙂');
            return;
          }
          existingDraft.value = v;
          await kvSet(db, draftKey, existingDraft);
        }

        const sale = existingDraft || parseSaleText(msg.text);
        if (sale) {
          if (sale.value == null) {
            await kvSet(db, draftKey, sale);
            await sendInChat(bot, msg, 'Entendi a venda, mas faltou o *VALOR*.\nResponda assim: `Valor: 3600`', {
              parse_mode: 'Markdown'
            });
            return;
          }

          const confirmId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
          const confirmKey = `confirm_sale:${confirmId}`;

          await kvSet(db, confirmKey, {
            ...sale,
            chat_id: msg.chat.id,
            user_id: msg.from?.id,
            created_at: new Date().toISOString()
          });
          await kvDel(db, draftKey);

          const summary = [
            '*Confirma criar esta venda?*',
            '',
            `Cliente: ${sale.client_name || '(não informado)'}`,
            `Descrição: ${sale.description || '(não informado)'}`,
            `Valor: ${formatMoneyBRL(Math.round(sale.value * 100))}`
          ].join('\n');

          await sendInChat(bot, msg, summary, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Confirmar', callback_data: `sale:confirm:${confirmId}` },
                  { text: '❌ Cancelar', callback_data: `sale:cancel:${confirmId}` }
                ]
              ]
            }
          });
          return;
        }
      }

      // AI
      const me = await bot.getMe().catch(() => null);
      const botUsername = me?.username;
      if (!globalAI && !String(msg.chat?.type || '').includes('group')) return;
      if (!shouldHandleAsAI({ msg, botUsername })) return;

      if (isTriggerForDailyServices(msg.text)) {
        const orders = await listTodayOrders(db);
        if (!orders.length) {
          await sendInChat(bot, msg, '📭 Hoje não tem pedidos registrados ainda.');
          return;
        }

        const companyContext =
          process.env.COMPANY_CONTEXT ||
          'Estofaria/marcenaria; foco em sofás, cadeiras e reformas.';

        const plan = await planProduction({ orders, companyContext, question: msg.text });
        await sendInChat(bot, msg, plan.message, { parse_mode: 'Markdown' });
        return;
      }

      await sendInChat(bot, msg, 'Entendi 👍\nSe quiser a lista do dia, digite: *serviços de hoje*', {
        parse_mode: 'Markdown'
      });
    } catch (e) {
      log.error('Handler error:', e);
      try {
        await sendInChat(bot, msg, '⚠️ Deu um erro aqui. Tenta de novo em 5 segundos.');
      } catch {}
    }
  });

  bot.on('callback_query', async (q) => {
    try {
      const msg = q.message;
      const data = q.data || '';
      await bot.answerCallbackQuery(q.id).catch(() => {});
      if (!msg) return;

      // VENDAS confirm/cancel
      if (data.startsWith('sale:confirm:') || data.startsWith('sale:cancel:')) {
        const parts = data.split(':');
        const action = parts[1];
        const id = parts.slice(2).join(':');
        const confirmKey = `confirm_sale:${id}`;
        const payload = await kvGet(db, confirmKey);

        if (!payload) {
          await bot.sendMessage(msg.chat.id, '⚠️ Essa confirmação expirou. Envie a venda novamente.', {
            message_thread_id: msg.message_thread_id
          });
          return;
        }

        if (action === 'cancel') {
          await kvDel(db, confirmKey);
          await bot.sendMessage(msg.chat.id, '❌ Ok, cancelei.', { message_thread_id: msg.message_thread_id });
          return;
        }

        const order = await createOrder(db, {
          client_name: payload.client_name,
          description: payload.description,
          value: payload.value,
          notes: 'Criado via grupo VENDAS',
          source_group_key: 'vendas'
        });

        await kvDel(db, confirmKey);

        await bot.sendMessage(msg.chat.id, `✅ Venda registrada! Pedido #${order.id}`, {
          message_thread_id: msg.message_thread_id
        });

        // Auto-notify production + finance
        const groups = await getGroups(db);
        const producao = groups.get('producao');
        const financeiro = groups.get('financeiro');

        const line = `🧾 Novo pedido #${order.id}\nCliente: ${order.client_name || '(não informado)'}\nDescrição: ${order.description || '(não informado)'}\nValor: ${order.value_cents != null ? formatMoneyBRL(order.value_cents) : '—'}`;

        if (producao?.chat_id) {
          await bot
            .sendMessage(producao.chat_id, `🧵 *PRODUÇÃO*\n\n${line}`, { parse_mode: 'Markdown' })
            .catch(() => {});
        }
        if (financeiro?.chat_id) {
          await bot
            .sendMessage(financeiro.chat_id, `💰 *FINANCEIRO*\n\n${line}`, { parse_mode: 'Markdown' })
            .catch(() => {});
        }

        return;
      }

      if (data === 'help') {
        const help = [
          '🧾 *Comandos úteis*',
          '',
          '• menu  → abre o painel',
          '• serviços de hoje  → lista pedidos do dia + ordem sugerida',
          '• /setgroup <chave> → registra o grupo (admin)',
          '',
          'No grupo VENDAS:',
          '• `Venda: reforma sofá 3 lugares para Maria 3600`',
          '',
          'Chaves: vendas | producao | financeiro | compras | relatorios | backups'
        ].join('\n');
        await bot.sendMessage(msg.chat.id, help, {
          parse_mode: 'Markdown',
          message_thread_id: msg.message_thread_id
        });
        return;
      }

      if (data === 'ai:services_today') {
        const orders = await listTodayOrders(db);
        if (!orders.length) {
          await bot.sendMessage(msg.chat.id, '📭 Hoje não tem pedidos registrados ainda.', {
            message_thread_id: msg.message_thread_id
          });
          return;
        }
        const companyContext =
          process.env.COMPANY_CONTEXT ||
          'Estofaria/marcenaria; foco em sofás, cadeiras e reformas.';
        const plan = await planProduction({ orders, companyContext, question: 'serviços do dia' });
        await bot.sendMessage(msg.chat.id, plan.message, {
          parse_mode: 'Markdown',
          message_thread_id: msg.message_thread_id
        });
        return;
      }

      if (data === 'ai:open_orders') {
        const orders = await listOpenOrders(db);
        if (!orders.length) {
          await bot.sendMessage(msg.chat.id, '✅ Não tem pedidos abertos.', {
            message_thread_id: msg.message_thread_id
          });
          return;
        }
        const lines = orders.slice(0, 30).map((o) => `• ${formatOrderLine(o)}`).join('\n');
        await bot.sendMessage(msg.chat.id, `📌 *Pedidos abertos*\n\n${lines}`, {
          parse_mode: 'Markdown',
          message_thread_id: msg.message_thread_id
        });
        return;
      }

      if (data === 'crm:new_sale_hint') {
        const hint = [
          'Para registrar uma venda, mande uma mensagem tipo:',
          '',
          'Venda: reforma sofá 3 lugares para Maria 3600',
          '',
          'Se faltar valor, eu vou pedir.'
        ].join('\n');
        await bot.sendMessage(msg.chat.id, hint, { message_thread_id: msg.message_thread_id });
        return;
      }
    } catch (e) {
      log.error('callback error:', e);
    }
  });

  bot.on('polling_error', (e) => {
    log.error('polling_error', e?.response?.body || e?.message || e);
  });

  return bot;
}

module.exports = {
  createTelegramBot
};
