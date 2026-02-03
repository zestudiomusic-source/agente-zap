import express from "express";

const app = express();

/**
 * Captura RAW BODY (obrigatório para Kommo)
 */
app.use(express.raw({ type: "/" }));

const PORT = process.env.PORT || 10000;

/**
 * Rota raiz
 */
app.get("/", (req, res) => {
  res.send("Agente online 🚀");
});

/**
 * Health check
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Agente rodando",
    time: new Date().toISOString()
  });
});

/**
 * Webhook do Kommo
 */
app.post("/kommo/webhook", (req, res) => {
  console.log("================================");
  console.log("Webhook do Kommo recebido");

  // Corpo bruto
  const rawBody = req.body?.toString("utf8") || "";

  console.log("RAW BODY:");
  console.log(rawBody);

  // Tenta converter em JSON (se der)
  try {
    const parsed = JSON.parse(rawBody);
    console.log("JSON PARSEADO:");
    console.log(JSON.stringify(parsed, null, 2));
  } catch (err) {
    console.log("Não foi possível converter para JSON");
  }

  console.log("================================");

  return res.status(200).json({ ok: true });
});

/**
 * Start
 */
app.listen(PORT, () => {
  console.log(Agente rodando na porta ${PORT});
});
