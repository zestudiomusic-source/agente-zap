import express from "express";

const app = express();

/**
 * Middlewares
 * IMPORTANTES para o Kommo
 */
app.use(express.json()); // JSON
app.use(express.urlencoded({ extended: true })); // form-urlencoded (Kommo usa isso)

/**
 * Porta (Render usa PORT automaticamente)
 */
const PORT = process.env.PORT || 3000;

/**
 * Rota raiz (teste simples)
 */
app.get("/", (req, res) => {
  res.send("Agente online 🚀");
});

/**
 * Health check (Render / teste manual)
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Agente rodando",
    time: new Date().toISOString(),
  });
});

/**
 * Webhook do Kommo
 * ESSA É A ROTA QUE VOCÊ COLOCA NO KOMMO
 */
app.post("/kommo/webhook", (req, res) => {
  console.log("🚀 Webhook do Kommo recebido!");

  console.log("🔹 HEADERS:");
  console.log(req.headers);

  console.log("🔹 BODY:");
  console.log(JSON.stringify(req.body, null, 2));

  // Sempre responda 200 pro Kommo
  return res.status(200).json({ ok: true });
});

/**
 * Start do servidor
 */
app.listen(PORT, () => {
  console.log(Agente rodando na porta ${PORT});
});
