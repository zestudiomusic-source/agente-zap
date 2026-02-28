const { Pool } = require("pg");

function createLogger(name = "DB") {
  return {
    info: (...args) => console.log(`[${name}]`, ...args),
    error: (...args) => console.error(`[${name}]`, ...args),
  };
}

function createDb(config) {
  const logger = createLogger("DB");

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || config?.db?.url,
    ssl: { rejectUnauthorized: false },
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
          exec: (sql, params = []) => client.query(sql, params),
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

    // 🔥 FUNÇÕES KV (ESSENCIAIS PARA O ERP)
    async kvGet(key) {
      const rows = await this.query(
        `SELECT value_json FROM kv_store WHERE key = $1`,
        [key]
      );
      return rows[0]?.value_json || null;
    },

    async kvSet(key, value) {
      await this.exec(
        `INSERT INTO kv_store (key, value_json, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key)
         DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
        [key, value]
      );
    },

    async kvDelete(key) {
      await this.exec(`DELETE FROM kv_store WHERE key = $1`, [key]);
    },
  };

  async function initSchema() {
    await db.transaction(async (tx) => {
      // TABELA ORDERS
      await tx.exec(`
        CREATE TABLE IF NOT EXISTS orders (
          id SERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      // MIGRAÇÃO SEGURA
      await tx.exec(`
        ALTER TABLE orders
          ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending',
          ADD COLUMN IF NOT EXISTS production_status TEXT DEFAULT 'not_started',
          ADD COLUMN IF NOT EXISTS description TEXT,
          ADD COLUMN IF NOT EXISTS customer_name TEXT,
          ADD COLUMN IF NOT EXISTS customer_phone TEXT,
          ADD COLUMN IF NOT EXISTS amount_cents BIGINT DEFAULT 0,
          ADD COLUMN IF NOT EXISTS meta_json JSONB,
          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
      `);

      // KV STORE (CRÍTICO PARA /setgroup)
      await tx.exec(`
        CREATE TABLE IF NOT EXISTS kv_store (
          key TEXT PRIMARY KEY,
          value_json JSONB,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      // FINANCEIRO
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
    });

    logger.info("Schema do banco inicializado com sucesso.");
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
