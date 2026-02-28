// src/db.js
const { Pool } = require("pg");

function makePool() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL não configurado");
  }

  return new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // obrigatório no Render
  });
}

async function exec(pool, sql, params = []) {
  return pool.query(sql, params);
}

async function initSchema(pool) {
  console.log("🧠 Sincronizando banco de dados...");

  // ===== TABELA DE MEMÓRIA DA IA (EVENTOS) =====
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
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    `
  );

  // ===== MIGRAÇÃO (CORRIGE SE BANCO ANTIGO NÃO TIVER AS COLUNAS) =====
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS chat_id BIGINT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS chat_type TEXT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS from_id BIGINT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS from_name TEXT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS message_id BIGINT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS text TEXT;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS payload JSONB;`);
  await exec(pool, `ALTER TABLE events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);

  // ===== MEMÓRIA ESTRATÉGICA DA IA =====
  await exec(
    pool,
    `
    CREATE TABLE IF NOT EXISTS ai_memory (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    `
  );

  // ===== PEDIDOS DA EMPRESA =====
  await exec(
    pool,
    `
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      client_name TEXT,
      description TEXT,
      value_cents BIGINT,
      status TEXT DEFAULT 'novo',
      priority INTEGER DEFAULT 3,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    `
  );

  console.log("✅ Banco sincronizado (events + ai_memory + orders)");
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
