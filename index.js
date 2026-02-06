import express from "express";

const app = express();
app.use(express.json());

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // ex: https://agente-zap.onrender.com

app.get("/", (req, res) => {
  res.send("OK - servidor no ar");
});

app.post("/telegram/webhook", async (req, res) => {
  try {
    // responde rápido pro Telegram
    res.sendStatus(200);

    if (!TELEGRAM_BOT_TOKEN) {
      console.log("❌ TELEGRAM_BOT_TOKEN não configurado");
      return;
    }

    const update = req.body;
    const msg = update?.message;

    if (!msg || !msg.text) return;

    const chatId = msg.chat.id;
    const text = msg.text;

    const reply = `Recebi: ${text}`;

    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: reply
      }),
    });

    console.log("✅ Mensagem respondida no Telegram");
  } catch (err) {
    console.log("🔥 ERRO /telegram/webhook:", err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Rodando na porta ${PORT}`);
});
