const { Pool } = require('pg');

function createLogger(name = 'DB') {
  return {
    info: (...args) => console.log(`[${name}]`, ...args),
    warn: (...args) => console.warn(`[${name}]`, ...args),
    error: (...args) => console.error(`[${name}]`, ...args)
  };
}

const log = createLogger('DB');

function makePool() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL não configurado');
  }

  // Render Postgres normalmente precisa SSL
  const ssl = process.env.PGSSLMODE === 'disable'
    ? false
    : { rejectUnauthorized: false };

  return new Pool({ connectionString: DATABASE_URL, ssl });
}

async function exec(pool, sql, params = []) {
  return pool.query(sql, params);
}

async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await fn({
      query: (sql, params) => client.query(sql, params)
    });
    await client.query('COMMIT');
    return res;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function initSchema(pool) {
  // Minimal schema for ERP
  const ddl = `
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS groups (
    key TEXT PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    has_topics BOOLEAN NOT NULL DEFAULT FALSE,
    title TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY,
    client_name TEXT,
    contact TEXT,
    address TEXT,
    description TEXT,
    notes TEXT,
    value_cents BIGINT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    due_date DATE,
    source_group_key TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_due_date ON orders(due_date);
  `;

  await exec(pool, ddl);
}

async function createDb() {
  const pool = makePool();
  // quick ping
  await exec(pool, 'SELECT 1');
  await initSchema(pool);

  return {
    pool,
    exec: (sql, params) => exec(pool, sql, params),
    transaction: (fn) => transaction(pool, fn)
  };
}

module.exports = {
  createDb
};
