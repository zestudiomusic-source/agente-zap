/**
 * AGENTE ERP (Telegram + IA + PostgreSQL) — versão integrada (ÚNICA e LIMPA)
 * 100% Postgres (Render)
 *
 * Módulos:
 * - Vendas (CRM)
 * - Pedidos
 * - Produção
 * - Financeiro
 * - Compras
 * - Relatórios/Rotinas (relatório semanal)
 * - IA: Chat IA + Insights + Alertas
 *
 * Arquivos (SEM PRINTS/IMAGENS):
 * - Aceita documentos no Telegram: PDF/XLSX/TXT/CSV
 * - Extrai texto, classifica e sugere encaminhamento / ações
 *
 * Automação (config do usuário):
 * - A1: Confirmar antes de criar pedido/tópico/ações automáticas
 * - B3: Tentar identificar cliente primeiro via CRM por palavras-chave/telefone/nome
 * - C2: Perguntar valor antes de criar pedido (se não vier)
 * - D1: Sugerir mover/encaminhar em vez de mover automaticamente quando houver dúvida
 *
 * ENV obrigatórias:
 * - DATABASE_URL
 * - TELEGRAM_ADMIN_ID
 * - TELEGRAM_BOT_TOKEN (ou BOT_TOKEN)
 *
 * ENV opcionais:
 * - OPENAI_API_KEY
 * - OPENAI_MODEL (default: gpt-4.1-mini)
 * - PUBLIC_BASE_URL (para mostrar links e status)
 *
 * Grupos / Tópicos (opcional, recomendado):
 * - SALES_CHAT_ID, SALES_THREAD_ID
 * - PROD_CHAT_ID,  PROD_THREAD_ID
 * - FIN_CHAT_ID,   FIN_THREAD_ID
 * - BUY_CHAT_ID,   BUY_THREAD_ID
 * - REPORTS_CHAT_ID, REPORTS_THREAD_ID
 *
 * Webhook:
 * - Telegram: POST /webhook
 * Health:
 * - GET /health
 */

const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");
const cron = require("node-cron");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const XLSX = require("xlsx");

// ===================== CONFIG =====================
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = Number(process.env.TELEGRAM_ADMIN_ID || 0);
const PORT = process.env.PORT || 3000;

const DATABASE_URL = process.env.DATABASE_URL || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

// Grupos/threads (opcional)
const SALES_CHAT_ID = process.env.SALES_CHAT_ID ? Number(process.env.SALES_CHAT_ID) : null;
const SALES_THREAD_ID = process.env.SALES_THREAD_ID ? Number(process.env.SALES_THREAD_ID) : null;

const PROD_CHAT_ID = process.env.PROD_CHAT_ID ? Number(process.env.PROD_CHAT_ID) : null;
const PROD_THREAD_ID = process.env.PROD_THREAD_ID ? Number(process.env.PROD_THREAD_ID) : null;

const FIN_CHAT_ID = process.env.FIN_CHAT_ID ? Number(process.env.FIN_CHAT_ID) : null;
const FIN_THREAD_ID = process.env.FIN_THREAD_ID ? Number(process.env.FIN_THREAD_ID) : null;

const BUY_CHAT_ID = process.env.BUY_CHAT_ID ? Number(process.env.BUY_CHAT_ID) : null;
const BUY_THREAD_ID = process.env.BUY_THREAD_ID ? Number(process.env.BUY_THREAD_ID) : null;

const REPORTS_CHAT_ID = process.env.REPORTS_CHAT_ID ? Number(process.env.REPORTS_CHAT_ID) : null;
const REPORTS_THREAD_ID = process.env.REPORTS_THREAD_ID ? Number(process.env.REPORTS_THREAD_ID) : null;

// Automations settings (do usuário)
const SETTINGS = {
  A: "A1",
  B: "B3",
  C: "C2",
  D: "D1",
};

if (!BOT_TOKEN) {
  console.error("ERRO: BOT_TOKEN/TELEGRAM_BOT_TOKEN não configurado!");
  process.exit(1);
}
if (!ADMIN_ID) {
  console.error("ERRO: TELEGRAM_ADMIN_ID não configurado!");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("ERRO: DATABASE_URL não configurado! (PostgreSQL)");
  process.exit(1);
}

// ===================== APP =====================
const app = express();
app.use(express.json({ limit: "4mb" }));

// upload (Telegram documentos -> vamos baixar via API; multer só se quiser endpoint externo no futuro)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ===================== DB (Postgres) =====================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("render.com") || DATABASE_URL.includes("postgres.render.com")
    ? { rejectUnauthorized: false }
    : undefined,
});

async function dbQuery(text, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function ensureSchema() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      nome TEXT,
      contato TEXT,
      endereco TEXT,
      descricao TEXT,
      observacoes TEXT,
      valor NUMERIC(12,2) DEFAULT 0,
      data_buscar DATE,
      data_entregar DATE,
      status_producao TEXT DEFAULT 'Aguardando produção',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      order_id INT REFERENCES orders(id) ON DELETE CASCADE,
      valor NUMERIC(12,2) NOT NULL,
      metodo TEXT,
      observacao TEXT,
      paid_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS deals (
      id SERIAL PRIMARY KEY,
      nome TEXT,
      contato TEXT,
      endereco TEXT,
      descricao TEXT,
      observacoes TEXT,
      valor_estimado NUMERIC(12,2),
      etapa TEXT DEFAULT 'Lead novo',
      origem TEXT DEFAULT 'manual',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    -- mensagens e logs
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      channel TEXT,
      chat_id BIGINT,
      user_id BIGINT,
      direction TEXT,
      text TEXT,
      meta_json JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      event_type TEXT,
      ref_type TEXT,
      ref_id TEXT,
      payload_json JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    -- IA
    CREATE TABLE IF NOT EXISTS insights (
      id SERIAL PRIMARY KEY,
      scope TEXT,
      insight_text TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    -- estado por chat (wizard/modos)
    CREATE TABLE IF NOT EXISTS state (
      chat_id BIGINT PRIMARY KEY,
      mode TEXT,
      step TEXT,
      payload_json JSONB,
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    -- memória IA por chat (para Chat IA / contexto persistente)
    CREATE TABLE IF NOT EXISTS ai_memory (
      chat_id BIGINT PRIMARY KEY,
      previous_response_id TEXT,
      summary TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    -- Compras (tecidos/insumos)
    CREATE TABLE IF NOT EXISTS purchases (
      id SERIAL PRIMARY KEY,
      order_id INT REFERENCES orders(id) ON DELETE SET NULL,
      client_name TEXT,
      item_type TEXT DEFAULT 'tecido',   -- tecido/espuma/madeira/outros
      item_code TEXT,
      item_desc TEXT,
      supplier TEXT,
      unit_value NUMERIC(12,2),
      qty NUMERIC(12,2),
      total_value NUMERIC(12,2),
      status TEXT DEFAULT 'A comprar',   -- A comprar / Comprado / Cancelado
      created_at TIMESTAMPTZ DEFAULT now()
    );

    -- Alertas da produção (faltou tecido/espuma/etc)
    CREATE TABLE IF NOT EXISTS prod_alerts (
      id SERIAL PRIMARY KEY,
      order_id INT REFERENCES orders(id) ON DELETE CASCADE,
      alert_type TEXT, -- faltou_tecido / faltou_espuma / faltou_madeira / outro
      message TEXT,
      status TEXT DEFAULT 'aberto', -- aberto / resolvido
      created_at TIMESTAMPTZ DEFAULT now(),
      resolved_at TIMESTAMPTZ
    );

    -- Checklist por pedido
    CREATE TABLE IF NOT EXISTS prod_checklist (
      id SERIAL PRIMARY KEY,
      order_id INT REFERENCES orders(id) ON DELETE CASCADE,
      item TEXT,
      done BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_deals_updated ON deals(updated_at);
    CREATE INDEX IF NOT EXISTS idx_payments_paid ON payments(paid_at);
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
  `);
}

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

function kb(rows) {
  return { reply_markup: { inline_keyboard: rows } };
}

async function tgSendMessage(chatId, text, extra = {}) {
  return tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
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

// Envio para módulo/grupo (com tópicos)
async function sendToModule(module, text, extra = {}) {
  let chatId = null;
  let threadId = null;

  if (module === "SALES") { chatId = SALES_CHAT_ID; threadId = SALES_THREAD_ID; }
  if (module === "PROD")  { chatId = PROD_CHAT_ID;  threadId = PROD_THREAD_ID; }
  if (module === "FIN")   { chatId = FIN_CHAT_ID;   threadId = FIN_THREAD_ID; }
  if (module === "BUY")   { chatId = BUY_CHAT_ID;   threadId = BUY_THREAD_ID; }
  if (module === "REPORTS"){ chatId = REPORTS_CHAT_ID; threadId = REPORTS_THREAD_ID; }

  // fallback: manda no admin privado se não tiver configurado
  if (!chatId) chatId = ADMIN_ID;

  const payload = { ...extra };
  if (threadId) payload.message_thread_id = threadId;

  return tgSendMessage(chatId, text, payload);
}

// ===================== HELPERS =====================
function isAdmin(userId) {
  return Number(userId) === ADMIN_ID;
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

function normalizePhone(str) {
  if (!str) return "";
  return String(str).replace(/[^\d]/g, "");
}

function shortHash(input) {
  return crypto.createHash("sha1").update(String(input)).digest("hex").slice(0, 10);
}

async function logEvent(event_type, ref_type, ref_id, payload) {
  await dbQuery(
    `INSERT INTO events(event_type, ref_type, ref_id, payload_json) VALUES ($1,$2,$3,$4)`,
    [event_type, String(ref_type || ""), String(ref_id || ""), payload || {}]
  );
}

async function saveMessage({ channel, chat_id, user_id, direction, text, meta }) {
  await dbQuery(
    `INSERT INTO messages(channel, chat_id, user_id, direction, text, meta_json) VALUES ($1,$2,$3,$4,$5,$6)`,
    [channel, chat_id || null, user_id || null, direction, text || "", meta || {}]
  );
}

// ===================== STATE =====================
async function setState(chatId, mode, step = "", payload = {}) {
  await dbQuery(
    `
    INSERT INTO state(chat_id, mode, step, payload_json, updated_at)
    VALUES($1,$2,$3,$4, now())
    ON CONFLICT(chat_id) DO UPDATE SET
      mode=EXCLUDED.mode,
      step=EXCLUDED.step,
      payload_json=EXCLUDED.payload_json,
      updated_at=now()
    `,
    [chatId, mode, step, payload || {}]
  );
}

async function getState(chatId) {
  const r = await dbQuery(`SELECT mode, step, payload_json FROM state WHERE chat_id=$1`, [chatId]);
  if (!r.rows.length) return { mode: "NONE", step: "", payload: {} };
  return { mode: r.rows[0].mode || "NONE", step: r.rows[0].step || "", payload: r.rows[0].payload_json || {} };
}

async function clearState(chatId) {
  await dbQuery(`DELETE FROM state WHERE chat_id=$1`, [chatId]);
}

// ===================== KPIs / CONTEXTO =====================
async function orderFinancial(orderId) {
  const o = await dbQuery(`SELECT valor FROM orders WHERE id=$1`, [orderId]);
  if (!o.rows.length) return null;

  const paidR = await dbQuery(`SELECT COALESCE(SUM(valor),0) s FROM payments WHERE order_id=$1`, [orderId]);
  const total = Number(o.rows[0].valor || 0);
  const paid = Number(paidR.rows[0].s || 0);

  let status = "PENDENTE";
  if (paid > 0 && paid + 1e-6 < total) status = "PARCIAL";
  if (paid + 1e-6 >= total) status = "PAGO";
  return { total, paid, status };
}

async function kpis() {
  const t = todayISO();
  const pedidosHoje = Number((await dbQuery(`SELECT COUNT(*) c FROM orders WHERE (created_at::date)=$1::date`, [t])).rows[0].c);
  const caixaHoje = Number((await dbQuery(`SELECT COALESCE(SUM(valor),0) s FROM payments WHERE (paid_at::date)=$1::date`, [t])).rows[0].s);
  const vendasEmAndamento = Number((await dbQuery(`SELECT COUNT(*) c FROM deals WHERE etapa NOT IN ('Concluída','Perdida')`, [])).rows[0].c);
  const atrasados = Number((await dbQuery(`
    SELECT COUNT(*) c FROM orders
    WHERE data_entregar IS NOT NULL AND data_entregar < $1::date AND status_producao != 'Entregue'
  `, [t])).rows[0].c);

  return { date: t, pedidosHoje, caixaHoje, vendasEmAndamento, atrasados };
}

async function buildContextSummary() {
  const k = await kpis();
  const late = (await dbQuery(`
    SELECT id, nome, valor, data_entregar, status_producao
    FROM orders
    WHERE data_entregar IS NOT NULL AND data_entregar < $1::date AND status_producao != 'Entregue'
    ORDER BY data_entregar ASC
    LIMIT 5
  `, [k.date])).rows;

  const deals = (await dbQuery(`
    SELECT id, nome, contato, valor_estimado, etapa, origem, updated_at
    FROM deals
    WHERE etapa NOT IN ('Concluída','Perdida')
    ORDER BY updated_at DESC
    LIMIT 5
  `)).rows;

  const finAttention = (await dbQuery(`
    SELECT o.id, o.nome, o.valor,
           COALESCE((SELECT SUM(valor) FROM payments p WHERE p.order_id=o.id),0) as paid
    FROM orders o
    ORDER BY o.id DESC
    LIMIT 80
  `)).rows
    .map(r => {
      const total = Number(r.valor || 0);
      const paid = Number(r.paid || 0);
      let status = "PENDENTE";
      if (paid > 0 && paid + 1e-6 < total) status = "PARCIAL";
      if (paid + 1e-6 >= total) status = "PAGO";
      return { id: r.id, nome: r.nome, total, paid, status };
    })
    .filter(x => x.status !== "PAGO")
    .slice(0, 5);

  const openAlerts = (await dbQuery(`
    SELECT a.id, a.order_id, a.alert_type, a.message, a.created_at
    FROM prod_alerts a
    WHERE a.status='aberto'
    ORDER BY a.created_at DESC
    LIMIT 5
  `)).rows;

  return {
    kpis: k,
    late_orders: late,
    deals_in_progress: deals,
    finance_attention: finAttention,
    prod_alerts_open: openAlerts,
  };
}

// ===================== OPENAI =====================
function extractResponseText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const out0 = data?.output?.[0];
  const content = out0?.content || [];
  for (const c of content) {
    if (c?.type === "output_text" && typeof c?.text === "string" && c.text.trim()) return c.text.trim();
    if (c?.type === "text" && typeof c?.text === "string" && c.text.trim()) return c.text.trim();
  }
  if (typeof data?.output === "string" && data.output.trim()) return data.output.trim();
  return "";
}

async function openaiAsk({ input, previous_response_id }) {
  if (!OPENAI_API_KEY) {
    return { ok: false, text: "IA não configurada. Coloque OPENAI_API_KEY no Render.", previous_response_id: null };
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input,
      previous_response_id: previous_response_id || undefined,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!data || data.error) {
    console.error("OpenAI error payload:", data);
    return { ok: false, text: `Erro IA: ${data?.error?.message || "falha na API"}`, previous_response_id: null };
  }

  const text = extractResponseText(data);
  return { ok: true, text: text || "Sem resposta.", previous_response_id: data.id || previous_response_id || null };
}

// Memória IA (por chat)
async function getAiMemory(chatId) {
  const r = await dbQuery(`SELECT previous_response_id, summary FROM ai_memory WHERE chat_id=$1`, [chatId]);
  if (!r.rows.length) return { previous_response_id: null, summary: "" };
  return { previous_response_id: r.rows[0].previous_response_id || null, summary: r.rows[0].summary || "" };
}
async function setAiMemory(chatId, { previous_response_id, summary }) {
  await dbQuery(
    `
    INSERT INTO ai_memory(chat_id, previous_response_id, summary, updated_at)
    VALUES($1,$2,$3, now())
    ON CONFLICT(chat_id) DO UPDATE SET
      previous_response_id=EXCLUDED.previous_response_id,
      summary=EXCLUDED.summary,
      updated_at=now()
    `,
    [chatId, previous_response_id || null, summary || ""]
  );
}

// ===================== MENUS =====================
function MENU_MAIN() {
  return kb([
    [{ text: "💰 Vendas (CRM)", callback_data: "M:DEALS" }, { text: "📦 Pedidos", callback_data: "M:ORDERS" }],
    [{ text: "🏭 Produção", callback_data: "M:PROD" }, { text: "📊 Financeiro", callback_data: "M:FIN" }],
    [{ text: "🧾 Compras", callback_data: "M:BUY" }, { text: "📈 Relatórios/Rotinas", callback_data: "M:REPORTS" }],
    [{ text: "🧠 IA", callback_data: "M:AI" }, { text: "⚙️ Sistema", callback_data: "M:SYSTEM" }],
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
    [{ text: "🚨 Alertas abertos", callback_data: "P:ALERTS:OPEN" }],
    [{ text: "➕ Criar alerta", callback_data: "P:ALERT:NEW" }],
    [{ text: "✅ Checklist pedido", callback_data: "P:CHECK:MENU" }],
    [{ text: "⬅️ Voltar", callback_data: "M:MAIN" }],
  ]);
}

function MENU_FIN() {
  return kb([
    [{ text: "💵 Registrar Pagamento", callback_data: "F:PAY" }],
    [{ text: "🧾 Pendentes", callback_data: "F:LIST:PEND" }, { text: "🟡 Parciais", callback_data: "F:LIST:PART" }],
    [{ text: "✅ Pagos", callback_data: "F:LIST:PAID" }],
    [{ text: "📊 Caixa do Dia", callback_data: "F:CASH:TODAY" }],
    [{ text: "⬅️ Voltar", callback_data: "M:MAIN" }],
  ]);
}

function MENU_BUY() {
  return kb([
    [{ text: "➕ Registrar compra (tecido/insumo)", callback_data: "B:NEW" }],
    [{ text: "📋 Lista A comprar (20)", callback_data: "B:LIST:TODO" }, { text: "✅ Comprados (20)", callback_data: "B:LIST:DONE" }],
    [{ text: "🔎 Buscar (ID/Cliente/Código)", callback_data: "B:SEARCH" }],
    [{ text: "⬅️ Voltar", callback_data: "M:MAIN" }],
  ]);
}

function MENU_REPORTS() {
  return kb([
    [{ text: "📅 Gerar relatório semanal (agora)", callback_data: "R:WEEKLY:NOW" }],
    [{ text: "📊 Resumo do dia", callback_data: "R:DAILY" }],
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
    [{ text: "🧪 Testar envio grupos", callback_data: "S:GROUPS:TEST" }],
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
    [{ text: "⬅️ Sair do Chat IA", callback_data: "AI:EXIT" }, { text: "🧹 Resetar memória IA", callback_data: "AI:RESET" }],
    [{ text: "⬅️ Voltar", callback_data: "M:MAIN" }],
  ]);
}

function KB_ROUTE_SUGGEST() {
  // D1: sugerir para onde vai
  return kb([
    [
      { text: "➡️ Vendas", callback_data: "ROUTE:SALES" },
      { text: "➡️ Produção", callback_data: "ROUTE:PROD" },
      { text: "➡️ Financeiro", callback_data: "ROUTE:FIN" },
    ],
    [{ text: "➡️ Compras", callback_data: "ROUTE:BUY" }],
    [{ text: "Cancelar", callback_data: "ROUTE:CANCEL" }],
  ]);
}

// ===================== LISTAGENS =====================
async function listDealsByType(type) {
  let where = "TRUE";
  if (type === "AND") where = `etapa NOT IN ('Concluída','Perdida')`;
  if (type === "DONE") where = `etapa='Concluída'`;
  if (type === "LOST") where = `etapa='Perdida'`;

  const rows = (await dbQuery(`
    SELECT id, nome, contato, valor_estimado, etapa, origem, updated_at
    FROM deals
    WHERE ${where}
    ORDER BY updated_at DESC
    LIMIT 20
  `)).rows;

  if (!rows.length) return "Nenhuma venda encontrada.";

  let txt = "💰 <b>Vendas</b>\n\n";
  for (const d of rows) {
    txt += `#${d.id} - ${d.nome || "Sem nome"} (${d.contato || "-"})\n`;
    txt += `Etapa: <b>${d.etapa}</b> | Origem: ${d.origem}\n`;
    if (d.valor_estimado != null) txt += `Valor estimado: ${moneyBR(d.valor_estimado)}\n`;
    txt += `Atualizado: ${new Date(d.updated_at).toLocaleString("pt-BR")}\n\n`;
  }
  return txt;
}

async function listOrders(limit = 20) {
  const rows = (await dbQuery(`SELECT * FROM orders ORDER BY id DESC LIMIT $1`, [limit])).rows;
  if (!rows.length) return "Nenhum pedido encontrado.";

  let txt = "📋 <b>Últimos Pedidos</b>\n\n";
  for (const p of rows) {
    const f = await orderFinancial(p.id);
    const fin = f ? ` | ${f.status} (${moneyBR(f.paid)}/${moneyBR(f.total)})` : "";
    txt += `#${p.id} - ${p.nome || "Sem nome"} - ${moneyBR(p.valor)}\n`;
    txt += `Prod: <b>${p.status_producao}</b>${fin}\n`;
    if (p.data_entregar) txt += `Entrega: ${p.data_entregar}\n`;
    txt += `\n`;
  }
  return txt;
}

async function listOrdersByProdStatus(status) {
  const rows = (await dbQuery(`
    SELECT id, nome, valor, data_entregar, status_producao
    FROM orders
    WHERE status_producao=$1
    ORDER BY COALESCE(data_entregar, '9999-12-31'::date) ASC, id DESC
    LIMIT 30
  `, [status])).rows;

  if (!rows.length) return `Nenhum pedido em: ${status}`;

  let txt = `🏭 <b>${status}</b>\n\n`;
  for (const p of rows) {
    txt += `#${p.id} - ${p.nome || "Sem nome"} - ${moneyBR(p.valor)}\n`;
    if (p.data_entregar) txt += `Entrega: ${p.data_entregar}\n`;
    txt += `\n`;
  }
  return txt;
}

async function listLateOrders() {
  const t = todayISO();
  const rows = (await dbQuery(`
    SELECT id, nome, valor, data_entregar, status_producao
    FROM orders
    WHERE data_entregar IS NOT NULL AND data_entregar < $1::date AND status_producao != 'Entregue'
    ORDER BY data_entregar ASC
    LIMIT 30
  `, [t])).rows;

  if (!rows.length) return "✅ Nenhum pedido atrasado.";

  let txt = "⏱️ <b>Pedidos Atrasados</b>\n\n";
  for (const p of rows) {
    txt += `#${p.id} - ${p.nome || "Sem nome"} - ${moneyBR(p.valor)}\n`;
    txt += `Entrega: <b>${p.data_entregar}</b> | Status: ${p.status_producao}\n\n`;
  }
  return txt;
}

async function listFinanceByType(type) {
  const rows = (await dbQuery(`
    SELECT o.id, o.nome, o.valor,
           COALESCE((SELECT SUM(valor) FROM payments p WHERE p.order_id=o.id),0) as paid
    FROM orders o
    ORDER BY o.id DESC
    LIMIT 200
  `)).rows;

  const out = [];
  for (const r of rows) {
    const total = Number(r.valor || 0);
    const paid = Number(r.paid || 0);
    let status = "PENDENTE";
    if (paid > 0 && paid + 1e-6 < total) status = "PARCIAL";
    if (paid + 1e-6 >= total) status = "PAGO";

    if (type === "PEND" && status === "PENDENTE") out.push({ ...r, total, paid, status });
    if (type === "PART" && status === "PARCIAL") out.push({ ...r, total, paid, status });
    if (type === "PAID" && status === "PAGO") out.push({ ...r, total, paid, status });
    if (out.length >= 25) break;
  }

  if (!out.length) return "Nada encontrado.";

  let txt = "📊 <b>Financeiro</b>\n\n";
  for (const p of out) {
    txt += `#${p.id} - ${p.nome || "Sem nome"}\n`;
    txt += `Total: ${moneyBR(p.total)} | Pago: ${moneyBR(p.paid)} | <b>${p.status}</b>\n\n`;
  }
  return txt;
}

async function cashToday() {
  const t = todayISO();
  const sum = Number((await dbQuery(`SELECT COALESCE(SUM(valor),0) s FROM payments WHERE (paid_at::date)=$1::date`, [t])).rows[0].s);
  const count = Number((await dbQuery(`SELECT COUNT(*) c FROM payments WHERE (paid_at::date)=$1::date`, [t])).rows[0].c);
  return { date: t, sum, count };
}

async function listPurchases(type) {
  let where = "TRUE";
  if (type === "TODO") where = `status='A comprar'`;
  if (type === "DONE") where = `status='Comprado'`;

  const rows = (await dbQuery(`
    SELECT id, client_name, item_type, item_code, item_desc, unit_value, qty, total_value, status, created_at
    FROM purchases
    WHERE ${where}
    ORDER BY created_at DESC
    LIMIT 20
  `)).rows;

  if (!rows.length) return "Nada encontrado.";

  let txt = `🧾 <b>Compras - ${type === "TODO" ? "A comprar" : "Comprados"}</b>\n\n`;
  for (const r of rows) {
    txt += `#${r.id} - Cliente: <b>${r.client_name || "-"}</b>\n`;
    txt += `Item: ${r.item_type} | Código: <b>${r.item_code || "-"}</b>\n`;
    txt += `Desc: ${r.item_desc || "-"}\n`;
    if (r.total_value != null) txt += `Total: <b>${moneyBR(r.total_value)}</b>\n`;
    txt += `Status: <b>${r.status}</b>\n\n`;
  }
  return txt;
}

async function listOpenProdAlerts() {
  const rows = (await dbQuery(`
    SELECT id, order_id, alert_type, message, created_at
    FROM prod_alerts
    WHERE status='aberto'
    ORDER BY created_at DESC
    LIMIT 30
  `)).rows;

  if (!rows.length) return "✅ Nenhum alerta aberto.";

  let txt = `🚨 <b>Alertas abertos</b>\n\n`;
  for (const a of rows) {
    txt += `#${a.id} (Pedido #${a.order_id}) - <b>${a.alert_type}</b>\n${a.message}\nCriado: ${new Date(a.created_at).toLocaleString("pt-BR")}\n\n`;
  }
  return txt;
}

// ===================== ARQUIVOS (PDF/XLSX/TXT/CSV) =====================
async function tgGetFile(fileId) {
  const r = await tg("getFile", { file_id: fileId });
  if (!r.ok) return null;
  return r.result;
}

async function downloadTelegramFile(filePath) {
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Falha ao baixar arquivo do Telegram");
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

async function extractTextFromFile(filename, buffer) {
  const lower = (filename || "").toLowerCase();

  if (lower.endsWith(".pdf")) {
    const data = await pdfParse(buffer);
    return (data.text || "").trim();
  }

  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const sheetNames = wb.SheetNames || [];
    let out = "";
    for (const sn of sheetNames.slice(0, 3)) {
      const ws = wb.Sheets[sn];
      const json = XLSX.utils.sheet_to_json(ws, { header: 1 });
      out += `\n--- SHEET: ${sn} ---\n`;
      for (const row of json.slice(0, 200)) {
        out += row.map(c => String(c ?? "")).join("\t") + "\n";
      }
    }
    return out.trim();
  }

  if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    return buffer.toString("utf8").trim();
  }

  // fallback: tenta texto
  return buffer.toString("utf8").trim();
}

// Classificar conteúdo do arquivo (IA se tiver; senão heurística)
async function classifyDocumentText(text) {
  const t = (text || "").toLowerCase();

  // heurística rápida
  const hasMoney = /r\$|\btotal\b|\bvalor\b|\bpix\b|\bcart[aã]o\b|\bpagamento\b/.test(t);
  const hasFabric = /\btecido\b|\bespuma\b|\bmadeira\b|\bfornecedor\b|\bc[oó]digo\b/.test(t);
  const hasOrder = /\bpedido\b|\bentrega\b|\bbuscar\b|\bmedida\b|\bsof[aá]\b|\bcadeira\b/.test(t);
  const hasSale = /\bor[cç]amento\b|\bproposta\b|\bnegocia[cç][aã]o\b|\bcliente\b/.test(t);

  if (!OPENAI_API_KEY) {
    if (hasFabric) return { kind: "BUY", confidence: 0.7 };
    if (hasMoney && !hasOrder && !hasSale) return { kind: "FIN", confidence: 0.6 };
    if (hasOrder) return { kind: "PROD", confidence: 0.55 };
    if (hasSale) return { kind: "SALES", confidence: 0.55 };
    return { kind: "UNKNOWN", confidence: 0.3 };
  }

  const prompt = `
Classifique o documento em UMA das categorias:
SALES (vendas/CRM), ORDERS (pedido/detalhes do pedido), PROD (produção/medidas), FIN (financeiro/pagamentos), BUY (compras/tecidos/insumos), UNKNOWN.

Responda APENAS em JSON com as chaves:
{"kind":"SALES|ORDERS|PROD|FIN|BUY|UNKNOWN","confidence":0-1,"notes":"curto"}

TEXTO:
${text.slice(0, 12000)}
  `.trim();

  const ans = await openaiAsk({ input: prompt, previous_response_id: null });
  if (!ans.ok) return { kind: "UNKNOWN", confidence: 0.3 };

  try {
    const j = JSON.parse(ans.text);
    if (j && j.kind) return j;
  } catch {}
  return { kind: "UNKNOWN", confidence: 0.3 };
}

// Tentar identificar cliente (B3) por telefone/nome
async function findClientFromText(text) {
  const phone = (text.match(/(\+?55)?\s?\(?\d{2}\)?\s?\d{4,5}\-?\d{4}/g) || [])[0];
  const phoneN = normalizePhone(phone || "");

  if (phoneN.length >= 10) {
    const r = await dbQuery(
      `SELECT id, nome, contato FROM deals WHERE regexp_replace(contato, '[^0-9]', '', 'g') LIKE $1 ORDER BY updated_at DESC LIMIT 1`,
      [`%${phoneN}%`]
    );
    if (r.rows.length) return { type: "deal", ...r.rows[0], matched: "phone" };

    const o = await dbQuery(
      `SELECT id, nome, contato FROM orders WHERE regexp_replace(contato, '[^0-9]', '', 'g') LIKE $1 ORDER BY updated_at DESC LIMIT 1`,
      [`%${phoneN}%`]
    );
    if (o.rows.length) return { type: "order", ...o.rows[0], matched: "phone" };
  }

  // tenta nome por “Cliente: X”
  const nameMatch = text.match(/cliente\s*[:\-]\s*([A-Za-zÀ-ÿ\s]{3,60})/i);
  const name = nameMatch ? nameMatch[1].trim() : "";

  if (name.length >= 3) {
    const r = await dbQuery(`SELECT id, nome, contato FROM deals WHERE nome ILIKE $1 ORDER BY updated_at DESC LIMIT 1`, [`%${name}%`]);
    if (r.rows.length) return { type: "deal", ...r.rows[0], matched: "name" };
    const o = await dbQuery(`SELECT id, nome, contato FROM orders WHERE nome ILIKE $1 ORDER BY updated_at DESC LIMIT 1`, [`%${name}%`]);
    if (o.rows.length) return { type: "order", ...o.rows[0], matched: "name" };
  }

  return null;
}

// ===================== RELATÓRIO SEMANAL (CRON) =====================
// Toda segunda 09:00 (BRT)
cron.schedule(
  "0 9 * * 1",
  async () => {
    try {
      const txt = await generateWeeklyReport();
      await sendToModule("REPORTS", txt);
      await logEvent("weekly_report_sent", "reports", "weekly", { ok: true });
    } catch (e) {
      console.error("Erro relatório semanal:", e);
      await logEvent("weekly_report_sent", "reports", "weekly", { ok: false, error: String(e) });
    }
  },
  { timezone: "America/Sao_Paulo" }
);

async function generateWeeklyReport() {
  const ctx = await buildContextSummary();

  const prompt =
    `Você é um consultor empresarial e diretor administrativo. ` +
    `Crie um relatório semanal (curto e prático) com:\n` +
    `1) Diagnóstico (vendas/produção/financeiro)\n` +
    `2) Alertas críticos\n` +
    `3) Plano de ação (top 5 ações)\n` +
    `4) Rotina recomendada para a semana\n` +
    `Sem pesquisar na web.\n\nDADOS(JSON):\n${JSON.stringify(ctx, null, 2)}`;

  if (!OPENAI_API_KEY) {
    // fallback sem IA
    let txt = `📈 <b>Relatório Semanal</b>\n\n`;
    txt += `Data: ${ctx.kpis.date}\n`;
    txt += `Pedidos hoje: ${ctx.kpis.pedidosHoje}\n`;
    txt += `Caixa hoje: ${moneyBR(ctx.kpis.caixaHoje)}\n`;
    txt += `Vendas em andamento: ${ctx.kpis.vendasEmAndamento}\n`;
    txt += `Atrasados: ${ctx.kpis.atrasados}\n\n`;
    txt += `Ações sugeridas:\n• Cobrar pendências\n• Priorizar atrasados\n• Revisar funil de vendas\n• Organizar compras\n• Padronizar checklist de produção\n`;
    return txt;
  }

  const ans = await openaiAsk({ input: prompt, previous_response_id: null });
  const out = ans.ok ? ans.text : ans.text;

  await dbQuery(`INSERT INTO insights(scope, insight_text) VALUES($1,$2)`, ["weekly", out]);
  return `📈 <b>Relatório Semanal</b>\n\n${out}`;
}

// ===================== UI / MENU =====================
async function showMainMenu(chatId, editMsgId = null) {
  const text = "📊 <b>Painel Administrativo</b>\nEscolha um módulo:";
  if (editMsgId) return tgEditMessage(chatId, editMsgId, text, MENU_MAIN());
  return tgSendMessage(chatId, text, MENU_MAIN());
}

// ===================== TELEGRAM WEBHOOK =====================
app.post("/webhook", async (req, res) => {
  const body = req.body;
  try {
    // ---------- CALLBACKS ----------
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
      if (data === "M:BUY") { await tgEditMessage(chatId, msgId, "🧾 <b>Compras</b>", MENU_BUY()); return res.sendStatus(200); }
      if (data === "M:REPORTS") { await tgEditMessage(chatId, msgId, "📈 <b>Relatórios/Rotinas</b>", MENU_REPORTS()); return res.sendStatus(200); }
      if (data === "M:AI") { await tgEditMessage(chatId, msgId, "🧠 <b>IA</b>", MENU_AI()); return res.sendStatus(200); }
      if (data === "M:SYSTEM") { await tgEditMessage(chatId, msgId, "⚙️ <b>Sistema</b>", MENU_SYSTEM()); return res.sendStatus(200); }

      // Rotas sugeridas (D1)
      if (data.startsWith("ROUTE:")) {
        const st = await getState(chatId);
        if (st.mode !== "ROUTE_SUGGEST") {
          await tgSendMessage(chatId, "Sem item para encaminhar agora.");
          return res.sendStatus(200);
        }
        if (data === "ROUTE:CANCEL") {
          await clearState(chatId);
          await tgSendMessage(chatId, "Cancelado.");
          return res.sendStatus(200);
        }
        const dest = data.split(":")[1];
        const payload = st.payload || {};
        const text = payload.text || "(sem texto)";
        const title = payload.title || "Encaminhamento";

        const map = { SALES: "SALES", PROD: "PROD", FIN: "FIN", BUY: "BUY" };
        await sendToModule(map[dest], `📎 <b>${title}</b>\n\n${text}`);
        await clearState(chatId);
        await tgSendMessage(chatId, `✅ Enviado para ${dest}.`);
        return res.sendStatus(200);
      }

      // ---------- VENDAS ----------
      if (data === "D:NEW") {
        await setState(chatId, "DEAL_WIZ", "nome", {});
        await tgSendMessage(chatId, "💰 <b>Nova Venda</b>\nDigite o <b>NOME</b> do cliente:");
        return res.sendStatus(200);
      }

      if (data.startsWith("D:LIST:")) {
        const type = data.split(":")[2];
        await tgSendMessage(chatId, await listDealsByType(type));
        return res.sendStatus(200);
      }

      if (data === "D:SEARCH") {
        await setState(chatId, "SEARCH", "deal", { last: "deal" });
        await tgSendMessage(chatId, "🔎 Digite: <b>ID</b> ou <b>nome</b> ou <b>contato</b> para buscar venda:");
        return res.sendStatus(200);
      }

      if (data.startsWith("D:SET:")) {
        const parts = data.split(":");
        const dealId = Number(parts[2]);
        const etapa = parts.slice(3).join(":");
        await dbQuery(`UPDATE deals SET etapa=$1, updated_at=now() WHERE id=$2`, [etapa, dealId]);
        await logEvent("deal_stage_changed", "deal", dealId, { etapa });
        await tgSendMessage(chatId, `✅ Venda #${dealId} atualizada para: <b>${etapa}</b>`);
        return res.sendStatus(200);
      }

      if (data.startsWith("D:TO_ORDER:")) {
        // A1: pedir confirmação antes (em vez de converter direto)
        const dealId = Number(data.split(":")[2]);
        const d = (await dbQuery(`SELECT * FROM deals WHERE id=$1`, [dealId])).rows[0];
        if (!d) { await tgSendMessage(chatId, "Venda não encontrada."); return res.sendStatus(200); }

        await setState(chatId, "CONFIRM_ACTION", "deal_to_order", { deal_id: dealId });
        await tgSendMessage(
          chatId,
          `Converter a venda <b>#${dealId}</b> em pedido?\nCliente: <b>${d.nome || "-"}</b>\nValor: <b>${moneyBR(d.valor_estimado || 0)}</b>`,
          KB_CONFIRM("CONFIRM:DEAL_TO_ORDER:YES", "CONFIRM:DEAL_TO_ORDER:NO")
        );
        return res.sendStatus(200);
      }

      // confirmação A1
      if (data === "CONFIRM:DEAL_TO_ORDER:YES" || data === "CONFIRM:DEAL_TO_ORDER:NO") {
        const st = await getState(chatId);
        if (st.mode !== "CONFIRM_ACTION" || st.step !== "deal_to_order") {
          await tgSendMessage(chatId, "Nada para confirmar agora.");
          return res.sendStatus(200);
        }
        if (data.endsWith(":NO")) {
          await clearState(chatId);
          await tgSendMessage(chatId, "Ok, não converti.");
          return res.sendStatus(200);
        }
        const dealId = Number(st.payload.deal_id);
        const d = (await dbQuery(`SELECT * FROM deals WHERE id=$1`, [dealId])).rows[0];
        if (!d) { await clearState(chatId); await tgSendMessage(chatId, "Venda não encontrada."); return res.sendStatus(200); }

        const ins = await dbQuery(`
          INSERT INTO orders(nome, contato, endereco, descricao, observacoes, valor, status_producao, updated_at)
          VALUES($1,$2,$3,$4,$5,$6,'Aguardando produção', now())
          RETURNING id
        `, [d.nome, d.contato, d.endereco, d.descricao, d.observacoes, Number(d.valor_estimado || 0)]);

        const orderId = ins.rows[0].id;
        await dbQuery(`UPDATE deals SET etapa='Concluída', updated_at=now() WHERE id=$1`, [dealId]);
        await logEvent("deal_converted_to_order", "deal", dealId, { order_id: orderId });

        await clearState(chatId);

        await tgSendMessage(chatId, `✅ Venda #${dealId} convertida em Pedido #${orderId}.`);

        // Interação entre grupos: avisar produção e financeiro
        await sendToModule("PROD", `📦 <b>Novo Pedido</b> (origem venda)\nPedido #${orderId}\nCliente: <b>${d.nome || "-"}</b>\nDescrição: ${d.descricao || "-"}\nValor: <b>${moneyBR(d.valor_estimado || 0)}</b>`);
        await sendToModule("FIN", `💳 <b>Novo Pedido para cobrança</b>\nPedido #${orderId}\nCliente: <b>${d.nome || "-"}</b>\nValor: <b>${moneyBR(d.valor_estimado || 0)}</b>\nStatus: PENDENTE`);
        return res.sendStatus(200);
      }

      // ---------- PEDIDOS ----------
      if (data === "O:NEW") {
        await setState(chatId, "ORDER_WIZ", "nome", {});
        await tgSendMessage(chatId, "📦 <b>Novo Pedido</b>\nDigite o <b>NOME</b> do cliente:");
        return res.sendStatus(200);
      }

      if (data === "O:LIST20") {
        await tgSendMessage(chatId, await listOrders(20));
        return res.sendStatus(200);
      }

      if (data === "O:SEARCH") {
        await setState(chatId, "SEARCH", "order", { last: "order" });
        await tgSendMessage(chatId, "🔎 Digite: <b>ID</b> ou <b>nome</b> ou <b>contato</b> para buscar pedido:");
        return res.sendStatus(200);
      }

      if (data === "O:SETSTATUS") {
        await setState(chatId, "SET_STATUS", "ask_id", {});
        await tgSendMessage(chatId, "🏷️ Digite o <b>ID do pedido</b> que você quer mudar o status de produção:");
        return res.sendStatus(200);
      }

      if (data.startsWith("ST:")) {
        const stNew = data.slice(3);
        const st = await getState(chatId);
        if (st.mode !== "SET_STATUS" || !st.payload?.order_id) {
          await tgSendMessage(chatId, "Sem pedido selecionado para status.");
          return res.sendStatus(200);
        }
        const orderId = Number(st.payload.order_id);
        await dbQuery(`UPDATE orders SET status_producao=$1, updated_at=now() WHERE id=$2`, [stNew, orderId]);
        await logEvent("order_status_changed", "order", orderId, { status: stNew });
        await clearState(chatId);
        await tgSendMessage(chatId, `✅ Pedido #${orderId} status atualizado para: <b>${stNew}</b>`);
        return res.sendStatus(200);
      }

      if (data === "O:CONFIRM:YES" || data === "O:CONFIRM:NO") {
        const st = await getState(chatId);
        if (st.mode !== "ORDER_WIZ" || st.step !== "confirm") {
          await tgSendMessage(chatId, "Nenhum pedido em confirmação no momento. Use /menu → Pedidos.");
          return res.sendStatus(200);
        }
        if (data === "O:CONFIRM:NO") {
          await clearState(chatId);
          await tgSendMessage(chatId, "❌ Pedido cancelado. Use /menu para criar outro.");
          return res.sendStatus(200);
        }

        const p = st.payload || {};
        const ins = await dbQuery(`
          INSERT INTO orders (nome, contato, endereco, descricao, observacoes, valor, data_buscar, data_entregar, status_producao, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Aguardando produção', now())
          RETURNING id
        `, [
          p.nome, p.contato, p.endereco, p.descricao, p.observacoes || null,
          Number(p.valor || 0),
          p.data_buscar ? p.data_buscar : null,
          p.data_entregar ? p.data_entregar : null
        ]);

        const orderId = ins.rows[0].id;
        await logEvent("order_created", "order", orderId, p);
        await clearState(chatId);

        await tgSendMessage(chatId, `✅ Pedido criado!\n<b>Pedido #${orderId}</b>\nCliente: <b>${p.nome}</b>\nValor: <b>${moneyBR(p.valor)}</b>\nStatus: <b>Aguardando produção</b>`);

        await sendToModule("PROD", `📦 <b>Novo Pedido</b>\nPedido #${orderId}\nCliente: <b>${p.nome}</b>\nDescrição: ${p.descricao}\nEntrega: ${p.data_entregar || "-"}\nValor: <b>${moneyBR(p.valor)}</b>`);
        await sendToModule("FIN", `💳 <b>Novo Pedido</b>\nPedido #${orderId}\nCliente: <b>${p.nome}</b>\nValor: <b>${moneyBR(p.valor)}</b>\nStatus: PENDENTE`);
        return res.sendStatus(200);
      }

      // ---------- PRODUÇÃO ----------
      if (data.startsWith("P:LIST:")) {
        const code = data.split(":")[2];
        const map = { A: "Aguardando produção", E: "Em produção", P: "Pronto", T: "Entregue", X: "Problema" };
        await tgSendMessage(chatId, await listOrdersByProdStatus(map[code]));
        return res.sendStatus(200);
      }

      if (data === "P:LATE") {
        await tgSendMessage(chatId, await listLateOrders());
        return res.sendStatus(200);
      }

      if (data === "P:ALERTS:OPEN") {
        await tgSendMessage(chatId, await listOpenProdAlerts());
        return res.sendStatus(200);
      }

      if (data === "P:ALERT:NEW") {
        await setState(chatId, "PROD_ALERT_WIZ", "order_id", {});
        await tgSendMessage(chatId, "🚨 <b>Novo alerta</b>\nDigite o <b>ID do pedido</b>:");
        return res.sendStatus(200);
      }

      if (data === "P:CHECK:MENU") {
        await setState(chatId, "PROD_CHECK_WIZ", "order_id", {});
        await tgSendMessage(chatId, "✅ <b>Checklist</b>\nDigite o <b>ID do pedido</b>:");
        return res.sendStatus(200);
      }

      // ---------- FINANCEIRO ----------
      if (data === "F:PAY") {
        await setState(chatId, "PAY_WIZ", "order_id", {});
        await tgSendMessage(chatId, "💵 Digite o <b>ID do pedido</b> para registrar pagamento:");
        return res.sendStatus(200);
      }

      if (data.startsWith("F:LIST:")) {
        const type = data.split(":")[2];
        await tgSendMessage(chatId, await listFinanceByType(type));
        return res.sendStatus(200);
      }

      if (data === "F:CASH:TODAY") {
        const c = await cashToday();
        await tgSendMessage(chatId, `📊 <b>Caixa do Dia</b> (${c.date})\nPagamentos: ${c.count}\nTotal: <b>${moneyBR(c.sum)}</b>`);
        return res.sendStatus(200);
      }

      if (data.startsWith("PM:")) {
        const method = data.slice(3);
        const st = await getState(chatId);
        if (st.mode !== "PAY_WIZ") {
          await tgSendMessage(chatId, "Fluxo de pagamento não ativo.");
          return res.sendStatus(200);
        }
        const payload = st.payload || {};
        payload.metodo = method;
        await setState(chatId, "PAY_WIZ", "valor", payload);
        await tgSendMessage(chatId, `Método: <b>${method}</b>\nAgora digite o <b>valor pago</b> (ex: 500 ou 500,00):`);
        return res.sendStatus(200);
      }

      // ---------- COMPRAS ----------
      if (data === "B:NEW") {
        await setState(chatId, "BUY_WIZ", "client_name", {});
        await tgSendMessage(chatId, "🧾 <b>Nova compra</b>\nNome do cliente (ou '-' se não tiver):");
        return res.sendStatus(200);
      }

      if (data.startsWith("B:LIST:")) {
        const type = data.split(":")[2];
        await tgSendMessage(chatId, await listPurchases(type));
        return res.sendStatus(200);
      }

      if (data === "B:SEARCH") {
        await setState(chatId, "SEARCH", "buy", { last: "buy" });
        await tgSendMessage(chatId, "🔎 Digite: <b>ID</b> ou <b>cliente</b> ou <b>código</b> para buscar compra:");
        return res.sendStatus(200);
      }

      // ---------- RELATÓRIOS ----------
      if (data === "R:WEEKLY:NOW") {
        const txt = await generateWeeklyReport();
        await tgSendMessage(chatId, txt);
        await sendToModule("REPORTS", txt);
        return res.sendStatus(200);
      }

      if (data === "R:DAILY") {
        const ctx = await buildContextSummary();
        let txt = `📊 <b>Resumo do dia</b> (${ctx.kpis.date})\n\n`;
        txt += `• Pedidos hoje: <b>${ctx.kpis.pedidosHoje}</b>\n`;
        txt += `• Caixa hoje: <b>${moneyBR(ctx.kpis.caixaHoje)}</b>\n`;
        txt += `• Vendas em andamento: <b>${ctx.kpis.vendasEmAndamento}</b>\n`;
        txt += `• Atrasados: <b>${ctx.kpis.atrasados}</b>\n\n`;
        if (ctx.prod_alerts_open?.length) txt += `🚨 Alertas abertos: <b>${ctx.prod_alerts_open.length}</b>\n`;
        await tgSendMessage(chatId, txt);
        return res.sendStatus(200);
      }

      // ---------- IA ----------
      if (data === "AI:CHAT") {
        const mem = await getAiMemory(chatId);
        await setState(chatId, "AI_CHAT", "", {});
        await tgSendMessage(chatId, "🤖 <b>Chat IA ativado</b>\n\nFale comigo aqui.\nPara sair: clique em <b>Sair do Chat IA</b>.", KB_AI_CHAT());
        if (!mem.summary) {
          await setAiMemory(chatId, { previous_response_id: null, summary: "Início de conversa." });
        }
        return res.sendStatus(200);
      }

      if (data === "AI:EXIT") {
        await clearState(chatId);
        await showMainMenu(chatId);
        return res.sendStatus(200);
      }

      if (data === "AI:RESET") {
        await setAiMemory(chatId, { previous_response_id: null, summary: "" });
        await tgSendMessage(chatId, "🧹 Memória da IA resetada. Pode falar de novo.", KB_AI_CHAT());
        return res.sendStatus(200);
      }

      if (data === "AI:ALERTS") {
        const ctx = await buildContextSummary();
        let txt = `⚠️ <b>Alertas do Dia</b> (${ctx.kpis.date})\n\n`;
        txt += `• Atrasados: <b>${ctx.kpis.atrasados}</b>\n`;
        txt += `• Caixa hoje: <b>${moneyBR(ctx.kpis.caixaHoje)}</b>\n`;
        txt += `• Pedidos hoje: <b>${ctx.kpis.pedidosHoje}</b>\n`;
        txt += `• Vendas em andamento: <b>${ctx.kpis.vendasEmAndamento}</b>\n\n`;
        if (ctx.late_orders.length) {
          txt += `<b>Top atrasados:</b>\n`;
          for (const o of ctx.late_orders) {
            txt += `#${o.id} ${o.nome || "Sem nome"} — entrega ${o.data_entregar} (${o.status_producao})\n`;
          }
        } else {
          txt += "✅ Sem atrasos no momento.\n";
        }
        if (ctx.prod_alerts_open?.length) {
          txt += `\n🚨 <b>Alertas produção abertos:</b>\n`;
          for (const a of ctx.prod_alerts_open) {
            txt += `#${a.id} Pedido #${a.order_id} — ${a.alert_type}\n`;
          }
        }
        await tgSendMessage(chatId, txt);
        return res.sendStatus(200);
      }

      if (data === "AI:INSIGHTS") {
        const ctx = await buildContextSummary();
        const prompt =
          `Você é o diretor administrativo e estrategista de uma empresa sob encomenda. ` +
          `Analise os dados abaixo e gere: (1) alertas financeiros, (2) gargalos de produção, (3) sugestões de vendas e cobrança, ` +
          `(4) priorização de agenda. Seja direto e prático.\n\nDADOS(JSON):\n${JSON.stringify(ctx, null, 2)}`;

        const mem = await getAiMemory(chatId);
        const ans = await openaiAsk({ input: prompt, previous_response_id: mem.previous_response_id });

        const out = ans.ok ? ans.text : ans.text;
        await dbQuery(`INSERT INTO insights(scope, insight_text) VALUES($1,$2)`, ["daily", out]);
        await logEvent("ai_insights_generated", "ai", "daily", { date: ctx.kpis.date });

        if (ans.ok) {
          await setAiMemory(chatId, { previous_response_id: ans.previous_response_id, summary: mem.summary || "" });
        }

        await tgSendMessage(chatId, `🧠 <b>Insights IA</b>\n\n${out}`);
        return res.sendStatus(200);
      }

      // ---------- SISTEMA ----------
      if (data === "S:DB") {
        const k = await kpis();
        await tgSendMessage(
          chatId,
          `📌 <b>Status do DB</b>\n\n` +
            `DATABASE_URL: <code>${DATABASE_URL ? "OK" : "NÃO"}</code>\n` +
            `Pedidos hoje: ${k.pedidosHoje}\n` +
            `Caixa hoje: ${moneyBR(k.caixaHoje)}\n` +
            `Vendas em andamento: ${k.vendasEmAndamento}\n` +
            `Atrasados: ${k.atrasados}\n`
        );
        return res.sendStatus(200);
      }

      if (data === "S:GROUPS:TEST") {
        await sendToModule("SALES", "✅ Teste: envio para VENDAS (SALES).");
        await sendToModule("PROD", "✅ Teste: envio para PRODUÇÃO (PROD).");
        await sendToModule("FIN", "✅ Teste: envio para FINANCEIRO (FIN).");
        await sendToModule("BUY", "✅ Teste: envio para COMPRAS (BUY).");
        await sendToModule("REPORTS", "✅ Teste: envio para RELATÓRIOS (REPORTS).");
        await tgSendMessage(chatId, "Enviei testes para os grupos (ou para você, se não estiver configurado).");
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    // ---------- MENSAGENS ----------
    if (body.message) {
      const msg = body.message;
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      if (!isAdmin(userId)) return res.sendStatus(200);

      const text = (msg.text || "").trim();

      // comandos básicos
      if (text === "/start" || text === "/menu" || text.toLowerCase() === "menu") {
        await clearState(chatId);
        await showMainMenu(chatId);
        return res.sendStatus(200);
      }

      // ✅ não analisar prints/imagens
      if (msg.photo || msg.sticker) {
        await tgSendMessage(chatId, "📎 Por enquanto eu não analiso prints/imagens. Envie o arquivo (PDF/XLSX/TXT/CSV) que eu leio.");
        return res.sendStatus(200);
      }

      // documentos (arquivos)
      if (msg.document) {
        const fileId = msg.document.file_id;
        const filename = msg.document.file_name || `arquivo_${fileId}`;

        try {
          const file = await tgGetFile(fileId);
          if (!file?.file_path) throw new Error("file_path ausente");

          const buf = await downloadTelegramFile(file.file_path);
          const extracted = await extractTextFromFile(filename, buf);

          await saveMessage({
            channel: "telegram",
            chat_id: chatId,
            user_id: userId,
            direction: "in",
            text: `[DOC:${filename}] ${extracted.slice(0, 2000)}`,
            meta: { fileId, filename, size: msg.document.file_size || null },
          });

          // B3: tentar identificar cliente primeiro
          const clientHit = await findClientFromText(extracted);

          const cls = await classifyDocumentText(extracted);
          const title = `Arquivo recebido: ${filename}\nClassificação: ${cls.kind} (${Math.round((cls.confidence || 0) * 100)}%)`;

          // D1: se não tiver confiança -> sugerir destinos
          if (cls.kind === "UNKNOWN" || (cls.confidence || 0) < 0.55) {
            await setState(chatId, "ROUTE_SUGGEST", "file", {
              title: "Arquivo (precisa direcionar)",
              text: `${title}\n\nTrecho:\n${extracted.slice(0, 2500)}`,
            });
            await tgSendMessage(chatId, `${title}\n\nNão tenho certeza. Para qual área você quer enviar?`, KB_ROUTE_SUGGEST());
            return res.sendStatus(200);
          }

          // envio por módulo
          if (cls.kind === "SALES") {
            await sendToModule("SALES", `📎 <b>${title}</b>\n\n${clientHit ? `Cliente identificado: <b>${clientHit.nome || "-"}</b> (${clientHit.contato || "-"})\n` : ""}\n${extracted.slice(0, 3000)}`);
            await tgSendMessage(chatId, "✅ Enviei para Vendas.");
            return res.sendStatus(200);
          }

          if (cls.kind === "FIN") {
            await sendToModule("FIN", `📎 <b>${title}</b>\n\n${clientHit ? `Cliente identificado: <b>${clientHit.nome || "-"}</b> (${clientHit.contato || "-"})\n` : ""}\n${extracted.slice(0, 3000)}`);
            await tgSendMessage(chatId, "✅ Enviei para Financeiro.");
            return res.sendStatus(200);
          }

          if (cls.kind === "BUY") {
            await sendToModule("BUY", `📎 <b>${title}</b>\n\n${clientHit ? `Cliente identificado: <b>${clientHit.nome || "-"}</b> (${clientHit.contato || "-"})\n` : ""}\n${extracted.slice(0, 3000)}`);
            await tgSendMessage(chatId, "✅ Enviei para Compras.");
            return res.sendStatus(200);
          }

          if (cls.kind === "PROD" || cls.kind === "ORDERS") {
            await sendToModule("PROD", `📎 <b>${title}</b>\n\n${clientHit ? `Cliente identificado: <b>${clientHit.nome || "-"}</b> (${clientHit.contato || "-"})\n` : ""}\n${extracted.slice(0, 3000)}`);
            await tgSendMessage(chatId, "✅ Enviei para Produção.");
            return res.sendStatus(200);
          }

          await tgSendMessage(chatId, "Arquivo recebido, mas não consegui direcionar.");
          return res.sendStatus(200);
        } catch (e) {
          console.error("Erro doc:", e);
          await tgSendMessage(chatId, `Erro ao ler arquivo: ${String(e.message || e)}`);
          return res.sendStatus(200);
        }
      }

      // fluxo por estado
      const st = await getState(chatId);

      // ====== Chat IA ======
      if (st.mode === "AI_CHAT") {
        const ctx = await buildContextSummary();
        const mem = await getAiMemory(chatId);

        const prompt =
          `Você é um diretor administrativo e vendedor estratégico.\n` +
          `Responda com clareza, propondo ações.\n` +
          `Sem web.\n\n` +
          `MEMÓRIA:\n${mem.summary || "(vazio)"}\n\n` +
          `CONTEXTO(JSON):\n${JSON.stringify(ctx, null, 2)}\n\n` +
          `MENSAGEM DO DONO:\n${text}`;

        const ans = await openaiAsk({ input: prompt, previous_response_id: mem.previous_response_id });

        if (ans.ok) {
          // atualiza memória (resumo simples)
          const newSummary = (mem.summary ? mem.summary + "\n" : "") + `Dono: ${text}\nIA: ${ans.text}`.slice(0, 4000);
          await setAiMemory(chatId, { previous_response_id: ans.previous_response_id, summary: newSummary });
          await tgSendMessage(chatId, ans.text, KB_AI_CHAT());
        } else {
          await tgSendMessage(chatId, ans.text, KB_AI_CHAT());
        }
        return res.sendStatus(200);
      }

      // ====== SEARCH ======
      if (st.mode === "SEARCH") {
        const kind = st.step;
        const q = text;
        const isId = /^\d+$/.test(q);

        if (kind === "order") {
          let rows = [];
          if (isId) {
            rows = (await dbQuery(`SELECT * FROM orders WHERE id=$1`, [Number(q)])).rows;
          } else {
            rows = (await dbQuery(`
              SELECT * FROM orders
              WHERE nome ILIKE $1 OR contato ILIKE $1
              ORDER BY id DESC
              LIMIT 20
            `, [`%${q}%`])).rows;
          }

          if (!rows.length) {
            await tgSendMessage(chatId, "Nenhum pedido encontrado.");
          } else {
            let txt = `🔎 <b>Resultados (Pedidos)</b>\n\n`;
            for (const p of rows) {
              const f = await orderFinancial(p.id);
              const fin = f ? ` | ${f.status} (${moneyBR(f.paid)}/${moneyBR(f.total)})` : "";
              txt += `#${p.id} - ${p.nome || "Sem nome"} - ${moneyBR(p.valor)}\nProd: ${p.status_producao}${fin}\n\n`;
            }
            await tgSendMessage(chatId, txt);
          }
        } else if (kind === "deal") {
          let rows = [];
          if (isId) {
            rows = (await dbQuery(`SELECT * FROM deals WHERE id=$1`, [Number(q)])).rows;
          } else {
            rows = (await dbQuery(`
              SELECT * FROM deals
              WHERE nome ILIKE $1 OR contato ILIKE $1
              ORDER BY updated_at DESC
              LIMIT 20
            `, [`%${q}%`])).rows;
          }

          if (!rows.length) {
            await tgSendMessage(chatId, "Nenhuma venda encontrada.");
          } else {
            for (const d of rows) {
              let txt = `🔎 <b>Venda #${d.id}</b>\n\n`;
              txt += `Nome: <b>${d.nome || "Sem nome"}</b>\n`;
              txt += `Contato: ${d.contato || "-"}\n`;
              txt += `Etapa: <b>${d.etapa}</b>\n`;
              txt += `Origem: ${d.origem}\n`;
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
        } else if (kind === "buy") {
          let rows = [];
          if (isId) {
            rows = (await dbQuery(`SELECT * FROM purchases WHERE id=$1`, [Number(q)])).rows;
          } else {
            rows = (await dbQuery(`
              SELECT * FROM purchases
              WHERE client_name ILIKE $1 OR item_code ILIKE $1 OR item_desc ILIKE $1
              ORDER BY created_at DESC
              LIMIT 20
            `, [`%${q}%`])).rows;
          }
          if (!rows.length) await tgSendMessage(chatId, "Nada encontrado.");
          else {
            let txt = `🔎 <b>Compras</b>\n\n`;
            for (const r of rows) {
              txt += `#${r.id} - ${r.client_name || "-"} | ${r.item_type} | ${r.item_code || "-"}\n`;
              txt += `${r.item_desc || "-"}\nStatus: <b>${r.status}</b>\nTotal: ${moneyBR(r.total_value || 0)}\n\n`;
            }
            await tgSendMessage(chatId, txt);
          }
        }

        await clearState(chatId);
        return res.sendStatus(200);
      }

      // ====== SET STATUS ======
      if (st.mode === "SET_STATUS" && st.step === "ask_id") {
        const id = Number(text);
        if (!id) { await tgSendMessage(chatId, "ID inválido. Digite apenas número."); return res.sendStatus(200); }
        const o = (await dbQuery(`SELECT id, nome, status_producao FROM orders WHERE id=$1`, [id])).rows[0];
        if (!o) { await tgSendMessage(chatId, "Pedido não encontrado."); return res.sendStatus(200); }
        await setState(chatId, "SET_STATUS", "choose", { order_id: id });
        await tgSendMessage(chatId, `Pedido #${id} (${o.nome || "Sem nome"})\nStatus atual: <b>${o.status_producao}</b>\n\nEscolha o novo status:`, KB_STATUS());
        return res.sendStatus(200);
      }

      // ====== PAY WIZ ======
      if (st.mode === "PAY_WIZ") {
        const payload = st.payload || {};
        if (st.step === "order_id") {
          const id = Number(text);
          if (!id) { await tgSendMessage(chatId, "ID inválido."); return res.sendStatus(200); }
          const o = (await dbQuery(`SELECT id, nome, valor FROM orders WHERE id=$1`, [id])).rows[0];
          if (!o) { await tgSendMessage(chatId, "Pedido não encontrado."); return res.sendStatus(200); }
          payload.order_id = id;
          await setState(chatId, "PAY_WIZ", "method", payload);
          await tgSendMessage(chatId, `Pedido #${id} (${o.nome || "Sem nome"})\nTotal: <b>${moneyBR(o.valor)}</b>\n\nEscolha o método:`, KB_PAY_METHOD());
          return res.sendStatus(200);
        }
        if (st.step === "valor") {
          const v = Number(text.replace(",", "."));
          if (!v || v <= 0) { await tgSendMessage(chatId, "Valor inválido."); return res.sendStatus(200); }

          const orderId = Number(payload.order_id);
          const metodo = payload.metodo || "N/A";

          await dbQuery(`INSERT INTO payments(order_id, valor, metodo, observacao) VALUES($1,$2,$3,$4)`, [orderId, v, metodo, payload.observacao || null]);
          await dbQuery(`UPDATE orders SET updated_at=now() WHERE id=$1`, [orderId]);

          await logEvent("payment_added", "order", orderId, { valor: v, metodo });
          const f = await orderFinancial(orderId);

          await clearState(chatId);
          await tgSendMessage(chatId, `✅ Pagamento registrado.\nPedido #${orderId}\nMétodo: ${metodo}\nPago: ${moneyBR(f.paid)} / ${moneyBR(f.total)}\nStatus: <b>${f.status}</b>`);
          return res.sendStatus(200);
        }
        await tgSendMessage(chatId, "Use os botões para escolher o método.");
        return res.sendStatus(200);
      }

      // ====== DEAL WIZ ======
      if (st.mode === "DEAL_WIZ") {
        const data = st.payload || {};
        if (st.step === "nome") { data.nome = text; await setState(chatId, "DEAL_WIZ", "contato", data); await tgSendMessage(chatId, "Digite o <b>CONTATO</b> (telefone):"); return res.sendStatus(200); }
        if (st.step === "contato") { data.contato = text; await setState(chatId, "DEAL_WIZ", "endereco", data); await tgSendMessage(chatId, "Digite o <b>ENDEREÇO</b> (ou '-' se não tiver):"); return res.sendStatus(200); }
        if (st.step === "endereco") { data.endereco = text === "-" ? null : text; await setState(chatId, "DEAL_WIZ", "descricao", data); await tgSendMessage(chatId, "Digite a <b>DESCRIÇÃO</b> / pedido do cliente:"); return res.sendStatus(200); }
        if (st.step === "descricao") { data.descricao = text; await setState(chatId, "DEAL_WIZ", "valor", data); await tgSendMessage(chatId, "Digite o <b>VALOR ESTIMADO</b> (ou 0 se não souber):"); return res.sendStatus(200); }
        if (st.step === "valor") { data.valor_estimado = Number(text.replace(",", ".")) || 0; await setState(chatId, "DEAL_WIZ", "obs", data); await tgSendMessage(chatId, "Digite <b>OBSERVAÇÕES</b> (ou '-' para pular):"); return res.sendStatus(200); }
        if (st.step === "obs") {
          data.observacoes = text === "-" ? null : text;
          const r = await dbQuery(`
            INSERT INTO deals(nome, contato, endereco, descricao, observacoes, valor_estimado, etapa, origem, updated_at)
            VALUES($1,$2,$3,$4,$5,$6,'Lead novo','manual', now())
            RETURNING id
          `, [data.nome, data.contato, data.endereco, data.descricao, data.observacoes, data.valor_estimado]);

          const dealId = r.rows[0].id;
          await logEvent("deal_created", "deal", dealId, data);
          await clearState(chatId);

          await tgSendMessage(
            chatId,
            `✅ Venda criada!\n<b>Lead #${dealId}</b>\nEtapa: <b>Lead novo</b>\n\nQuer marcar etapa agora?`,
            kb([
              [{ text: "📨 Orçamento enviado", callback_data: `D:SET:${dealId}:Orçamento enviado` }],
              [{ text: "🟡 Negociação", callback_data: `D:SET:${dealId}:Negociação` }],
              [{ text: "➡️ Converter em Pedido", callback_data: `D:TO_ORDER:${dealId}` }],
              [{ text: "⬅️ Voltar", callback_data: "M:MAIN" }],
            ])
          );

          await sendToModule("SALES", `💰 <b>Nova venda</b>\nLead #${dealId}\nCliente: <b>${data.nome}</b>\nContato: ${data.contato}\nDescrição: ${data.descricao}\nValor: <b>${moneyBR(data.valor_estimado)}</b>`);
          return res.sendStatus(200);
        }
      }

      // ====== ORDER WIZ ======
      if (st.mode === "ORDER_WIZ") {
        const data = st.payload || {};

        if (st.step === "nome") { data.nome = text; await setState(chatId, "ORDER_WIZ", "contato", data); await tgSendMessage(chatId, "Digite o <b>CONTATO</b>:"); return res.sendStatus(200); }
        if (st.step === "contato") { data.contato = text; await setState(chatId, "ORDER_WIZ", "endereco", data); await tgSendMessage(chatId, "Digite o <b>ENDEREÇO</b>:"); return res.sendStatus(200); }
        if (st.step === "endereco") { data.endereco = text; await setState(chatId, "ORDER_WIZ", "descricao", data); await tgSendMessage(chatId, "Digite a <b>DESCRIÇÃO</b> do pedido:"); return res.sendStatus(200); }
        if (st.step === "descricao") { data.descricao = text; await setState(chatId, "ORDER_WIZ", "obs", data); await tgSendMessage(chatId, "Digite <b>OBSERVAÇÕES</b> (ou '-' para pular):"); return res.sendStatus(200); }
        if (st.step === "obs") { data.observacoes = text === "-" ? null : text; await setState(chatId, "ORDER_WIZ", "valor", data); await tgSendMessage(chatId, "Digite o <b>VALOR</b> (ex: 1700 ou 1700,00):"); return res.sendStatus(200); }

        if (st.step === "valor") {
          const v = Number(text.replace(",", "."));
          if (!v || v <= 0) { await tgSendMessage(chatId, "Valor inválido."); return res.sendStatus(200); }
          data.valor = v;
          await setState(chatId, "ORDER_WIZ", "data_buscar", data);
          await tgSendMessage(chatId, "Digite a <b>DATA DE BUSCAR</b> (DD/MM/AAAA ou YYYY-MM-DD) ou '-' para pular:");
          return res.sendStatus(200);
        }

        if (st.step === "data_buscar") {
          if (text === "-") data.data_buscar = null;
          else {
            const iso = parseDateToISO(text);
            if (!iso) { await tgSendMessage(chatId, "Data inválida. Use DD/MM/AAAA."); return res.sendStatus(200); }
            data.data_buscar = iso;
          }
          await setState(chatId, "ORDER_WIZ", "data_entregar", data);
          await tgSendMessage(chatId, "Digite a <b>DATA DE ENTREGAR</b> (DD/MM/AAAA ou YYYY-MM-DD) ou '-' para pular:");
          return res.sendStatus(200);
        }

        if (st.step === "data_entregar") {
          if (text === "-") data.data_entregar = null;
          else {
            const iso = parseDateToISO(text);
            if (!iso) { await tgSendMessage(chatId, "Data inválida. Use DD/MM/AAAA."); return res.sendStatus(200); }
            data.data_entregar = iso;
          }

          await setState(chatId, "ORDER_WIZ", "confirm", data);

          const preview =
            `🧾 <b>Confirme o Pedido</b>\n\n` +
            `Cliente: <b>${data.nome}</b>\n` +
            `Contato: ${data.contato}\n` +
            `Endereço: ${data.endereco}\n` +
            `Descrição: ${data.descricao}\n` +
            `Obs: ${data.observacoes || "-"}\n` +
            `Valor: <b>${moneyBR(data.valor)}</b>\n` +
            `Buscar: ${data.data_buscar || "-"}\n` +
            `Entregar: ${data.data_entregar || "-"}\n\n` +
            `Salvar?`;

          await tgSendMessage(chatId, preview, KB_CONFIRM("O:CONFIRM:YES", "O:CONFIRM:NO"));
          return res.sendStatus(200);
        }

        if (st.step === "confirm") {
          await tgSendMessage(chatId, "Use os botões ✅ SIM / ❌ NÃO.");
          return res.sendStatus(200);
        }
      }

      // ====== PROD ALERT WIZ ======
      if (st.mode === "PROD_ALERT_WIZ") {
        const data = st.payload || {};
        if (st.step === "order_id") {
          const id = Number(text);
          if (!id) { await tgSendMessage(chatId, "ID inválido."); return res.sendStatus(200); }
          const o = (await dbQuery(`SELECT id, nome FROM orders WHERE id=$1`, [id])).rows[0];
          if (!o) { await tgSendMessage(chatId, "Pedido não encontrado."); return res.sendStatus(200); }
          data.order_id = id;
          await setState(chatId, "PROD_ALERT_WIZ", "type", data);
          await tgSendMessage(chatId, `Pedido #${id} (${o.nome || "-"})\nTipo do alerta? (ex: faltou_tecido / faltou_espuma / faltou_madeira / outro)`);
          return res.sendStatus(200);
        }
        if (st.step === "type") {
          data.alert_type = text.trim().slice(0, 40);
          await setState(chatId, "PROD_ALERT_WIZ", "msg", data);
          await tgSendMessage(chatId, "Mensagem do alerta (detalhes do que faltou):");
          return res.sendStatus(200);
        }
        if (st.step === "msg") {
          data.message = text.trim().slice(0, 1000);
          await dbQuery(`INSERT INTO prod_alerts(order_id, alert_type, message) VALUES($1,$2,$3)`, [data.order_id, data.alert_type, data.message]);
          await logEvent("prod_alert_created", "order", data.order_id, data);
          await clearState(chatId);

          await tgSendMessage(chatId, "✅ Alerta criado e enviado ao ADM.");
          await tgSendMessage(ADMIN_ID, `🚨 <b>ALERTA PRODUÇÃO</b>\nPedido #${data.order_id}\nTipo: <b>${data.alert_type}</b>\n${data.message}`);
          return res.sendStatus(200);
        }
      }

      // ====== PROD CHECKLIST WIZ ======
      if (st.mode === "PROD_CHECK_WIZ") {
        const data = st.payload || {};
        if (st.step === "order_id") {
          const id = Number(text);
          if (!id) { await tgSendMessage(chatId, "ID inválido."); return res.sendStatus(200); }
          const o = (await dbQuery(`SELECT id, nome FROM orders WHERE id=$1`, [id])).rows[0];
          if (!o) { await tgSendMessage(chatId, "Pedido não encontrado."); return res.sendStatus(200); }
          data.order_id = id;
          await setState(chatId, "PROD_CHECK_WIZ", "item", data);
          await tgSendMessage(chatId, `Pedido #${id} (${o.nome || "-"})\nDigite um item do checklist (ex: “costura ok”, “tecido conferido”, “espuma ok”).\nQuando terminar, digite: <b>fim</b>`);
          return res.sendStatus(200);
        }
        if (st.step === "item") {
          const t = text.trim();
          if (t.toLowerCase() === "fim") {
            await clearState(chatId);
            await tgSendMessage(chatId, "✅ Checklist salvo.");
            return res.sendStatus(200);
          }
          if (t.length < 2) { await tgSendMessage(chatId, "Item muito curto."); return res.sendStatus(200); }
          await dbQuery(`INSERT INTO prod_checklist(order_id, item, done) VALUES($1,$2,false)`, [data.order_id, t.slice(0, 200)]);
          await tgSendMessage(chatId, `➕ Adicionado: ${t}`);
          return res.sendStatus(200);
        }
      }

      // ====== BUY WIZ ======
      if (st.mode === "BUY_WIZ") {
        const data = st.payload || {};
        if (st.step === "client_name") {
          data.client_name = text === "-" ? null : text;
          await setState(chatId, "BUY_WIZ", "item_code", data);
          await tgSendMessage(chatId, "Código do tecido/insumo (ou '-' se não tiver):");
          return res.sendStatus(200);
        }
        if (st.step === "item_code") {
          data.item_code = text === "-" ? null : text;
          await setState(chatId, "BUY_WIZ", "item_desc", data);
          await tgSendMessage(chatId, "Descrição do item (ex: “Valência 108 listrado bege e cru”):");
          return res.sendStatus(200);
        }
        if (st.step === "item_desc") {
          data.item_desc = text;
          await setState(chatId, "BUY_WIZ", "unit_value", data);
          await tgSendMessage(chatId, "Valor unitário (ex: 120 ou 120,00). Se não souber, digite 0:");
          return res.sendStatus(200);
        }
        if (st.step === "unit_value") {
          data.unit_value = Number(text.replace(",", ".")) || 0;
          await setState(chatId, "BUY_WIZ", "qty", data);
          await tgSendMessage(chatId, "Quantidade (ex: 2 ou 2,5). Se não souber, digite 1:");
          return res.sendStatus(200);
        }
        if (st.step === "qty") {
          data.qty = Number(text.replace(",", ".")) || 1;
          const total = Number(data.unit_value || 0) * Number(data.qty || 1);
          data.total_value = total;
          await dbQuery(`
            INSERT INTO purchases(client_name, item_type, item_code, item_desc, unit_value, qty, total_value, status)
            VALUES($1,'tecido',$2,$3,$4,$5,$6,'A comprar')
          `, [data.client_name, data.item_code, data.item_desc, data.unit_value, data.qty, data.total_value]);
          await logEvent("purchase_created", "buy", "new", data);
          await clearState(chatId);

          await tgSendMessage(chatId, `✅ Compra registrada.\nCliente: ${data.client_name || "-"}\nCódigo: ${data.item_code || "-"}\nTotal: <b>${moneyBR(data.total_value)}</b>`);
          await sendToModule("BUY", `🧾 <b>Novo item para comprar</b>\nCliente: <b>${data.client_name || "-"}</b>\nCódigo: <b>${data.item_code || "-"}</b>\nDesc: ${data.item_desc}\nTotal: <b>${moneyBR(data.total_value)}</b>\nStatus: <b>A comprar</b>`);
          return res.sendStatus(200);
        }
      }

      // fallback
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
app.get("/", (req, res) => res.send("Bot ERP (Postgres) rodando"));
app.get("/health", async (req, res) => {
  try {
    await dbQuery("SELECT 1");
    res.json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: String(e) });
  }
});

// (opcional) endpoint para upload externo no futuro
app.post("/upload", upload.single("file"), async (req, res) => {
  res.status(501).json({ ok: false, msg: "Endpoint reservado. Use envio de documento no Telegram." });
});

// ===================== START =====================
(async () => {
  await ensureSchema();

  app.listen(PORT, () => {
    console.log("Servidor rodando na porta", PORT);
    console.log("Telegram webhook: POST /webhook");
    console.log("DB: Postgres OK");
    console.log("PUBLIC_BASE_URL:", PUBLIC_BASE_URL || "(vazio)");
  });
})();
