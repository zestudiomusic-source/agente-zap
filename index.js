/**
 * AGENTE ERP (Telegram + WhatsApp + IA) — versão integrada (ÚNICA e LIMPA)
 * - Telegram: painel administrativo + wizard + menus + modo Chat IA
 * - WhatsApp: captura mensagens (lead) via webhook (GET verify + POST receive)
 * - CRM/Vendas: pipeline (Em andamento / Concluídas / Perdidas) + converter venda em pedido
 * - Pedidos: wizard completo (Nome/Contato/Endereço/Descrição/Obs/Valor/Data buscar/Data entregar) + status produção
 * - Produção: status por botões + filtros + atrasados
 * - Financeiro: registrar pagamentos + pendentes/parciais/pagos + caixa do dia + fechar dia
 * - IA: Chat IA + Insights (alertas, estratégias, gargalos)
 *
 * Webhooks:
 * - Telegram: POST /webhook
 * - WhatsApp: GET/POST /wa/webhook
 *
 * ENV no Render (mínimo):
 * - TELEGRAM_ADMIN_ID          (seu user id)
 * - BOT_TOKEN                  (ou TELEGRAM_BOT_TOKEN)
 * - WA_VERIFY_TOKEN            (para verificação do webhook WA)
 * - OPENAI_API_KEY             (opcional, para IA)
 * - OPENAI_MODEL               (opcional, ex: gpt-4.1-mini)
 *
 * ENV WA (para enviar mensagens futuramente, não usado agora):
 * - WA_TOKEN
 * - PHONE_NUMBER_ID
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

// ===================== CONFIG =====================
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = Number(process.env.TELEGRAM_ADMIN_ID || 0);
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini"; // default melhor alinhado ao seu env

const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "";

if (!BOT_TOKEN) {
  console.error("ERRO: BOT_TOKEN/TELEGRAM_BOT_TOKEN não configurado!");
  process.exit(1);
}
if (!ADMIN_ID) {
  console.error("ERRO: TELEGRAM_ADMIN_ID não configurado!");
  process.exit(1);
}
if (!WA_VERIFY_TOKEN) {
  console.warn("⚠️ WA_VERIFY_TOKEN não configurado! A verificação GET /wa/webhook vai falhar.");
}

// Node >=18 tem fetch global. Se por algum motivo não existir:
if (typeof fetch !== "function") {
  console.error("ERRO: fetch não está disponível. Use Node 18+ no Render.");
  process.exit(1);
}

// ===================== APP (ORDEM CERTA) =====================
const app = express();
app.use(express.json({ limit: "2mb" }));

// ===================== DATABASE =====================
const isRender = !!process.env.RENDER;
const dbPath = isRender ? path.join("/tmp", "bot.db") : path.join(__dirname, "db", "bot.db");

if (!isRender) {
  const dbDir = path.join(__dirname, "db");
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// ===================== DB SCHEMA =====================
db.exec(`
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT,
  contato TEXT,
  endereco TEXT,
  descricao TEXT,
  observacoes TEXT,
  valor REAL,
  data_buscar TEXT,
  data_entregar TEXT,
  status_producao TEXT DEFAULT 'Aguardando produção',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  valor REAL,
  metodo TEXT,
  observacao TEXT,
  paid_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(order_id) REFERENCES orders(id)
);

-- CRM / VENDAS
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT,
  contato TEXT,
  endereco TEXT,
  descricao TEXT,
  observacoes TEXT,
  valor_estimado REAL,
  etapa TEXT DEFAULT 'Lead novo',         -- pipeline livre
  origem TEXT DEFAULT 'manual',
  wa_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT,           -- 'whatsapp' / 'telegram'
  wa_id TEXT,             -- telefone do WA (string)
  chat_id TEXT,           -- chat id telegram (string)
  direction TEXT,         -- 'in' ou 'out'
  text TEXT,
  raw_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT,
  ref_type TEXT,
  ref_id TEXT,
  payload_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT,
  insight_text TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ESTADOS (wizard e modo IA)
CREATE TABLE IF NOT EXISTS state (
  chat_id INTEGER PRIMARY KEY,
  mode TEXT,              -- 'NONE' | 'ORDER_WIZ' | 'DEAL_WIZ' | 'PAY_WIZ' | 'AI_CHAT' | 'SEARCH' | 'SET_STATUS'
  step TEXT,
  payload_json TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
`);

// ===================== TELEGRAM =====================
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tg(method, body) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.error("Telegram error:", method, data);
  return data;
}

async function tgSendMessage(chatId, text, extra = {}) {
  return tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
}

async function tgSendMessagePlain(chatId, text, extra = {}) {
  // sem parse_mode (útil para textos “crus”)
  return tg("sendMessage", { chat_id: chatId, text, ...extra });
}

async function tgEditMessage(chatId, messageId, text, extra = {}) {
  return tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    ...extra,
  });
}

async function tgAnswerCallbackQuery(id) {
  return tg("answerCallbackQuery", { callback_query_id: id });
}

// Split para evitar limite do Telegram
async function tgSendLongHTML(chatId, text, extra = {}) {
  const max = 3500; // margem segura
  const chunks = [];
  let s = String(text || "");
  while (s.length > max) {
    chunks.push(s.slice(0, max));
    s = s.slice(max);
  }
  if (s.length) chunks.push(s);

  for (const c of chunks) {
    await tgSendMessage(chatId, c, extra);
  }
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ===================== HELPERS =====================
function kb(rows) {
  return { reply_markup: { inline_keyboard: rows } };
}

function moneyBR(v) {
  const n = Number(v || 0);
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseDateToISO(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function setState(chatId, mode, step = "", payload = {}) {
  db.prepare(`
    INSERT INTO state(chat_id, mode, step, payload_json, updated_at)
    VALUES(?,?,?,?, datetime('now'))
    ON CONFLICT(chat_id) DO UPDATE SET
      mode=excluded.mode,
      step=excluded.step,
      payload_json=excluded.payload_json,
      updated_at=datetime('now')
  `).run(chatId, mode, step, JSON.stringify(payload || {}));
}

function getState(chatId) {
  const row = db.prepare(`SELECT mode, step, payload_json FROM state WHERE chat_id=?`).get(chatId);
  if (!row) return { mode: "NONE", step: "", payload: {} };
  let payload = {};
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : {};
  } catch {
    payload = {};
  }
  return { mode: row.mode || "NONE", step: row.step || "", payload };
}

function clearState(chatId) {
  db.prepare(`DELETE FROM state WHERE chat_id=?`).run(chatId);
}

function logEvent(event_type, ref_type, ref_id, payload) {
  db.prepare(`INSERT INTO events(event_type, ref_type, ref_id, payload_json) VALUES (?,?,?,?)`).run(
    event_type,
    String(ref_type || ""),
    String(ref_id || ""),
    JSON.stringify(payload || {})
  );
}

function saveMessage({ channel, wa_id, chat_id, direction, text, raw }) {
  db.prepare(`
    INSERT INTO messages(channel, wa_id, chat_id, direction, text, raw_json)
    VALUES(?,?,?,?,?,?)
  `).run(channel, wa_id || null, chat_id || null, direction, text || "", raw ? JSON.stringify(raw) : null);
}

function orderFinancial(orderId) {
  const o = db.prepare(`SELECT valor FROM orders WHERE id=?`).get(orderId);
  if (!o) return null;
  const paid = db.prepare(`SELECT COALESCE(SUM(valor),0) s FROM payments WHERE order_id=?`).get(orderId).s;
  const total = Number(o.valor || 0);
  let status = "PENDENTE";
  if (paid > 0 && paid + 1e-6 < total) status = "PARCIAL";
  if (paid + 1e-6 >= total) status = "PAGO";
  return { total, paid, status };
}

function kpis() {
  const t = todayISO();
  const pedidosHoje = db.prepare(`SELECT COUNT(*) c FROM orders WHERE substr(created_at,1,10)=?`).get(t).c;
  const vendasHoje = db.prepare(`SELECT COUNT(*) c FROM deals WHERE substr(updated_at,1,10)=? AND etapa='Concluída'`).get(t).c;
  const caixaHoje = db.prepare(`SELECT COALESCE(SUM(valor),0) s FROM payments WHERE substr(paid_at,1,10)=?`).get(t).s;
  const atrasados = db.prepare(`
    SELECT COUNT(*) c FROM orders
    WHERE data_entregar IS NOT NULL AND data_entregar < ? AND status_producao != 'Entregue'
  `).get(t).c;
  return { date: t, pedidosHoje, vendasHoje, caixaHoje, atrasados };
}

// ===================== MENUS =====================
function MENU_MAIN() {
  return kb([
    [{ text: "💰 Vendas (CRM)", callback_data: "M:DEALS" }, { text: "📦 Pedidos", callback_data: "M:ORDERS" }],
    [{ text: "🏭 Produção", callback_data: "M:PROD" }, { text: "📊 Financeiro", callback_data: "M:FIN" }],
    [{ text: "📆 Agenda", callback_data: "M:AGENDA" }, { text: "🧠 IA", callback_data: "M:AI" }],
    [{ text: "⚙️ Sistema", callback_data: "M:SYSTEM" }],
  ]);
}

function MENU_DEALS() {
  return kb([
    [{ text: "➕ Nova Venda", callback_data: "D:NEW" }],
    [{ text: "🟡 Em andamento", callback_data: "D:LIST:AND" }, { text: "🟢 Concluídas", callback_data: "D:LIST:DONE" }],
    [{ text: "🔴 Perdidas", callback_data: "D:LIST:LOST" }],
    [{ text: "🔎 Buscar (ID/Nome/Contato)", callback_data: "D:SEARCH" }],
    [{ text: "⬅️ Voltar", callback_data: "M:MAIN" }],
  ]);
}

function MENU_ORDERS() {
  return kb([
    [{ text: "➕ Criar Pedido", callback_data: "O:NEW" }],
    [{ text: "📋 Ver Pedidos (20)", callback_data: "O:LIST20" }],
    [{ text: "🔎 Buscar (ID/Nome/Contato)", callback_data: "O:SEARCH" }],
    [{ text: "🏷️ Alterar Status Produção", callback_data: "O:SETSTATUS" }],
    [{ text: "⬅️ Voltar", callback_data: "M:MAIN" }],
  ]);
}

function MENU_PROD() {
  return kb([
    [{ text: "🧵 Aguardando", callback_data: "P:LIST:A" }, { text: "⚙️ Em produção", callback_data: "P:LIST:E" }],
    [{ text: "✅ Pronto", callback_data: "P:LIST:P" }, { text: "🚚 Entregue", callback_data: "P:LIST:T" }],
    [{ text: "⚠️ Problema", callback_data: "P:LIST:X" }],
    [{ text: "⏱️ Atrasados", callback_data: "P:LATE" }],
    [{ text: "⬅️ Voltar", callback_data: "M:MAIN" }],
  ]);
}

function MENU_FIN() {
  return kb([
    [{ text: "💵 Registrar Pagamento", callback_data: "F:PAY" }],
    [{ text: "🧾 Pendentes", callback_data: "F:LIST:PEND" }, { text: "🟡 Parciais", callback_data: "F:LIST:PART" }],
    [{ text: "✅ Pagos", callback_data: "F:LIST:PAID" }],
    [{ text: "📊 Caixa do Dia", callback_data: "F:CASH:TODAY" }],
    [{ text: "✅ Fechar Dia", callback_data: "F:CLOSE:DAY" }],
    [{ text: "⬅️ Voltar", callback_data: "M:MAIN" }],
  ]);
}

function MENU_AGENDA() {
  return kb([
    [{ text: "📦 Buscas Hoje", callback_data: "A:PICKUP:TODAY" }, { text: "🚚 Entregas Hoje", callback_data: "A:DELIV:TODAY" }],
    [{ text: "📅 Próximas Entregas (7d)", callback_data: "A:DELIV:WEEK" }],
    [{ text: "⏱️ Atrasados", callback_data: "A:LATE" }],
    [{ text: "⬅️ Voltar", callback_data: "M:MAIN" }],
  ]);
}

function MENU_AI() {
  return kb([
    [{ text: "💬 Chat IA", callback_data: "AI:CHAT" }, { text: "🧠 Insights IA", callback_data: "AI:INSIGHTS" }],
    [{ text: "⚠️ Alertas do Dia", callback_data: "AI:ALERTS" }],
    [{ text: "⬅️ Voltar", callback_data: "M:MAIN" }],
  ]);
}

function MENU_SYSTEM() {
  return kb([
    [{ text: "📌 Status DB", callback_data: "S:DB" }],
    [{ text: "📲 Status WhatsApp", callback_data: "S:WA" }],
    [{ text: "⬅️ Voltar", callback_data: "M:MAIN" }],
  ]);
}

function KB_CONFIRM(yes, no) {
  return kb([[{ text: "✅ SIM", callback_data: yes }, { text: "❌ NÃO", callback_data: no }]]);
}

function KB_STATUS() {
  return kb([
    [{ text: "🧵 Aguardando produção", callback_data: "ST:Aguardando produção" }],
    [{ text: "⚙️ Em produção", callback_data: "ST:Em produção" }],
    [{ text: "✅ Pronto", callback_data: "ST:Pronto" }],
    [{ text: "🚚 Entregue", callback_data: "ST:Entregue" }],
    [{ text: "⚠️ Problema", callback_data: "ST:Problema" }],
    [{ text: "⬅️ Cancelar", callback_data: "M:MAIN" }],
  ]);
}

function KB_PAY_METHOD() {
  return kb([
    [{ text: "Pix", callback_data: "PM:Pix" }, { text: "Dinheiro", callback_data: "PM:Dinheiro" }],
    [{ text: "Cartão", callback_data: "PM:Cartão" }, { text: "Transferência", callback_data: "PM:Transferência" }],
    [{ text: "⬅️ Cancelar", callback_data: "M:MAIN" }],
  ]);
}

function KB_AI_CHAT() {
  return kb([
    [{ text: "⬅️ Sair do Chat IA", callback_data: "AI:EXIT" }, { text: "🧹 Resetar conversa IA", callback_data: "AI:RESET" }],
    [{ text: "⬅️ Voltar", callback_data: "M:MAIN" }],
  ]);
}

// ===================== OPENAI (IA) =====================
// ✅ BLINDADO: varre TODA estrutura do /v1/responses
function extractResponseText(data) {
  // 1) Atalho comum
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();

  // 2) Varrer todos os itens de output
  const outputs = Array.isArray(data?.output) ? data.output : [];
  for (const item of outputs) {
    // às vezes vem direto
    if (typeof item?.text === "string" && item.text.trim()) return item.text.trim();
    if (typeof item?.output_text === "string" && item.output_text.trim()) return item.output_text.trim();

    // padrão: item.content = [{type:"output_text", text:"..."}]
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (typeof c?.text === "string" && c.text.trim()) return c.text.trim();
      if (typeof c?.output_text === "string" && c.output_text.trim()) return c.output_text.trim();
    }
  }

  // 3) Último fallback
  if (typeof data?.output === "string" && data.output.trim()) return data.output.trim();
  return "";
}

async function openaiAsk({ input, previous_response_id }) {
  if (!OPENAI_API_KEY) {
    return { ok: false, text: "IA não configurada. Coloque OPENAI_API_KEY no Render.", previous_response_id: null };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000); // 25s

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input,
        previous_response_id: previous_response_id || undefined,
        max_output_tokens: 700,
        temperature: 0.4,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data?.error) {
      console.error("OpenAI HTTP:", res.status, res.statusText);
      console.error("OpenAI error payload:", JSON.stringify(data));
      return {
        ok: false,
        text: `Erro IA: ${data?.error?.message || `HTTP ${res.status}`}`,
        previous_response_id: null,
      };
    }

    const text = extractResponseText(data);

    // Se veio “ok” mas sem texto, NÃO retorna ok=true (pra não virar “Sem resposta.” silencioso)
    if (!text) {
      console.error("OpenAI retorno sem texto. Payload:", JSON.stringify(data));
      return { ok: false, text: "⚠️ A IA retornou vazio. Verifique os logs do Render.", previous_response_id: null };
    }

    return { ok: true, text, previous_response_id: data.id || previous_response_id || null };
  } catch (err) {
    const isAbort = String(err?.name || "").toLowerCase().includes("abort");
    console.error("Falha na OpenAI:", err);
    return {
      ok: false,
      text: isAbort ? "⚠️ Timeout falando com a IA (25s). Tente novamente." : "⚠️ Falha ao conectar com a IA.",
      previous_response_id: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildContextSummary() {
  const k = kpis();

  const late = db.prepare(`
    SELECT id, nome, valor, data_entregar, status_producao
    FROM orders
    WHERE data_entregar IS NOT NULL AND data_entregar < ? AND status_producao != 'Entregue'
    ORDER BY data_entregar ASC
    LIMIT 5
  `).all(k.date);

  const and = db.prepare(`
    SELECT id, nome, contato, valor_estimado, etapa, origem
    FROM deals
    WHERE etapa NOT IN ('Concluída','Perdida')
    ORDER BY updated_at DESC
    LIMIT 5
  `).all();

  const orders = db.prepare(`SELECT id, nome, valor FROM orders ORDER BY id DESC LIMIT 60`).all();
  const pend = [];
  for (const o of orders) {
    const f = orderFinancial(o.id);
    if (!f) continue;
    if ((f.status === "PENDENTE" || f.status === "PARCIAL") && pend.length < 5) {
      pend.push({ id: o.id, nome: o.nome, total: f.total, paid: f.paid, status: f.status });
    }
  }

  return {
    kpis: k,
    late_orders: late,
    deals_in_progress: and,
    finance_attention: pend,
  };
}

// ===================== WHATSAPP WEBHOOK =====================
app.get("/wa/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("WA VERIFY HIT:", { mode, hasToken: !!token, hasChallenge: !!challenge });

  if (mode === "subscribe" && token && token === WA_VERIFY_TOKEN) {
    console.log("WA webhook verified ✅");
    return res.status(200).send(challenge);
  }
  console.log("WA webhook verify failed ❌");
  return res.sendStatus(403);
});

app.post("/wa/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;

    if (!messages?.length) return;

    for (const m of messages) {
      const wa_id = m.from;
      const text = m.text?.body || "[Mensagem não textual]";

      saveMessage({ channel: "whatsapp", wa_id, direction: "in", text, raw: body });

      const existing = db.prepare(`SELECT id FROM deals WHERE wa_id=? ORDER BY id DESC LIMIT 1`).get(wa_id);
      let dealId = existing?.id;

      if (!dealId) {
        const r = db.prepare(`
          INSERT INTO deals(nome, contato, endereco, descricao, observacoes, valor_estimado, etapa, origem, wa_id, updated_at)
          VALUES(?,?,?,?,?,?,?,?,?, datetime('now'))
        `).run(null, wa_id, null, text, null, null, "Lead novo", "whatsapp", wa_id);
        dealId = r.lastInsertRowid;
        logEvent("wa_lead_created", "deal", dealId, { wa_id, first_message: text });
      } else {
        db.prepare(`UPDATE deals SET updated_at=datetime('now') WHERE id=?`).run(dealId);
        logEvent("wa_message_in", "deal", dealId, { wa_id, text });
      }

      await tgSendMessage(
        ADMIN_ID,
        `📲 <b>Novo WhatsApp</b>\n<b>Lead #${dealId}</b>\nDe: <b>${wa_id}</b>\nMsg: ${escapeHtml(text)}\n\nUse /menu → 💰 Vendas (CRM) para gerenciar.`
      );
    }
  } catch (err) {
    console.error("Erro WA webhook:", err);
  }
});

// ===================== TELEGRAM HANDLERS =====================
async function showMainMenu(chatId, editMsgId = null) {
  const text = "📊 <b>Painel Administrativo</b>\nEscolha um módulo:";
  if (editMsgId) return tgEditMessage(chatId, editMsgId, text, MENU_MAIN());
  return tgSendMessage(chatId, text, MENU_MAIN());
}

function isAdmin(userId) {
  return Number(userId) === ADMIN_ID;
}

// ===================== REPORTS / LIST BUILDERS =====================
function listDealsByType(type) {
  let where = "1=1";
  if (type === "AND") where = `etapa NOT IN ('Concluída','Perdida')`;
  if (type === "DONE") where = `etapa='Concluída'`;
  if (type === "LOST") where = `etapa='Perdida'`;

  const rows = db.prepare(`
    SELECT id, nome, contato, valor_estimado, etapa, origem, updated_at
    FROM deals
    WHERE ${where}
    ORDER BY updated_at DESC
    LIMIT 20
  `).all();

  if (!rows.length) return "Nenhuma venda encontrada.";

  let txt = "💰 <b>Vendas</b>\n\n";
  for (const d of rows) {
    txt += `#${d.id} - ${escapeHtml(d.nome || "Sem nome")} (${escapeHtml(d.contato || "-")})\n`;
    txt += `Etapa: <b>${escapeHtml(d.etapa)}</b> | Origem: ${escapeHtml(d.origem)}\n`;
    if (d.valor_estimado != null) txt += `Valor estimado: ${moneyBR(d.valor_estimado)}\n`;
    txt += `Atualizado: ${escapeHtml(d.updated_at)}\n\n`;
  }
  return txt;
}

function listOrders(limit = 20) {
  const rows = db.prepare(`SELECT * FROM orders ORDER BY id DESC LIMIT ?`).all(limit);
  if (!rows.length) return "Nenhum pedido encontrado.";

  let txt = "📋 <b>Últimos Pedidos</b>\n\n";
  for (const p of rows) {
    const f = orderFinancial(p.id);
    const fin = f ? ` | ${f.status} (${moneyBR(f.paid)}/${moneyBR(f.total)})` : "";
    txt += `#${p.id} - ${escapeHtml(p.nome || "Sem nome")} - ${moneyBR(p.valor)}\n`;
    txt += `Prod: <b>${escapeHtml(p.status_producao)}</b>${fin}\n`;
    if (p.data_entregar) txt += `Entrega: ${escapeHtml(p.data_entregar)}\n`;
    txt += `\n`;
  }
  return txt;
}

function listOrdersByProdStatus(status) {
  const rows = db.prepare(`
    SELECT id, nome, valor, data_entregar, status_producao
    FROM orders
    WHERE status_producao=?
    ORDER BY COALESCE(data_entregar,'9999-12-31') ASC, id DESC
    LIMIT 30
  `).all(status);

  if (!rows.length) return `Nenhum pedido em: ${status}`;

  let txt = `🏭 <b>${escapeHtml(status)}</b>\n\n`;
  for (const p of rows) {
    txt += `#${p.id} - ${escapeHtml(p.nome || "Sem nome")} - ${moneyBR(p.valor)}\n`;
    if (p.data_entregar) txt += `Entrega: ${escapeHtml(p.data_entregar)}\n`;
    txt += `\n`;
  }
  return txt;
}

function listLateOrders() {
  const t = todayISO();
  const rows = db.prepare(`
    SELECT id, nome, valor, data_entregar, status_producao
    FROM orders
    WHERE data_entregar IS NOT NULL AND data_entregar < ? AND status_producao != 'Entregue'
    ORDER BY data_entregar ASC
    LIMIT 30
  `).all(t);

  if (!rows.length) return "✅ Nenhum pedido atrasado.";

  let txt = "⏱️ <b>Pedidos Atrasados</b>\n\n";
  for (const p of rows) {
    txt += `#${p.id} - ${escapeHtml(p.nome || "Sem nome")} - ${moneyBR(p.valor)}\n`;
    txt += `Entrega: <b>${escapeHtml(p.data_entregar)}</b> | Status: ${escapeHtml(p.status_producao)}\n\n`;
  }
  return txt;
}

function listAgendaPickupToday() {
  const t = todayISO();
  const rows = db.prepare(`
    SELECT id, nome, contato, endereco, data_buscar, status_producao
    FROM orders
    WHERE data_buscar = ?
    ORDER BY id DESC
    LIMIT 30
  `).all(t);

  if (!rows.length) return "Nenhuma busca para hoje.";

  let txt = "📦 <b>Buscas de Hoje</b>\n\n";
  for (const p of rows) {
    txt += `#${p.id} - ${escapeHtml(p.nome || "Sem nome")} | ${escapeHtml(p.contato || "-")}\n`;
    txt += `Endereço: ${escapeHtml(p.endereco || "-")}\n`;
    txt += `Status: ${escapeHtml(p.status_producao)}\n\n`;
  }
  return txt;
}

function listAgendaDeliveryToday() {
  const t = todayISO();
  const rows = db.prepare(`
    SELECT id, nome, contato, endereco, data_entregar, status_producao
    FROM orders
    WHERE data_entregar = ?
    ORDER BY id DESC
    LIMIT 30
  `).all(t);

  if (!rows.length) return "Nenhuma entrega para hoje.";

  let txt = "🚚 <b>Entregas de Hoje</b>\n\n";
  for (const p of rows) {
    txt += `#${p.id} - ${escapeHtml(p.nome || "Sem nome")} | ${escapeHtml(p.contato || "-")}\n`;
    txt += `Endereço: ${escapeHtml(p.endereco || "-")}\n`;
    txt += `Status: ${escapeHtml(p.status_producao)}\n\n`;
  }
  return txt;
}

function listAgendaDeliveryWeek() {
  const t = todayISO();
  const rows = db.prepare(`
    SELECT id, nome, valor, data_entregar, status_producao
    FROM orders
    WHERE data_entregar IS NOT NULL
      AND data_entregar >= ?
      AND data_entregar <= date(?, '+7 day')
      AND status_producao != 'Entregue'
    ORDER BY data_entregar ASC
    LIMIT 50
  `).all(t, t);

  if (!rows.length) return "Nenhuma entrega nos próximos 7 dias.";

  let txt = "📅 <b>Entregas (próximos 7 dias)</b>\n\n";
  for (const p of rows) {
    txt += `${escapeHtml(p.data_entregar)} — #${p.id} ${escapeHtml(p.nome || "Sem nome")} (${moneyBR(p.valor)})\n`;
    txt += `Status: ${escapeHtml(p.status_producao)}\n\n`;
  }
  return txt;
}

function listFinanceByType(type) {
  const rows = db.prepare(`SELECT id, nome, valor FROM orders ORDER BY id DESC LIMIT 200`).all();
  const out = [];
  for (const o of rows) {
    const f = orderFinancial(o.id);
    if (!f) continue;
    if (type === "PEND" && f.status === "PENDENTE") out.push({ ...o, ...f });
    if (type === "PART" && f.status === "PARCIAL") out.push({ ...o, ...f });
    if (type === "PAID" && f.status === "PAGO") out.push({ ...o, ...f });
    if (out.length >= 25) break;
  }
  if (!out.length) return "Nada encontrado.";
  let txt = "📊 <b>Financeiro</b>\n\n";
  for (const p of out) {
    txt += `#${p.id} - ${escapeHtml(p.nome || "Sem nome")}\n`;
    txt += `Total: ${moneyBR(p.total)} | Pago: ${moneyBR(p.paid)} | <b>${escapeHtml(p.status)}</b>\n\n`;
  }
  return txt;
}

function cashToday() {
  const t = todayISO();
  const sum = db.prepare(`SELECT COALESCE(SUM(valor),0) s FROM payments WHERE substr(paid_at,1,10)=?`).get(t).s;
  const count = db.prepare(`SELECT COUNT(*) c FROM payments WHERE substr(paid_at,1,10)=?`).get(t).c;
  return { date: t, sum, count };
}

// ===================== TELEGRAM WEBHOOK (ÚNICO) =====================
app.post("/webhook", async (req, res) => {
  const body = req.body;

  try {
    // ---------- CALLBACK ----------
    if (body.callback_query) {
      const q = body.callback_query;
      const chatId = q.message.chat.id;
      const msgId = q.message.message_id;
      const userId = q.from.id;
      const data = q.data;

      await tgAnswerCallbackQuery(q.id);

      if (!isAdmin(userId)) return res.sendStatus(200);

      // Menus
      if (data === "M:MAIN") { await showMainMenu(chatId, msgId); return res.sendStatus(200); }
      if (data === "M:DEALS") { await tgEditMessage(chatId, msgId, "💰 <b>Vendas (CRM)</b>", MENU_DEALS()); return res.sendStatus(200); }
      if (data === "M:ORDERS") { await tgEditMessage(chatId, msgId, "📦 <b>Pedidos</b>", MENU_ORDERS()); return res.sendStatus(200); }
      if (data === "M:PROD") { await tgEditMessage(chatId, msgId, "🏭 <b>Produção</b>", MENU_PROD()); return res.sendStatus(200); }
      if (data === "M:FIN") { await tgEditMessage(chatId, msgId, "📊 <b>Financeiro</b>", MENU_FIN()); return res.sendStatus(200); }
      if (data === "M:AGENDA") { await tgEditMessage(chatId, msgId, "📆 <b>Agenda</b>", MENU_AGENDA()); return res.sendStatus(200); }
      if (data === "M:AI") { await tgEditMessage(chatId, msgId, "🧠 <b>IA</b>", MENU_AI()); return res.sendStatus(200); }
      if (data === "M:SYSTEM") { await tgEditMessage(chatId, msgId, "⚙️ <b>Sistema</b>", MENU_SYSTEM()); return res.sendStatus(200); }

      // -------- CRM/VENDAS --------
      if (data === "D:NEW") {
        setState(chatId, "DEAL_WIZ", "nome", {});
        await tgSendMessage(chatId, "💰 <b>Nova Venda</b>\nDigite o <b>NOME</b> do cliente:");
        return res.sendStatus(200);
      }

      if (data.startsWith("D:LIST:")) {
        const type = data.split(":")[2];
        await tgSendLongHTML(chatId, listDealsByType(type));
        return res.sendStatus(200);
      }

      if (data === "D:SEARCH") {
        setState(chatId, "SEARCH", "deal", { last: "deal" });
        await tgSendMessage(chatId, "🔎 Digite: <b>ID</b> ou <b>nome</b> ou <b>contato</b> para buscar venda:");
        return res.sendStatus(200);
      }

      if (data.startsWith("D:SET:")) {
        const parts = data.split(":");
        const dealId = Number(parts[2]);
        const etapa = parts.slice(3).join(":");
        db.prepare(`UPDATE deals SET etapa=?, updated_at=datetime('now') WHERE id=?`).run(etapa, dealId);
        logEvent("deal_stage_changed", "deal", dealId, { etapa });
        await tgSendMessage(chatId, `✅ Venda #${dealId} atualizada para: <b>${escapeHtml(etapa)}</b>`);
        return res.sendStatus(200);
      }

      if (data.startsWith("D:TO_ORDER:")) {
        const dealId = Number(data.split(":")[2]);
        const d = db.prepare(`SELECT * FROM deals WHERE id=?`).get(dealId);
        if (!d) { await tgSendMessage(chatId, "Venda não encontrada."); return res.sendStatus(200); }

        const r = db.prepare(`
          INSERT INTO orders (nome, contato, endereco, descricao, observacoes, valor)
          VALUES (?,?,?,?,?,?)
        `).run(d.nome, d.contato, d.endereco, d.descricao, d.observacoes, d.valor_estimado || 0);

        db.prepare(`UPDATE deals SET etapa='Concluída', updated_at=datetime('now') WHERE id=?`).run(dealId);
        logEvent("deal_converted_to_order", "deal", dealId, { order_id: r.lastInsertRowid });
        await tgSendMessage(chatId, `✅ Venda #${dealId} convertida em Pedido #${r.lastInsertRowid}.`);
        return res.sendStatus(200);
      }

      // -------- PEDIDOS --------
      if (data === "O:NEW") {
        setState(chatId, "ORDER_WIZ", "nome", {});
        await tgSendMessage(chatId, "📦 <b>Novo Pedido</b>\nDigite o <b>NOME</b> do cliente:");
        return res.sendStatus(200);
      }

      if (data === "O:LIST20") { await tgSendLongHTML(chatId, listOrders(20)); return res.sendStatus(200); }

      if (data === "O:SEARCH") {
        setState(chatId, "SEARCH", "order", { last: "order" });
        await tgSendMessage(chatId, "🔎 Digite: <b>ID</b> ou <b>nome</b> ou <b>contato</b> para buscar pedido:");
        return res.sendStatus(200);
      }

      if (data === "O:SETSTATUS") {
        setState(chatId, "SET_STATUS", "ask_id", {});
        await tgSendMessage(chatId, "🏷️ Digite o <b>ID do pedido</b> que você quer mudar o status de produção:");
        return res.sendStatus(200);
      }

      if (data.startsWith("ST:")) {
        const st = data.slice(3);
        const stt = getState(chatId);
        if (stt.mode !== "SET_STATUS" || !stt.payload?.order_id) {
          await tgSendMessage(chatId, "Sem pedido selecionado para status.");
          return res.sendStatus(200);
        }
        const orderId = Number(stt.payload.order_id);
        db.prepare(`UPDATE orders SET status_producao=? WHERE id=?`).run(st, orderId);
        logEvent("order_status_changed", "order", orderId, { status: st });
        clearState(chatId);
        await tgSendMessage(chatId, `✅ Pedido #${orderId} status atualizado para: <b>${escapeHtml(st)}</b>`);
        return res.sendStatus(200);
      }

      if (data === "O:CONFIRM:YES" || data === "O:CONFIRM:NO") {
        const stt = getState(chatId);
        if (stt.mode !== "ORDER_WIZ" || stt.step !== "confirm") {
          await tgSendMessage(chatId, "Nenhum pedido em confirmação no momento. Use /menu → Pedidos.");
          return res.sendStatus(200);
        }

        if (data === "O:CONFIRM:NO") {
          clearState(chatId);
          await tgSendMessage(chatId, "❌ Pedido cancelado. Use /menu para criar outro.");
          return res.sendStatus(200);
        }

        const p = stt.payload || {};
        const r = db.prepare(`
          INSERT INTO orders (nome, contato, endereco, descricao, observacoes, valor, data_buscar, data_entregar, status_producao)
          VALUES (?,?,?,?,?,?,?,?, 'Aguardando produção')
        `).run(
          p.nome,
          p.contato,
          p.endereco,
          p.descricao,
          p.observacoes || null,
          Number(p.valor || 0),
          p.data_buscar || null,
          p.data_entregar || null
        );

        logEvent("order_created", "order", r.lastInsertRowid, p);
        clearState(chatId);

        await tgSendMessage(
          chatId,
          `✅ Pedido criado!\n<b>Pedido #${r.lastInsertRowid}</b>\nCliente: <b>${escapeHtml(p.nome)}</b>\nValor: <b>${moneyBR(p.valor)}</b>\nStatus: <b>Aguardando produção</b>`
        );
        return res.sendStatus(200);
      }

      // -------- PRODUÇÃO --------
      if (data.startsWith("P:LIST:")) {
        const code = data.split(":")[2];
        const map = { A: "Aguardando produção", E: "Em produção", P: "Pronto", T: "Entregue", X: "Problema" };
        await tgSendLongHTML(chatId, listOrdersByProdStatus(map[code]));
        return res.sendStatus(200);
      }
      if (data === "P:LATE") { await tgSendLongHTML(chatId, listLateOrders()); return res.sendStatus(200); }

      // -------- AGENDA --------
      if (data === "A:PICKUP:TODAY") { await tgSendLongHTML(chatId, listAgendaPickupToday()); return res.sendStatus(200); }
      if (data === "A:DELIV:TODAY") { await tgSendLongHTML(chatId, listAgendaDeliveryToday()); return res.sendStatus(200); }
      if (data === "A:DELIV:WEEK") { await tgSendLongHTML(chatId, listAgendaDeliveryWeek()); return res.sendStatus(200); }
      if (data === "A:LATE") { await tgSendLongHTML(chatId, listLateOrders()); return res.sendStatus(200); }

      // -------- FINANCEIRO --------
      if (data === "F:PAY") {
        setState(chatId, "PAY_WIZ", "order_id", {});
        await tgSendMessage(chatId, "💵 Digite o <b>ID do pedido</b> para registrar pagamento:");
        return res.sendStatus(200);
      }

      if (data.startsWith("F:LIST:")) {
        const type = data.split(":")[2];
        await tgSendLongHTML(chatId, listFinanceByType(type));
        return res.sendStatus(200);
      }

      if (data === "F:CASH:TODAY") {
        const c = cashToday();
        await tgSendMessage(chatId, `📊 <b>Caixa do Dia</b> (${c.date})\nPagamentos: ${c.count}\nTotal: <b>${moneyBR(c.sum)}</b>`);
        return res.sendStatus(200);
      }

      if (data === "F:CLOSE:DAY") {
        const c = cashToday();
        logEvent("cash_close_day", "finance", c.date, c);
        await tgSendMessage(chatId, `✅ <b>Dia fechado</b> (${c.date})\nTotal: <b>${moneyBR(c.sum)}</b>\nPagamentos: ${c.count}`);
        return res.sendStatus(200);
      }

      if (data.startsWith("PM:")) {
        const method = data.slice(3);
        const stt = getState(chatId);
        if (stt.mode !== "PAY_WIZ") { await tgSendMessage(chatId, "Fluxo de pagamento não ativo."); return res.sendStatus(200); }
        stt.payload = stt.payload || {};
        stt.payload.metodo = method;
        setState(chatId, "PAY_WIZ", "valor", stt.payload);
        await tgSendMessage(chatId, `Método: <b>${escapeHtml(method)}</b>\nAgora digite o <b>valor pago</b> (ex: 500 ou 500,00):`);
        return res.sendStatus(200);
      }

      // -------- IA --------
      if (data === "AI:CHAT") {
        setState(chatId, "AI_CHAT", "", { previous_response_id: null });
        await tgSendMessage(chatId, "🤖 <b>Chat IA ativado</b>\n\nFale comigo aqui.\nPara sair: clique em <b>Sair do Chat IA</b>.", KB_AI_CHAT());
        return res.sendStatus(200);
      }

      if (data === "AI:EXIT") { clearState(chatId); await showMainMenu(chatId); return res.sendStatus(200); }

      if (data === "AI:RESET") {
        setState(chatId, "AI_CHAT", "", { previous_response_id: null });
        await tgSendMessage(chatId, "🧹 Conversa da IA resetada. Pode falar de novo.", KB_AI_CHAT());
        return res.sendStatus(200);
      }

      if (data === "AI:ALERTS") {
        const ctx = buildContextSummary();
        let txt = `⚠️ <b>Alertas do Dia</b> (${ctx.kpis.date})\n\n`;
        txt += `• Atrasados: <b>${ctx.kpis.atrasados}</b>\n`;
        txt += `• Caixa hoje: <b>${moneyBR(ctx.kpis.caixaHoje)}</b>\n`;
        txt += `• Pedidos hoje: <b>${ctx.kpis.pedidosHoje}</b>\n\n`;

        if (ctx.late_orders.length) {
          txt += `<b>Top atrasados:</b>\n`;
          for (const o of ctx.late_orders) {
            txt += `#${o.id} ${escapeHtml(o.nome || "Sem nome")} — entrega ${escapeHtml(o.data_entregar)} (${escapeHtml(o.status_producao)})\n`;
          }
        } else {
          txt += "✅ Sem atrasos no momento.\n";
        }

        await tgSendLongHTML(chatId, txt);
        return res.sendStatus(200);
      }

      if (data === "AI:INSIGHTS") {
        const ctx = buildContextSummary();
        const prompt =
          `Você é o diretor administrativo e estrategista de uma empresa sob encomenda (Make-to-Order). ` +
          `Analise os dados abaixo e gere: (1) alertas financeiros, (2) gargalos de produção, (3) sugestões de vendas e cobrança, ` +
          `(4) priorização de agenda. Seja direto e prático.\n\nDADOS(JSON):\n${JSON.stringify(ctx, null, 2)}`;

        const stt = getState(chatId);
        const prev = stt.mode === "AI_CHAT" ? stt.payload?.previous_response_id : null;
        const ans = await openaiAsk({ input: prompt, previous_response_id: prev });

        const out = ans.ok ? ans.text : ans.text;
        db.prepare(`INSERT INTO insights(scope, insight_text) VALUES(?,?)`).run("daily", out);
        logEvent("ai_insights_generated", "ai", "daily", { date: ctx.kpis.date });

        // Escape para não quebrar HTML
        const safe = escapeHtml(out);
        await tgSendLongHTML(chatId, `🧠 <b>Insights IA</b>\n\n${safe}`);
        return res.sendStatus(200);
      }

      // -------- SISTEMA --------
      if (data === "S:DB") {
        const k = kpis();
        await tgSendMessage(
          chatId,
          `📌 <b>Status do DB</b>\n\nArquivo: <code>${escapeHtml(dbPath)}</code>\nPedidos hoje: ${k.pedidosHoje}\nVendas concluídas hoje: ${k.vendasHoje}\nCaixa hoje: ${moneyBR(k.caixaHoje)}\nAtrasados: ${k.atrasados}`
        );
        return res.sendStatus(200);
      }

      if (data === "S:WA") {
        const has = !!WA_VERIFY_TOKEN;
        await tgSendMessage(
          chatId,
          `📲 <b>Status WhatsApp</b>\nWebhook: <code>/wa/webhook</code>\nVerify token configurado: <b>${has ? "SIM" : "NÃO"}</b>\n\nTeste:\n<code>/wa/webhook?hub.mode=subscribe&hub.verify_token=SEU_TOKEN&hub.challenge=123</code>`
        );
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    // ---------- MESSAGES ----------
    if (body.message) {
      const msg = body.message;
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const text = (msg.text || "").trim();

      if (!isAdmin(userId)) return res.sendStatus(200);

      if (text === "/start" || text === "/menu" || text.toLowerCase() === "menu") {
        clearState(chatId);
        await showMainMenu(chatId);
        return res.sendStatus(200);
      }

      const stt = getState(chatId);

      // ====== MODO CHAT IA ======
      if (stt.mode === "AI_CHAT") {
        const ctx = buildContextSummary();
        const prompt =
          `Você é um diretor administrativo e vendedor estratégico. ` +
          `Responda ao dono com clareza, propondo alertas e ações. ` +
          `Use os dados do contexto para embasar.\n\nCONTEXTO(JSON):\n${JSON.stringify(ctx, null, 2)}\n\nMENSAGEM DO DONO:\n${text}`;

        const ans = await openaiAsk({
          input: prompt,
          previous_response_id: stt.payload?.previous_response_id || null,
        });

        if (ans.ok) {
          stt.payload.previous_response_id = ans.previous_response_id;
          setState(chatId, "AI_CHAT", "", stt.payload);

          // Escape para não quebrar o parse_mode HTML
          const safe = escapeHtml(ans.text);
          await tgSendLongHTML(chatId, safe, KB_AI_CHAT());
        } else {
          await tgSendMessage(chatId, escapeHtml(ans.text), KB_AI_CHAT());
        }
        return res.sendStatus(200);
      }

      // ====== SEARCH ======
      if (stt.mode === "SEARCH") {
        const kind = stt.step;
        const q = text;
        const isId = /^\d+$/.test(q);

        if (kind === "order") {
          let rows = [];
          if (isId) {
            const o = db.prepare(`SELECT * FROM orders WHERE id=?`).get(Number(q));
            rows = o ? [o] : [];
          } else {
            rows = db.prepare(`
              SELECT * FROM orders
              WHERE nome LIKE ? OR contato LIKE ?
              ORDER BY id DESC
              LIMIT 20
            `).all(`%${q}%`, `%${q}%`);
          }

          if (!rows.length) {
            await tgSendMessage(chatId, "Nenhum pedido encontrado.");
          } else {
            let txt = `🔎 <b>Resultados (Pedidos)</b>\n\n`;
            for (const p of rows) {
              const f = orderFinancial(p.id);
              const fin = f ? ` | ${f.status} (${moneyBR(f.paid)}/${moneyBR(f.total)})` : "";
              txt += `#${p.id} - ${escapeHtml(p.nome || "Sem nome")} - ${moneyBR(p.valor)}\nProd: ${escapeHtml(p.status_producao)}${fin}\n\n`;
            }
            await tgSendLongHTML(chatId, txt);
          }
        } else {
          let rows = [];
          if (isId) {
            const d = db.prepare(`SELECT * FROM deals WHERE id=?`).get(Number(q));
            rows = d ? [d] : [];
          } else {
            rows = db.prepare(`
              SELECT * FROM deals
              WHERE nome LIKE ? OR contato LIKE ? OR wa_id LIKE ?
              ORDER BY updated_at DESC
              LIMIT 20
            `).all(`%${q}%`, `%${q}%`, `%${q}%`);
          }

          if (!rows.length) {
            await tgSendMessage(chatId, "Nenhuma venda encontrada.");
          } else {
            for (const d of rows) {
              let txt = `🔎 <b>Venda #${d.id}</b>\n\n`;
              txt += `Nome: <b>${escapeHtml(d.nome || "Sem nome")}</b>\n`;
              txt += `Contato: ${escapeHtml(d.contato || "-")}\n`;
              txt += `Etapa: <b>${escapeHtml(d.etapa)}</b>\n`;
              txt += `Origem: ${escapeHtml(d.origem)}\n`;
              if (d.valor_estimado != null) txt += `Valor: ${moneyBR(d.valor_estimado)}\n`;

              await tgSendMessage(
                chatId,
                txt,
                kb([
                  [
                    { text: "🟡 Negociação", callback_data: `D:SET:${d.id}:Negociação` },
                    { text: "📨 Orçamento enviado", callback_data: `D:SET:${d.id}:Orçamento enviado` },
                  ],
                  [
                    { text: "🟢 Concluir", callback_data: `D:SET:${d.id}:Concluída` },
                    { text: "🔴 Perder", callback_data: `D:SET:${d.id}:Perdida` },
                  ],
                  [{ text: "➡️ Converter em Pedido", callback_data: `D:TO_ORDER:${d.id}` }],
                ])
              );
            }
          }
        }

        clearState(chatId);
        return res.sendStatus(200);
      }

      // ====== SET STATUS FLOW ======
      if (stt.mode === "SET_STATUS" && stt.step === "ask_id") {
        const id = Number(text);
        if (!id) { await tgSendMessage(chatId, "ID inválido. Digite apenas número."); return res.sendStatus(200); }
        const o = db.prepare(`SELECT id, nome, status_producao FROM orders WHERE id=?`).get(id);
        if (!o) { await tgSendMessage(chatId, "Pedido não encontrado."); return res.sendStatus(200); }
        setState(chatId, "SET_STATUS", "choose", { order_id: id });
        await tgSendMessage(
          chatId,
          `Pedido #${id} (${escapeHtml(o.nome || "Sem nome")})\nStatus atual: <b>${escapeHtml(o.status_producao)}</b>\n\nEscolha o novo status:`,
          KB_STATUS()
        );
        return res.sendStatus(200);
      }

      // ====== PAY FLOW ======
      if (stt.mode === "PAY_WIZ") {
        const payload = stt.payload || {};
        if (stt.step === "order_id") {
          const id = Number(text);
          if (!id) { await tgSendMessage(chatId, "ID inválido."); return res.sendStatus(200); }
          const o = db.prepare(`SELECT id, nome, valor FROM orders WHERE id=?`).get(id);
          if (!o) { await tgSendMessage(chatId, "Pedido não encontrado."); return res.sendStatus(200); }
          payload.order_id = id;
          setState(chatId, "PAY_WIZ", "method", payload);
          await tgSendMessage(chatId, `Pedido #${id} (${escapeHtml(o.nome || "Sem nome")})\nTotal: <b>${moneyBR(o.valor)}</b>\n\nEscolha o método:`, KB_PAY_METHOD());
          return res.sendStatus(200);
        }

        if (stt.step === "valor") {
          const v = Number(text.replace(",", "."));
          if (!v || v <= 0) { await tgSendMessage(chatId, "Valor inválido."); return res.sendStatus(200); }

          const orderId = Number(payload.order_id);
          const metodo = payload.metodo || "N/A";

          db.prepare(`INSERT INTO payments(order_id, valor, metodo, observacao) VALUES(?,?,?,?)`).run(orderId, v, metodo, payload.observacao || null);

          logEvent("payment_added", "order", orderId, { valor: v, metodo });
          const f = orderFinancial(orderId);

          clearState(chatId);
          await tgSendMessage(chatId, `✅ Pagamento registrado.\nPedido #${orderId}\nMétodo: ${escapeHtml(metodo)}\nPago: ${moneyBR(f.paid)} / ${moneyBR(f.total)}\nStatus: <b>${escapeHtml(f.status)}</b>`);
          return res.sendStatus(200);
        }

        await tgSendMessage(chatId, "Use os botões para escolher o método.");
        return res.sendStatus(200);
      }

      // ====== DEAL WIZARD ======
      if (stt.mode === "DEAL_WIZ") {
        const data = stt.payload || {};

        if (stt.step === "nome") { data.nome = text; setState(chatId, "DEAL_WIZ", "contato", data); await tgSendMessage(chatId, "Digite o <b>CONTATO</b> (telefone):"); return res.sendStatus(200); }
        if (stt.step === "contato") { data.contato = text; setState(chatId, "DEAL_WIZ", "endereco", data); await tgSendMessage(chatId, "Digite o <b>ENDEREÇO</b> (ou '-' se não tiver):"); return res.sendStatus(200); }
        if (stt.step === "endereco") { data.endereco = text === "-" ? null : text; setState(chatId, "DEAL_WIZ", "descricao", data); await tgSendMessage(chatId, "Digite a <b>DESCRIÇÃO</b> / pedido do cliente:"); return res.sendStatus(200); }
        if (stt.step === "descricao") { data.descricao = text; setState(chatId, "DEAL_WIZ", "valor", data); await tgSendMessage(chatId, "Digite o <b>VALOR ESTIMADO</b> (ou 0 se não souber):"); return res.sendStatus(200); }
        if (stt.step === "valor") { data.valor_estimado = Number(text.replace(",", ".")) || 0; setState(chatId, "DEAL_WIZ", "obs", data); await tgSendMessage(chatId, "Digite <b>OBSERVAÇÕES</b> (ou '-' para pular):"); return res.sendStatus(200); }

        if (stt.step === "obs") {
          data.observacoes = text === "-" ? null : text;

          const r = db.prepare(`
            INSERT INTO deals(nome, contato, endereco, descricao, observacoes, valor_estimado, etapa, origem, updated_at)
            VALUES(?,?,?,?,?,?, 'Lead novo', 'manual', datetime('now'))
          `).run(data.nome, data.contato, data.endereco, data.descricao, data.observacoes, data.valor_estimado);

          logEvent("deal_created", "deal", r.lastInsertRowid, data);

          clearState(chatId);

          await tgSendMessage(
            chatId,
            `✅ Venda criada!\n<b>Lead #${r.lastInsertRowid}</b>\nEtapa: <b>Lead novo</b>\n\nQuer marcar etapa agora?`,
            kb([
              [{ text: "📨 Orçamento enviado", callback_data: `D:SET:${r.lastInsertRowid}:Orçamento enviado` }],
              [{ text: "🟡 Negociação", callback_data: `D:SET:${r.lastInsertRowid}:Negociação` }],
              [{ text: "➡️ Converter em Pedido", callback_data: `D:TO_ORDER:${r.lastInsertRowid}` }],
              [{ text: "⬅️ Voltar", callback_data: "M:MAIN" }],
            ])
          );
          return res.sendStatus(200);
        }
      }

      // ====== ORDER WIZARD (completo) ======
      if (stt.mode === "ORDER_WIZ") {
        const data = stt.payload || {};

        if (stt.step === "nome") { data.nome = text; setState(chatId, "ORDER_WIZ", "contato", data); await tgSendMessage(chatId, "Digite o <b>CONTATO</b>:"); return res.sendStatus(200); }
        if (stt.step === "contato") { data.contato = text; setState(chatId, "ORDER_WIZ", "endereco", data); await tgSendMessage(chatId, "Digite o <b>ENDEREÇO</b>:"); return res.sendStatus(200); }
        if (stt.step === "endereco") { data.endereco = text; setState(chatId, "ORDER_WIZ", "descricao", data); await tgSendMessage(chatId, "Digite a <b>DESCRIÇÃO</b> do pedido:"); return res.sendStatus(200); }
        if (stt.step === "descricao") { data.descricao = text; setState(chatId, "ORDER_WIZ", "obs", data); await tgSendMessage(chatId, "Digite <b>OBSERVAÇÕES</b> (ou '-' para pular):"); return res.sendStatus(200); }
        if (stt.step === "obs") { data.observacoes = text === "-" ? null : text; setState(chatId, "ORDER_WIZ", "valor", data); await tgSendMessage(chatId, "Digite o <b>VALOR</b> (ex: 1700 ou 1700,00):"); return res.sendStatus(200); }

        if (stt.step === "valor") {
          const v = Number(text.replace(",", "."));
          if (!v || v <= 0) { await tgSendMessage(chatId, "Valor inválido."); return res.sendStatus(200); }
          data.valor = v;
          setState(chatId, "ORDER_WIZ", "data_buscar", data);
          await tgSendMessage(chatId, "Digite a <b>DATA DE BUSCAR</b> (DD/MM/AAAA ou YYYY-MM-DD) ou '-' para pular:");
          return res.sendStatus(200);
        }

        if (stt.step === "data_buscar") {
          if (text === "-") data.data_buscar = null;
          else {
            const iso = parseDateToISO(text);
            if (!iso) { await tgSendMessage(chatId, "Data inválida. Use DD/MM/AAAA."); return res.sendStatus(200); }
            data.data_buscar = iso;
          }
          setState(chatId, "ORDER_WIZ", "data_entregar", data);
          await tgSendMessage(chatId, "Digite a <b>DATA DE ENTREGAR</b> (DD/MM/AAAA ou YYYY-MM-DD) ou '-' para pular:");
          return res.sendStatus(200);
        }

        if (stt.step === "data_entregar") {
          if (text === "-") data.data_entregar = null;
          else {
            const iso = parseDateToISO(text);
            if (!iso) { await tgSendMessage(chatId, "Data inválida. Use DD/MM/AAAA."); return res.sendStatus(200); }
            data.data_entregar = iso;
          }

          setState(chatId, "ORDER_WIZ", "confirm", data);

          const preview =
            `🧾 <b>Confirme o Pedido</b>\n\n` +
            `Cliente: <b>${escapeHtml(data.nome)}</b>\n` +
            `Contato: ${escapeHtml(data.contato)}\n` +
            `Endereço: ${escapeHtml(data.endereco)}\n` +
            `Descrição: ${escapeHtml(data.descricao)}\n` +
            `Obs: ${escapeHtml(data.observacoes || "-")}\n` +
            `Valor: <b>${moneyBR(data.valor)}</b>\n` +
            `Buscar: ${escapeHtml(data.data_buscar || "-")}\n` +
            `Entregar: ${escapeHtml(data.data_entregar || "-")}\n\n` +
            `Salvar?`;

          await tgSendMessage(chatId, preview, KB_CONFIRM("O:CONFIRM:YES", "O:CONFIRM:NO"));
          return res.sendStatus(200);
        }

        if (stt.step === "confirm") {
          await tgSendMessage(chatId, "Use os botões ✅ SIM / ❌ NÃO.");
          return res.sendStatus(200);
        }
      }

      await tgSendMessage(chatId, "Use /menu para abrir o painel.");
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("ERRO webhook:", err);
    return res.sendStatus(200);
  }
});

// ===================== ROOT =====================
app.get("/", (req, res) => res.send("Bot ERP rodando"));
app.get("/health", (req, res) => res.json({ ok: true }));

// ===================== START =====================
app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
  console.log("Banco:", dbPath);
  console.log("Telegram webhook: POST /webhook");
  console.log("WhatsApp webhook: GET/POST /wa/webhook");
  console.log("OpenAI model:", OPENAI_MODEL);
  console.log("OpenAI key set:", !!OPENAI_API_KEY);
});
