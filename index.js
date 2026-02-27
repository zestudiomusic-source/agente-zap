/**
 * AGENTE ERP (Telegram + IA placeholder) — v2 (Postgres + Automação + Tópicos)
 * - Telegram: painel admin + wizard + menus
 * - Postgres: 100% (Render)
 * - Grupos: VENDAS/PRODUCAO/FINANCEIRO/COMPRAS/RELATORIOS
 * - Fechar venda => cria Pedido + Financeiro + notifica Produção (com tópicos se habilitado)
 * - Tópicos: cria 1 tópico por pedido nos grupos que forem "forum"
 * - Relatório semanal (segunda) sem web
 */

const express = require("express");
const cron = require("node-cron");
const { Pool } = require("pg");

// ================= CONFIG =================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.TELEGRAM_ADMIN_ID || process.env.ADMIN_ID);
const DATABASE_URL = process.env.DATABASE_URL;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // ex: https://agente-zap.onrender.com
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN (ou BOT_TOKEN) não configurado.");
  process.exit(1);
}
if (!ADMIN_ID) {
  console.error("TELEGRAM_ADMIN_ID (ou ADMIN_ID) não configurado.");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("DATABASE_URL não configurado.");
  process.exit(1);
}
if (!PUBLIC_BASE_URL) {
  console.error("PUBLIC_BASE_URL não configurado. Ex: https://seu-servico.onrender.com");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "5mb" })); // texto + callbacks

// ================= DB =================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

async function dbExec(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

async function initDb() {
  await dbExec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
      key TEXT PRIMARY KEY,                -- vendas, producao, financeiro, compras, relatorios
      chat_id BIGINT NOT NULL,
      title TEXT,
      is_forum BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS threads (
      id SERIAL PRIMARY KEY,
      group_key TEXT NOT NULL REFERENCES groups(key) ON DELETE CASCADE,
      entity_type TEXT NOT NULL,           -- "order"
      entity_id BIGINT NOT NULL,           -- order_id
      thread_id BIGINT,                    -- message_thread_id (forum topic id)
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(group_key, entity_type, entity_id)
    );

    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL,
      contact TEXT,
      description TEXT,
      value_cents BIGINT DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open', -- open, won, lost
      created_by BIGINT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      lead_id BIGINT REFERENCES leads(id),
      customer_name TEXT NOT NULL,
      contact TEXT,
      address TEXT,
      description TEXT,
      notes TEXT,
      value_cents BIGINT DEFAULT 0,
      pickup_date TEXT,
      delivery_date TEXT,
      status TEXT NOT NULL DEFAULT 'novo', -- novo, em_producao, pronto, entregue, cancelado
      created_by BIGINT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS finance (
      id SERIAL PRIMARY KEY,
      order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
      type TEXT NOT NULL,                  -- receivable, payment
      value_cents BIGINT NOT NULL,
      method TEXT,
      status TEXT NOT NULL DEFAULT 'pendente', -- pendente, parcial, pago
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS production_alerts (
      id SERIAL PRIMARY KEY,
      order_id BIGINT REFERENCES orders(id) ON DELETE CASCADE,
      alert TEXT NOT NULL,                 -- "faltou tecido", "faltou espuma"...
      created_by BIGINT,
      created_at TIMESTAMP DEFAULT NOW(),
      resolved BOOLEAN DEFAULT FALSE,
      resolved_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id SERIAL PRIMARY KEY,
      order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
      customer_name TEXT,
      item_name TEXT NOT NULL,
      item_code TEXT,
      value_cents BIGINT DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'a_comprar', -- a_comprar, comprado
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reports_log (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL, -- weekly
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log("DB: Postgres OK");
}

// ================= TELEGRAM API =================
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tgCall(method, payload) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  return json;
}

async function tgSendMessage(chat_id, text, extra = {}) {
  const payload = { chat_id, text, ...extra };
  const r = await tgCall("sendMessage", payload);

  // Trata migração para supergrupo (migrate_to_chat_id)
  if (!r.ok && r.error_code === 400 && r.parameters && r.parameters.migrate_to_chat_id) {
    const newChatId = Number(r.parameters.migrate_to_chat_id);
    console.warn("Telegram migrate_to_chat_id detectado. Atualizando groups.chat_id =>", newChatId);

    await dbExec(`UPDATE groups SET chat_id=$1, updated_at=NOW() WHERE chat_id=$2`, [newChatId, chat_id]);

    // tenta de novo
    const retry = await tgCall("sendMessage", { ...payload, chat_id: newChatId });
    return retry;
  }

  return r;
}

function isAdmin(userId) {
  return Number(userId) === ADMIN_ID;
}

// ================= MENU UI =================
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "💰 Vendas (CRM)", callback_data: "MENU_VENDAS" }, { text: "🧾 Pedidos", callback_data: "MENU_PEDIDOS" }],
      [{ text: "🧵 Produção", callback_data: "MENU_PRODUCAO" }, { text: "📊 Financeiro", callback_data: "MENU_FINANCEIRO" }],
      [{ text: "🛒 Compras", callback_data: "MENU_COMPRAS" }, { text: "📑 Relatórios/Rotinas", callback_data: "MENU_RELATORIOS" }],
      [{ text: "🤖 IA", callback_data: "MENU_IA" }, { text: "⚙️ Sistema", callback_data: "MENU_SISTEMA" }],
    ],
  };
}

function backKeyboard() {
  return { inline_keyboard: [[{ text: "⬅️ Voltar ao menu", callback_data: "MENU_HOME" }]] };
}

function centsFromText(s) {
  if (!s) return 0;
  // aceita "3600", "3.600,00", "3600,00"
  const cleaned = String(s).trim().replace(/\./g, "").replace(",", ".");
  const n = Number(cleaned);
  if (Number.isNaN(n) || n < 0) return 0;
  return Math.round(n * 100);
}

function moneyBR(cents) {
  const v = (Number(cents || 0) / 100).toFixed(2).replace(".", ",");
  return `R$ ${v}`;
}

// ================= GROUPS + TOPICS =================
const GROUP_KEYS = ["vendas", "producao", "financeiro", "compras", "relatorios"];

async function setGroup(key, chat) {
  if (!GROUP_KEYS.includes(key)) {
    return { ok: false, error: "Chave inválida. Use: vendas|producao|financeiro|compras|relatorios" };
  }
  const chatId = Number(chat.id);
  const isForum = !!chat.is_forum;
  const title = chat.title || chat.username || "";

  await dbExec(
    `INSERT INTO groups(key, chat_id, title, is_forum, updated_at)
     VALUES($1,$2,$3,$4,NOW())
     ON CONFLICT(key) DO UPDATE SET chat_id=EXCLUDED.chat_id, title=EXCLUDED.title, is_forum=EXCLUDED.is_forum, updated_at=NOW()`,
    [key, chatId, title, isForum]
  );

  return { ok: true, key, chatId, isForum, title };
}

async function getGroup(key) {
  const r = await dbExec(`SELECT * FROM groups WHERE key=$1`, [key]);
  return r.rows[0] || null;
}

async function ensureOrderThread(groupKey, orderId, topicTitle) {
  const group = await getGroup(groupKey);
  if (!group) return { ok: false, reason: "Grupo não registrado" };

  // se não for forum, não tem thread
  if (!group.is_forum) return { ok: true, thread_id: null, group };

  // já existe thread?
  const existing = await dbExec(
    `SELECT thread_id FROM threads WHERE group_key=$1 AND entity_type='order' AND entity_id=$2`,
    [groupKey, orderId]
  );
  if (existing.rows[0]?.thread_id) {
    return { ok: true, thread_id: Number(existing.rows[0].thread_id), group };
  }

  // cria tópico
  const topicRes = await tgCall("createForumTopic", {
    chat_id: Number(group.chat_id),
    name: topicTitle.slice(0, 128),
  });

  if (!topicRes.ok) {
    console.warn("Falha ao criar tópico:", topicRes);
    // fallback: sem tópico
    return { ok: true, thread_id: null, group };
  }

  const threadId = Number(topicRes.result.message_thread_id);

  await dbExec(
    `INSERT INTO threads(group_key, entity_type, entity_id, thread_id)
     VALUES($1,'order',$2,$3)
     ON CONFLICT(group_key, entity_type, entity_id) DO UPDATE SET thread_id=EXCLUDED.thread_id`,
    [groupKey, orderId, threadId]
  );

  return { ok: true, thread_id: threadId, group };
}

async function sendToGroup(groupKey, text, orderId = null, extra = {}) {
  const group = await getGroup(groupKey);
  if (!group) return { ok: false, error: `Grupo '${groupKey}' não registrado. Use /setgroup ${groupKey} dentro do grupo.` };

  let message_thread_id = undefined;

  if (orderId) {
    const topicTitle = `Pedido #${orderId}`;
    const thread = await ensureOrderThread(groupKey, orderId, topicTitle);
    if (thread.ok && thread.thread_id) message_thread_id = thread.thread_id;
  }

  const payload = {
    parse_mode: "HTML",
    ...extra,
  };

  if (message_thread_id) payload.message_thread_id = message_thread_id;

  const r = await tgSendMessage(Number(group.chat_id), text, payload);
  return r;
}

// ================= STATE (wizard simples) =================
/**
 * Wizard por usuário:
 * - NEW_LEAD: coletar nome, contato, descrição, valor
 * - NEW_ORDER: coletar pedido direto (admin)
 */
const userState = new Map(); // userId => { step, data }

function setState(userId, step, data = {}) {
  userState.set(String(userId), { step, data });
}
function getState(userId) {
  return userState.get(String(userId)) || null;
}
function clearState(userId) {
  userState.delete(String(userId));
}

// ================= BUSINESS: VENDAS -> FECHAR -> PEDIDO/FIN/PROD =================
async function createLead(data, createdBy) {
  const r = await dbExec(
    `INSERT INTO leads(customer_name, contact, description, value_cents, status, created_by, updated_at)
     VALUES($1,$2,$3,$4,'open',$5,NOW())
     RETURNING *`,
    [data.customer_name, data.contact || null, data.description || null, Number(data.value_cents || 0), Number(createdBy)]
  );
  return r.rows[0];
}

async function markLeadWon(leadId) {
  await dbExec(`UPDATE leads SET status='won', updated_at=NOW() WHERE id=$1`, [leadId]);
}

async function createOrderFromLead(lead, createdBy) {
  const r = await dbExec(
    `INSERT INTO orders(lead_id, customer_name, contact, description, value_cents, status, created_by, updated_at)
     VALUES($1,$2,$3,$4,$5,'novo',$6,NOW())
     RETURNING *`,
    [lead.id, lead.customer_name, lead.contact, lead.description, lead.value_cents, Number(createdBy)]
  );
  return r.rows[0];
}

async function createFinanceReceivable(order) {
  const r = await dbExec(
    `INSERT INTO finance(order_id, type, value_cents, status, note)
     VALUES($1,'receivable',$2,'pendente',$3)
     RETURNING *`,
    [order.id, order.value_cents, `Recebível do Pedido #${order.id}`]
  );
  return r.rows[0];
}

// ================= REPORT (segunda) =================
async function buildWeeklyReportText() {
  const weekOrders = await dbExec(
    `SELECT COUNT(*)::int as n, COALESCE(SUM(value_cents),0)::bigint as total
     FROM orders
     WHERE created_at >= NOW() - INTERVAL '7 days'`
  );
  const openLeads = await dbExec(`SELECT COUNT(*)::int as n FROM leads WHERE status='open'`);
  const pendingFin = await dbExec(`SELECT COUNT(*)::int as n, COALESCE(SUM(value_cents),0)::bigint as total FROM finance WHERE status IN ('pendente','parcial')`);

  const prodAlerts = await dbExec(`SELECT COUNT(*)::int as n FROM production_alerts WHERE resolved=false`);

  const ord = weekOrders.rows[0];
  const leads = openLeads.rows[0];
  const fin = pendingFin.rows[0];
  const alerts = prodAlerts.rows[0];

  const text =
`<b>📑 Relatório Semanal (últimos 7 dias)</b>

<b>Vendas/Pedidos</b>
• Pedidos criados: <b>${ord.n}</b>
• Total em pedidos: <b>${moneyBR(ord.total)}</b>
• Leads em aberto: <b>${leads.n}</b>

<b>Financeiro</b>
• Pendências (pendente/parcial): <b>${fin.n}</b>
• Total pendente: <b>${moneyBR(fin.total)}</b>

<b>Produção</b>
• Alertas abertos: <b>${alerts.n}</b>

<b>Ações recomendadas</b>
1) Revisar leads em aberto e definir próxima mensagem/ação.
2) Conferir pendências do financeiro (cobranças, parcelas).
3) Tratar alertas de produção (materiais faltando) e alimentar Compras.

(Obs: relatório sem pesquisa na web.)`;

  return text;
}

async function sendWeeklyReport() {
  const grp = await getGroup("relatorios");
  if (!grp) {
    console.warn("Relatórios: grupo 'relatorios' não registrado. Use /setgroup relatorios no grupo.");
    return;
  }
  const txt = await buildWeeklyReportText();
  await sendToGroup("relatorios", txt, null);
  await dbExec(`INSERT INTO reports_log(kind) VALUES('weekly')`);
}

// ================= TELEGRAM HANDLERS =================
async function handleCommand(message) {
  const text = (message.text || "").trim();
  const chat = message.chat;
  const from = message.from;

  const userId = from.id;
  const chatId = chat.id;
  const isGroup = ["group", "supergroup"].includes(chat.type);

  // comando /start
  if (text.startsWith("/start")) {
    await tgSendMessage(chatId, "Olá! Use /menu para abrir o painel.");
    return;
  }

  // comando /menu
  if (text.startsWith("/menu")) {
    // segurança: menu completo só pro admin (no privado ou no grupo)
    if (!isAdmin(userId)) {
      await tgSendMessage(chatId, "Acesso restrito. Fale com o administrador.");
      return;
    }
    await tgSendMessage(chatId, "📊 <b>Painel Administrativo</b>\nEscolha um módulo:", {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  // comando /setgroup <key>
  if (text.startsWith("/setgroup")) {
    if (!isAdmin(userId)) {
      await tgSendMessage(chatId, "Somente o ADM pode registrar grupos.");
      return;
    }
    if (!isGroup) {
      await tgSendMessage(chatId, "Use este comando DENTRO de um grupo.");
      return;
    }
    const parts = text.split(/\s+/);
    const key = (parts[1] || "").toLowerCase();
    const r = await setGroup(key, chat);
    if (!r.ok) {
      await tgSendMessage(chatId, `Erro: ${r.error}`);
      return;
    }
    await tgSendMessage(chatId, `✅ Grupo registrado: <b>${key}</b>\nchat_id: <code>${r.chatId}</code>\nTópicos (forum): <b>${r.isForum ? "SIM" : "NÃO"}</b>`, {
      parse_mode: "HTML",
    });
    return;
  }

  // comando /ping (teste)
  if (text.startsWith("/ping")) {
    await tgSendMessage(chatId, `pong ✅\nchat_id: <code>${chatId}</code>\nuser_id: <code>${userId}</code>\nchat_type: <code>${chat.type}</code>`, {
      parse_mode: "HTML",
    });
    return;
  }

  // comandos de produção: /alerta <texto> (funcionário pode usar no grupo de produção)
  if (text.startsWith("/alerta")) {
    const parts = text.split(" ");
    const alertText = parts.slice(1).join(" ").trim();
    if (!alertText) {
      await tgSendMessage(chatId, "Uso: /alerta faltou tecido (ou espuma, madeira...)");
      return;
    }
    // exige estar no grupo PRODUCAO
    const prod = await getGroup("producao");
    if (!prod || Number(prod.chat_id) !== Number(chatId)) {
      await tgSendMessage(chatId, "Este comando deve ser usado no grupo PRODUCAO.");
      return;
    }
    // opcional: tentar extrair pedido #ID no texto
    const m = alertText.match(/#(\d+)/);
    const orderId = m ? Number(m[1]) : null;

    const ins = await dbExec(
      `INSERT INTO production_alerts(order_id, alert, created_by) VALUES($1,$2,$3) RETURNING *`,
      [orderId, alertText, Number(userId)]
    );
    await tgSendMessage(chatId, `⚠️ Alerta registrado${orderId ? ` no Pedido #${orderId}` : ""}: ${alertText}`);

    // avisa ADM no grupo RELATORIOS (ou FINANCEIRO, você escolhe)
    const notifyText = `⚠️ <b>ALERTA DE PRODUÇÃO</b>\n${orderId ? `Pedido: <b>#${orderId}</b>\n` : ""}Texto: ${alertText}`;
    await sendToGroup("relatorios", notifyText, orderId || null);

    return;
  }

  // Se estiver em wizard, trata aqui
  const st = getState(userId);
  if (st) {
    await handleWizardMessage(message, st);
    return;
  }

  // texto solto: não responder no grupo (anti-spam); no privado orientar
  if (!isGroup) {
    await tgSendMessage(chatId, "Use /menu para abrir o painel.");
  }
}

async function handleWizardMessage(message, st) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = (message.text || "").trim();

  if (st.step === "NEW_LEAD_NAME") {
    st.data.customer_name = text;
    setState(userId, "NEW_LEAD_CONTACT", st.data);
    await tgSendMessage(chatId, "Contato (telefone/WhatsApp) do cliente? (ou digite '-' para pular)");
    return;
  }

  if (st.step === "NEW_LEAD_CONTACT") {
    st.data.contact = text === "-" ? "" : text;
    setState(userId, "NEW_LEAD_DESC", st.data);
    await tgSendMessage(chatId, "Descrição do orçamento (ex: sofá 3 lugares, reforma, etc.)");
    return;
  }

  if (st.step === "NEW_LEAD_DESC") {
    st.data.description = text;
    setState(userId, "NEW_LEAD_VALUE", st.data);
    await tgSendMessage(chatId, "Valor do orçamento? (ex: 3600 ou 3.600,00)");
    return;
  }

  if (st.step === "NEW_LEAD_VALUE") {
    st.data.value_cents = centsFromText(text);

    const lead = await createLead(st.data, userId);
    clearState(userId);

    const msg =
`✅ <b>Lead criado</b>
Cliente: <b>${lead.customer_name}</b>
Contato: ${lead.contact || "-"}
Descrição: ${lead.description || "-"}
Valor: <b>${moneyBR(lead.value_cents)}</b>

O que deseja fazer?`;

    await tgSendMessage(chatId, msg, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Fechar venda (vira pedido)", callback_data: `LEAD_WON_${lead.id}` }],
          [{ text: "⬅️ Menu", callback_data: "MENU_HOME" }],
        ],
      },
    });

    // também notifica no grupo VENDAS (se configurado)
    await sendToGroup(
      "vendas",
      `🧾 <b>Novo orçamento</b>\nCliente: <b>${lead.customer_name}</b>\nValor: <b>${moneyBR(lead.value_cents)}</b>\nDescrição: ${lead.description || "-"}`,
      null
    );

    return;
  }

  await tgSendMessage(chatId, "Wizard inválido. Use /menu novamente.");
  clearState(userId);
}

async function handleCallback(callback) {
  const data = callback.data;
  const from = callback.from;
  const msg = callback.message;

  const userId = from.id;
  const chatId = msg.chat.id;

  // segurança: menus e ações administrativas somente ADM
  if (!isAdmin(userId)) {
    await tgCall("answerCallbackQuery", { callback_query_id: callback.id, text: "Acesso restrito." });
    return;
  }

  await tgCall("answerCallbackQuery", { callback_query_id: callback.id });

  // HOME
  if (data === "MENU_HOME") {
    await tgSendMessage(chatId, "📊 <b>Painel Administrativo</b>\nEscolha um módulo:", {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  // MENUS
  if (data === "MENU_VENDAS") {
    await tgSendMessage(chatId, "💰 <b>Vendas (CRM)</b>\nO que deseja fazer?", {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "➕ Novo orçamento (lead)", callback_data: "VENDAS_NEW_LEAD" }],
          [{ text: "📋 Leads em aberto", callback_data: "VENDAS_LIST_OPEN" }],
          [{ text: "⬅️ Voltar", callback_data: "MENU_HOME" }],
        ],
      },
    });
    return;
  }

  if (data === "VENDAS_NEW_LEAD") {
    setState(userId, "NEW_LEAD_NAME", {});
    await tgSendMessage(chatId, "Nome do cliente?");
    return;
  }

  if (data === "VENDAS_LIST_OPEN") {
    const r = await dbExec(
      `SELECT id, customer_name, value_cents, created_at FROM leads WHERE status='open' ORDER BY id DESC LIMIT 10`
    );
    if (!r.rows.length) {
      await tgSendMessage(chatId, "Nenhum lead em aberto no momento.", { reply_markup: backKeyboard() });
      return;
    }

    const lines = r.rows
      .map((x) => `• #${x.id} — ${x.customer_name} — <b>${moneyBR(x.value_cents)}</b>`)
      .join("\n");

    const kb = r.rows.map((x) => [{ text: `✅ Fechar #${x.id}`, callback_data: `LEAD_WON_${x.id}` }]);
    kb.push([{ text: "⬅️ Voltar", callback_data: "MENU_VENDAS" }]);

    await tgSendMessage(chatId, `<b>Leads em aberto</b>\n\n${lines}`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: kb },
    });
    return;
  }

  if (data.startsWith("LEAD_WON_")) {
    const leadId = Number(data.replace("LEAD_WON_", ""));
    const rLead = await dbExec(`SELECT * FROM leads WHERE id=$1`, [leadId]);
    const lead = rLead.rows[0];
    if (!lead) {
      await tgSendMessage(chatId, "Lead não encontrado.");
      return;
    }

    await markLeadWon(leadId);
    const order = await createOrderFromLead(lead, userId);
    const fin = await createFinanceReceivable(order);

    // Notifica Produção e Financeiro (com tópicos se tiver)
    const prodText =
`🧵 <b>Novo Pedido para Produção</b>
Pedido: <b>#${order.id}</b>
Cliente: <b>${order.customer_name}</b>
Descrição: ${order.description || "-"}
Valor: <b>${moneyBR(order.value_cents)}</b>

Use /alerta se faltar algo.`;

    const finText =
`📊 <b>Novo Recebível</b>
Pedido: <b>#${order.id}</b>
Cliente: <b>${order.customer_name}</b>
Valor: <b>${moneyBR(fin.value_cents)}</b>
Status: <b>${fin.status}</b>`;

    await sendToGroup("producao", prodText, order.id);
    await sendToGroup("financeiro", finText, order.id);

    await tgSendMessage(chatId,
      `✅ <b>Venda fechada!</b>\nPedido <b>#${order.id}</b> criado.\nFinanceiro e Produção foram avisados automaticamente.`,
      { parse_mode: "HTML", reply_markup: backKeyboard() }
    );

    return;
  }

  if (data === "MENU_PEDIDOS") {
    const r = await dbExec(`SELECT id, customer_name, status, value_cents FROM orders ORDER BY id DESC LIMIT 10`);
    if (!r.rows.length) {
      await tgSendMessage(chatId, "Nenhum pedido ainda.", { reply_markup: backKeyboard() });
      return;
    }
    const lines = r.rows
      .map((o) => `• <b>#${o.id}</b> — ${o.customer_name} — <code>${o.status}</code> — <b>${moneyBR(o.value_cents)}</b>`)
      .join("\n");
    await tgSendMessage(chatId, `<b>Últimos pedidos</b>\n\n${lines}`, { parse_mode: "HTML", reply_markup: backKeyboard() });
    return;
  }

  if (data === "MENU_PRODUCAO") {
    await tgSendMessage(chatId, "🧵 <b>Produção</b>\n\n• Alertas podem ser criados no grupo PRODUCAO com:\n<code>/alerta faltou tecido #123</code>\n\n• O sistema cria tópico por pedido (se tópicos estiverem habilitados).", {
      parse_mode: "HTML",
      reply_markup: backKeyboard(),
    });
    return;
  }

  if (data === "MENU_FINANCEIRO") {
    const r = await dbExec(
      `SELECT id, order_id, value_cents, status FROM finance ORDER BY id DESC LIMIT 10`
    );
    const lines = r.rows.length
      ? r.rows.map((f) => `• #${f.id} — Pedido #${f.order_id || "-"} — <b>${moneyBR(f.value_cents)}</b> — <code>${f.status}</code>`).join("\n")
      : "Nenhum lançamento ainda.";

    await tgSendMessage(chatId, `<b>Financeiro (últimos lançamentos)</b>\n\n${lines}`, {
      parse_mode: "HTML",
      reply_markup: backKeyboard(),
    });
    return;
  }

  if (data === "MENU_COMPRAS") {
    const r = await dbExec(`SELECT id, customer_name, item_name, item_code, value_cents, status FROM purchases ORDER BY id DESC LIMIT 10`);
    const lines = r.rows.length
      ? r.rows.map((p) => `• #${p.id} — ${p.customer_name || "-"} — ${p.item_name} (${p.item_code || "-"}) — <b>${moneyBR(p.value_cents)}</b> — <code>${p.status}</code>`).join("\n")
      : "Nenhum item de compras ainda.";

    await tgSendMessage(chatId, `<b>Compras</b>\n\n${lines}\n\n(Fluxos avançados de compras podemos expandir depois.)`, {
      parse_mode: "HTML",
      reply_markup: backKeyboard(),
    });
    return;
  }

  if (data === "MENU_RELATORIOS") {
    await tgSendMessage(chatId, "📑 <b>Relatórios/Rotinas</b>\nO que deseja fazer?", {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📌 Gerar relatório agora", callback_data: "REL_NOW" }],
          [{ text: "⬅️ Voltar", callback_data: "MENU_HOME" }],
        ],
      },
    });
    return;
  }

  if (data === "REL_NOW") {
    const txt = await buildWeeklyReportText();
    await tgSendMessage(chatId, txt, { parse_mode: "HTML", reply_markup: backKeyboard() });
    // também manda no grupo relatorios
    await sendToGroup("relatorios", txt, null);
    return;
  }

  if (data === "MENU_SISTEMA") {
    const r = await dbExec(`SELECT key, chat_id, is_forum, title FROM groups ORDER BY key ASC`);
    const lines = r.rows.length
      ? r.rows.map((g) => `• <b>${g.key}</b> — <code>${g.chat_id}</code> — tópicos: <b>${g.is_forum ? "SIM" : "NÃO"}</b> — ${g.title || ""}`).join("\n")
      : "Nenhum grupo registrado ainda. Use /setgroup dentro do grupo.";

    await tgSendMessage(chatId, `<b>Sistema</b>\n\n<b>Grupos registrados:</b>\n${lines}`, {
      parse_mode: "HTML",
      reply_markup: backKeyboard(),
    });
    return;
  }

  if (data === "MENU_IA") {
    await tgSendMessage(chatId, "🤖 <b>IA</b>\n\nNeste momento a IA está como módulo placeholder.\nComo você pediu: sem análise de prints, apenas arquivos (futuramente podemos ligar leitura de arquivo e extração).\n\n(O núcleo do ERP já está pronto.)", {
      parse_mode: "HTML",
      reply_markup: backKeyboard(),
    });
    return;
  }

  await tgSendMessage(chatId, "Opção não reconhecida.", { reply_markup: backKeyboard() });
}

// ================= WEBHOOK =================
app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;

    // LOG resumido
    if (update.message) {
      const m = update.message;
      console.log("UPDATE.message:", {
        chat_id: m.chat?.id,
        chat_type: m.chat?.type,
        chat_title: m.chat?.title,
        from_id: m.from?.id,
        text: m.text,
      });
      if (m.text && m.text.startsWith("/")) {
        await handleCommand(m);
      } else {
        // se estiver em wizard, trata; senão ignora em grupo e orienta em privado
        const st = getState(m.from.id);
        if (st) await handleWizardMessage(m, st);
        else await handleCommand(m); // aqui cai no "texto solto"
      }
    }

    if (update.callback_query) {
      console.log("UPDATE.callback:", update.callback_query.data);
      await handleCallback(update.callback_query);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Erro no webhook:", err);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => {
  res.status(200).send("OK");
});

// ================= STARTUP =================
async function setWebhook() {
  const url = `${PUBLIC_BASE_URL.replace(/\/$/, "")}/webhook`;
  const r = await tgCall("setWebhook", { url });
  console.log("Telegram setWebhook:", r.ok ? "OK" : r);
}

async function startup() {
  console.log("Iniciando servidor...");
  await initDb();

  // Set webhook
  await setWebhook();

  // Relatório semanal: segunda-feira 09:00 (horário BR -03:00)
  // node-cron usa timezone opcional:
  cron.schedule(
    "0 9 * * 1",
    async () => {
      try {
        console.log("CRON: gerando relatório semanal...");
        await sendWeeklyReport();
      } catch (e) {
        console.error("CRON erro:", e);
      }
    },
    { timezone: "America/Sao_Paulo" }
  );

  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Telegram webhook: POST /webhook`);
    console.log(`PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}`);
  });
}

startup().catch((e) => {
  console.error("Falha no startup:", e);
  process.exit(1);
});
