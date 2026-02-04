import express from "express";

const app = express();
app.use(express.json());

const VERIFY_TOKEN = "zap123";

// rota raiz (já existe)
app.get("/", (req, res) => {
  res.send("Servidor Kommo rodando corretamente 🚀");
});

// 🔹 VERIFICAÇÃO DO WHATSAPP (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// 🔹 RECEBER MENSAGENS (POST)
app.post("/webhook", async (req, res) => {
  console.log("📩 EVENTO RECEBIDO:");
  console.log(JSON.stringify(req.body, null, 2));

  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const message = changes?.value?.messages?.[0];

  if (message && message.from) {
    const from = message.from;

    await fetch(
      "https://graph.facebook.com/v18.0/SEU_PHONE_NUMBER_ID/messages",
      {
        method: "POST",
        headers: {
          "Authorization": Bearer ${process.env.WA_TOKEN},
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: from,
          text: { body: "Olá! Recebi sua mensagem 😊" }
        })
      }
    );
  }

  res.sendStatus(200);
});
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});


