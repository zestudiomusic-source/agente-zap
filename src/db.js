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

  // 1) Garante que a tabela exista (pode existir antiga)
  await exec(
    pool,
    `
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT,
      text TEXT,
      tag TEXT,
      payload JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `
  );

  // 2) MIGRAÇÕES (pra quem já tinha tabela antiga)
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS chat_id BIGINT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS text TEXT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS tag TEXT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS payload JSONB;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);

  // Se sua tabela antiga usava coluna "message", copia pra "text"
  // (não dá erro se não existir)
  await exec(
    pool,
    `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name='events' AND column_name='message'
      ) THEN
        UPDATE events
        SET text = COALESCE(text, message)
        WHERE text IS NULL;
      END IF;
    END $$;
  `
  );

  // 3) Regras/ordens da IA (para "passar a fazer algo" e ela lembrar)
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

  // 4) Financeiro estruturado (lançamento por linha do CSV)
  await exec(
    pool,
    `
    CREATE TABLE IF NOT EXISTS financial_records (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT,
      ref TEXT,
      source TEXT,
      date DATE,
      direction TEXT,
      amount NUMERIC,
      description TEXT,
      payee TEXT,
      category TEXT,
      raw JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `
  );

  // índices
  await exec(pool, `CREATE INDEX IF NOT EXISTS idx_fin_chat ON financial_records(chat_id);`);
  await exec(pool, `CREATE INDEX IF NOT EXISTS idx_fin_date ON financial_records(date);`);
  await exec(pool, `CREATE INDEX IF NOT EXISTS idx_fin_payee ON financial_records(payee);`);

  console.log("✅ Banco OK (migrado): events / ai_rules / financial_records");
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
