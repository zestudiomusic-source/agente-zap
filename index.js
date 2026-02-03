import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Agente online 🚀");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Agente rodando",
    time: new Date().toISOString()
  });
});

app.post("/kommo/webhook", (req, res) => {
  console.log("Webhook do Kommo recebido:");
  console.log(JSON.stringify(req.body, null, 2));
  res.status(200).json({ ok: true });
});

app.listen(PORT, () => {
  console.log("Agente rodando na porta", PORT);
});
