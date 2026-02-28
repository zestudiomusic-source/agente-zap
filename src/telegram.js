// src/telegram.js
const TelegramBot = require("node-telegram-bot-api");
const { askOpenAI } = require("./openai");
const { createLogger } = require("./logger");

function parseSaleText(text) {
  const t = String(text || "").trim();
  if (!t) return null;

  const cliente =
    (t.match(/cliente[:\s]+([^\n,]+)/i)?.[1] ||
      t.match(/para\s+([^\n,]+)\s+\d/i)?.[1] ||
      t.match(/p\/\s*([^\n,]+)\s+\d/i)?.[1] ||
      "").trim();

  const valorRaw =
    (t.match(/valor[:\s]*([\d\.\,]+)/i)?.[1] ||
      t.match(/\b(\d{2,3}(?:[\.\,]\d{3})*(?:[\.\,]\d{2})?)\b/)?.[1] ||
      "").trim();

  const valor = valorRaw
    ? Math.round(Number(valorRaw.replace(/\./g, "").replace(",", ".")) * 100)
    : 0;

  const produto =
    (t.match(/produto[:\s]+([^\n]+)/i)?.[1] ||
      t.match(/venda[:\s]+([^\n]+)/i)?.[1] ||
      t.match(/produção[:\s]+([^\n]+)/i)?.[1] ||
      "").trim();

  if (!cliente && !produto && !valor) return null;

  return {
    customer_name: cliente || null,
    description: produto || t,
    amount_cents: valor || 0,
    raw_text: t,
  };
}

function shouldCallIA(text) {
  const t = String(text || "").trim();
  if (!t) return false;

  // IA funciona em QUALQUER PARTE DO GRUPO:
  // - "ia: ..."
  // - "IA: ..."
  // - "@bot ..." (se o usuário mencionar)
  // - "/ia ..." (comando)
  // - "gpt: ..." (atalho)
  return (
    /^ia[:\s]/i.test(t) ||
    /^gpt[:\s]/i.test(t) ||
    /^\/ia(\s|$)/i.test(t)
  );
}

function extractIAQuery(text) {
  const t = String(text || "").trim();
  if (!t) return "";

  if (/^\/ia(\s|$)/i.test(t)) return t.replace(/^\/ia\s*/i, "").trim();
  if (/^ia[:\s]/i.test(t)) return t.replace(/^ia[:\s]*/i, "").trim();
  if (/^gpt[:\s]/i.test(t)) return t.replace(/^gpt[:\s]*/i, "").trim();
  return t;
}

async function getGroups(db) {
  return (await db.kvGet("groups")) || {};
}

async function setGroup(db, key, payload) {
  const groups = (await getGroups(db)) || {};
  groups[key] = payload;
  await db.kvSet("groups", groups);
  return groups;
}

// envia mensagem respeitando tópico (forum)
async function send(bot, msg, text, extra = {}) {
  const opts = { ...extra };
  if (msg?.message_thread_id) opts.message_thread_id = msg.message_thread_id;
  return bot.sendMessage(msg.chat.id, text, opts);
}

function menuForGroupKey(groupKey) {
  // você pode crescer isso depois (Produção, Financeiro etc.)
  if (groupKey === "vendas") {
    return {
      inline_keyboard: [
        [{ text: "🧾 CRM", callback_data: "menu:vendas:crm" }],
        [{ text: "➕ Nova venda (atalho)", callback_data: "menu:vendas:nova" }],
      ],
    };
  }

  if (groupKey === "compras") {
    return {
      inline_keyboard: [
        [{ text: "🛒 Lista de compras", callback_data: "menu:compras:lista" }],
      ],
    };
  }

  if (groupKey === "producao") {
    return {
      inline_keyboard: [
        [{ text: "🏭 Fila de produção", callback_data: "menu:producao:fila" }],
      ],
    };
  }

  if (groupKey === "financeiro") {
    return {
      inline_keyboard: [
        [{ text: "💰 Caixa / Pendências", callback_data: "menu:financeiro:caixa" }],
      ],
    };
  }

  if (groupKey === "relatorios") {
    return {
      inline_keyboard: [
        [{ text: "📈 Ver últimos relatórios", callback_data: "menu:relatorios:ultimos" }],
      ],
    };
  }

  if (groupKey === "backups") {
    return {
      inline_keyboard: [
        [{ text: "🗄️ Status de backups", callback_data: "menu:backups:status" }],
      ],
    };
  }

  return {
    inline_keyboard: [[{ text: "ℹ️ Ajuda", callback_data: "menu:ajuda" }]],
  };
}

async function createTelegramBot({ config, db }) {
  const logger = createLogger("TELEGRAM");

  const botToken = process.env.TELEGRAM_BOT_TOKEN || config?.telegram?.botToken;
  const adminId = Number(process.env.TELEGRAM_ADMIN_ID || config?.telegram?.adminId || 0);

  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN não configurado!");
  if (!adminId) throw new Error("TELEGRAM_ADMIN_ID não configurado!");

  const useWebhook = !!(process.env.TELEGRAM_USE_WEBHOOK || config?.telegram?.useWebhook);

  // Para Web Service: polling por padrão (estável e simples)
  const bot = new TelegramBot(botToken, { polling: !useWebhook });

  const me = await bot.getMe();
  logger.info(`✅ Bot conectado: @${me.username} (ADM)`);

  // =========================
  // /start
  // =========================
  bot.onText(/^\/start$/, async (msg) => {
    if (msg.from?.id !== adminId) return;
    await send(
      bot,
      msg,
      "✅ ERP bot ativo!\n\nUse /menu para abrir o painel.\nUse /ia para perguntar algo.\nUse /setgroup <nome> para registrar o grupo."
    );
  });

  // =========================
  // /menu (mostra menu do grupo atual)
  // =========================
  bot.onText(/^\/menu$/, async (msg) => {
    if (msg.from?.id !== adminId) return;

    const groups = await getGroups(db);
    const chatId = Number(msg.chat.id);

    // acha qual grupo é esse chat_id
    let groupKey = null;
    for (const [k, v] of Object.entries(groups)) {
      if (Number(v?.chat_id) === chatId) {
        groupKey = k;
        break;
      }
    }

    if (!groupKey) {
      return send(
        bot,
        msg,
        "⚠️ Este grupo não está registrado.\nUse: /setgroup vendas | compras | producao | financeiro | relatorios | backups"
      );
    }

    await send(bot, msg, `📌 Menu do grupo: ${groupKey}`, {
      reply_markup: menuForGroupKey(groupKey),
    });
  });

  // =========================
  // /ia (IA em qualquer grupo/tópico)
  // =========================
  bot.onText(/^\/ia(?:\s+([\s\S]+))?$/i, async (msg, match) => {
    if (msg.from?.id !== adminId) return;

    const prompt = String(match?.[1] || "").trim();
    if (!prompt) {
      return send(
        bot,
        msg,
        "Digite assim:\n\n/ia Como está o andamento das vendas?\n\nOu use: IA: <pergunta> em qualquer mensagem."
      );
    }

    const apiKey = process.env.OPENAI_API_KEY || config?.openai?.apiKey;
    const model = process.env.OPENAI_MODEL || config?.openai?.model || "gpt-4o-mini";

    const groups = await getGroups(db);
    const context = {
      groups,
      note: "IA responde no grupo e no mesmo tópico. A IA analisa principalmente ARQUIVOS (documentos).",
    };

    const answer = await askOpenAI({
      apiKey,
      model,
      messages: [
        { role: "system", content: "Você é um assistente de ERP para uma empresa de estofados. Responda curto e prático." },
        { role: "user", content: `Contexto JSON:\n${JSON.stringify(context)}\n\nPergunta:\n${prompt}` },
      ],
      maxTokens: 700,
      temperature: 0.2,
    });

    await send(bot, msg, answer || "Sem resposta no momento.");
  });

  // =========================
  // /setgroup <nome>  (registra grupos)
  // =========================
  bot.onText(/^\/setgroup\s+(\w+)$/i, async (msg, match) => {
    try {
      if (msg.from?.id !== adminId) return;

      const key = String(match?.[1] || "").toLowerCase();
      const allowed = ["compras", "vendas", "producao", "financeiro", "relatorios", "backups"];
      if (!allowed.includes(key)) {
        return send(bot, msg, `❌ Nome inválido. Use: ${allowed.join(" | ")}`);
      }

      const chat = msg.chat;
      const payload = {
        chat_id: Number(chat.id),
        title: chat.title || key,
        is_forum: !!chat.is_forum,
        updated_at: new Date().toISOString(),
      };

      await setGroup(db, key, payload);

      await send(
        bot,
        msg,
        `✅ Grupo registrado com sucesso!\n\nNome: ${key}\nChat ID: ${payload.chat_id}\nFórum/Tópicos: ${payload.is_forum ? "SIM" : "NÃO"}`
      );
    } catch (err) {
      logger.error("Erro ao registrar grupo:", err?.message || err);
      await send(bot, msg, `❌ Erro ao registrar grupo: ${err?.message || err}`);
    }
  });

  // =========================
  // CALLBACKS (botões)
  // =========================
  bot.on("callback_query", async (q) => {
    try {
      const data = q.data || "";
      const msg = q.message;

      // Menu
      if (data === "menu:vendas:crm") {
        await bot.sendMessage(msg.chat.id, "📒 CRM: em breve (lista/etapas).", {
          message_thread_id: msg.message_thread_id,
        });
        return bot.answerCallbackQuery(q.id);
      }

      if (data === "menu:vendas:nova") {
        await bot.sendMessage(
          msg.chat.id,
          "🧾 Para registrar venda, mande assim:\n\nCliente: Mariza\nProduto: Sofá 3 lugares\nValor: 3600\nObs: Produção nova\n\nOu mensagem natural:\ncliente mariza produção sofá 3 lugares valor 3600",
          { message_thread_id: msg.message_thread_id }
        );
        return bot.answerCallbackQuery(q.id);
      }

      // ===============================
      // CONFIRMAÇÃO DE VENDA (A1)
      // ===============================
      if (data.startsWith("sale:ok:")) {
        const token = data.replace("sale:ok:", "");
        const draft = await db.kvGet(`draft_sale:${token}`);
        if (!draft) return bot.answerCallbackQuery(q.id, { text: "Draft expirou." });

        const rows = await db.query(
          `INSERT INTO orders (customer_name, description, amount_cents, status, production_status, meta_json, created_at, updated_at)
           VALUES ($1,$2,$3,'confirmed','not_started',$4,NOW(),NOW())
           RETURNING id`,
          [
            draft.customer_name,
            draft.description,
            draft.amount_cents,
            { source: "telegram:vendas", token, raw_text: draft.raw_text || "" },
          ]
        );

        await db.kvDelete(`draft_sale:${token}`);

        await bot.sendMessage(
          msg.chat.id,
          `✅ Venda registrada! Pedido #${rows[0].id}`,
          { message_thread_id: msg.message_thread_id }
        );

        return bot.answerCallbackQuery(q.id, { text: "Venda criada ✅" });
      }

      if (data.startsWith("sale:no:")) {
        const token = data.replace("sale:no:", "");
        await db.kvDelete(`draft_sale:${token}`);
        await bot.sendMessage(msg.chat.id, "❌ Venda cancelada.", {
          message_thread_id: msg.message_thread_id,
        });
        return bot.answerCallbackQuery(q.id, { text: "Cancelado" });
      }

      return bot.answerCallbackQuery(q.id);
    } catch (err) {
      logger.error("callback_query erro:", err?.message || err);
      try {
        await bot.answerCallbackQuery(q.id, { text: "Erro." });
      } catch {}
    }
  });

  // ===============================
  // IA + VENDAS por mensagem (QUALQUER TÓPICO)
  // ===============================
  bot.on("message", async (msg) => {
    try {
      // ignora comandos (tratados acima)
      if (msg.text && msg.text.startsWith("/")) return;

      const groups = await getGroups(db);

      // ============ IA EM QUALQUER GRUPO/TÓPICO ============
      // Só dispara quando você chamar: "IA: ..." ou "/ia ..." ou "gpt: ..."
      if (msg.text && shouldCallIA(msg.text)) {
        if (msg.from?.id !== adminId) return; // você pode remover isso se quiser permitir para equipe

        const apiKey = process.env.OPENAI_API_KEY || config?.openai?.apiKey;
        const model = process.env.OPENAI_MODEL || config?.openai?.model || "gpt-4o-mini";

        const userPrompt = extractIAQuery(msg.text);
        if (!userPrompt) return;

        // contexto leve: quais grupos existem e qual grupo atual
        let currentGroupKey = null;
        for (const [k, v] of Object.entries(groups)) {
          if (Number(v?.chat_id) === Number(msg.chat.id)) {
            currentGroupKey = k;
            break;
          }
        }

        const context = {
          current_group: currentGroupKey,
          groups_registered: Object.keys(groups),
          note: "Responda curto e prático. Se pedir análise de arquivo, oriente enviar PDF/CSV/documento.",
        };

        const answer = await askOpenAI({
          apiKey,
          model,
          messages: [
            { role: "system", content: "Você é uma IA de ERP. Responda curto, direto e com passos." },
            { role: "user", content: `Contexto JSON:\n${JSON.stringify(context)}\n\nPergunta:\n${userPrompt}` },
          ],
          maxTokens: 700,
          temperature: 0.2,
        });

        await send(bot, msg, answer || "Sem resposta no momento.");
        return;
      }

      // ============ VENDAS AUTOMÁTICA (mensagem normal no grupo VENDAS) ============
      const vendasChatId = groups?.vendas?.chat_id;
      if (vendasChatId && Number(msg.chat.id) === Number(vendasChatId) && msg.text) {
        const parsed = parseSaleText(msg.text);
        if (!parsed) return;

        // C2: se faltar valor, perguntar antes
        if (!parsed.amount_cents || parsed.amount_cents <= 0) {
          await send(
            bot,
            msg,
            "💰 Entendi a venda, mas faltou o VALOR.\nResponda assim:\n\nValor: 3600"
          );
          return;
        }

        // A1: confirmar antes de criar
        const token = `${msg.chat.id}:${msg.message_id}`;

        await db.kvSet(`draft_sale:${token}`, {
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          ...parsed,
          created_at: new Date().toISOString(),
        });

        await send(
          bot,
          msg,
          `🧾 Confirma criar esta venda?\n\n` +
            `Cliente: ${parsed.customer_name || "(não informado)"}\n` +
            `Descrição: ${parsed.description || "(não informado)"}\n` +
            `Valor: R$ ${(parsed.amount_cents / 100).toFixed(2).replace(".", ",")}\n\n` +
            `✅ Confirmar ou ❌ Cancelar`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ Confirmar", callback_data: `sale:ok:${token}` },
                  { text: "❌ Cancelar", callback_data: `sale:no:${token}` },
                ],
              ],
            },
          }
        );
        return;
      }

      // ============ ARQUIVOS (IA só para documentos) ============
      // (prints/imagens não analisamos — decisão sua)
      if (msg.document) {
        // aqui você pode evoluir depois para baixar e extrair texto de CSV/PDF
        // por enquanto: confirma recebimento e orienta
        await send(
          bot,
          msg,
          `📎 Arquivo recebido: ${msg.document.file_name || "documento"}\n` +
            `✅ Registrado. Se quiser análise, mande junto uma mensagem começando com:\n` +
            `IA: analisar este arquivo e resumir pontos importantes.`
        );
      }
    } catch (err) {
      logger.error("message handler erro:", err?.message || err);
    }
  });

  return bot;
}

module.exports = { createTelegramBot };
