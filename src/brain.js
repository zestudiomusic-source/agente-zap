// src/brain.js (IA CEO: planeja + pede confirmação + executa)
const crypto = require("crypto");

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// --- helpers DB ---
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
    `SELECT id, rule FROM public.ai_rules WHERE (chat_id=$1 OR chat_id IS NULL) AND active=true ORDER BY id ASC`,
    [chatId]
  );
  return r.rows.map(x => x.rule);
}

async function logEvent(db, chatId, role, text, tag = null, payload = null) {
  await db.exec(
    `INSERT INTO public.events(chat_id, role, text, tag, payload) VALUES($1,$2,$3,$4,$5)`,
    [chatId, role, text, tag, payload]
  );
}

// --- OpenAI call (simples, sem “inventar execução”) ---
async function callOpenAI({ apiKey, model, system, messages }) {
  // Você já tem openai.js no projeto; se não tiver, mantenha aqui.
  // Implementação minimalista via fetch.
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model || "gpt-4.1-mini",
      temperature: 0.2,
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI error: ${res.status} ${t}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

/**
 * IA CEO = sempre retorna:
 * - reply (texto curto pro Telegram)
 * - proposal (opcional) => {question, plan} para pedir confirmação
 */
async function thinkCEO({ db, chatId, userText, attachments = [] }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { reply: "OPENAI_API_KEY não configurada no Render. Não consigo pensar/decidir ainda." };
  }

  const summary = await getSummary(db, chatId);
  const rules = await getRules(db, chatId);

  // “Janela” do contexto: últimos eventos (para chat linear real)
  const last = await db.exec(
    `SELECT role, text, tag, created_at FROM public.events WHERE chat_id=$1 ORDER BY id DESC LIMIT 20`,
    [chatId]
  );

  const history = last.rows.reverse().map(r => ({
    role: r.role === "assistant" ? "assistant" : "user",
    content: r.text || "",
  }));

  const system = `
Você é a IA CEO de uma empresa.
Objetivo: gerir toda a operação (ADM e PRODUÇÃO) com decisões práticas.

REGRAS IMPORTANTES:
1) Respostas sempre curtas e objetivas.
2) NUNCA diga que executou algo (enviou email, gerou PDF, salvou) se não for execução confirmada.
3) Se faltar dado (ex: CSV sem descrição/estabelecimento), diga isso claramente, sem inventar.
4) Você deve:
   - interpretar mensagens
   - propor ações (com confirmação curta)
   - registrar o que deve ser salvo no banco
   - criar regras permanentes quando o dono mandar “a partir de hoje...”
5) SEMPRE que for executar algo real: peça confirmação em 1 linha: "Confirmar? (sim/não)"

CONTEXTO RESUMIDO (memória persistente):
${summary || "(vazio)"}

REGRAS PERMANENTES ATIVAS:
${rules.length ? rules.map((r,i)=>`${i+1}) ${r}`).join("\n") : "(nenhuma)"}

ANEXOS RECEBIDOS:
${attachments.length ? attachments.map(a => `- ${a.file_name} (${a.mime_type || "?"}, ${a.bytes || "?"} bytes)`).join("\n") : "(nenhum)"}

Saída no formato JSON E SOMENTE JSON:
{
  "reply": "texto curto pro Telegram",
  "need_confirm": true/false,
  "question": "pergunta curta (se need_confirm=true)",
  "plan": { ... objeto com ações ... },
  "new_memory": "resumo atualizado (curto)",
  "save_rule": "se o usuário deu uma ordem permanente, escreva aqui, senão null"
}
`;

  const raw = await callOpenAI({
    apiKey,
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    system,
    messages: [...history, { role: "user", content: userText }],
  });

  // parse seguro
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    // fallback: não quebra o bot
    return { reply: "Não consegui estruturar a resposta. Reenvie em 1 frase objetiva." };
  }

  // Atualiza memória
  if (typeof obj.new_memory === "string") {
    await setSummary(db, chatId, obj.new_memory.slice(0, 2000));
  }

  // Salva regra permanente se tiver
  if (obj.save_rule && typeof obj.save_rule === "string") {
    await db.exec(
      `INSERT INTO public.ai_rules(chat_id, rule, active) VALUES($1,$2,true)`,
      [chatId, obj.save_rule]
    );
  }

  // Log
  await logEvent(db, chatId, "assistant", obj.reply || "", "ceo_reply", obj.plan || null);

  if (obj.need_confirm) {
    // registra pendência
    const q = (obj.question || "Confirmar execução?").slice(0, 400);
    const plan = obj.plan || {};
    const r = await db.exec(
      `INSERT INTO public.pending_actions(chat_id, question, plan) VALUES($1,$2,$3) RETURNING id`,
      [chatId, q, plan]
    );

    const id = r.rows[0].id;
    return {
      reply: `${obj.reply}\n\n${q}\nID: ${id} — Confirmar? (sim/não)`,
      pending_id: id,
    };
  }

  return { reply: obj.reply || "Ok." };
}

module.exports = { thinkCEO, logEvent };
