// src/workflow.js (executa planos aprovados)
const { sendEmail } = require("./email");
const { generateSimplePDF } = require("./pdf");

async function executePlan({ db, chatId, plan }) {
  // Plano é JSON criado pela IA (com sua confirmação)
  // Aqui é onde vira “real”.

  const actions = Array.isArray(plan?.actions) ? plan.actions : [];

  const results = [];

  for (const a of actions) {
    const type = a?.type;

    if (type === "save_financial_records") {
      const rows = Array.isArray(a.records) ? a.records : [];
      for (const r of rows) {
        await db.exec(
          `
          INSERT INTO public.financial_records
            (chat_id, source, ref, date, direction, amount, description, payee, category, raw)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `,
          [
            chatId,
            r.source || "manual",
            r.ref || null,
            r.date || null,
            r.direction || null,
            r.amount || null,
            r.description || null,
            r.payee || null,
            r.category || null,
            r.raw || null,
          ]
        );
      }
      results.push(`Financeiro: ${rows.length} lançamentos salvos.`);
      continue;
    }

    if (type === "generate_pdf") {
      const pdfPath = await generateSimplePDF(a.title || "Documento", a.lines || []);
      results.push(`PDF gerado: ${pdfPath}`);
      continue;
    }

    if (type === "send_email") {
      const ok = await sendEmail({
        to: a.to,
        subject: a.subject || "Documento",
        text: a.text || "",
        attachments: a.attachments || [],
      });
      results.push(ok ? `Email enviado para ${a.to}` : `Email NÃO enviado (email não configurado).`);
      continue;
    }

    if (type === "save_rule") {
      if (a.rule) {
        await db.exec(`INSERT INTO public.ai_rules(chat_id, rule, active) VALUES($1,$2,true)`, [
          chatId,
          a.rule,
        ]);
        results.push("Regra permanente salva.");
      }
      continue;
    }

    results.push(`Ação ignorada (tipo desconhecido): ${type}`);
  }

  return results;
}

async function handleYesNo({ db, chatId, userText }) {
  const txt = (userText || "").trim().toLowerCase();

  if (txt !== "sim" && txt !== "não" && txt !== "nao") return null;

  // pega a última pendência
  const r = await db.exec(
    `
    SELECT id, plan, question
    FROM public.pending_actions
    WHERE chat_id=$1 AND status='pending'
    ORDER BY id DESC
    LIMIT 1
  `,
    [chatId]
  );

  const pending = r.rows[0];
  if (!pending) return "Não achei nenhuma ação pendente para confirmar.";

  if (txt === "não" || txt === "nao") {
    await db.exec(
      `UPDATE public.pending_actions SET status='rejected', decided_at=NOW() WHERE id=$1`,
      [pending.id]
    );
    return "Cancelado. Nenhuma ação foi executada.";
  }

  // aprovado
  await db.exec(
    `UPDATE public.pending_actions SET status='approved', decided_at=NOW() WHERE id=$1`,
    [pending.id]
  );

  try {
    const results = await executePlan({ db, chatId, plan: pending.plan });
    await db.exec(`UPDATE public.pending_actions SET status='done' WHERE id=$1`, [pending.id]);
    return `Executado.\n- ${results.join("\n- ")}`;
  } catch (e) {
    await db.exec(`UPDATE public.pending_actions SET status='error' WHERE id=$1`, [pending.id]);
    return `Erro ao executar: ${e.message}`;
  }
}

module.exports = { handleYesNo };
