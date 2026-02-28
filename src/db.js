const { Pool } = require("pg");

function makePool() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) throw new Error("DATABASE_URL não configurado");
  return new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

async function exec(pool, sql, params = []) {
  return pool.query(sql, params);
}

async function initSchema(pool) {
  await exec(
    pool,
    `
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      chat_type TEXT,
      from_id BIGINT,
      from_name TEXT,
      message_id BIGINT,
      kind TEXT NOT NULL DEFAULT 'text',
      text TEXT,
      file_name TEXT,
      file_mime TEXT,
      file_text TEXT,
      payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    `
  );

  await exec(
    pool,
    `
    CREATE TABLE IF NOT EXISTS ai_memory (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    `
  );

  await exec(
    pool,
    `
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      client_name TEXT,
      contact TEXT,
      address TEXT,
      description TEXT,
      notes TEXT,
      value_cents BIGINT,
      status TEXT NOT NULL DEFAULT 'novo',
      priority INTEGER NOT NULL DEFAULT 3,
      due_date DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    `
  );

  await exec(pool, `ALTER TABLE orders ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 3;`);
  await exec(pool, `ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text';`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS file_name TEXT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS file_mime TEXT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS file_text TEXT;`);

  await exec(pool, `CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);`);
  await exec(pool, `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);`);
  await exec(pool, `CREATE INDEX IF NOT EXISTS idx_orders_due_date ON orders(due_date);`);
  await exec(pool, `CREATE INDEX IF NOT EXISTS idx_orders_priority ON orders(priority);`);

  console.log("✅ DB pronto: events / ai_memory / orders");
}

async function createDb() {
  const pool = makePool();
  await exec(pool, "SELECT 1");
  await initSchema(pool);

  return {
    pool,
    exec: (sql, params) => exec(pool, sql, params),
  };
}

module.exports = { createDb };
