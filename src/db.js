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
  console.log("🧠 Sincronizando banco...");

  await exec(pool, `
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT,
      text TEXT,
      tag TEXT,
      payload JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // migração: garantir colunas
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS tag TEXT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS payload JSONB;`);

  await exec(pool, `
    CREATE TABLE IF NOT EXISTS ai_rules (
      id BIGSERIAL PRIMARY KEY,
      rule TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Tabela financeira estruturada (lançamento por linha)
  await exec(pool, `
    CREATE TABLE IF NOT EXISTS financial_records (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT,
      ref TEXT,                 -- nome do arquivo / origem
      source TEXT,              -- csv/pdf/manual
      date DATE,
      direction TEXT,           -- in/out/unknown
      amount NUMERIC,
      description TEXT,
      payee TEXT,               -- fornecedor / favorecido (quando houver)
      category TEXT,
      raw JSONB,                -- linha original
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // índices
  await exec(pool, `CREATE INDEX IF NOT EXISTS idx_fin_chat ON financial_records(chat_id);`);
  await exec(pool, `CREATE INDEX IF NOT EXISTS idx_fin_date ON financial_records(date);`);
  await exec(pool, `CREATE INDEX IF NOT EXISTS idx_fin_payee ON financial_records(payee);`);

  console.log("✅ Banco ok: events / ai_rules / financial_records");
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
