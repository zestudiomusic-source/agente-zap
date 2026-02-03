import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* Rota raiz */
app.get("/", (req, res) => {
  res.send("Agente online 🚀");
});

/* Health check */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Agente rodando",
    time: new Date().toISOString(),
  });
});

/* Webhook do Kommo (vai configurar no Kommo para chamar esta URL) */
app.post("/kommo/webhook", (req, res) => {
  console.log("Kommo webhook recebido:");
  console.log(JSON.stringify(req.body, null, 2));

  // Por enquanto só confirma recebimento
  return res.status(200).json({ ok: true });
});

app.listen(PORT, () => {
  console.log("Agente rodando na porta", PORT);
});