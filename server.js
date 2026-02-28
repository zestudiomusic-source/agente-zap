require("dotenv").config();
const express = require("express");
const { initDatabase } = require("./src/database");
const startTelegramBot = require("./src/telegram/bot"); // 🔥 CORREÇÃO PRINCIPAL

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

async function main() {
  try {
    console.log("[TELEGRAM] 🤖 IA global ativada (todos os grupos)");

    // Inicializa banco
    await initDatabase();

    // Inicia BOT TELEGRAM (sem erro createTelegramBot)
    startTelegramBot();

    // Servidor web (Render exige porta aberta)
    app.get("/", (req, res) => {
      res.send("ERP BOT ONLINE 🚀");
    });

    app.listen(PORT, () => {
      console.log(`[SERVER] Web Service online na porta ${PORT}`);
    });

  } catch (error) {
    console.error("FATAL:", error);
    process.exit(1);
  }
}

main();
