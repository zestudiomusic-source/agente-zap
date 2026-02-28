const { Pool } = require("pg");

function createLogger(name = "DB") {
  return {
    info: (...args) => console.log(`[${name}]`, ...args),
    error: (...args) => console.error(`[${name}]`, ...args),
  };
}

function createDb(config) {
  const logger = createLogger("DB");

  if (!process.env.DATABASE_URL && !config?.db?.url) {
    throw new Error("DATABASE_URL não configurado!");
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || config.db.url,
    ssl: {
      rejectUnauthorized: false,
    },
  });

  const db = {
    async exec(sql, params = []) {
      const client = await pool.connect();
      try {
        await client.query(sql, params);
      } finally {
        client.release();
      }
    },

    async query(sql, params = []) {
      const client = await pool.connect();
      try {
        const res = await client.query(sql, params);
        return res.rows;
      } finally {
        client.release();
      }
    },

    async transaction(callback) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx = {
          exec: async (sql, params = []) => {
            await client.query(sql, params);
          },
          query: async (sql, params = []) => {
            const res = await client.query(sql, params);
            return res.rows;
          },
        };

        const result = await callback(tx);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
  };

  async function initSchema() {
    await db.transaction(async (tx) => {
      // ===========================
      // TABELA PRINCIPAL DE PEDIDOS
      // ===========================
      await tx.exec(`
        CREATE TABLE IF NOT EXISTS orders (
          id SERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      // ===========================
      // MIGRAÇÃO DE SCHEMA (CRÍTICA)
      // Corrige bancos antigos que já tinham a tabela sem as colunas novas
      // ===========================
      await tx.exec(`
        ALTER TABLE orders
          ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending',
          ADD COLUMN IF NOT EXISTS production_status TEXT DEFAULT 'not_started',
          ADD COLUMN IF NOT EXISTS delivery_date DATE,
          ADD COLUMN IF NOT EXISTS description TEXT,
          ADD COLUMN IF NOT EXISTS customer_name TEXT,
          ADD COLUMN IF NOT EXISTS customer_phone TEXT,
          ADD COLUMN IF NOT EXISTS customer_email TEXT,
          ADD COLUMN IF NOT EXISTS amount_cents BIGINT DEFAULT 0,
          ADD COLUMN IF NOT EXISTS notes TEXT,
          ADD COLUMN IF NOT EXISTS meta_json JSONB,
          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
      `);

      // ===========================
      // TABELA FINANCEIRO
      // ===========================
      await tx.exec(`
        CREATE TABLE IF NOT EXISTS finance (
          id SERIAL PRIMARY KEY,
          description TEXT,
          amount_cents BIGINT,
          category TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          meta_json JSONB
        );
      `);

      // ===========================
      // TABELA CONFIG / KV (cache, tokens, etc)
      // ===========================
      await tx.exec(`
        CREATE TABLE IF NOT EXISTS kv_store (
          key TEXT PRIMARY KEY,
          value_json JSONB,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      // ===========================
      // ÍNDICES (agora não quebram mais)
      // ===========================
      await tx.exec(`
        CREATE INDEX IF NOT EXISTS idx_orders_status
        ON orders(status);
      `);

      await tx.exec(`
        CREATE INDEX IF NOT EXISTS idx_orders_created_at
        ON orders(created_at);
      `);

      await tx.exec(`
        CREATE INDEX IF NOT EXISTS idx_finance_created_at
        ON finance(created_at);
      `);
    });

    logger.info("Schema do banco inicializado com sucesso.");
  }

  async function create() {
    await initSchema();
    return db;
  }

  return {
    ...db,
    initSchema,
  };
}

module.exports = {
  createDb: async (config) => {
    const db = createDb(config);
    await db.initSchema();
    return db;
  },
};
