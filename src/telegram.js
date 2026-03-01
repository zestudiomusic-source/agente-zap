// src/telegram.js
const fetch = require("node-fetch");
const pdfParse = require("pdf-parse");
const { parse } = require("csv-parse/sync");
const { handleYesNo } = require("./workflow");

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const ADM_CHAT_ID = Number(process.env.ADM_CHAT_ID);
const PROD_CHAT_ID = Number(process.env.PROD_CHAT_ID);

function isAllowedChat(chatId) {
  return chatId === ADM_CHAT_ID || chatId === PROD_CHAT_ID;
}

// ---------- Telegram helpers ----------
async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function downloadFile(fileId) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
  const data = await res.json();
  const filePath = data.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  return await fetch(fileUrl).then((r) => r.buffer());
}

// ---------- util: parse BRL/num ----------
function parseMoneyBR(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;

  let t = s.replace(/\s/g, "").replace("R$", "");
  if (t.includes(".") && t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (t.includes(",")) t = t.replace(",", ".");

  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function detectDelimiter(text) {
  const sample = text.split("\n").slice(0, 5).join("\n");
  const candidates = [",", ";", "\t"];
  let best = ",";
  let bestCount = -1;
  for (const d of candidates) {
    const count = (sample.match(new RegExp(`\\${d}`, "g")) || []).length;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

function normHeader(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^\w_]/g, "");
}

function mapRowToTxn(rowObj) {
  const keys = Object.keys(rowObj);

  const pick = (arr) => {
    for (const k of arr) {
      const found = keys.find((x) => x === k);
      if (found) return rowObj[found];
    }
    return null;
  };

  const date =
    pick(["data", "date", "dt", "data_transacao"]) ||
    pick(["data_do_lancamento", "data_lancamento"]);

  const amount = pick(["valor", "amount", "vlr", "valor_rs", "valor_r"]) || pick(["saida", "entrada"]);

  const desc =
    pick(["descricao", "description", "historico", "memo", "detalhe"]) ||
    pick(["identificador", "tipo", "categoria"]);

  const payee =
    pick(["estabelecimento", "favorecido", "beneficiario", "merchant", "payee"]) || null;

  return { date, amount, desc, payee, raw: rowObj };
}

function parseDateAny(v) {
  if (!v) return null;
  const s = String(v).trim();
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return s;
  return null;
}

// ---------- DB helpers ----------
async function logEvent(db, chatId, role, text, tag = null, payload = null) {
  await db.exec(
    `INSERT INTO public.events(chat_id, role, text, tag, payload) VALUES ($1,$2,$3,$4,$5)`,
    [chatId, role, text, tag, payload]
  );
}

async function getRecentContext(db, chatId, limit = 14) {
  const r = await db.exec(
    `SELECT role, text FROM public.events WHERE chat_id=$1 ORDER BY id DESC LIMIT $2`,
    [chatId, limit]
  );
  return r.rows.reverse();
}

async function getSummary(db, chatId) {
  const r = await db.exec(`SELECT summary FROM public.chat_memory WHERE chat_id=$1`, [chatId]);
  return r.rows[0]?.summary || "";
}

async function setSummary(db, chatId, summary) {
  await db.exec(
    `
    INSERT INTO public.chat_memory(chat_id, summary, updated_at)
    VALUES($1,$2,NOW())
    ON CONFLICT (chat_id) DO UPDATE SET summary=EXCLUDED.summary, updated_at=NOW()
  `,
    [chatId, summary]
  );
}

async function getRules(db, chatId) {
  const r = await db.exec(
    `SELECT rule FROM public.ai_rules WHERE (chat_id=$1 OR chat_id IS NULL) AND active=true ORDER BY id ASC`,
    [chatId]
  );
  return r.rows.map((x) => x.rule);
}

// ---------- OpenAI (chat completions) ----------
async function callAI(db, chatId, userText, extra) {
  if (!OPENAI_API_KEY) return "OPENAI_API_KEY não configurada no Render.";

  const summary = await getSummary(db, chatId);
  const rules = await getRules(db, chatId);
  const recent = await getRecentContext(db, chatId, 12);

  const system = `
Você é a IA gerente/CEO da empresa.
- Responda SEMPRE curto e objetivo (1 a 4 linhas).
- Mantenha contexto da conversa.
- NÃO invente dados (fornecedor, payee, valores) que não existam no arquivo ou mensagem.
- Se faltar coluna de descrição/estabelecimento, diga: "não dá pra identificar pra quem foi".
- Se for uma ação operacional (salvar/importar/alterar), peça confirmação curta: "Confirmar? (sim/não)".

Memória (resumo):
${summary || "(vazio)"}

Regras permanentes ativas:
${rules.length ? rules.map((r, i) => `${i + 1}) ${r}`).join("\n") : "(nenhuma)"}
`.trim();

  const messages = [
    { role: "system", content: system },
    ...recent.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.text || "" })),
    { role: "user", content: userText },
  ];

  if (extra) {
    messages.push({ role: "user", content: extra });
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.25,
      messages,
    }),
  });

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || "Ok. Me diga o objetivo em 1 frase.";
}

// Atualiza memória curta (resumo) sem gastar muito
async function updateSummaryLight(db, chatId, lastUserText, lastAssistantText) {
  if (!OPENAI_API_KEY) return;

  const current = await getSummary(db, chatId);
  const prompt = `
Resuma a conversa em 5 a 10 linhas (bem curto) focando:
- objetivos do dono
- decisões já tomadas
- pendências importantes
Não invente nada.

Resumo atual:
${current || "(vazio)"}

Nova interação:
Usuário: ${lastUserText}
IA: ${lastAssistantText}

Devolva APENAS o novo resumo.
`.trim();

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.1,
        messages: [
          { role: "system", content: "Você cria resumos curtos e fiéis." },
          { role: "user", content: prompt },
        ],
      }),
    });
    const data = await r.json();
    const newSum = data.choices?.[0]?.message?.content?.trim();
    if (newSum) await setSummary(db, chatId, newSum.slice(0, 2000));
  } catch {
    // silencioso (não derruba bot)
  }
}

// ---------- Document analysis deterministic ----------
function computeFromTxns(txns) {
  let totalIn = 0;
  let totalOutAbs = 0;
  let count = 0;

  for (const tx of txns) {
    if (typeof tx.amount === "number" && Number.isFinite(tx.amount)) {
      count++;
      if (tx.amount >= 0) totalIn += tx.amount;
      else totalOutAbs += Math.abs(tx.amount);
    }
  }
  return { in: totalIn, out: totalOutAbs, balance: totalIn - totalOutAbs, count };
}

function samplePayeesAndDescs(txns, max = 12) {
  const out = [];
  for (const tx of txns) {
    const v = (tx.payee || tx.description || "").trim();
    if (!v) continue;
    if (!out.includes(v)) out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

// ---------- MAIN HANDLER ----------
async function handleTelegramUpdate(update, db) {
  try {
    if (!update.message) return;

    const msg = update.message;
    const chatId = msg.chat.id;

    if (!isAllowedChat(chatId)) return;

    // ----------- TEXTO -----------
    if (msg.text) {
      const text = msg.text.trim();
      const low = text.toLowerCase();

      await logEvent(db, chatId, "user", text, "MSG", null);

      // 1) Primeiro: confirmações sim/não (pendência real no banco)
      const yesNoResult = await handleYesNo(db, chatId, low);
      if (yesNoResult) {
        await logEvent(db, chatId, "assistant", yesNoResult, "CONFIRM_RESULT", null);
        await sendMessage(chatId, yesNoResult);
        return;
      }

      // 2) Ordem permanente (ex: "a partir de hoje ...")
      // simples e eficiente: se a frase começar assim, vira regra (com confirmação curta)
      if (low.startsWith("a partir de hoje") || low.startsWith("de agora em diante")) {
        // cria pendência para salvar regra
        const plan = {
          actions: [{ type: "save_rule", rule: text }],
        };
        const question = "Salvar essa regra permanente e passar a executar daqui pra frente?";

        await db.exec(
          `INSERT INTO public.pending_actions(chat_id, question, plan) VALUES($1,$2,$3)`,
          [chatId, question, plan]
        );

        const reply = `Entendi.\n${question}\nConfirmar? (sim/não)`;
        await logEvent(db, chatId, "assistant", reply, "ASK_CONFIRM_RULE", plan);
        await sendMessage(chatId, reply);
        return;
      }

      // 3) Conversa normal com contexto real + memória resumida
      const reply = await callAI(db, chatId, text);
      await logEvent(db, chatId, "assistant", reply, "AI_REPLY", null);
      await sendMessage(chatId, reply);

      // atualiza resumo
      await updateSummaryLight(db, chatId, text, reply);

      return;
    }

    // ----------- DOCUMENTO -----------
    if (msg.document) {
      const fileName = (msg.document.file_name || "arquivo").toLowerCase();
      const mimeType = msg.document.mime_type || "";

      await sendMessage(chatId, "📄 Documento recebido. Vou calcular no código (números fixos) e depois te peço sim/não.");

      const buffer = await downloadFile(msg.document.file_id);

      let source = "file";
      let txns = [];

      // PDF
      if (fileName.endsWith(".pdf") || mimeType.includes("pdf")) {
        source = "pdf";
        const pdfData = await pdfParse(buffer);
        const text = (pdfData.text || "").slice(0, 25000);

        // PDF genérico: sem layout, então não prometemos “pra quem foi”
        txns = [{
          date: null,
          amount: 0,
          direction: "unknown",
          description: "PDF importado (texto salvo em raw)",
          payee: null,
          raw: { text },
        }];
      }

      // CSV
      if (fileName.endsWith(".csv") || mimeType.includes("csv") || mimeType.includes("excel")) {
        source = "csv";
        const csvText = buffer.toString("utf-8");
        const delimiter = detectDelimiter(csvText);

        let records;
        try {
          records = parse(csvText, {
            delimiter,
            columns: (h) => normHeader(h),
            skip_empty_lines: true,
            relax_column_count: true,
          });
        } catch {
          const rows = parse(csvText, {
            delimiter,
            skip_empty_lines: true,
            relax_column_count: true,
          });
          const header = rows[0] || [];
          const dataRows = rows.slice(1);
          records = dataRows.map((r) => {
            const obj = {};
            r.forEach((v, i) => (obj[normHeader(header[i] || `col${i + 1}`)] = v));
            return obj;
          });
        }

        txns = records.map((row) => {
          const mapped = mapRowToTxn(row);
          const amount = parseMoneyBR(mapped.amount);
          const dt = parseDateAny(mapped.date);

          let direction = "unknown";
          if (typeof amount === "number") direction = amount >= 0 ? "in" : "out";

          return {
            date: dt,
            amount: typeof amount === "number" ? amount : 0,
            direction,
            description: mapped.desc ? String(mapped.desc).slice(0, 250) : null,
            payee: mapped.payee ? String(mapped.payee).slice(0, 180) : null,
            raw: row,
          };
        });
      }

      const computed = computeFromTxns(txns);
      const sample = samplePayeesAndDescs(txns, 12);

      // Se não tiver payee/desc, deixa isso explícito
      const hasPayeeInfo = sample.length > 0;

      const insightExtra = `
Resumo calculado (fixo):
- Entradas: R$ ${computed.in.toFixed(2)}
- Saídas: R$ ${computed.out.toFixed(2)}
- Saldo: R$ ${computed.balance.toFixed(2)}
- Lançamentos: ${computed.count}

Amostra de descrição/payee encontrada:
${hasPayeeInfo ? sample.join("\n") : "(não encontrei coluna de descrição/estabelecimento — não dá pra saber pra quem foi)"}
`.trim();

      const insight = await callAI(
        db,
        chatId,
        "Analise o arquivo e diga o que dá para concluir. Se não tiver descrição/payee, diga claramente.",
        insightExtra
      );

      // Cria plano para salvar no financeiro (limit de segurança)
      const safeTxns = txns.slice(0, 3000).map((t) => ({
        source,
        ref: fileName,
        date: t.date,
        direction: t.direction,
        amount: t.amount,
        description: t.description,
        payee: t.payee,
        raw: t.raw,
      }));

      const plan = {
        actions: [
          {
            type: "save_financial_records",
            records: safeTxns,
          },
        ],
      };

      const question = `Importar e salvar no financeiro este arquivo (${fileName})?`;

      await db.exec(
        `INSERT INTO public.pending_actions(chat_id, question, plan) VALUES($1,$2,$3)`,
        [chatId, question, plan]
      );

      const msgOut =
        `✅ Cálculo (fixo):\n` +
        `Entradas: R$ ${computed.in.toFixed(2)}\n` +
        `Saídas: R$ ${computed.out.toFixed(2)}\n` +
        `Saldo: R$ ${computed.balance.toFixed(2)}\n\n` +
        `${insight}\n\n` +
        `${question}\nConfirmar? (sim/não)`;

      await logEvent(db, chatId, "assistant", msgOut, "DOC_ANALYSIS", { computed, sampleCount: sample.length });
      await sendMessage(chatId, msgOut);

      return;
    }
  } catch (err) {
    console.error("Erro IA completa:", err);
    // não derruba, mas avisa
    try {
      const chatId = update?.message?.chat?.id;
      if (chatId) await sendMessage(chatId, "❌ Deu erro interno. Me mande o print do log do Render (últimas 15 linhas).");
    } catch {}
  }
}

module.exports = { handleTelegramUpdate };
