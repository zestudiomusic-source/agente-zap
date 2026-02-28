// src/telegram.js
const fetch = require("node-fetch");
const pdfParse = require("pdf-parse");
const { parse } = require("csv-parse/sync");

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

const ADM_CHAT_ID = Number(process.env.ADM_CHAT_ID);
const PROD_CHAT_ID = Number(process.env.PROD_CHAT_ID);

// pendência por chat (para confirmar importação)
const pending = {};

// memória curta por chat (diálogo linear)
const memory = {};
const MAX_MEM = 18;

function isAllowedChat(chatId) {
  return chatId === ADM_CHAT_ID || chatId === PROD_CHAT_ID;
}

function pushMem(chatId, role, content) {
  if (!memory[chatId]) memory[chatId] = [];
  memory[chatId].push({ role, content });
  if (memory[chatId].length > MAX_MEM) memory[chatId].shift();
}

async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  pushMem(chatId, "assistant", text);
}

async function downloadFile(fileId) {
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`
  );
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

  // remove R$, espaços
  let t = s.replace(/\s/g, "").replace("R$", "");

  // Se tiver '.' e ',' assume BR: 1.234,56
  // Se tiver só ',' assume decimal BR
  // Se tiver só '.' assume decimal EN
  if (t.includes(".") && t.includes(",")) {
    t = t.replace(/\./g, "").replace(",", ".");
  } else if (t.includes(",")) {
    t = t.replace(",", ".");
  }

  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// tenta detectar delimitador
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

// normaliza chaves de header
function normHeader(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^\w_]/g, "");
}

// extrai campos “prováveis” do CSV
function mapRowToTxn(rowObj) {
  const keys = Object.keys(rowObj);

  const pick = (arr) => {
    for (const k of arr) {
      const found = keys.find((x) => x === k);
      if (found) return rowObj[found];
    }
    return null;
  };

  // campos comuns em bancos
  const date =
    pick(["data", "date", "dt", "data_transacao"]) ||
    pick(["data_do_lancamento", "data_lancamento"]);

  const amount =
    pick(["valor", "amount", "vlr", "valor_rs", "valor_r"]) ||
    pick(["saida", "entrada"]);

  const desc =
    pick(["descricao", "description", "historico", "memo", "detalhe"]) ||
    pick(["identificador", "tipo", "categoria"]);

  const payee =
    pick(["estabelecimento", "favorecido", "beneficiario", "merchant", "payee"]) ||
    null;

  return { date, amount, desc, payee, raw: rowObj };
}

function parseDateAny(v) {
  if (!v) return null;
  const s = String(v).trim();

  // tenta dd/mm/yyyy
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;

  // tenta yyyy-mm-dd
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return s;

  return null;
}

// chama OpenAI com contexto (diálogo linear)
async function callAI(chatId, system, user, temperature = 0.35) {
  const msgs = [
    { role: "system", content: system },
    ...(memory[chatId] || []).slice(-12),
    { role: "user", content: user },
  ];

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature,
      input: msgs,
    }),
  });

  const data = await response.json();
  return data.output?.[0]?.content?.[0]?.text || "Entendi. Me diga o objetivo.";
}

// análise inteligente, mas com números já calculados no código
async function aiInsightsFromComputed(chatId, computed, samplePayees) {
  const system = `
Você é uma IA financeira e administrativa da empresa.
Você NÃO inventa nomes de fornecedores. Use apenas o que existir nos dados.
Se não houver coluna/descrição, diga claramente que não dá para identificar "pra quem".
Responda curto (até 6 linhas), direto e útil.`;

  const user = `
Resumo calculado (confiável):
- Entradas: R$ ${computed.in.toFixed(2)}
- Saídas: R$ ${computed.out.toFixed(2)}
- Saldo: R$ ${(computed.in - computed.out).toFixed(2)}
- Qtde lançamentos: ${computed.count}

Amostra de "payee/descrição" encontrada (se houver):
${samplePayees.length ? samplePayees.join("\n") : "(nenhuma descrição/payee encontrada)"}

Me dê:
1) leitura do período
2) top 5 possíveis fornecedores/descrições (se existirem)
3) o que falta para identificar "com quem foi" (se estiver faltando)
`;
  return callAI(chatId, system, user, 0.25);
}

async function handleTelegramUpdate(update, db) {
  try {
    if (!update.message) return;

    const msg = update.message;
    const chatId = msg.chat.id;

    if (!isAllowedChat(chatId)) return;

    // ----------- TEXTO -----------
    if (msg.text) {
      const text = msg.text.trim();
      pushMem(chatId, "user", text);

      // Se há pendência: só aceita "sim" ou "não". Perguntas mantêm pendência.
      if (pending[chatId]) {
        const t = text.toLowerCase();
        const isYes = t === "sim" || t.startsWith("sim ");
        const isNo = t === "não" || t === "nao" || t.startsWith("não ") || t.startsWith("nao ");

        if (isYes) {
          const p = pending[chatId];

          // salva “documento bruto” como evento
          await db.exec(
            `INSERT INTO events (chat_id, text, tag, payload) VALUES ($1,$2,$3,$4)`,
            [chatId, `Importação confirmada: ${p.ref}`, "IMPORT_CONFIRM", p.computed]
          );

          // salva transações estruturadas
          // (limit de segurança para não estourar)
          const txns = p.txns.slice(0, 3000);

          for (const tx of txns) {
            await db.exec(
              `INSERT INTO financial_records
               (chat_id, ref, source, date, direction, amount, description, payee, category, raw)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [
                chatId,
                p.ref,
                p.source,
                tx.date || null,
                tx.direction || "unknown",
                tx.amount,
                tx.description || null,
                tx.payee || null,
                null,
                tx.raw || null,
              ]
            );
          }

          delete pending[chatId];
          await sendMessage(chatId, "✅ Importado e salvo. Quer que eu gere **Top gastos** e **gastos por fornecedor**?");
          return;
        }

        if (isNo) {
          delete pending[chatId];
          await sendMessage(chatId, "Ok. ❌ Cancelado. Nada foi salvo.");
          return;
        }

        // pergunta sem cancelar
        const reply = await callAI(
          chatId,
          `Você é a IA gerente/financeiro. Existe uma importação pendente.
Responda a pergunta do usuário e repita a confirmação (sim/não) em 1 linha.`,
          `Pergunta: ${text}\n\nPendência: ${pending[chatId].ref}\nResumo: ${JSON.stringify(pending[chatId].computed)}`
        );
        await sendMessage(chatId, `${reply}\n\nConfirmar importação? (sim/não)`);
        return;
      }

      // conversa normal com contexto
      await db.exec(
        `INSERT INTO events (chat_id, text, tag) VALUES ($1,$2,$3)`,
        [chatId, text, "MSG"]
      );

      const reply = await callAI(
        chatId,
        `Você é uma IA gerente completa da empresa.
Responda curto (1-3 linhas), inteligente e com contexto da conversa.
Se for ação crítica, peça confirmação.`,
        text,
        0.35
      );

      await sendMessage(chatId, reply);
      return;
    }

    // ----------- DOCUMENTO -----------
    if (msg.document) {
      const fileName = (msg.document.file_name || "arquivo").toLowerCase();
      const mimeType = msg.document.mime_type || "";

      await sendMessage(chatId, "📄 Documento recebido. Lendo e calculando (sem inventar números)...");

      const buffer = await downloadFile(msg.document.file_id);
      let source = "file";
      let txns = [];

      // PDF (aqui é texto; “pra quem foi” só se o PDF tiver essa info)
      if (fileName.endsWith(".pdf") || mimeType.includes("pdf")) {
        source = "pdf";
        const pdfData = await pdfParse(buffer);
        const text = (pdfData.text || "").slice(0, 20000);

        // para PDF, não dá para estruturar linha por linha sem layout.
        // então salvamos como 1 txn “unknown”, mas o cálculo será feito se houver valores detectáveis.
        // (melhorias depois: extractor por padrão do banco)
        txns = [{
          date: null,
          amount: 0,
          direction: "unknown",
          description: "PDF importado (texto disponível em raw)",
          payee: null,
          raw: { text },
        }];
      }

      // CSV (aqui sim fica 100% determinístico)
      if (fileName.endsWith(".csv") || mimeType.includes("csv") || mimeType.includes("excel")) {
        source = "csv";
        const csvText = buffer.toString("utf-8");
        const delimiter = detectDelimiter(csvText);

        // tenta com header
        let records;
        try {
          records = parse(csvText, {
            delimiter,
            columns: (h) => normHeader(h),
            skip_empty_lines: true,
            relax_column_count: true,
          });
        } catch (e) {
          // fallback sem header
          const rows = parse(csvText, {
            delimiter,
            skip_empty_lines: true,
            relax_column_count: true,
          });
          // transforma em obj genérico col1,col2...
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

      // cálculo determinístico
      let totalIn = 0;
      let totalOut = 0;
      let count = 0;

      for (const tx of txns) {
        if (typeof tx.amount === "number") {
          count++;
          if (tx.amount >= 0) totalIn += tx.amount;
          else totalOut += Math.abs(tx.amount);
        }
      }

      // amostra de payees/descrições (para dizer “pra quem foi” quando existir)
      const samplePayees = [];
      for (const tx of txns) {
        const line = tx.payee || tx.description;
        if (line && !samplePayees.includes(line)) samplePayees.push(line);
        if (samplePayees.length >= 12) break;
      }

      const computed = { in: totalIn, out: totalOut, count, balance: totalIn - totalOut };

      const insight = await aiInsightsFromComputed(chatId, computed, samplePayees);

      // cria pendência pra confirmar importação
      pending[chatId] = {
        ref: fileName,
        source,
        computed,
        txns,
      };

      await sendMessage(
        chatId,
        `✅ Cálculo (confiável):\nEntradas: R$ ${totalIn.toFixed(2)}\nSaídas: R$ ${totalOut.toFixed(2)}\nSaldo: R$ ${(totalIn - totalOut).toFixed(2)}\n\n${insight}\n\nImportar e salvar esses lançamentos no financeiro? (sim/não)`
      );

      return;
    }
  } catch (err) {
    console.error("Erro IA completa:", err);
  }
}

module.exports = { handleTelegramUpdate };
