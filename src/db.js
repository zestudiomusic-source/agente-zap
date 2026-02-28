// src/db.js (ULTRA SAFE - não trava em coluna faltando)
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
  console.log("🧠 Sincronizando banco... (modo ultra seguro)");

  // Sempre trabalha no schema public explicitamente
  await exec(
    pool,
    `
    CREATE TABLE IF NOT EXISTS public.events (
      id BIGSERIAL PRIMARY KEY
    );
  `
  );

  // Migrações (se falhar, aparece no log — mas não deve falhar)
  await exec(pool, `ALTER TABLE public.events ADD COLUMN IF NOT EXISTS chat_id BIGINT;`);
  await exec(pool, `ALTER TABLE public.events ADD COLUMN IF NOT EXISTS text TEXT;`);
  await exec(pool, `ALTER TABLE public.events ADD COLUMN IF NOT EXISTS tag TEXT;`);
  await exec(pool, `ALTER TABLE public.events ADD COLUMN IF NOT EXISTS payload JSONB;`);
  await exec(
    pool,
    `ALTER TABLE public.events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`
  );

  // Tabela de regras (ordens permanentes da IA)
  await exec(
    pool,
    `
    CREATE TABLE IF NOT EXISTS public.ai_rules (
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
    CREATE TABLE IF NOT EXISTS public.financial_records (
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

  // ✅ Índices: só cria SE a coluna existir (não trava mais o start)
  await exec(
    pool,
    `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name='events' AND column_name='chat_id'
      ) THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_events_chat_id ON public.events(chat_id);';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name='events' AND column_name='created_at'
      ) THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_events_created_at ON public.events(created_at);';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name='financial_records' AND column_name='chat_id'
      ) THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_financial_chat_id ON public.financial_records(chat_id);';
      END IF;
    END $$;
  `
  );

  // Log de verificação (mostra no log se chat_id existe)
  const check = await exec(
    pool,
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='events'
    ORDER BY ordinal_position;
  `
  );

  console.log("✅ Colunas em public.events:", check.rows.map(r => r.column_name).join(", "));
  console.log("✅ Banco sincronizado (modo ultra seguro) OK");
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
