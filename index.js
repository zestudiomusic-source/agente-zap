import express from "express";

const app = express();

/**
 * MUITO IMPORTANTE
 * Kommo envia webhook como FORM, não JSON
 */
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

  // Kommo manda como FORM DATA
  console.log("BODY:", req.body);

  // Se quiser ver tudo cru:
  console.log("Keys:", Object.keys(req.body));

  console.log("================================");

  return res.status(200).json({ ok: true });
});

/**
 * Start
 */
app.listen(PORT, () => {
  console.log("Agente rodando na porta " + PORT);
});
