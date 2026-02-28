function toCents(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Math.round(value * 100);
  const s = String(value).trim().replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  if (Number.isFinite(n)) return Math.round(n * 100);
  return null;
}

function formatMoneyBRL(cents) {
  if (cents == null) return '—';
  const n = cents / 100;
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function startOfTodayISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function startOfTomorrowISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

async function createOrder(db, payload) {
  const {
    client_name,
    contact,
    address,
    description,
    notes,
    value,
    due_date,
    source_group_key
  } = payload;

  const value_cents = toCents(value);

  const q = `
    INSERT INTO orders (client_name, contact, address, description, notes, value_cents, due_date, source_group_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *
  `;

  const r = await db.exec(q, [
    client_name || null,
    contact || null,
    address || null,
    description || null,
    notes || null,
    value_cents,
    due_date || null,
    source_group_key || null
  ]);

  return r.rows[0];
}

async function listTodayOrders(db) {
  const q = `
    SELECT *
    FROM orders
    WHERE created_at >= $1 AND created_at < $2
    ORDER BY created_at ASC
  `;
  const r = await db.exec(q, [startOfTodayISO(), startOfTomorrowISO()]);
  return r.rows;
}

async function listOpenOrders(db) {
  const q = `
    SELECT *
    FROM orders
    WHERE status <> 'done'
    ORDER BY (due_date IS NULL) ASC, due_date ASC, created_at ASC
  `;
  const r = await db.exec(q);
  return r.rows;
}

function formatOrderLine(o) {
  const parts = [];
  parts.push(`#${o.id}`);
  if (o.client_name) parts.push(o.client_name);
  if (o.description) parts.push(`— ${o.description}`);
  if (o.value_cents != null) parts.push(`(${formatMoneyBRL(o.value_cents)})`);
  if (o.due_date) parts.push(`📅 ${o.due_date}`);
  return parts.join(' ');
}

module.exports = {
  createOrder,
  listTodayOrders,
  listOpenOrders,
  formatOrderLine,
  formatMoneyBRL
};
