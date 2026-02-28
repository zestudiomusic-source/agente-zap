const { callOpenAI } = require("./openai");
const { extractTextFromFile } = require("./file_ingest");
const { buildDailyReport, buildWeeklyReport, buildStatusReport, listOpenOrders } = require("./reports");

function isAdmin(context, fromId) {
  return Number(fromId) === Number(context.TELEGRAM_ADMIN_ID);
}

async function saveEvent(db, evt) {
  const q = `
    INSERT INTO events (chat_id, chat_type, from_id, from_name, message_id, kind, text, file_name, file_mime, file_text, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
  `;
  const p = [
    evt.chat_id,
    evt.chat_type || null,
    evt.from_id || null,
    evt.from_name || null,
    evt.message_id || null,
    evt.kind || "text",
    evt.text || null,
    evt.file_name || null,
    evt.file_mime || null,
    evt.file_text || null,
    evt.payload ? JSON.stringify(evt.payload) : null,
  ];
  await db.exec(q, p);
}

async function getMemory(db, key, fallback) {
  const r = await db.exec("SELECT value FROM ai_memory WHERE key=$1", [key]);
  if (r.rows?.[0]?.value != null) return r.rows[0].value;
  return fallback;
}

async function setMemory(db, key, value) {
  await db.exec(
    `
    INSERT INTO ai_memory (key, value, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
    `,
    [key, JSON.stringify(value)]
  );
}

async function processMessage({ db, tg, message, context }) {
  const { chatId, chatLabel, fromId, fromName, messageId, text, doc } = message;

  // comandos rápidos
  if (text === "/status") return tg.sendMessage(chatId, await buildStatusReport(db));
  if (text === "/hoje") return tg.sendMessage(chatId, await buildDailyReport(db));
  if (text === "/semana") return tg.sendMessage(chatId, await buildWeeklyReport(db));
  if (text === "/pedidos") return tg.sendMessage(chatId, await listOpenOrders(db));

  let fileText = null;
  let fileName = null;
  let fileMime = null;

  if (doc && tg.getFileLink) {
    fileName = doc.file_name || null;
    fileMime = doc.mime_type || null;
    const link = await tg.getFileLink(doc.file_id);
    fileText = await extractTextFromFile({ fileUrl: link, fileName, mimeType: fileMime });
  }

  await saveEvent(db, {
    chat_id: chatId,
    chat_type: chatLabel,
    from_id: fromId,
    from_name: fromName,
    message_id: messageId,
    kind: doc ? "file" : "text",
    text: text || "",
    file_name: fileName,
    file_mime: fileMime,
    file_text: fileText,
    payload: { chatLabel },
  });

  // confirmação pendente
  const pending = await getMemory(db, "pending_confirm", null);

  if (pending && isYes(text)) {
    await applyPlannedActions(db, tg, pending, context);
    await setMemory(db, "pending_confirm", null);
    return tg.sendMessage(chatId, "✅ Confirmado. Ações aplicadas.");
  }
  if (pending && isNo(text)) {
    await setMemory(db, "pending_confirm", null);
    return tg.sendMessage(chatId, "❌ Cancelado. Nada foi alterado.");
  }

  const role = isAdmin(context, fromId) ? "ADM" : (chatLabel === "PRODUÇÃO" ? "PRODUÇÃO" : "MEMBRO");

  const lastState = await getMemory(db, "company_state", { last_decisions: [], preferences: { confirmations: "minimal" } });

  const prompt = buildPrompt({ role, chatLabel, fromName, text, fileName, fileMime, fileText, lastState });

  const aiText = await callOpenAI([
    { role: "system", content: systemPrompt() },
    { role: "user", content: prompt },
  ]);

  const plan = safeParseJSON(aiText);
  if (!plan) {
    return tg.sendMessage(chatId, aiText || "Entendi. Pode repetir com mais detalhes?");
  }

  const actions = Array.isArray(plan.actions) ? plan.actions : [];
  const critical = actions.some((a) => a && a.requires_confirm);

  const summary = plan.summary || "Ok.";
  const next = Array.isArray(plan.next_steps) ? plan.next_steps.slice(0, 5) : [];

  const msgOut =
    `<b>Entendi:</b> ${escapeHtml(summary)}\n` +
    (next.length ? `<b>Próximos passos:</b>\n- ${next.map(escapeHtml).join("\n- ")}` : "");

  await tg.sendMessage(chatId, msgOut);

  if (actions.length) {
    if (critical && role === "ADM") {
      await setMemory(db, "pending_confirm", plan);
      return tg.sendMessage(chatId, "Confirmar? (sim/não)");
    }
    await applyPlannedActions(db, tg, plan, context);
  }

  lastState.last_decisions = (lastState.last_decisions || []).slice(-19);
  lastState.last_decisions.push({ at: new Date().toISOString(), summary });
  await setMemory(db, "company_state", lastState);
}

function systemPrompt() {
  return `
Você é a IA gerente geral da empresa.
Você opera em DOIS grupos do Telegram: ADM e PRODUÇÃO.
Você deve transformar mensagens e arquivos (PDF/CSV) em ações e organização.

Responda SEMPRE em JSON válido, seguindo o schema:

{
  "summary": "1 frase",
  "next_steps": ["até 5 itens curtos"],
  "actions": [
    {
      "type": "create_order|update_order|message_adm|message_prod",
      "requires_confirm": true|false,
      "data": { ... }
    }
  ]
}

Regras de confirmação (requires_confirm=true) APENAS se:
- criar pedido
- mudar status para concluído/cancelado
- alterar valor
- definir/alterar prazo (due_date)

Se faltar informação, peça ao ADM com 1 pergunta curta via action message_adm.
`;
}

function buildPrompt({ role, chatLabel, fromName, text, fileName, fileMime, fileText, lastState }) {
  return `
CANAL: ${chatLabel}
REMETENTE: ${fromName} (${role})
MENSAGEM: ${text || ""}

${fileName ? `ARQUIVO: ${fileName} (${fileMime || "mime?"})` : ""}
${fileText ? `CONTEÚDO EXTRAÍDO:\n${fileText}` : ""}

ESTADO RECENTE (resumo):
${JSON.stringify(lastState).slice(0, 5000)}
`;
}

function safeParseJSON(s) {
  if (!s) return null;
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

function escapeHtml(str) {
  return String(str || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function isYes(t) {
  if (!t) return false;
  const x = String(t).trim().toLowerCase();
  return ["sim", "s", "confirmo", "ok", "yes"].includes(x);
}
function isNo(t) {
  if (!t) return false;
  const x = String(t).trim().toLowerCase();
  return ["não", "nao", "n", "cancelar", "no"].includes(x);
}

async function applyPlannedActions(db, tg, plan, context) {
  const ADM_CHAT_ID = context.ADM_CHAT_ID;
  const PROD_CHAT_ID = context.PROD_CHAT_ID;

  const actions = Array.isArray(plan.actions) ? plan.actions : [];
  for (const a of actions) {
    if (!a || !a.type) continue;

    if (a.type === "message_adm") {
      const t = a.data?.text || plan.summary || "Atualização";
      await tg.sendMessage(ADM_CHAT_ID, `📌 ${escapeHtml(t)}`);
      continue;
    }

    if (a.type === "message_prod") {
      const t = a.data?.text || plan.summary || "Atualização";
      await tg.sendMessage(PROD_CHAT_ID, `📌 ${escapeHtml(t)}`);
      continue;
    }

    if (a.type === "create_order") {
      const d = a.data || {};
      const r = await db.exec(
        `
        INSERT INTO orders (client_name, contact, address, description, notes, value_cents, status, priority, due_date, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
        RETURNING id
        `,
        [
          d.client_name || null,
          d.contact || null,
          d.address || null,
          d.description || null,
          d.notes || null,
          d.value_cents ?? null,
          d.status || "novo",
          Number.isFinite(d.priority) ? d.priority : 3,
          d.due_date || null,
        ]
      );
      const id = r.rows?.[0]?.id;
      await tg.sendMessage(ADM_CHAT_ID, `✅ Pedido criado (#${id}).`);
      await tg.sendMessage(PROD_CHAT_ID, `🧾 Novo pedido #${id}: ${escapeHtml(d.description || "(sem descrição)")}`);
      continue;
    }

    if (a.type === "update_order") {
      const d = a.data || {};
      if (!d.id) continue;

      const allow = ["client_name", "contact", "address", "description", "notes", "value_cents", "status", "priority", "due_date"];
      const fields = [];
      const values = [];
      let idx = 1;

      for (const k of allow) {
        if (d[k] !== undefined) {
          fields.push(`${k}=$${idx++}`);
          values.push(d[k]);
        }
      }
      if (!fields.length) continue;

      values.push(d.id);
      await db.exec(`UPDATE orders SET ${fields.join(", ")}, updated_at=NOW() WHERE id=$${idx}`, values);

      await tg.sendMessage(ADM_CHAT_ID, `✅ Pedido #${d.id} atualizado.`);
      if (d.status) await tg.sendMessage(PROD_CHAT_ID, `🔄 Pedido #${d.id} status: ${escapeHtml(d.status)}`);
    }
  }
}

module.exports = { processMessage };
