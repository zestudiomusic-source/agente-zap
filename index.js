import express from "express";

const app = express();
app.use(express.json());

// ENV VARS (Render)
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "zap123";
const WA_TOKEN = process.env.WA_TOKEN; // obrigatório
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // obrigatório

// ✅ rota raiz (teste)
app.get("/", (req, res) => {
  res.send("Servidor rodando corretamente 🚀");
});

// ✅ VERIFICAÇÃO DO WHATSAPP (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado com sucesso");
    return res.status(200).send(challenge);
  } else {
    console.log("❌ Falha na verificação do webhook", { mode, token });
    return res.sendStatus(403);
  }
});

// ✅ RECEBER EVENTOS (POST)
app.post("/webhook", async (req, res) => {
  try {
    // sempre responde 200 rápido pro WhatsApp não reenviar
    res.sendStatus(200);

    const body = req.body;
    console.log("📩 EVENTO RECEBIDO:", JSON.stringify(body, null, 2));

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // mensagens recebidas
    const message = value?.messages?.[0];
    if (!message) return;

    const from = message.from; // número do cliente
    const msgType = message.type;

    // se for texto, responde
    if (msgType === "text") {
      const text = message.text?.body || "";

      if (!WA_TOKEN || !PHONE_NUMBER_ID) {
        console.log("❌ Falta WA_TOKEN ou PHONE_NUMBER_ID no Render (env vars).");
        return;
      }

      const replyText = Recebi: ${text};

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
    }

  } catch (err) {
    console.log("🔥 ERRO NO /webhook:", err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(✅ Servidor rodando na porta ${PORT}));
