// src/server.js
const express = require("express");
const { createDb } = require("./db");
const { handleTelegramUpdate } = require("./telegram");
const { startSchedulers } = require("./schedulers");

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN não configurado!");
  process.exit(1);
}

async function main() {
  console.log("🚀 Iniciando ERP IA Central...");

  const db = await createDb();
  console.log("✅ Banco conectado");

  const app = express();
  app.use(express.json({ limit: "20mb" }));

  app.get("/", (req, res) => res.send("ERP IA Central rodando ✅"));

  app.post("/webhook", async (req, res) => {
    try {
      await handleTelegramUpdate(req.body, db);
      res.sendStatus(200);
    } catch (err) {
      console.error("❌ Erro no webhook:", err);
      res.sendStatus(200);
    }
  });

  startSchedulers(db);

  app.listen(PORT, () => {
    console.log(`🌐 Servidor rodando na porta ${PORT}`);
    console.log("🤖 IA pronta para operar nos grupos ADM e PRODUÇÃO");
  });
}

main().catch((err) => {
  console.error("❌ Erro fatal ao iniciar:", err);
  process.exit(1);
});
