import express from "express";

const app = express();

// ================== MIDDLEWARE ==================
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ================== ROTAS DE TESTE ==================
app.get("/", (req, res) => {
  res.status(200).send("OK - agente zap online");
});

app.get("/whatsapp", (req, res) => {
  res
    .status(200)
    .send("OK (GET) - endpoint ativo. Use POST para Kommo.");
});

// ================== WEBHOOK KOMMO ==================
app.post("/whatsapp", async (req, res) => {
  console.log("========== WEBHOOK KOMMO RECEBIDO ==========");
  console.log("BODY:", JSON.stringify(req.body, null, 2));

  // ===== LEITURA REAL DO KOMMO (FORM-DATA) =====
  const texto =
    req.body["message[add][0][text]"] ||
    req.body?.message?.add?.[0]?.text ||
    "";

  console.log("TEXTO:", texto);

  // ===== IGNORA EVENTOS SEM TEXTO =====
  if (!texto) {
    return res.status(200).json({
      ok: true,
      ignored: true,
      reason: "evento sem texto",
    });
  }

  // ===== RESPOSTA DE TESTE =====
  // Se isso responder no WhatsApp, a integração está 100% OK
  return res.status(200).json({
    type: "text",
    text: "Recebi sua mensagem ✅",
  });
});

// ================== START SERVER ==================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(Agente rodando na porta ${PORT});
});
