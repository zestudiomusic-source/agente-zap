// src/db.js (CEO MODE - ultra safe migrations)
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
  console.log("🧠 Sincronizando banco... (CEO mode)");

  // Sempre public.*
  await exec(pool, `CREATE SCHEMA IF NOT EXISTS public;`);

  // EVENTS (log geral)
  await exec(pool, `
    CREATE TABLE IF NOT EXISTS public.events (
      id BIGSERIAL PRIMARY KEY
    );
  `);

  await exec(pool, `ALTER TABLE public.events ADD COLUMN IF NOT EXISTS chat_id BIGINT;`);
  await exec(pool, `ALTER TABLE public.events ADD COLUMN IF NOT EXISTS role TEXT;`);        // user/assistant/system
  await exec(pool, `ALTER TABLE public.events ADD COLUMN IF NOT EXISTS text TEXT;`);
  await exec(pool, `ALTER TABLE public.events ADD COLUMN IF NOT EXISTS tag TEXT;`);         // finance/pdf/order/etc
  await exec(pool, `ALTER TABLE public.events ADD COLUMN IF NOT EXISTS payload JSONB;`);
  await exec(pool, `ALTER TABLE public.events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);

  // MEMORY (contexto linear por chat)
  await exec(pool, `
    CREATE TABLE IF NOT EXISTS public.chat_memory (
      chat_id BIGINT PRIMARY KEY,
      summary TEXT DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // PENDING ACTIONS (fila de ações com confirmação)
  await exec(pool, `
    CREATE TABLE IF NOT EXISTS public.pending_actions (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',  -- pending/approved/rejected/done/error
      question TEXT NOT NULL,
      plan JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      decided_at TIMESTAMPTZ
    );
  `);

  // RULES (ordens permanentes do dono)
  await exec(pool, `
    CREATE TABLE IF NOT EXISTS public.ai_rules (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT,
      rule TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // FINANCE (lançamentos estruturados)
  await exec(pool, `
    CREATE TABLE IF NOT EXISTS public.financial_records (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT,
      source TEXT,              -- csv/pdf/manual
      ref TEXT,                 -- id do arquivo/linha
      date DATE,
      direction TEXT,           -- in/out
      amount NUMERIC,
      description TEXT,
      payee TEXT,
      category TEXT,
      raw JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // FILES (anexos recebidos do Telegram)
  await exec(pool, `
    CREATE TABLE IF NOT EXISTS public.files (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT,
      telegram_file_id TEXT,
      file_name TEXT,
      mime_type TEXT,
      bytes BIGINT,
      local_path TEXT,
      sha256 TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Índices: só cria se a coluna existir (nunca trava)
  await exec(pool, `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='events' AND column_name='chat_id'
      ) THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_events_chat ON public.events(chat_id);';
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='events' AND column_name='created_at'
      ) THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_events_time ON public.events(created_at);';
      END IF;

      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_pending_chat ON public.pending_actions(chat_id);';
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_fin_chat ON public.financial_records(chat_id);';
      EXECUTE 'CREATE INDEX IF NOT EXISTS idx_fin_date ON public.financial_records(date);';
    END $$;
  `);

  const cols = await exec(pool, `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='events'
    ORDER BY ordinal_position;
  `);

  console.log("✅ public.events colunas:", cols.rows.map(r => r.column_name).join(", "));
  console.log("✅ Banco OK (CEO mode)");
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
