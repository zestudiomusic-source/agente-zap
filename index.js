import express from "express";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

/**
 * Rota raiz
 */
app.get("/", (req, res) => {
  res.send("Agente online 🚀");
});

/**
 * Health
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Agente rodando",
    time: new Date().toISOString()
  });
});

/**
 * Webhook Kommo
 */
app.post("/kommo/webhook", (req, res) => {
  console.log("================================");
  console.log("Webhook do Kommo recebido");

  const payload = req.body;

  try {
    const msg = payload?.message?.add?.[0];

    if (!msg) {
      console.log("Nenhuma mensagem encontrada");
      return res.status(200).json({ ok: true });
    }

    const texto =
      msg.text ||
      msg.message ||
      msg.content ||
      "[mensagem sem texto]";

    const telefone =
      msg.sender?.phone ||
      msg.chat_id ||
      "telefone nao identificado";

    const nome =
      msg.sender?.name ||
      "Contato sem nome";

    console.log("📩 Texto:", texto);
    console.log("📱 Telefone:", telefone);
    console.log("👤 Nome:", nome);

  } catch (err) {
    console.log("Erro ao processar mensagem:", err.message);
  }

  console.log("================================");

  return res.status(200).json({ ok: true });
});

/**
 * Start
 */
app.listen(PORT, () => {
  console.log("Agente rodando na porta " + PORT);
});

