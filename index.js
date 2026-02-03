import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const KOMMO_TOKEN = process.env.KOMMO_TOKEN;
const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN;

/**
 * Health check
 */
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/**
 * Webhook Kommo
 */
app.post("/kommo/webhook", async (req, res) => {
  console.log("====================================");
  console.log("Webhook do Kommo recebido");

  try {
    const body = req.body;

    if (
      !body.message ||
      !body.message.add ||
      !body.message.add[0] ||
      !body.message.add[0].text
    ) {
      console.log("Nenhuma mensagem encontrada");
      console.log("====================================");
      return res.status(200).json({ ok: true });
    }

    const textoRecebido = body.message.add[0].text;
    const contatoId = body.message.add[0].contact_id;

    console.log("Texto:", textoRecebido);
    console.log("Contato ID:", contatoId);

    const resposta = "Oi! Recebi sua mensagem. Como posso ajudar?";

    const url = https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/messages;

    const payload = {
      messages: [
        {
          contact_id: contatoId,
          text: resposta
        }
      ]
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": Bearer ${KOMMO_TOKEN},
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const result = await response.text();
    console.log("Resposta Kommo:", result);
  } catch (err) {
    console.log("Erro:", err.message);
  }

  console.log("====================================");
  res.status(200).json({ ok: true });
});

/**
 * Start server
 */
app.listen(PORT, () => {
  console.log("Agente rodando na porta " + PORT);
});

