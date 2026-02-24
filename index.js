const express = require("express");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

// =====================
// 1) CONFIG
// =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("ERRO: BOT_TOKEN não encontrado. Configure no Render (Environment).");
  process.exit(1);
}

const ADMIN_ID = Number(process.env.TELEGRAM_ADMIN_ID || 0);
if (!ADMIN_ID) {
  console.error("ERRO: TELEGRAM_ADMIN_ID não encontrado. Configure no Render (Environment).");
  process.exit(1);
}

const PORT = process.env.PORT || 3000;

// Render normalmente define RENDER="true"
const isRender = !!process.env.RENDER;

// Banco: Render usa /tmp (pode apagar ao reiniciar). Local usa ./db
const dbPath = isRender
  ? path.join("/tmp", "bot.db")
  : path.join(__dirname, "db", "bot.db");

if (!isRender) {
  const dbDir = path.join(__dirname, "db");
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// =====================
// 2) DB SCHEMA
// =====================
db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT,
  contato TEXT,
  endereco TEXT,
  descricao TEXT,
  valor REAL,
  data_buscar TEXT,      -- ISO: YYYY-MM-DD
  data_entregar TEXT,    -- ISO: YYYY-MM-DD
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

CREATE TABLE IF NOT EXISTS order_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  event_type TEXT,
  old_value TEXT,
  new_value TEXT,
  meta_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS wizard_state (
  chat_id INTEGER PRIMARY KEY,
  state TEXT,
  payload_json TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
`);

// =====================
// 3) HELPERS (Telegram)
// =====================
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tg(method, payload) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    console.error("Telegram API error:", method, data);
  }
  return data;
}

async function tgSendMessage(chatId, text, extra = {}) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra,
  });
}

async function tgAnswerCallbackQuery(callbackQueryId) {
  return tg("answerCallbackQuery", { callback_query_id: callbackQueryId });
}

// =====================
// 4) HELPERS (Wizard / Data)
// =====================
function isAdmin(msgOrChatId) {
  // msgOrChatId pode ser msg (com msg.from.id) ou um chatId
  return true; // segurança será checada no webhook pela msg.from.id
}

function setWizard(chatId, state, payload = {}) {
  const stmt = db.prepare(`
    INSERT INTO wizard_state(chat_id, state, payload_json, updated_at)
    VALUES(?, ?, ?, datetime('now'))
    ON CONFLICT(chat_id) DO UPDATE SET
      state=excluded.state,
      payload_json=excluded.payload_json,
      updated_at=datetime('now')
  `);
  stmt.run(chatId, state, JSON.stringify(payload));
}

function getWizard(chatId) {
  const row = db.prepare(`SELECT state, payload_json FROM wizard_state WHERE chat_id=?`).get(chatId);
  if (!row) return { state: "NONE", payload: {} };
  let payload = {};
  try { payload = row.payload_json ? JSON.parse(row.payload_json) : {}; } catch { payload = {}; }
  return { state: row.state || "NONE", payload };
}

function clearWizard(chatId) {
  db.prepare(`DELETE FROM wizard_state WHERE chat_id=?`).run(chatId);
}

function parseBRDateToISO(s) {
  // aceita DD/MM/AAAA ou YYYY-MM-DD
  if (!s) return null;
  const t = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [_, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatMoney(v) {
  const n = Number(v || 0);
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function orderFinancialStatus(orderId) {
  const order = db.prepare(`SELECT valor FROM orders WHERE id=?`).get(orderId);
  if (!order) return null;
  const paid = db.prepare(`SELECT COALESCE(SUM(valor),0) as s FROM payments WHERE order_id=?`).get(orderId).s;
  const total = Number(order.valor || 0);
  if (paid <= 0) return { paid, total, status: "PENDENTE" };
  if (paid + 0.00001 < total) return { paid, total, status: "PARCIAL" };
  return { paid, total, status: "PAGO" };
}

// =====================
// 5) KEYBOARDS
// =====================
function menuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📦 Pedidos", callback_data: "menu_pedidos" },
        { text: "📆 Agenda", callback_data: "menu_agenda" }
      ],
      [
        { text: "🏭 Produção", callback_data: "menu_producao" },
        { text: "💰 Financeiro", callback_data: "menu_financeiro" }
      ],
      [
        { text: "📊 Relatórios", callback_data: "menu_relatorios" },
        { text: "⚙️ Sistema", callback_data: "menu_sistema" }
      ]
    ]
  };
}

function pedidosKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "➕ Criar Pedido", callback_data: "ped_criar" }],
      [{ text: "📋 Ver Pedidos (20)", callback_data: "ped_listar20" }],
      [{ text: "🔎 Buscar (ID/Nome/Contato)", callback_data: "ped_buscar" }],
      [{ text: "🏷️ Atualizar Status (guiado)", callback_data: "ped_status" }],
      [{ text: "⬅️ Voltar", callback_data: "menu_principal" }],
    ],
  };
}

function agendaKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📦 Buscas Hoje", callback_data: "ag_busca_hoje" }, { text: "🚚 Entregas Hoje", callback_data: "ag_entrega_hoje" }],
      [{ text: "⏱️ Atrasados", callback_data: "ag_atrasados" }],
      [{ text: "⬅️ Voltar", callback_data: "menu_principal" }],
    ],
  };
}

function producaoKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🧵 Aguardando", callback_data: "pr_status:Aguardando produção" }],
      [{ text: "⚙️ Em produção", callback_data: "pr_status:Em produção" }],
      [{ text: "✅ Prontos", callback_data: "pr_status:Pronto" }],
      [{ text: "🚚 Entregues", callback_data: "pr_status:Entregue" }],
      [{ text: "⚠️ Problemas", callback_data: "pr_status:Problema" }],
      [{ text: "⬅️ Voltar", callback_data: "menu_principal" }],
    ],
  };
}

function financeiroKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "💵 Registrar Pagamento", callback_data: "fin_pagar" }],
      [{ text: "🧾 Pendentes", callback_data: "fin_pend" }, { text: "🟡 Parciais", callback_data: "fin_part" }],
      [{ text: "✅ Pagos", callback_data: "fin_pago" }],
      [{ text: "📊 Caixa do Dia", callback_data: "fin_caixa_hoje" }],
      [{ text: "✅ Fechar Dia", callback_data: "fin_fechar_dia" }],
      [{ text: "⬅️ Voltar", callback_data: "menu_principal" }],
    ],
  };
}

function confirmKeyboard(yesData, noData) {
  return {
    inline_keyboard: [
      [{ text: "✅ SIM", callback_data: yesData }, { text: "❌ NÃO", callback_data: noData }],
    ],
  };
}

function statusSetKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🧵 Aguardando produção", callback_data: "set_status:Aguardando produção" }],
      [{ text: "⚙️ Em produção", callback_data: "set_status:Em produção" }],
      [{ text: "✅ Pronto", callback_data: "set_status:Pronto" }],
      [{ text: "🚚 Entregue", callback_data: "set_status:Entregue" }],
      [{ text: "⚠️ Problema", callback_data: "set_status:Problema" }],
      [{ text: "⬅️ Cancelar", callback_data: "menu_principal" }],
    ],
  };
}

function payMethodKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Pix", callback_data: "pay_method:Pix" }, { text: "Dinheiro", callback_data: "pay_method:Dinheiro" }],
      [{ text: "Cartão", callback_data: "pay_method:Cartão" }, { text: "Transferência", callback_data: "pay_method:Transferência" }],
      [{ text: "⬅️ Cancelar", callback_data: "menu_principal" }],
    ],
  };
}

// =====================
// 6) APP / WEBHOOK
// =====================
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("OK"));

app.post("/webhook", async (req, res) => {
  const body = req.body;

  try {
    // -------- Callback buttons --------
    if (body.callback_query) {
      const q = body.callback_query;
      const chatId = q.message.chat.id;
      const userId = q.from.id;
      const data = q.data;

      await tgAnswerCallbackQuery(q.id);

      if (userId !== ADMIN_ID) {
        await tgSendMessage(chatId, "Acesso negado.");
        return res.sendStatus(200);
      }

      // Navegação principal
      if (data === "menu_principal") {
        await tgSendMessage(chatId, "Painel Administrativo:", { reply_markup: menuKeyboard() });
        return res.sendStatus(200);
      }
      if (data === "menu_pedidos") {
        await tgSendMessage(chatId, "📦 PEDIDOS", { reply_markup: pedidosKeyboard() });
        return res.sendStatus(200);
      }
      if (data === "menu_agenda") {
        await tgSendMessage(chatId, "📆 AGENDA", { reply_markup: agendaKeyboard() });
        return res.sendStatus(200);
      }
      if (data === "menu_producao") {
        await tgSendMessage(chatId, "🏭 PRODUÇÃO", { reply_markup: producaoKeyboard() });
        return res.sendStatus(200);
      }
      if (data === "menu_financeiro") {
        await tgSendMessage(chatId, "💰 FINANCEIRO", { reply_markup: financeiroKeyboard() });
        return res.sendStatus(200);
      }
      if (data === "menu_relatorios") {
        await tgSendMessage(chatId, "📊 RELATÓRIOS\n\n(Em seguida ligamos hoje/semana/mês/ranking)", { reply_markup: menuKeyboard() });
        return res.sendStatus(200);
      }
      if (data === "menu_sistema") {
        await tgSendMessage(chatId, "⚙️ SISTEMA\n\n(Depois ligamos export CSV / resumo geral)", { reply_markup: menuKeyboard() });
        return res.sendStatus(200);
      }

      // PEDIDOS
      if (data === "ped_criar") {
        clearWizard(chatId);
        setWizard(chatId, "CREATE_NOME", {});
        await tgSendMessage(chatId, "➕ Criar Pedido\n\nDigite o <b>NOME</b> do cliente:");
        return res.sendStatus(200);
      }

      if (data === "ped_listar20") {
        const rows = db.prepare(`
          SELECT id, nome, descricao, valor, data_entregar, status_producao
          FROM orders
          ORDER BY id DESC
          LIMIT 20
        `).all();

        if (!rows.length) {
          await tgSendMessage(chatId, "Nenhum pedido encontrado.");
          return res.sendStatus(200);
        }

        const txt = rows.map(r =>
          `#${r.id} • ${r.nome}\n${r.descricao}\n${formatMoney(r.valor)} • Entrega: ${r.data_entregar || "-"} • ${r.status_producao}\n`
        ).join("\n");

        await tgSendMessage(chatId, "📋 Últimos 20 pedidos:\n\n" + txt);
        return res.sendStatus(200);
      }

      if (data === "ped_buscar") {
        setWizard(chatId, "SEARCH_QUERY", {});
        await tgSendMessage(chatId, "🔎 Buscar Pedido\n\nEnvie:\n- <b>ID</b> (ex: 12)\nOU\n- <b>Nome</b>\nOU\n- <b>Contato</b>");
        return res.sendStatus(200);
      }

      if (data === "ped_status") {
        setWizard(chatId, "STATUS_WAIT_ID", {});
        await tgSendMessage(chatId, "🏷️ Atualizar Status\n\nDigite o <b>ID</b> do pedido:");
        return res.sendStatus(200);
      }

      if (data.startsWith("set_status:")) {
        const { state, payload } = getWizard(chatId);
        if (state !== "STATUS_CHOOSE" || !payload.orderId) {
          await tgSendMessage(chatId, "Não achei o pedido em edição. Clique em: Pedidos > Atualizar Status.");
          return res.sendStatus(200);
        }
        const newStatus = data.split(":").slice(1).join(":");
        const orderId = Number(payload.orderId);

        const old = db.prepare(`SELECT status_producao FROM orders WHERE id=?`).get(orderId);
        if (!old) {
          await tgSendMessage(chatId, "Pedido não encontrado.");
          clearWizard(chatId);
          return res.sendStatus(200);
        }

        db.prepare(`UPDATE orders SET status_producao=? WHERE id=?`).run(newStatus, orderId);
        db.prepare(`
          INSERT INTO order_history(order_id, event_type, old_value, new_value, meta_json)
          VALUES(?, 'STATUS_CHANGED', ?, ?, ?)
        `).run(orderId, old.status_producao, newStatus, JSON.stringify({ by: "ADMIN" }));

        clearWizard(chatId);
        await tgSendMessage(chatId, `✅ Status atualizado!\nPedido #${orderId}\n<b>${old.status_producao}</b> ➜ <b>${newStatus}</b>`);
        return res.sendStatus(200);
      }

      // Confirmação do pedido
      if (data === "order_confirm_yes") {
        const { state, payload } = getWizard(chatId);
        if (state !== "CREATE_CONFIRM") {
          await tgSendMessage(chatId, "Nada para confirmar.");
          return res.sendStatus(200);
        }

        const ins = db.prepare(`
          INSERT INTO orders (nome, contato, endereco, descricao, valor, data_buscar, data_entregar, status_producao)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const info = ins.run(
          payload.nome || "",
          payload.contato || "",
          payload.endereco || "",
          payload.descricao || "",
          Number(payload.valor || 0),
          payload.data_buscar || null,
          payload.data_entregar || null,
          "Aguardando produção"
        );

        const orderId = info.lastInsertRowid;

        db.prepare(`
          INSERT INTO order_history(order_id, event_type, old_value, new_value, meta_json)
          VALUES(?, 'ORDER_CREATED', '', 'created', ?)
        `).run(orderId, JSON.stringify(payload));

        clearWizard(chatId);
        await tgSendMessage(chatId, `✅ Pedido criado com sucesso! ID: <b>#${orderId}</b>\n\nAbra /menu para continuar.`);
        return res.sendStatus(200);
      }

      if (data === "order_confirm_no") {
        clearWizard(chatId);
        await tgSendMessage(chatId, "❌ Criação cancelada. /menu");
        return res.sendStatus(200);
      }

      // FINANCEIRO
      if (data === "fin_pagar") {
        clearWizard(chatId);
        setWizard(chatId, "PAY_WAIT_ID", {});
        await tgSendMessage(chatId, "💵 Registrar Pagamento\n\nDigite o <b>ID</b> do pedido:");
        return res.sendStatus(200);
      }

      if (data.startsWith("pay_method:")) {
        const method = data.split(":").slice(1).join(":");
        const { state, payload } = getWizard(chatId);
        if (state !== "PAY_WAIT_METHOD") {
          await tgSendMessage(chatId, "Não estou no passo de método. Comece em Financeiro > Registrar Pagamento.");
          return res.sendStatus(200);
        }
        payload.metodo = method;
        setWizard(chatId, "PAY_WAIT_NOTE", payload);
        await tgSendMessage(chatId, "Observação (opcional). Se não quiser, envie apenas: <b>-</b>");
        return res.sendStatus(200);
      }

      if (data === "fin_pend" || data === "fin_part" || data === "fin_pago") {
        // Mostra lista simples por status financeiro
        const all = db.prepare(`
          SELECT id, nome, descricao, valor
          FROM orders
          ORDER BY id DESC
          LIMIT 80
        `).all();

        const target = (data === "fin_pend") ? "PENDENTE" : (data === "fin_part") ? "PARCIAL" : "PAGO";

        const filtered = all.filter(o => {
          const fs = orderFinancialStatus(o.id);
          return fs && fs.status === target;
        }).slice(0, 20);

        if (!filtered.length) {
          await tgSendMessage(chatId, `Nenhum pedido ${target}.`);
          return res.sendStatus(200);
        }

        const txt = filtered.map(o => {
          const fs = orderFinancialStatus(o.id);
          return `#${o.id} • ${o.nome}\n${o.descricao}\nTotal: ${formatMoney(o.valor)} | Pago: ${formatMoney(fs.paid)} | <b>${fs.status}</b>\n`;
        }).join("\n");

        await tgSendMessage(chatId, `💰 ${target} (até 20):\n\n${txt}`);
        return res.sendStatus(200);
      }

      if (data === "fin_caixa_hoje") {
        const t = todayISO();
        const rows = db.prepare(`
          SELECT metodo, COALESCE(SUM(valor),0) as total
          FROM payments
          WHERE substr(paid_at,1,10)=?
          GROUP BY metodo
          ORDER BY total DESC
        `).all(t);

        const total = db.prepare(`
          SELECT COALESCE(SUM(valor),0) as total
          FROM payments
          WHERE substr(paid_at,1,10)=?
        `).get(t).total;

        let txt = `📊 Caixa do dia (${t})\n\nTotal: <b>${formatMoney(total)}</b>\n\n`;
        if (!rows.length) txt += "Sem pagamentos hoje.";
        else txt += rows.map(r => `• ${r.metodo}: ${formatMoney(r.total)}`).join("\n");

        await tgSendMessage(chatId, txt);
        return res.sendStatus(200);
      }

      if (data === "fin_fechar_dia") {
        const t = todayISO();
        const pedidosHoje = db.prepare(`SELECT COUNT(*) as c FROM orders WHERE substr(created_at,1,10)=?`).get(t).c;
        const entregasHoje = db.prepare(`SELECT COUNT(*) as c FROM orders WHERE data_entregar=? AND status_producao='Entregue'`).get(t).c;

        const caixaTotal = db.prepare(`SELECT COALESCE(SUM(valor),0) as total FROM payments WHERE substr(paid_at,1,10)=?`).get(t).total;

        const atrasados = db.prepare(`
          SELECT COUNT(*) as c
          FROM orders
          WHERE data_entregar IS NOT NULL
            AND data_entregar < ?
            AND status_producao != 'Entregue'
        `).get(t).c;

        const txt =
`✅ Fechamento do dia (${t})

📦 Pedidos criados: <b>${pedidosHoje}</b>
🚚 Entregas marcadas e entregues: <b>${entregasHoje}</b>
⏱️ Atrasados: <b>${atrasados}</b>
💰 Caixa do dia: <b>${formatMoney(caixaTotal)}</b>

(Próximo passo: ligar insights/estratégias automáticas)`;

        await tgSendMessage(chatId, txt);
        return res.sendStatus(200);
      }

      // AGENDA
      if (data === "ag_busca_hoje") {
        const t = todayISO();
        const rows = db.prepare(`
          SELECT id, nome, descricao, data_buscar, status_producao
          FROM orders
          WHERE data_buscar=?
          ORDER BY id DESC
        `).all(t);

        if (!rows.length) {
          await tgSendMessage(chatId, `📦 Buscas de hoje (${t}): nenhuma.`);
          return res.sendStatus(200);
        }

        const txt = rows.map(r => `#${r.id} • ${r.nome}\n${r.descricao}\nBuscar: ${r.data_buscar} • ${r.status_producao}\n`).join("\n");
        await tgSendMessage(chatId, `📦 Buscas de hoje (${t}):\n\n${txt}`);
        return res.sendStatus(200);
      }

      if (data === "ag_entrega_hoje") {
        const t = todayISO();
        const rows = db.prepare(`
          SELECT id, nome, descricao, data_entregar, status_producao
          FROM orders
          WHERE data_entregar=?
          ORDER BY id DESC
        `).all(t);

        if (!rows.length) {
          await tgSendMessage(chatId, `🚚 Entregas de hoje (${t}): nenhuma.`);
          return res.sendStatus(200);
        }

        const txt = rows.map(r => `#${r.id} • ${r.nome}\n${r.descricao}\nEntrega: ${r.data_entregar} • ${r.status_producao}\n`).join("\n");
        await tgSendMessage(chatId, `🚚 Entregas de hoje (${t}):\n\n${txt}`);
        return res.sendStatus(200);
      }

      if (data === "ag_atrasados") {
        const t = todayISO();
        const rows = db.prepare(`
          SELECT id, nome, descricao, data_entregar, status_producao, valor
          FROM orders
          WHERE data_entregar IS NOT NULL
            AND data_entregar < ?
            AND status_producao != 'Entregue'
          ORDER BY data_entregar ASC
          LIMIT 30
        `).all(t);

        if (!rows.length) {
          await tgSendMessage(chatId, `⏱️ Atrasados: nenhum 🎉`);
          return res.sendStatus(200);
        }

        const txt = rows.map(r =>
          `#${r.id} • ${r.nome}\n${r.descricao}\nEntrega: ${r.data_entregar} • ${r.status_producao} • ${formatMoney(r.valor)}\n`
        ).join("\n");

        await tgSendMessage(chatId, `⏱️ Atrasados (até 30):\n\n${txt}`);
        return res.sendStatus(200);
      }

      // PRODUÇÃO por status
      if (data.startsWith("pr_status:")) {
        const status = data.split(":").slice(1).join(":");
        const rows = db.prepare(`
          SELECT id, nome, descricao, data_entregar, valor
          FROM orders
          WHERE status_producao=?
          ORDER BY id DESC
          LIMIT 30
        `).all(status);

        if (!rows.length) {
          await tgSendMessage(chatId, `🏭 ${status}: nenhum pedido.`);
          return res.sendStatus(200);
        }

        const txt = rows.map(r =>
          `#${r.id} • ${r.nome}\n${r.descricao}\nEntrega: ${r.data_entregar || "-"} • ${formatMoney(r.valor)}\n`
        ).join("\n");

        await tgSendMessage(chatId, `🏭 ${status} (até 30):\n\n${txt}`);
        return res.sendStatus(200);
      }

      await tgSendMessage(chatId, `Ação não reconhecida: ${data}`);
      return res.sendStatus(200);
    }

    // -------- Text messages --------
    if (body.message) {
      const msg = body.message;
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const text = (msg.text || "").trim();

      if (userId !== ADMIN_ID) {
        await tgSendMessage(chatId, "Acesso negado.");
        return res.sendStatus(200);
      }

      // comandos
      if (text === "/start" || text === "/menu") {
        await tgSendMessage(chatId, "Painel Administrativo:", { reply_markup: menuKeyboard() });
        return res.sendStatus(200);
      }

      // wizard handler
      const wz = getWizard(chatId);
      const state = wz.state;
      const payload = wz.payload;

      // ============ CREATE ORDER ============
      if (state === "CREATE_NOME") {
        payload.nome = text;
        setWizard(chatId, "CREATE_CONTATO", payload);
        await tgSendMessage(chatId, "Contato (telefone/whatsapp):");
        return res.sendStatus(200);
      }

      if (state === "CREATE_CONTATO") {
        payload.contato = text;
        setWizard(chatId, "CREATE_ENDERECO", payload);
        await tgSendMessage(chatId, "Endereço:");
        return res.sendStatus(200);
      }

      if (state === "CREATE_ENDERECO") {
        payload.endereco = text;
        setWizard(chatId, "CREATE_DESCRICAO", payload);
        await tgSendMessage(chatId, "Descrição do pedido (ex: reforma sofá, mesa, tecido, etc):");
        return res.sendStatus(200);
      }

      if (state === "CREATE_DESCRICAO") {
        payload.descricao = text;
        setWizard(chatId, "CREATE_VALOR", payload);
        await tgSendMessage(chatId, "Valor (apenas número). Ex: 1200 ou 1200.50");
        return res.sendStatus(200);
      }

      if (state === "CREATE_VALOR") {
        const v = Number(String(text).replace(",", "."));
        if (!Number.isFinite(v) || v < 0) {
          await tgSendMessage(chatId, "Valor inválido. Envie só número. Ex: 1200 ou 1200.50");
          return res.sendStatus(200);
        }
        payload.valor = v;
        setWizard(chatId, "CREATE_BUSCAR", payload);
        await tgSendMessage(chatId, "Data de buscar (DD/MM/AAAA) ou (YYYY-MM-DD):");
        return res.sendStatus(200);
      }

      if (state === "CREATE_BUSCAR") {
        const iso = parseBRDateToISO(text);
        if (!iso) {
          await tgSendMessage(chatId, "Data inválida. Use DD/MM/AAAA. Ex: 10/03/2026");
          return res.sendStatus(200);
        }
        payload.data_buscar = iso;
        setWizard(chatId, "CREATE_ENTREGAR", payload);
        await tgSendMessage(chatId, "Data de entregar (DD/MM/AAAA) ou (YYYY-MM-DD):");
        return res.sendStatus(200);
      }

      if (state === "CREATE_ENTREGAR") {
        const iso = parseBRDateToISO(text);
        if (!iso) {
          await tgSendMessage(chatId, "Data inválida. Use DD/MM/AAAA. Ex: 20/03/2026");
          return res.sendStatus(200);
        }
        payload.data_entregar = iso;

        setWizard(chatId, "CREATE_CONFIRM", payload);

        const resumo =
`📦 <b>NOVO PEDIDO</b>

👤 Nome: <b>${payload.nome}</b>
📞 Contato: <b>${payload.contato}</b>
📍 Endereço: <b>${payload.endereco}</b>
📝 Descrição: <b>${payload.descricao}</b>
💰 Valor: <b>${formatMoney(payload.valor)}</b>
📦 Buscar: <b>${payload.data_buscar}</b>
🚚 Entregar: <b>${payload.data_entregar}</b>
🏭 Status: <b>Aguardando produção</b>

Confirmar?`;

        await tgSendMessage(chatId, resumo, { reply_markup: confirmKeyboard("order_confirm_yes", "order_confirm_no") });
        return res.sendStatus(200);
      }

      // ============ SEARCH ============
      if (state === "SEARCH_QUERY") {
        const q = text;
        let rows = [];
        if (/^\d+$/.test(q)) {
          const r = db.prepare(`SELECT * FROM orders WHERE id=?`).get(Number(q));
          rows = r ? [r] : [];
        } else {
          rows = db.prepare(`
            SELECT *
            FROM orders
            WHERE nome LIKE ? OR contato LIKE ?
            ORDER BY id DESC
            LIMIT 20
          `).all(`%${q}%`, `%${q}%`);
        }

        clearWizard(chatId);

        if (!rows.length) {
          await tgSendMessage(chatId, "Nada encontrado.");
          return res.sendStatus(200);
        }

        const txt = rows.map(r => {
          const fs = orderFinancialStatus(r.id);
          const fin = fs ? `${fs.status} (Pago ${formatMoney(fs.paid)} / ${formatMoney(fs.total)})` : "-";
          return `#${r.id} • ${r.nome}\n${r.descricao}\n${formatMoney(r.valor)} • Buscar: ${r.data_buscar || "-"} • Entrega: ${r.data_entregar || "-"}\n🏭 ${r.status_producao} • 💰 ${fin}\n`;
        }).join("\n");

        await tgSendMessage(chatId, `🔎 Resultado (até 20):\n\n${txt}`);
        return res.sendStatus(200);
      }

      // ============ STATUS UPDATE ============
      if (state === "STATUS_WAIT_ID") {
        if (!/^\d+$/.test(text)) {
          await tgSendMessage(chatId, "Envie apenas o ID numérico do pedido.");
          return res.sendStatus(200);
        }
        const orderId = Number(text);
        const order = db.prepare(`SELECT * FROM orders WHERE id=?`).get(orderId);
        if (!order) {
          await tgSendMessage(chatId, "Pedido não encontrado.");
          clearWizard(chatId);
          return res.sendStatus(200);
        }

        setWizard(chatId, "STATUS_CHOOSE", { orderId });
        await tgSendMessage(
          chatId,
          `Pedido #${orderId}\n${order.nome}\n${order.descricao}\nStatus atual: <b>${order.status_producao}</b>\n\nEscolha o novo status:`,
          { reply_markup: statusSetKeyboard() }
        );
        return res.sendStatus(200);
      }

      // ============ PAYMENTS ============
      if (state === "PAY_WAIT_ID") {
        if (!/^\d+$/.test(text)) {
          await tgSendMessage(chatId, "Envie apenas o ID numérico do pedido.");
          return res.sendStatus(200);
        }
        const orderId = Number(text);
        const order = db.prepare(`SELECT id, nome, descricao, valor FROM orders WHERE id=?`).get(orderId);
        if (!order) {
          await tgSendMessage(chatId, "Pedido não encontrado.");
          clearWizard(chatId);
          return res.sendStatus(200);
        }

        const fs = orderFinancialStatus(orderId);
        setWizard(chatId, "PAY_WAIT_AMOUNT", { orderId });

        await tgSendMessage(
          chatId,
          `Pedido #${orderId} • ${order.nome}\n${order.descricao}\nTotal: <b>${formatMoney(order.valor)}</b>\nPago: <b>${formatMoney(fs.paid)}</b>\n\nDigite o <b>valor pago agora</b>:`
        );
        return res.sendStatus(200);
      }

      if (state === "PAY_WAIT_AMOUNT") {
        const v = Number(String(text).replace(",", "."));
        if (!Number.isFinite(v) || v <= 0) {
          await tgSendMessage(chatId, "Valor inválido. Envie só número maior que 0. Ex: 200");
          return res.sendStatus(200);
        }
        payload.valor = v;
        setWizard(chatId, "PAY_WAIT_METHOD", payload);
        await tgSendMessage(chatId, "Escolha o método:", { reply_markup: payMethodKeyboard() });
        return res.sendStatus(200);
      }

      if (state === "PAY_WAIT_NOTE") {
        const note = (text === "-" ? "" : text);
        const orderId = Number(payload.orderId);
        const valor = Number(payload.valor);
        const metodo = payload.metodo || "Pix";

        db.prepare(`
          INSERT INTO payments(order_id, valor, metodo, observacao)
          VALUES(?, ?, ?, ?)
        `).run(orderId, valor, metodo, note);

        db.prepare(`
          INSERT INTO order_history(order_id, event_type, old_value, new_value, meta_json)
          VALUES(?, 'PAYMENT_ADDED', '', ?, ?)
        `).run(orderId, String(valor), JSON.stringify({ metodo, note }));

        const fs = orderFinancialStatus(orderId);
        clearWizard(chatId);

        await tgSendMessage(
          chatId,
          `✅ Pagamento registrado!\nPedido #${orderId}\nMétodo: <b>${metodo}</b>\nValor: <b>${formatMoney(valor)}</b>\n\nStatus financeiro: <b>${fs.status}</b>\nPago: <b>${formatMoney(fs.paid)}</b> / <b>${formatMoney(fs.total)}</b>`
        );
        return res.sendStatus(200);
      }

      // Se chegou aqui: não está em wizard
      await tgSendMessage(chatId, "Comando não reconhecido. Use /menu");
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("ERRO webhook:", err);
    return res.sendStatus(200);
  }
});

// =====================
// 7) START SERVER
// =====================
app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
  console.log("DB:", dbPath);
});
