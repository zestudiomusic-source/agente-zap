// src/workflow.js
async function executePlan(db, chatId, plan) {
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  const results = [];

  for (const a of actions) {
    if (a.type === "save_financial_records") {
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
            r.direction || "unknown",
            r.amount ?? null,
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

    if (a.type === "save_rule") {
      if (a.rule) {
        await db.exec(
          `INSERT INTO public.ai_rules(chat_id, rule, active) VALUES($1,$2,true)`,
          [chatId, a.rule]
        );
        results.push("Regra permanente salva.");
      }
      continue;
    }

    results.push(`Ação ignorada: ${a.type}`);
  }

  return results;
}

async function handleYesNo(db, chatId, textLower) {
  const isYes = textLower === "sim" || textLower.startsWith("sim ");
  const isNo =
    textLower === "não" ||
    textLower === "nao" ||
    textLower.startsWith("não ") ||
    textLower.startsWith("nao ");

  if (!isYes && !isNo) return null;

  const r = await db.exec(
    `
    SELECT id, question, plan
    FROM public.pending_actions
    WHERE chat_id=$1 AND status='pending'
    ORDER BY id DESC
    LIMIT 1
  `,
    [chatId]
  );

  const p = r.rows[0];
  if (!p) return "Não achei nada pendente para confirmar.";

  if (isNo) {
    await db.exec(
      `UPDATE public.pending_actions SET status='rejected', decided_at=NOW() WHERE id=$1`,
      [p.id]
    );
    return "Ok. ❌ Cancelado. Nada foi salvo/executado.";
  }

  await db.exec(
    `UPDATE public.pending_actions SET status='approved', decided_at=NOW() WHERE id=$1`,
    [p.id]
  );

  try {
    const results = await executePlan(db, chatId, p.plan);
    await db.exec(`UPDATE public.pending_actions SET status='done' WHERE id=$1`, [p.id]);
    return `✅ Executado.\n- ${results.join("\n- ")}`;
  } catch (e) {
    await db.exec(`UPDATE public.pending_actions SET status='error' WHERE id=$1`, [p.id]);
    return `❌ Erro ao executar: ${e.message}`;
  }
}

module.exports = { handleYesNo };
