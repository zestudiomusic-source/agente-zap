/**
 * AGENTE ERP (Telegram + WhatsApp + IA + Postgres) — ÚNICO index.js
 * - Telegram: painel administrativo /menu + módulos (Vendas/Produção/Compras/Financeiro/Relatórios/IA/Sistema)
 * - Grupos separados: VENDAS, PRODUCAO, FINANCEIRO, COMPRAS, RELATORIOS (registrados no banco)
 * - Postgres 100% (Render Postgres) via DATABASE_URL
 * - Webhooks:
 *    - Telegram: POST /webhook
 *    - WhatsApp: GET/POST /wa/webhook (verificação + recebimento básico)
 * - Permissões por Telegram ID:
 *    - ADM total (TELEGRAM_ADMIN_ID)
 *    - Outros perfis podem ser cadastrados no banco (tabela users)
 * - Menu recomendado: só no privado. Em grupos, /menu orienta abrir DM.
 * - Tratamento do erro: “group chat was upgraded to a supergroup chat” (migrate_to_chat_id)
 *
 * ENV obrigatórias:
 * - TELEGRAM_BOT_TOKEN
 * - TELEGRAM_ADMIN_ID
 * - PUBLIC_BASE_URL          (ex: https://agente-zap.onrender.com)
 * - DATABASE_URL             (Render Postgres “Internal Database URL” ou External)
 *
 * ENV opcionais:
 * - WA_VERIFY_TOKEN
 * - OPENAI_API_KEY
 * - OPENAI_MODEL             (ex: gpt-4.1-mini)
 */

"use strict";

const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

// Node 18+ já tem fetch
const fetchJson = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
};

// ================= CONFIG =================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.TELEGRAM_ADMIN_ID);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const PORT = Number(process.env.PORT || 3000);

const DATABASE_URL = process.env.DATABASE_URL;

const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

if (!BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN/BOT_TOKEN não configurado!");
  process.exit(1);
}
if (!ADMIN_ID) {
  console.error("❌ TELEGRAM_ADMIN_ID não configurado!");
  process.exit(1);
}
if (!PUBLIC_BASE_URL) {
  console.error("❌ PUBLIC_BASE_URL não configurado! (ex: https://seuapp.onrender.com)");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL não configurado (Render Postgres)!");
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ================= APP =================
const app = express();
app.use(express.json({ limit: "10mb" }));

// ================= DATABASE (Postgres) =================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

const q = (text, params) => pool.query(text, params);

// ---- schema
async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
      key TEXT PRIMARY KEY,              -- vendas|producao|financeiro|compras|relatorios
      chat_id BIGINT NOT NULL,
      title TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'staff', -- admin|vendas|producao|financeiro|compras|staff
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS leads (
      id BIGSERIAL PRIMARY KEY,
      name TEXT,
      phone TEXT,
      source TEXT DEFAULT 'manual',
      stage TEXT NOT NULL DEFAULT 'em_andamento', -- em_andamento|concluida|perdida
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      lead_id BIGINT REFERENCES leads(id) ON DELETE SET NULL,
      customer_name TEXT NOT NULL,
      contact TEXT,
      address TEXT,
      description TEXT,
      obs TEXT,
      value_cents BIGINT,
      pickup_date DATE,
      delivery_date DATE,
      status TEXT NOT NULL DEFAULT 'novo', -- novo|em_producao|pronto|entregue|cancelado
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT REFERENCES orders(id) ON DELETE CASCADE,
      amount_cents BIGINT NOT NULL,
      method TEXT,
      paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS production_alerts (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
      created_by BIGINT,
      type TEXT NOT NULL,   -- tecido|espuma|madeira|outro
      message TEXT NOT NULL,
      is_open BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      closed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
      customer_name TEXT,
      item TEXT NOT NULL,   -- tecido / espuma / madeira / etc
      code TEXT,
      price_cents BIGINT,
      qty TEXT,
      is_done BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      done_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS ai_memory (
      id BIGSERIAL PRIMARY KEY,
      scope TEXT NOT NULL,      -- ex: 'empresa' ou 'lead:123'
      role TEXT NOT NULL,       -- user|assistant|system
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
    CREATE INDEX IF NOT EXISTS idx_purchases_done ON purchases(is_done);
    CREATE INDEX IF NOT EXISTS idx_alerts_open ON production_alerts(is_open);
  `);

  // garante admin no banco
  await q(
    `INSERT INTO users (telegram_id, name, role) VALUES ($1, $2, 'admin')
     ON CONFLICT (telegram_id) DO UPDATE SET role='admin', is_active=true`,
    [ADMIN_ID, "ADMIN"]
  );

  console.log("✅ DB: Postgres OK");
}

// ================= UTIL: Telegram =================
function escapeHtml(s = "") {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function tg(method, payload) {
  return fetchJson(`${TG_API}/${method}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * Envia mensagem e trata migração de grupo -> supergrupo
 */
async function tgSendMessage(chat_id, text, extra = {}) {
  try {
    return await tg("sendMessage", {
      chat_id,
      text,
      parse_mode: extra.parse_mode || "HTML",
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (e) {
    const data = e?.data;
    const migrate = data?.parameters?.migrate_to_chat_id;
    const desc = data?.description || "";
    if (migrate && desc.includes("upgraded to a supergroup")) {
      // atualiza chat_id na tabela groups se existir
      await q(
        `UPDATE groups SET chat_id=$2, updated_at=now() WHERE chat_id=$1`,
        [chat_id, migrate]
      ).catch(() => null);

      // tenta novamente
      return await tg("sendMessage", {
        chat_id: migrate,
        text,
        parse_mode: extra.parse_mode || "HTML",
        disable_web_page_preview: true,
        ...extra,
      });
    }
    throw e;
  }
}

async function tgAnswerCallbackQuery(callback_query_id, text = "") {
  return tg("answerCallbackQuery", { callback_query_id, text, show_alert: false });
}

function isPrivateChat(msg) {
  return msg?.chat?.type === "private";
}

async function getUserRole(telegramId) {
  if (telegramId === ADMIN_ID) return "admin";
  const r = await q(`SELECT role, is_active FROM users WHERE telegram_id=$1`, [telegramId]);
  if (!r.rows.length) return "staff";
  if (!r.rows[0].is_active) return "blocked";
  return r.rows[0].role;
}

function hasAccess(role, moduleKey) {
  // moduleKey: vendas|producao|financeiro|compras|relatorios|ia|sistema|pedidos
  if (role === "admin") return true;

  const map = {
    vendas: ["vendas", "pedidos"],
    producao: ["producao"],
    financeiro: ["financeiro"],
    compras: ["compras"],
    relatorios: ["relatorios"],
    staff: [], // sem menu
  };

  if (role === "blocked") return false;

  const allow = map[role] || map.staff;
  return allow.includes(moduleKey);
}

function kb(rows) {
  return { inline_keyboard: rows };
}

// ================= GROUP REGISTRY =================
const GROUP_KEYS = {
  vendas: "VENDAS",
  producao: "PRODUCAO",
  financeiro: "FINANCEIRO",
  compras: "COMPRAS",
  relatorios: "RELATORIOS",
};

async function setGroup(key, chat) {
  await q(
    `INSERT INTO groups (key, chat_id, title) VALUES ($1,$2,$3)
     ON CONFLICT (key) DO UPDATE SET chat_id=$2, title=$3, updated_at=now()`,
    [key, chat.id, chat.title || ""]
  );
}

async function getGroupChatId(key) {
  const r = await q(`SELECT chat_id FROM groups WHERE key=$1`, [key]);
  return r.rows[0]?.chat_id ? Number(r.rows[0].chat_id) : null;
}

async function notifyGroup(key, text, extra = {}) {
  const chatId = await getGroupChatId(key);
  if (!chatId) return null;
  return tgSendMessage(chatId, text, extra);
}

// ================= BUSINESS HELPERS =================
function centsFromBRL(str) {
  if (!str) return null;
  const s = String(str).replace(/[^\d,.-]/g, "").replace(".", "").replace(",", ".");
  const n = Number(s);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100);
}
function brlFromCents(cents) {
  if (cents == null) return "—";
  const n = Number(cents) / 100;
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

async function touchOrder(orderId) {
  await q(`UPDATE orders SET updated_at=now() WHERE id=$1`, [orderId]);
}

// ================= UI: MENUS =================
function adminPanelKeyboard(role) {
  // só mostra botões conforme permissões
  const rows = [];
  const row1 = [];
  if (hasAccess(role, "vendas")) row1.push({ text: "💰 Vendas (CRM)", callback_data: "m:vendas" });
  row1.push({ text: "📦 Pedidos", callback_data: "m:pedidos" });
  if (row1.length) rows.push(row1);

  const row2 = [];
  if (hasAccess(role, "producao")) row2.push({ text: "🏭 Produção", callback_data: "m:producao" });
  if (hasAccess(role, "financeiro")) row2.push({ text: "📊 Financeiro", callback_data: "m:financeiro" });
  if (row2.length) rows.push(row2);

  const row3 = [];
  if (hasAccess(role, "compras")) row3.push({ text: "🧾 Compras", callback_data: "m:compras" });
  if (hasAccess(role, "relatorios")) row3.push({ text: "📈 Relatórios/Rotinas", callback_data: "m:relatorios" });
  if (row3.length) rows.push(row3);

  const row4 = [];
  row4.push({ text: "🤖 IA", callback_data: "m:ia" });
  if (role === "admin") row4.push({ text: "⚙️ Sistema", callback_data: "m:sistema" });
  rows.push(row4);

  return kb(rows);
}

async function showMenu(chat_id, role) {
  const text =
    `<b>📊 Painel Administrativo</b>\n` +
    `Escolha um módulo:`;
  return tgSendMessage(chat_id, text, { reply_markup: adminPanelKeyboard(role) });
}

// ================= TELEGRAM COMMANDS =================
async function handleCommand(msg) {
  const chat = msg.chat;
  const from = msg.from;
  const text = (msg.text || "").trim();
  const role = await getUserRole(from.id);

  // /start
  if (text.startsWith("/start")) {
    if (!isPrivateChat(msg)) {
      return tgSendMessage(chat.id, "✅ Estou ativo. Para abrir o painel, fale comigo no privado e use <b>/menu</b>.");
    }
    return tgSendMessage(
      chat.id,
      `Olá, <b>${escapeHtml(from.first_name || "Tudo certo")}</b>!\nUse <b>/menu</b> para abrir o painel.`,
      { reply_markup: adminPanelKeyboard(role) }
    );
  }

  // /menu
  if (text.startsWith("/menu")) {
    if (!isPrivateChat(msg)) {
      return tgSendMessage(chat.id, "📌 Para usar o painel, abra meu privado e digite <b>/menu</b>.");
    }
    return showMenu(chat.id, role);
  }

  // Registrar grupo (admin) — rodar dentro do grupo:
  // /setgroup vendas  (ou producao/financeiro/compras/relatorios)
  if (text.startsWith("/setgroup")) {
    if (role !== "admin") return tgSendMessage(chat.id, "❌ Apenas ADM pode usar este comando.");
    const parts = text.split(/\s+/);
    const key = (parts[1] || "").toLowerCase();
    if (!GROUP_KEYS[key]) {
      return tgSendMessage(
        chat.id,
        `Uso: <b>/setgroup vendas</b> | <b>producao</b> | <b>financeiro</b> | <b>compras</b> | <b>relatorios</b>`
      );
    }
    if (chat.type === "private") return tgSendMessage(chat.id, "❌ Use este comando dentro do grupo correspondente.");
    await setGroup(key, chat);
    return tgSendMessage(chat.id, `✅ Grupo registrado como <b>${GROUP_KEYS[key]}</b>.`);
  }

  // Cadastro rápido de usuário (admin):
  // /setrole 123456789 producao Nome
  if (text.startsWith("/setrole")) {
    if (role !== "admin") return tgSendMessage(chat.id, "❌ Apenas ADM.");
    const parts = text.split(/\s+/);
    const id = Number(parts[1]);
    const newRole = (parts[2] || "").toLowerCase();
    const name = parts.slice(3).join(" ").trim() || null;
    const okRoles = ["admin", "vendas", "producao", "financeiro", "compras", "relatorios", "staff"];
    if (!id || !okRoles.includes(newRole)) {
      return tgSendMessage(chat.id, `Uso: <b>/setrole TELEGRAM_ID role Nome</b>\nRoles: ${okRoles.join(", ")}`);
    }
    await q(
      `INSERT INTO users (telegram_id, name, role, is_active)
       VALUES ($1,$2,$3,true)
       ON CONFLICT (telegram_id) DO UPDATE SET name=COALESCE($2, users.name), role=$3, is_active=true`,
      [id, name, newRole]
    );
    return tgSendMessage(chat.id, `✅ Usuário <b>${id}</b> agora é <b>${newRole}</b>.`);
  }

  // Bloquear/Desbloquear
  if (text.startsWith("/block")) {
    if (role !== "admin") return tgSendMessage(chat.id, "❌ Apenas ADM.");
    const id = Number(text.split(/\s+/)[1]);
    if (!id) return tgSendMessage(chat.id, "Uso: <b>/block TELEGRAM_ID</b>");
    await q(`UPDATE users SET is_active=false WHERE telegram_id=$1`, [id]);
    return tgSendMessage(chat.id, `⛔ Usuário ${id} bloqueado.`);
  }
  if (text.startsWith("/unblock")) {
    if (role !== "admin") return tgSendMessage(chat.id, "❌ Apenas ADM.");
    const id = Number(text.split(/\s+/)[1]);
    if (!id) return tgSendMessage(chat.id, "Uso: <b>/unblock TELEGRAM_ID</b>");
    await q(`UPDATE users SET is_active=true WHERE telegram_id=$1`, [id]);
    return tgSendMessage(chat.id, `✅ Usuário ${id} desbloqueado.`);
  }

  // fallback: se alguém mandar comando desconhecido
  if (text.startsWith("/")) {
    if (!isPrivateChat(msg)) return; // evita spam em grupo
    return tgSendMessage(chat.id, "Comando não reconhecido. Use <b>/menu</b>.");
  }
}

// ================= CALLBACKS (BOTÕES) =================
async function handleCallbackQuery(cb) {
  const from = cb.from;
  const role = await getUserRole(from.id);
  const data = cb.data || "";
  const chat_id = cb.message?.chat?.id;

  if (!chat_id) return tgAnswerCallbackQuery(cb.id, "Ok");

  // navegação módulos
  if (data.startsWith("m:")) {
    const mod = data.slice(2);

    // bloqueia acesso
    const modToCheck = mod === "pedidos" ? "pedidos" : mod;
    if (mod !== "ia" && mod !== "pedidos" && !hasAccess(role, modToCheck) && role !== "admin") {
      await tgAnswerCallbackQuery(cb.id, "Sem permissão.");
      return;
    }

    await tgAnswerCallbackQuery(cb.id, "Abrindo...");

    if (mod === "vendas") return showSales(chat_id, role);
    if (mod === "pedidos") return showOrders(chat_id, role);
    if (mod === "producao") return showProduction(chat_id, role);
    if (mod === "financeiro") return showFinance(chat_id, role);
    if (mod === "compras") return showPurchases(chat_id, role);
    if (mod === "relatorios") return showReports(chat_id, role);
    if (mod === "ia") return showAI(chat_id, role);
    if (mod === "sistema") return showSystem(chat_id, role);
  }

  // ações rápidas (prefixos)
  if (data.startsWith("order:")) {
    // order:STATUS:ID
    const [, status, idStr] = data.split(":");
    const id = Number(idStr);
    if (!id) return tgAnswerCallbackQuery(cb.id, "Inválido.");

    // Produção e Admin podem mudar status
    if (!(role === "admin" || role === "producao")) {
      await tgAnswerCallbackQuery(cb.id, "Sem permissão.");
      return;
    }

    await q(`UPDATE orders SET status=$1, updated_at=now() WHERE id=$2`, [status, id]);
    await tgAnswerCallbackQuery(cb.id, "Atualizado!");

    // avisa no grupo Produção/Financeiro conforme status
    const ord = await q(`SELECT customer_name, description FROM orders WHERE id=$1`, [id]);
    const o = ord.rows[0];
    const msg =
      `🏷️ <b>Status do Pedido #${id}</b>\n` +
      `Cliente: <b>${escapeHtml(o?.customer_name || "")}</b>\n` +
      `Status: <b>${escapeHtml(status)}</b>\n` +
      `Descrição: ${escapeHtml(o?.description || "—")}`;

    await notifyGroup("producao", msg).catch(() => null);
    await notifyGroup("relatorios", msg).catch(() => null);

    // reabre tela produção
    return showProduction(chat_id, role);
  }

  if (data.startsWith("alert:")) {
    // alert:close:ID
    const [, action, idStr] = data.split(":");
    const id = Number(idStr);
    if (!id) return tgAnswerCallbackQuery(cb.id, "Inválido.");
    if (!(role === "admin" || role === "producao")) {
      await tgAnswerCallbackQuery(cb.id, "Sem permissão.");
      return;
    }
    if (action === "close") {
      await q(`UPDATE production_alerts SET is_open=false, closed_at=now() WHERE id=$1`, [id]);
      await tgAnswerCallbackQuery(cb.id, "Alerta fechado.");
      return showProduction(chat_id, role);
    }
  }

  if (data.startsWith("buy:")) {
    // buy:done:ID
    const [, action, idStr] = data.split(":");
    const id = Number(idStr);
    if (!id) return tgAnswerCallbackQuery(cb.id, "Inválido.");
    if (!(role === "admin" || role === "compras")) {
      await tgAnswerCallbackQuery(cb.id, "Sem permissão.");
      return;
    }
    if (action === "done") {
      await q(`UPDATE purchases SET is_done=true, done_at=now() WHERE id=$1`, [id]);
      await tgAnswerCallbackQuery(cb.id, "Marcado como comprado.");
      return showPurchases(chat_id, role);
    }
  }

  return tgAnswerCallbackQuery(cb.id, "Ok");
}

// ================= MODULE SCREENS =================
async function showSales(chat_id, role) {
  if (!(role === "admin" || role === "vendas")) {
    return tgSendMessage(chat_id, "❌ Sem permissão para Vendas.");
  }

  const r = await q(
    `SELECT stage, COUNT(*)::int as c
     FROM leads
     GROUP BY stage`
  );

  const counts = Object.fromEntries(r.rows.map((x) => [x.stage, x.c]));
  const em = counts.em_andamento || 0;
  const con = counts.concluida || 0;
  const per = counts.perdida || 0;

  const txt =
    `<b>💰 Vendas (CRM)</b>\n` +
    `Em andamento: <b>${em}</b>\n` +
    `Concluídas: <b>${con}</b>\n` +
    `Perdidas: <b>${per}</b>\n\n` +
    `📌 Ações principais (por enquanto):\n` +
    `• Registrar lead/pedido pelo módulo Pedidos\n` +
    `• Evoluir o sistema depois para condução avançada\n`;

  return tgSendMessage(chat_id, txt, {
    reply_markup: kb([[{ text: "⬅️ Voltar", callback_data: "m:home" }]]),
  }).catch(async () => {
    // fallback: volta ao menu
    return showMenu(chat_id, role);
  });
}

async function showOrders(chat_id, role) {
  // Pedidos: admin/vendas/producao/financeiro podem ver
  if (!(role === "admin" || role === "vendas" || role === "producao" || role === "financeiro")) {
    return tgSendMessage(chat_id, "❌ Sem permissão para Pedidos.");
  }

  const r = await q(
    `SELECT id, customer_name, description, status, value_cents, created_at
     FROM orders
     ORDER BY id DESC
     LIMIT 10`
  );

  let txt = `<b>📦 Pedidos (últimos 10)</b>\n\n`;
  if (!r.rows.length) {
    txt += `Nenhum pedido ainda.\n`;
  } else {
    for (const o of r.rows) {
      txt +=
        `#${o.id} — <b>${escapeHtml(o.customer_name)}</b>\n` +
        `Status: <b>${escapeHtml(o.status)}</b> | Valor: <b>${escapeHtml(brlFromCents(o.value_cents))}</b>\n` +
        `Desc: ${escapeHtml(o.description || "—")}\n\n`;
    }
  }

  txt += `📌 Criação de pedidos via fluxo/wizard completo pode ser ligado depois (se você quiser).`;

  return tgSendMessage(chat_id, txt, { reply_markup: adminPanelKeyboard(role) });
}

async function showProduction(chat_id, role) {
  if (!(role === "admin" || role === "producao")) {
    return tgSendMessage(chat_id, "❌ Sem permissão para Produção.");
  }

  const orders = await q(
    `SELECT id, customer_name, description, status
     FROM orders
     WHERE status IN ('novo','em_producao','pronto')
     ORDER BY updated_at DESC
     LIMIT 8`
  );

  const alerts = await q(
    `SELECT id, type, message, created_at
     FROM production_alerts
     WHERE is_open=true
     ORDER BY created_at DESC
     LIMIT 5`
  );

  let txt = `<b>🏭 Produção</b>\n\n`;

  txt += `<b>Pedidos em aberto</b>\n`;
  if (!orders.rows.length) txt += `— Nenhum.\n`;
  for (const o of orders.rows) {
    txt += `#${o.id} <b>${escapeHtml(o.customer_name)}</b> — <i>${escapeHtml(o.status)}</i>\n${escapeHtml(
      o.description || "—"
    )}\n`;
    txt += `\n`;
  }

  txt += `\n<b>Alertas abertos</b>\n`;
  if (!alerts.rows.length) txt += `— Nenhum.\n`;

  // teclado de ações: status por pedido + fechar alertas
  const rows = [];

  for (const o of orders.rows) {
    rows.push([
      { text: `#${o.id} ✅ Pronto`, callback_data: `order:pronto:${o.id}` },
      { text: `#${o.id} 🏭 Em produção`, callback_data: `order:em_producao:${o.id}` },
    ]);
    rows.push([{ text: `#${o.id} 🚚 Entregue`, callback_data: `order:entregue:${o.id}` }]);
  }

  if (alerts.rows.length) {
    rows.push([{ text: "— Fechar alertas —", callback_data: "noop" }]);
    for (const a of alerts.rows) {
      rows.push([{ text: `Fechar alerta #${a.id} (${a.type})`, callback_data: `alert:close:${a.id}` }]);
    }
  }

  rows.push([{ text: "⬅️ Menu", callback_data: "m:home" }]);

  // descreve alertas no texto
  if (alerts.rows.length) {
    txt += `\n`;
    for (const a of alerts.rows) {
      txt += `⚠️ <b>#${a.id}</b> [${escapeHtml(a.type)}] — ${escapeHtml(a.message)}\n`;
    }
  }

  return tgSendMessage(chat_id, txt, { reply_markup: kb(rows) }).catch(() => showMenu(chat_id, role));
}

async function showFinance(chat_id, role) {
  if (!(role === "admin" || role === "financeiro")) {
    return tgSendMessage(chat_id, "❌ Sem permissão para Financeiro.");
  }

  // caixa do dia (pagamentos hoje)
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const dateStr = `${yyyy}-${mm}-${dd}`;

  const cash = await q(
    `SELECT COALESCE(SUM(amount_cents),0)::bigint as total
     FROM payments
     WHERE paid_at::date = $1::date`,
    [dateStr]
  );

  const pending = await q(
    `SELECT COUNT(*)::int as c
     FROM orders
     WHERE status NOT IN ('entregue','cancelado')`
  );

  const txt =
    `<b>📊 Financeiro</b>\n\n` +
    `💵 Caixa do dia (${escapeHtml(dateStr)}): <b>${escapeHtml(brlFromCents(cash.rows[0].total))}</b>\n` +
    `📦 Pedidos em aberto: <b>${pending.rows[0].c}</b>\n\n` +
    `📌 Registro de pagamentos (wizard) pode ser ligado na próxima etapa.\n`;

  return tgSendMessage(chat_id, txt, { reply_markup: adminPanelKeyboard(role) });
}

async function showPurchases(chat_id, role) {
  if (!(role === "admin" || role === "compras")) {
    return tgSendMessage(chat_id, "❌ Sem permissão para Compras.");
  }

  const open = await q(
    `SELECT id, customer_name, item, code, price_cents, qty, created_at
     FROM purchases
     WHERE is_done=false
     ORDER BY created_at DESC
     LIMIT 10`
  );

  let txt = `<b>🧾 Compras</b>\n\n`;
  txt += `<b>Lista (pendentes)</b>\n`;
  if (!open.rows.length) txt += `— Nenhum item pendente.\n`;

  const rows = [];
  for (const p of open.rows) {
    txt +=
      `• <b>#${p.id}</b> Cliente: <b>${escapeHtml(p.customer_name || "—")}</b>\n` +
      `  Item: ${escapeHtml(p.item)} | Código: ${escapeHtml(p.code || "—")} | Valor: <b>${escapeHtml(
        brlFromCents(p.price_cents)
      )}</b> | Qtd: ${escapeHtml(p.qty || "—")}\n\n`;

    rows.push([{ text: `✅ Marcar comprado #${p.id}`, callback_data: `buy:done:${p.id}` }]);
  }
  rows.push([{ text: "⬅️ Menu", callback_data: "m:home" }]);

  return tgSendMessage(chat_id, txt, { reply_markup: kb(rows) }).catch(() => showMenu(chat_id, role));
}

async function showReports(chat_id, role) {
  if (!(role === "admin" || role === "relatorios")) {
    return tgSendMessage(chat_id, "❌ Sem permissão para Relatórios.");
  }

  const r1 = await q(`SELECT COUNT(*)::int as c FROM orders`);
  const r2 = await q(`SELECT COUNT(*)::int as c FROM leads`);
  const r3 = await q(`SELECT COUNT(*)::int as c FROM purchases WHERE is_done=false`);
  const r4 = await q(`SELECT COUNT(*)::int as c FROM production_alerts WHERE is_open=true`);

  const txt =
    `<b>📈 Relatórios / Rotinas</b>\n\n` +
    `Pedidos total: <b>${r1.rows[0].c}</b>\n` +
    `Leads total: <b>${r2.rows[0].c}</b>\n` +
    `Compras pendentes: <b>${r3.rows[0].c}</b>\n` +
    `Alertas abertos: <b>${r4.rows[0].c}</b>\n\n` +
    `🗓️ Toda segunda-feira eu gero um relatório semanal automático no grupo RELATORIOS (se estiver registrado).\n`;

  return tgSendMessage(chat_id, txt, { reply_markup: adminPanelKeyboard(role) });
}

async function showAI(chat_id, role) {
  const txt =
    `<b>🤖 IA</b>\n\n` +
    `IA está habilitada para ajudar em análises e textos.\n` +
    `• Para usar, fale comigo no privado e escreva sua pergunta.\n\n` +
    `Obs: se OPENAI_API_KEY não estiver configurado, eu funciono sem IA.\n`;

  return tgSendMessage(chat_id, txt, { reply_markup: adminPanelKeyboard(role) });
}

async function showSystem(chat_id, role) {
  if (role !== "admin") return tgSendMessage(chat_id, "❌ Apenas ADM.");
  const groups = await q(`SELECT key, chat_id, title FROM groups ORDER BY key ASC`);
  let txt = `<b>⚙️ Sistema</b>\n\n<b>Grupos registrados</b>\n`;
  if (!groups.rows.length) txt += `— Nenhum ainda.\n`;
  for (const g of groups.rows) {
    txt += `• <b>${escapeHtml(g.key)}</b> → ${escapeHtml(String(g.chat_id))} (${escapeHtml(g.title || "")})\n`;
  }

  txt +=
    `\n<b>Comandos ADM</b>\n` +
    `• /setgroup vendas|producao|financeiro|compras|relatorios (dentro do grupo)\n` +
    `• /setrole TELEGRAM_ID role Nome\n` +
    `• /block TELEGRAM_ID | /unblock TELEGRAM_ID\n`;

  return tgSendMessage(chat_id, txt, { reply_markup: adminPanelKeyboard(role) });
}

// home callback
async function handleHome(cb) {
  const from = cb.from;
  const role = await getUserRole(from.id);
  const chat_id = cb.message?.chat?.id;
  if (!chat_id) return;
  return showMenu(chat_id, role);
}

// ================= AI (opcional) =================
async function openaiChat(messages) {
  // API “Responses” é o mais novo, mas para manter simples e compatível:
  // vamos usar /v1/chat/completions (funciona em muitos modelos).
  const body = {
    model: OPENAI_MODEL,
    messages,
    temperature: 0.4,
  };

  const res = await fetchJson("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(body),
  });

  const content = res?.choices?.[0]?.message?.content || "";
  return content.trim();
}

async function maybeHandleAIPrivateText(msg) {
  // regra: só no privado e sem começar com "/"
  if (!isPrivateChat(msg)) return false;
  if (!msg.text) return false;
  const text = msg.text.trim();
  if (!text || text.startsWith("/")) return false;

  // se não tem API, apenas não faz nada
  if (!OPENAI_API_KEY) return false;

  const from = msg.from;
  const role = await getUserRole(from.id);
  if (role === "blocked") return true;

  // memória leve: últimos 12 registros no escopo empresa
  const scope = "empresa";
  await q(`INSERT INTO ai_memory (scope, role, content) VALUES ($1,'user',$2)`, [scope, text]);

  const mem = await q(
    `SELECT role, content FROM ai_memory WHERE scope=$1 ORDER BY id DESC LIMIT 12`,
    [scope]
  );

  const messages = [
    {
      role: "system",
      content:
        "Você é um assistente de gestão para uma empresa de estofaria/móveis. Seja prático, objetivo e proponha ações. Não invente dados; quando faltar dado, peça o mínimo necessário.",
    },
    ...mem.rows.reverse().map((r) => ({ role: r.role, content: r.content })),
  ];

  let answer;
  try {
    answer = await openaiChat(messages);
  } catch (e) {
    console.error("OpenAI error:", e?.data || e?.message || e);
    await tgSendMessage(msg.chat.id, "❌ Falha ao chamar IA agora. Verifique OPENAI_API_KEY / OPENAI_MODEL.");
    return true;
  }

  await q(`INSERT INTO ai_memory (scope, role, content) VALUES ($1,'assistant',$2)`, [scope, answer]);
  await tgSendMessage(msg.chat.id, answer);
  return true;
}

// ================= WEEKLY REPORT (SEGUNDA) =================
async function generateWeeklyReportText() {
  // últimos 7 dias
  const rOrders = await q(
    `SELECT COUNT(*)::int as total,
            COALESCE(SUM(value_cents),0)::bigint as total_value
     FROM orders
     WHERE created_at >= now() - interval '7 days'`
  );
  const rPayments = await q(
    `SELECT COALESCE(SUM(amount_cents),0)::bigint as total
     FROM payments
     WHERE paid_at >= now() - interval '7 days'`
  );
  const rOpenAlerts = await q(`SELECT COUNT(*)::int as c FROM production_alerts WHERE is_open=true`);
  const rOpenPurch = await q(`SELECT COUNT(*)::int as c FROM purchases WHERE is_done=false`);

  const ordersTotal = rOrders.rows[0].total;
  const ordersValue = rOrders.rows[0].total_value;
  const paid = rPayments.rows[0].total;
  const openAlerts = rOpenAlerts.rows[0].c;
  const openPurch = rOpenPurch.rows[0].c;

  const txt =
    `📌 <b>Relatório Semanal (últimos 7 dias)</b>\n\n` +
    `🧾 Pedidos criados: <b>${ordersTotal}</b>\n` +
    `💰 Valor em pedidos: <b>${escapeHtml(brlFromCents(ordersValue))}</b>\n` +
    `💵 Pagamentos recebidos: <b>${escapeHtml(brlFromCents(paid))}</b>\n` +
    `⚠️ Alertas abertos (produção): <b>${openAlerts}</b>\n` +
    `🧵 Compras pendentes: <b>${openPurch}</b>\n\n` +
    `<b>Ações recomendadas</b>\n` +
    `1) Revisar gargalos na produção (alertas e pedidos parados).\n` +
    `2) Conferir itens pendentes em compras e priorizar materiais críticos.\n` +
    `3) Fazer follow-up nos clientes com pedidos em aberto e alinhar prazos.\n` +
    `4) Checar fluxo de caixa: recebidos vs. pedidos emitidos.\n`;

  return txt;
}

// scheduler simples: roda 1x por minuto, dispara segunda 09:00 (horário do servidor)
let lastWeeklyKey = "";
async function tickScheduler() {
  const now = new Date();
  const day = now.getDay(); // 1=segunda
  const hh = now.getHours();
  const mm = now.getMinutes();

  // dispara segunda 09:00
  if (day === 1 && hh === 9 && mm === 0) {
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-weekly`;
    if (key !== lastWeeklyKey) {
      lastWeeklyKey = key;
      const chatId = await getGroupChatId("relatorios");
      if (chatId) {
        const txt = await generateWeeklyReportText();
        await tgSendMessage(chatId, txt).catch((e) => console.error("Weekly report send error:", e?.data || e));
      }
    }
  }
}

// ================= TELEGRAM WEBHOOK =================
app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;

    // mensagens
    if (update.message) {
      const msg = update.message;

      // log leve
      if (msg?.text) {
        console.log(`TG msg @${msg.chat.type} chat=${msg.chat.id} from=${msg.from.id}: ${msg.text}`);
      }

      // comandos
      if (msg.text && msg.text.trim().startsWith("/")) {
        await handleCommand(msg);
        return res.sendStatus(200);
      }

      // IA (opcional) no privado
      const handledAI = await maybeHandleAIPrivateText(msg);
      if (handledAI) return res.sendStatus(200);

      // Em grupo: ignorar texto solto (evita spam)
      return res.sendStatus(200);
    }

    // callbacks (botões)
    if (update.callback_query) {
      const cb = update.callback_query;
      if (cb.data === "m:home") {
        await tgAnswerCallbackQuery(cb.id, "Ok");
        await handleHome(cb);
        return res.sendStatus(200);
      }
      if (cb.data === "noop") {
        await tgAnswerCallbackQuery(cb.id, "Ok");
        return res.sendStatus(200);
      }
      await handleCallbackQuery(cb);
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e?.data || e?.message || e);
    return res.sendStatus(200);
  }
});

// ================= WHATSAPP WEBHOOK (básico) =================
app.get("/wa/webhook", (req, res) => {
  // verificação estilo Meta
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/wa/webhook", async (req, res) => {
  try {
    // aqui você pode evoluir para classificar mensagens e criar lead/pedido automaticamente
    console.log("WA webhook received");
    return res.sendStatus(200);
  } catch (e) {
    console.error("WA webhook error:", e?.message || e);
    return res.sendStatus(200);
  }
});

// ================= HEALTH =================
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

// ================= STARTUP =================
async function ensureTelegramWebhook() {
  const url = `${PUBLIC_BASE_URL.replace(/\/+$/, "")}/webhook`;
  const r = await tg("setWebhook", { url });
  console.log("Telegram webhook:", r?.ok ? "OK" : "FAIL", url);
}

async function boot() {
  await initDb();

  app.listen(PORT, () => {
    console.log(`✅ Servidor rodando na porta ${PORT}`);
    console.log(`Telegram webhook: POST /webhook`);
    console.log(`WA webhook: GET/POST /wa/webhook`);
    console.log(`PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}`);
  });

  await ensureTelegramWebhook();

  // scheduler (1 min)
  setInterval(() => tickScheduler().catch(() => null), 60 * 1000);
}

boot().catch((e) => {
  console.error("BOOT error:", e?.data || e?.message || e);
  process.exit(1);
});
