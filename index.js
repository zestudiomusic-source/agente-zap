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
    time: new Date().toISOString()
  });
});

/* Placeholder WhatsApp */
app.post("/whatsapp", (req, res) => {
  console.log("Mensagem recebida:", req.body);
  res.send("Webhook recebido");
});

app.listen(PORT, () => {
  console.log("Agente rodando na porta", PORT);
});