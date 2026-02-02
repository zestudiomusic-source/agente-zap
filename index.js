import express from "express";

const app = express();

// Kommo envia JSON
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Rota raiz (health check)
app.get("/", (req, res) => {
  res.status(200).send("OK - agente zap online");
});

// (opcional) GET pra testar no navegador
app.get("/whatsapp", (req, res) => {
  res
    .status(200)
    .send("OK (GET) - use POST para mensagens do Kommo");
});

// ===== WEBHOOK KOMMO =====
app.post("/whatsapp", async (req, res) => {
  // -------- DEBUG --------
  console.log("========== WEBHOOK KOMMO RECEBIDO ==========");
  console.log("HEADERS:", JSON.stringify(req.headers, null, 2));
  console.log("BODY:", JSON.stringify(req.body, null, 2));

  // -------- LEITURA DEFENSIVA --------
  const from =
    req.body?.from ||
    req.body?.sender?.id ||
    req.body?.message?.from ||
    req.body?.contact?.id ||
    "unknown";

  const texto =
    req.body?.content?.text ||
    req.body?.message?.text ||
    req.body?.text ||
    req.body?.body ||
    "";

  console.log("FROM:", from);
  console.log("TEXTO:", texto);

  // -------- SE NÃO FOR TEXTO, IGNORA --------
  if (!texto) {
    return res.status(200).json({
      ok: true,
      ignored: true,
      reason: "evento sem texto",
    });
  }

  // -------- RESPOSTA SIMPLES (TESTE) --------
  // Quando isso responder no WhatsApp, a integração está 100% OK
  return res.status(200).json({
    type: "text",
    text: "Recebi sua mensagem ✅",
  });
});

// Porta (Render)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(Agente rodando na porta ${PORT});
});
