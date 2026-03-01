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

  // EVENTS (log do chat + ações)
  await exec(pool, `
    CREATE TABLE IF NOT EXISTS public.events (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT,
      role TEXT,
      text TEXT,
      tag TEXT,
      payload JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // garante colunas (para bases antigas)
  await exec(pool, `ALTER TABLE public.events ADD COLUMN IF NOT EXISTS chat_id BIGINT;`);
  await exec(pool, `ALTER TABLE public.events ADD COLUMN IF NOT EXISTS role TEXT;`);
  await exec(pool, `ALTER TABLE public.events ADD COLUMN IF NOT EXISTS text TEXT;`);
  await exec(pool, `ALTER TABLE public.events ADD COLUMN IF NOT EXISTS tag TEXT;`);
  await exec(pool, `ALTER TABLE public.events ADD COLUMN IF NOT EXISTS payload JSONB;`);
  await exec(pool, `ALTER TABLE public.events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);

  await exec(pool, `CREATE INDEX IF NOT EXISTS idx_events_chat_time ON public.events(chat_id, created_at);`);

  // MEMÓRIA PERSISTENTE por chat (resumo curto)
  await exec(pool, `
    CREATE TABLE IF NOT EXISTS public.chat_memory (
      chat_id BIGINT PRIMARY KEY,
      summary TEXT DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // PENDÊNCIAS (confirmação sim/não)
  await exec(pool, `
    CREATE TABLE IF NOT EXISTS public.pending_actions (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      question TEXT NOT NULL,
      plan JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',  -- pending/approved/rejected/done/error
      created_at TIMESTAMPTZ DEFAULT NOW(),
      decided_at TIMESTAMPTZ
    );
  `);
  await exec(pool, `CREATE INDEX IF NOT EXISTS idx_pending_chat ON public.pending_actions(chat_id, status);`);

  // REGRAS PERMANENTES (ordens que você manda e ficam ativas)
  await exec(pool, `
    CREATE TABLE IF NOT EXISTS public.ai_rules (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT,
      rule TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // FINANCEIRO
  await exec(pool, `
    CREATE TABLE IF NOT EXISTS public.financial_records (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT,
      source TEXT,
      ref TEXT,
      date DATE,
      direction TEXT,
      amount NUMERIC,
      description TEXT,
      payee TEXT,
      category TEXT,
      raw JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await exec(pool, `CREATE INDEX IF NOT EXISTS idx_fin_chat_date ON public.financial_records(chat_id, date);`);

  console.log("✅ Banco OK");
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
