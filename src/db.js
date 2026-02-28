// src/db.js
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
  console.log("🧠 Sincronizando banco de dados...");

  // 1) Cria a tabela base (se não existir)
  await exec(
    pool,
    `
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT,
      chat_type TEXT,
      from_id BIGINT,
      from_name TEXT,
      message_id BIGINT,
      text TEXT,
      payload JSONB,
      tag TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    `
  );

  // 2) Migrações (se existir antiga, garante colunas)
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS chat_id BIGINT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS chat_type TEXT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS from_id BIGINT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS from_name TEXT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS message_id BIGINT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS text TEXT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS payload JSONB;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS tag TEXT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);

  // Regras permanentes
  await exec(
    pool,
    `
    CREATE TABLE IF NOT EXISTS ai_rules (
      id BIGSERIAL PRIMARY KEY,
      rule TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    `
  );

  // Financeiro estruturado
  await exec(
    pool,
    `
    CREATE TABLE IF NOT EXISTS financial_records (
      id BIGSERIAL PRIMARY KEY,
      type TEXT,
      description TEXT,
      amount NUMERIC,
      source TEXT,
      ref TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    `
  );

  // Logs de ações pendentes/confirmadas (opcional mas útil)
  await exec(
    pool,
    `
    CREATE TABLE IF NOT EXISTS ai_actions (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT,
      summary TEXT,
      payload JSONB,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ
    );
    `
  );

  // Índices
  await exec(pool, `CREATE INDEX IF NOT EXISTS idx_events_chat_id ON events(chat_id);`);
  await exec(pool, `CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);`);
  await exec(pool, `CREATE INDEX IF NOT EXISTS idx_events_tag ON events(tag);`);

  console.log("✅ Banco sincronizado (events + ai_rules + financial_records + ai_actions)");
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
