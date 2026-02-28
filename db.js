/**
 * src/db.js - Gerenciador de Banco de Dados PostgreSQL (Render)
 * Versão 3.0 - Compatível com a API antiga (db.prepare/get/all/run) + KV store
 *
 * Requer: npm i pg
 * ENV: DATABASE_URL (Render)
 */

const { Pool } = require('pg');
const { createLogger } = require('./logger');

const logger = createLogger('DB');

/**
 * Converte placeholders "?" para "$1, $2, ..."
 * (Compatibilidade com o código que era SQLite)
 */
function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/**
 * Cria um "db" que parece com better-sqlite3, porém async (PostgreSQL).
 * @param {Pool|import('pg').PoolClient} clientOrPool
 */
function makeDbApi(clientOrPool) {
  const isClient = typeof clientOrPool?.query === 'function' && !!clientOrPool.release; // PoolClient tem release
  const executor = async (sql, params = []) => clientOrPool.query(sql, params);

  const db = {
    /**
     * Executa SQL bruto sem retorno
     */
    async exec(sql) {
      await executor(sql, []);
    },

    /**
     * Prepara query (mantém interface prepare/get/all/run)
     */
    prepare(sql) {
      const text = convertPlaceholders(sql);

      return {
        async get(...params) {
          const r = await executor(text, params);
          return r.rows?.[0] ?? undefined;
        },
        async all(...params) {
          const r = await executor(text, params);
          return r.rows ?? [];
        },
        async run(...params) {
          const r = await executor(text, params);
          // Compat: better-sqlite3 retorna { changes }
          return { changes: r.rowCount ?? 0 };
        }
      };
    },

    /**
     * Inicia transação
     * @param {(txDb: ReturnType<typeof makeDbApi>) => Promise<any>} fn
     */
    async transaction(fn) {
      // Se já for client (transação externa), apenas executa
      if (isClient) {
        return await fn(db);
      }

      const pool = clientOrPool;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const txDb = makeDbApi(client);
        const result = await fn(txDb);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch {}
        throw err;
      } finally {
        client.release();
      }
    },

    // ===========================
    // KV STORE (async)
    // ===========================
    async kvGet(key) {
      try {
        const row = await db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
        return row ? JSON.parse(row.value) : null;
      } catch (err) {
        logger.error(`Erro ao ler KV key="${key}":`, err.message);
        return null;
      }
    },

    async kvSet(key, value) {
      try {
        const json = JSON.stringify(value);
        await db.prepare(`
          INSERT INTO kv (key, value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value = EXCLUDED.value,
            updated_at = EXCLUDED.updated_at
        `).run(key, json, new Date().toISOString());
        return true;
      } catch (err) {
        logger.error(`Erro ao escrever KV key="${key}":`, err.message);
        return false;
      }
    },

    async kvDelete(key) {
      try {
        await db.prepare('DELETE FROM kv WHERE key = ?').run(key);
        return true;
      } catch (err) {
        logger.error(`Erro ao deletar KV key="${key}":`, err.message);
        return false;
      }
    },

    async kvList(prefix = '') {
      try {
        const rows = await db.prepare('SELECT key FROM kv WHERE key LIKE ?').all(prefix + '%');
        return rows.map(r => r.key);
      } catch (err) {
        logger.error(`Erro ao listar KV prefix="${prefix}":`, err.message);
        return [];
      }
    },

    async kvClear() {
      try {
        await db.prepare('DELETE FROM kv').run();
        return true;
      } catch (err) {
        logger.error('Erro ao limpar KV store:', err.message);
        return false;
      }
    }
  };

  return db;
}

/**
 * Inicializa schema no PostgreSQL (idempotente)
 */
async function initSchema(db) {
  await db.transaction(async (tx) => {
    // KV
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
    `);

    // Uploads
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS uploads (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL,
        kind TEXT NOT NULL,
        filename TEXT,
        telegram_file_id TEXT,
        telegram_chat_id BIGINT,
        telegram_message_id BIGINT,
        local_path TEXT,
        sha256 TEXT,
        file_size BIGINT DEFAULT 0,
        meta_json JSONB,
        deleted_at TIMESTAMPTZ
      );
    `);

    await tx.exec(`CREATE INDEX IF NOT EXISTS idx_uploads_kind ON uploads(kind);`);
    await tx.exec(`CREATE INDEX IF NOT EXISTS idx_uploads_created_at ON uploads(created_at);`);
    await tx.exec(`CREATE INDEX IF NOT EXISTS idx_uploads_sha256 ON uploads(sha256);`);
    await tx.exec(`CREATE INDEX IF NOT EXISTS idx_uploads_deleted_at ON uploads(deleted_at);`);

    // Bank transactions
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS bank_tx (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL,
        source TEXT NOT NULL,
        tx_date DATE,
        description TEXT,
        category TEXT,
        amount_cents BIGINT DEFAULT 0,
        direction TEXT,
        account TEXT,
        counterparty TEXT,
        raw_json JSONB
      );
    `);

    await tx.exec(`CREATE INDEX IF NOT EXISTS idx_bank_tx_date ON bank_tx(tx_date);`);
    await tx.exec(`CREATE INDEX IF NOT EXISTS idx_bank_tx_direction ON bank_tx(direction);`);
    await tx.exec(`CREATE INDEX IF NOT EXISTS idx_bank_tx_category ON bank_tx(category);`);
    await tx.exec(`CREATE INDEX IF NOT EXISTS idx_bank_tx_source ON bank_tx(source);`);
    await tx.exec(`CREATE INDEX IF NOT EXISTS idx_bank_tx_created_at ON bank_tx(created_at);`);

    // Orders
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL,
        status TEXT DEFAULT 'pending',
        production_status TEXT DEFAULT 'not_started',
        delivery_date DATE,
        description TEXT,
        customer_name TEXT,
        customer_phone TEXT,
        customer_email TEXT,
        amount_cents BIGINT DEFAULT 0,
        notes TEXT,
        meta_json JSONB,
        updated_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ
      );
    `);

    await tx.exec(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);`);
    await tx.exec(`CREATE INDEX IF NOT EXISTS idx_orders_delivery_date ON orders(delivery_date);`);
    await tx.exec(`CREATE INDEX IF NOT EXISTS idx_orders_production_status ON orders(production_status);`);
    await tx.exec(`CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);`);
    await tx.exec(`CREATE INDEX IF NOT EXISTS idx_orders_deleted_at ON orders(deleted_at);`);

    // Logs
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL,
        level TEXT NOT NULL,
        module TEXT,
        message TEXT NOT NULL,
        meta_json JSONB
      );
    `);

    await tx.exec(`CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);`);
    await tx.exec(`CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);`);
    await tx.exec(`CREATE INDEX IF NOT EXISTS idx_logs_module ON logs(module);`);

    // Reports cache
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS reports_cache (
        id BIGSERIAL PRIMARY KEY,
        cache_key TEXT NOT NULL UNIQUE,
        report_type TEXT NOT NULL,
        content JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
    `);

    await tx.exec(`CREATE INDEX IF NOT EXISTS idx_reports_cache_key ON reports_cache(cache_key);`);
    await tx.exec(`CREATE INDEX IF NOT EXISTS idx_reports_cache_expires ON reports_cache(expires_at);`);
  });

  logger.info('✅ Schema PostgreSQL inicializado com sucesso');
}

/**
 * Cria pool e retorna db API
 * @param {Object} config
 */
async function createDb(config) {
  if (!config?.db?.url) {
    throw new Error('DATABASE_URL não configurado (PostgreSQL)');
  }

  const pool = new Pool({
    connectionString: config.db.url,
    max: parseInt(process.env.PGPOOL_MAX || '10', 10),
    idleTimeoutMillis: parseInt(process.env.PGPOOL_IDLE_TIMEOUT || '30000', 10),
    connectionTimeoutMillis: parseInt(process.env.PGPOOL_CONN_TIMEOUT || '15000', 10),
    ssl: process.env.PGSSLMODE === 'disable' ? false : (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false)
  });

  // Testa conexão
  await pool.query('SELECT 1 as ok');

  const db = makeDbApi(pool);
  db.pool = pool;

  await initSchema(db);

  return db;
}

module.exports = { createDb };
