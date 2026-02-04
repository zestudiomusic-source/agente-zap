import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

/**
 * ================================
 * VARIÁVEIS DE AMBIENTE (RENDER)
 * ================================
 * WA_VERIFY_TOKEN   -> mesmo valor configurado no Meta Webhook
 * WA_TOKEN          -> token permanente do WhatsApp Cloud
 * PHONE_NUMBER_ID   -> Phone Number ID do WhatsApp Cloud
 */
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "zap123";
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

/**
 * ================================
 * ROTA RAIZ (TESTE)
 * ================================
 */
app.get("/", (req, res) => {
  res.send("Servidor rodando corretamente 🚀");
});

/**
 * ================================
 * VERIFICAÇÃO DO WEBHOOK (GET)
 * ================================
 */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado com sucesso");
    return res.status(200).send(challenge);
  }

  console.log("❌ Falha na verificação do webhook");
  return res.sendStatus(403);
});

/**
 * ================================
 * RECEBER MENSAGENS (POST)
 * ================================
 */
app.post("/webhook", async (req, res) => {
  try {
    // Responde rápido pro WhatsApp não reenviar
    res.sendStatus(200);

    const body = req.body;
    console.log("📩 EVENTO RECEBIDO:", JSON.stringify(body, null, 2));

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const from = message.from; // número do cliente
    const msgType = message.type;

    if (msgType !== "text") return;

    const text = message.text?.body || "";

    if (!WA_TOKEN || !PHONE_NUMBER_ID) {
      console.log("❌ WA_TOKEN ou PHONE_NUMBER_ID não configurados");
      return;
    }

    const replyText = Recebi sua mensagem: ${text};

    const url = https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages;

    const payload = {
      messaging_product: "whatsapp",
      to: from,
      type: "text",
      text: { body: replyText },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": Bearer ${WA_TOKEN},
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    console.log("✅ RESPOSTA ENVIADA:", data);

  } catch (err) {
    console.error("🔥 ERRO NO /webhook:", err);
  }
});

/**
 * ================================
 * START DO SERVIDOR
 * ================================
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(✅ Servidor rodando na porta ${PORT});
});
