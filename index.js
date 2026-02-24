const express = require("express");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.TELEGRAM_ADMIN_ID);
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN não configurado!");
  process.exit(1);
}

if (!ADMIN_ID) {
  console.error("TELEGRAM_ADMIN_ID não configurado!");
  process.exit(1);
}

// ================= DATABASE =================
const isRender = !!process.env.RENDER;
const dbPath = isRender
  ? path.join("/tmp", "bot.db")
  : path.join(__dirname, "db", "bot.db");

if (!isRender) {
  const dbDir = path.join(__dirname, "db");
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir);
}

const db = new Database(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT,
  contato TEXT,
  endereco TEXT,
  descricao TEXT,
  valor REAL,
  data_buscar TEXT,
  data_entregar TEXT,
  status_producao TEXT DEFAULT 'Aguardando produção',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wizard (
  chat_id INTEGER PRIMARY KEY,
  step TEXT,
  data TEXT
);
`);

// ================= TELEGRAM =================
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tg(method, body) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function tgSendMessage(chatId, text, extra = {}) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra,
  });
}

// ================= MENU =================
function menuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📦 Pedidos", callback_data: "menu_pedidos" },
        { text: "📆 Agenda", callback_data: "menu_agenda" },
      ],
      [
        { text: "🏭 Produção", callback_data: "menu_producao" },
        { text: "💰 Financeiro", callback_data: "menu_financeiro" },
      ],
      [
        { text: "📊 Relatórios", callback_data: "menu_relatorios" },
        { text: "⚙️ Sistema", callback_data: "menu_sistema" },
      ],
    ],
  };
}

function pedidosKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "➕ Criar Pedido", callback_data: "criar_pedido" }],
      [{ text: "📋 Ver Pedidos", callback_data: "ver_pedidos" }],
      [{ text: "⬅️ Voltar", callback_data: "menu_principal" }],
    ],
  };
}

// ================= WIZARD =================
function setWizard(chatId, step, data = {}) {
  db.prepare(`
    INSERT INTO wizard (chat_id, step, data)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET step=excluded.step, data=excluded.data
  `).run(chatId, step, JSON.stringify(data));
}

function getWizard(chatId) {
  const row = db.prepare("SELECT * FROM wizard WHERE chat_id=?").get(chatId);
  if (!row) return null;
  return { step: row.step, data: JSON.parse(row.data || "{}") };
}

function clearWizard(chatId) {
  db.prepare("DELETE FROM wizard WHERE chat_id=?").run(chatId);
}

// ================= APP =================
const app = express();
app.use(express.json());

// ================= WEBHOOK =================
app.post("/webhook", async (req, res) => {
  const body = req.body;

  try {
    // ================= CALLBACK BUTTONS =================
    if (body.callback_query) {
      const chatId = body.callback_query.message.chat.id;
      const userId = body.callback_query.from.id;
      const data = body.callback_query.data;

      if (userId !== ADMIN_ID) return res.sendStatus(200);

      if (data === "menu_principal") {
        await tgSendMessage(chatId, "📊 Painel Administrativo", {
          reply_markup: menuKeyboard(),
        });
      }

      if (data === "menu_pedidos") {
        await tgSendMessage(chatId, "📦 MÓDULO PEDIDOS", {
          reply_markup: pedidosKeyboard(),
        });
      }

      if (data === "criar_pedido") {
        setWizard(chatId, "nome", {});
        await tgSendMessage(chatId, "Digite o NOME do cliente:");
      }

      if (data === "ver_pedidos") {
        const pedidos = db
          .prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 10")
          .all();

        if (!pedidos.length) {
          await tgSendMessage(chatId, "Nenhum pedido encontrado.");
        } else {
          let texto = "📋 Últimos Pedidos:\n\n";
          pedidos.forEach((p) => {
            texto += `#${p.id} - ${p.nome} - R$${p.valor}\nStatus: ${p.status_producao}\n\n`;
          });
          await tgSendMessage(chatId, texto);
        }
      }

      return res.sendStatus(200);
    }

    // ================= MENSAGENS =================
    if (body.message) {
      const msg = body.message;
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const text = (msg.text || "").trim();

      if (userId !== ADMIN_ID) return res.sendStatus(200);

      // 🔥 PRIORIDADE ABSOLUTA PARA COMANDOS (CORREÇÃO DO SEU ERRO)
      if (text === "/start" || text === "/menu" || text.toLowerCase() === "menu") {
        clearWizard(chatId);
        await tgSendMessage(chatId, "📊 Painel Administrativo", {
          reply_markup: menuKeyboard(),
        });
        return res.sendStatus(200);
      }

      // ================= WIZARD FLOW =================
      const wizard = getWizard(chatId);

      if (wizard) {
        const data = wizard.data;

        if (wizard.step === "nome") {
          data.nome = text;
          setWizard(chatId, "contato", data);
          await tgSendMessage(chatId, "Digite o CONTATO:");
          return res.sendStatus(200);
        }

        if (wizard.step === "contato") {
          data.contato = text;
          setWizard(chatId, "endereco", data);
          await tgSendMessage(chatId, "Digite o ENDEREÇO:");
          return res.sendStatus(200);
        }

        if (wizard.step === "endereco") {
          data.endereco = text;
          setWizard(chatId, "descricao", data);
          await tgSendMessage(chatId, "Digite a DESCRIÇÃO do pedido:");
          return res.sendStatus(200);
        }

        if (wizard.step === "descricao") {
          data.descricao = text;
          setWizard(chatId, "valor", data);
          await tgSendMessage(chatId, "Digite o VALOR:");
          return res.sendStatus(200);
        }

        if (wizard.step === "valor") {
          data.valor = parseFloat(text.replace(",", "."));
          db.prepare(`
            INSERT INTO orders (nome, contato, endereco, descricao, valor)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            data.nome,
            data.contato,
            data.endereco,
            data.descricao,
            data.valor
          );

          clearWizard(chatId);
          await tgSendMessage(chatId, "✅ Pedido criado com sucesso!");
          return res.sendStatus(200);
        }
      }

      // 🚫 NÃO SALVA MAIS “/menu” COMO NOTA
      await tgSendMessage(chatId, "Use /menu para abrir o painel.");
      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("ERRO:", err);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => {
  res.send("Bot ERP rodando");
});

app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
  console.log("Banco:", dbPath);
});
