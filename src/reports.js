async function buildStatusReport(db) {
  const open = await db.exec(`SELECT COUNT(*)::int AS n FROM orders WHERE status IN ('novo','em_producao','aguardando')`);
  const done = await db.exec(`SELECT COUNT(*)::int AS n FROM orders WHERE status IN ('concluido')`);
  const late = await db.exec(`SELECT COUNT(*)::int AS n FROM orders WHERE due_date IS NOT NULL AND due_date < CURRENT_DATE AND status NOT IN ('concluido','cancelado')`);
  return (
    `<b>📊 Status geral</b>\n` +
    `Abertos: ${open.rows[0].n}\n` +
    `Concluídos: ${done.rows[0].n}\n` +
    `Atrasados: ${late.rows[0].n}`
  );
}

async function listOpenOrders(db) {
  const r = await db.exec(
    `
    SELECT id, description, status, priority, due_date
    FROM orders
    WHERE status NOT IN ('concluido','cancelado')
    ORDER BY priority ASC, due_date NULLS LAST, updated_at DESC
    LIMIT 30
    `
  );
  if (!r.rows.length) return "Sem pedidos abertos.";
  const lines = r.rows.map((o) => `#${o.id} [p${o.priority}] (${o.status}) ${o.description || "(sem descrição)"}${o.due_date ? " — prazo: " + o.due_date : ""}`);
  return `<b>🧾 Pedidos abertos</b>\n` + lines.join("\n");
}

async function buildDailyReport(db) {
  const r1 = await db.exec(`SELECT COUNT(*)::int AS n FROM events WHERE created_at >= NOW() - INTERVAL '24 hours'`);
  const r2 = await db.exec(`SELECT COUNT(*)::int AS n FROM orders WHERE created_at >= NOW() - INTERVAL '24 hours'`);
  const r3 = await db.exec(`SELECT COUNT(*)::int AS n FROM orders WHERE status='concluido' AND updated_at >= NOW() - INTERVAL '24 hours'`);

  const top = await db.exec(
    `
    SELECT id, description, status, priority, due_date
    FROM orders
    WHERE status NOT IN ('concluido','cancelado')
    ORDER BY priority ASC, due_date NULLS LAST, updated_at DESC
    LIMIT 8
    `
  );

  const lines = top.rows.map((o) => `• #${o.id} [p${o.priority}] (${o.status}) ${o.description || "(sem descrição)"}${o.due_date ? " — " + o.due_date : ""}`);

  return (
    `<b>📅 Relatório diário</b>\n` +
    `Eventos (24h): ${r1.rows[0].n}\n` +
    `Pedidos criados (24h): ${r2.rows[0].n}\n` +
    `Concluídos (24h): ${r3.rows[0].n}\n\n` +
    `<b>Prioridades agora:</b>\n` +
    (lines.length ? lines.join("\n") : "—")
  );
}

async function buildWeeklyReport(db) {
  const r1 = await db.exec(`SELECT COUNT(*)::int AS n FROM events WHERE created_at >= NOW() - INTERVAL '7 days'`);
  const r2 = await db.exec(`SELECT COUNT(*)::int AS n FROM orders WHERE created_at >= NOW() - INTERVAL '7 days'`);
  const r3 = await db.exec(`SELECT COUNT(*)::int AS n FROM orders WHERE status='concluido' AND updated_at >= NOW() - INTERVAL '7 days'`);

  const byStatus = await db.exec(
    `
    SELECT status, COUNT(*)::int AS n
    FROM orders
    GROUP BY status
    ORDER BY n DESC
    `
  );

  const lines = byStatus.rows.map((x) => `• ${x.status}: ${x.n}`);

  return (
    `<b>🗓️ Relatório semanal</b>\n` +
    `Eventos (7d): ${r1.rows[0].n}\n` +
    `Pedidos criados (7d): ${r2.rows[0].n}\n` +
    `Concluídos (7d): ${r3.rows[0].n}\n\n` +
    `<b>Pedidos por status:</b>\n` +
    (lines.length ? lines.join("\n") : "—")
  );
}

module.exports = { buildStatusReport, buildDailyReport, buildWeeklyReport, listOpenOrders };
