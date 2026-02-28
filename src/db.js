// src/db.js
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  // Memória geral da IA
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT,
      text TEXT,
      tag TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Regras permanentes aprendidas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_rules (
      id SERIAL PRIMARY KEY,
      rule TEXT,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Financeiro estruturado (IA pode usar)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS financial_records (
      id SERIAL PRIMARY KEY,
      type TEXT,
      description TEXT,
      amount NUMERIC,
      source TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Ferramentas criadas pela IA
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_tools (
      id SERIAL PRIMARY KEY,
      name TEXT,
      purpose TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log("🧠 Banco autônomo pronto: events / ai_rules / financial_records / ai_tools");
}

async function exec(query, params = []) {
  return pool.query(query, params);
}

module.exports = {
  pool,
  exec,
  initDb,
};
