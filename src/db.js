// src/db.js (VERSÃO DEFININITIVA ANTI-ERRO 42703)
const { Pool } = require("pg");

function makePool() {
  const DATABASE_URL = process.env.DATABASE_URL;

  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL não configurado no Render");
  }

  return new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

async function exec(pool, sql, params = []) {
  return pool.query(sql, params);
}

async function initSchema(pool) {
  console.log("🧠 Sincronizando banco... (modo seguro)");

  // 1) CRIA TABELA BASE SUPER SIMPLES (SEM ÍNDICES)
  await exec(
    pool,
    `
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY
    );
  `
  );

  // 2) MIGRAÇÃO SEGURA COLUNA POR COLUNA (ESSA PARTE EVITA O ERRO 42703)
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS chat_id BIGINT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS text TEXT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS tag TEXT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS payload JSONB;`);
  await exec(
    pool,
    `ALTER TABLE events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`
  );

  // 3) TABELA DE REGRAS DA IA (ORDENS PERMANENTES)
  await exec(
    pool,
    `
    CREATE TABLE IF NOT EXISTS ai_rules (
      id BIGSERIAL PRIMARY KEY,
      rule TEXT NOT NULL,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `
  );

  // 4) TABELA FINANCEIRA (PARA CSV / PDF / EXTRATOS)
  await exec(
    pool,
    `
    CREATE TABLE IF NOT EXISTS financial_records (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT,
      date DATE,
      amount NUMERIC,
      description TEXT,
      payee TEXT,
      category TEXT,
      source TEXT,
      raw JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `
  );

  // 5) AGORA SIM CRIAR ÍNDICES (DEPOIS DAS COLUNAS EXISTIREM)
  await exec(
    pool,
    `CREATE INDEX IF NOT EXISTS idx_events_chat_id ON events(chat_id);`
  );
  await exec(
    pool,
    `CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);`
  );
  await exec(
    pool,
    `CREATE INDEX IF NOT EXISTS idx_financial_chat ON financial_records(chat_id);`
  );

  console.log("✅ Banco sincronizado com sucesso (migração segura aplicada)");
}

async function createDb() {
  const pool = makePool();

  // Testa conexão primeiro
  await exec(pool, "SELECT 1");

  // Depois sincroniza
  await initSchema(pool);

  return {
    pool,
    exec: (sql, params) => exec(pool, sql, params),
  };
}

module.exports = { createDb };
