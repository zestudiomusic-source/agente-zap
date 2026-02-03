import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN;
const KOMMO_TOKEN = process.env.KOMMO_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/* ===================== HEALTH ===================== */
app.get("/health", (req, res) => {
  return res.json({ status: "ok", message: "Agente rodando" });
});

/* ===================== WEBHOOK ===================== */
app.post("/webhook", async (req, res) => {
  console.log("================================");
  console.log("Webhook do Kommo recebido");

  try {
    const body = req.body;

    if (
      !body ||
      !body.message ||
      !body.message.add ||
      body.message.add.length === 0
    ) {
      console.log("Nenhuma mensagem encontrada");
      console.log("================================");
      return res.status(200).json({ ok: true });
    }

    const msg = body.message.add[0];

    const textoRecebido =
      msg.text || msg.message || "Mensagem sem texto";

    const telefone =
      msg.contact?.id || "telefone_desconhecido";

    const nome =
      msg.contact?.name || "Contato sem nome";

    console.log("Texto:", textoRecebido);
    console.log("Telefone:", telefone);
    console.log("Nome:", nome);

    /* ===================== OPENAI ===================== */
    const openaiResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + OPENAI_API_KEY
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "Você é um atendente educado, claro e direto. Responda mensagens de WhatsApp de forma curta e amigável."
            },
            {
              role: "user",
              content: textoRecebido
            }
          ],
          temperature: 0.5
        })
      }
    );

    const openaiData = await openaiResponse.json();

    const respostaIA =
      openaiData.choices &&
      openaiData.choices[0] &&
      openaiData.choices[0].message &&
      openaiData.choices[0].message.content
        ? openaiData.choices[0].message.content
        : "Desculpa, não consegui responder agora.";

    console.log("Resposta IA:", respostaIA);

    /* ===================== ENVIAR PARA KOMMO ===================== */
    const kommoUrl =
      "https://" +
      KOMMO_SUBDOMAIN +
      ".kommo.com/api/v4/messages";

    await fetch(kommoUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + KOMMO_TOKEN
      },
      body: JSON.stringify({
        message_type: "text",
        text: respostaIA,
        contact_id: telefone
      })
    });

    console.log("Resposta enviada ao WhatsApp");
    console.log("================================");

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.log("Erro no webhook:", err.message);
    console.log("================================");
    return res.status(200).json({ ok: true });
  }
});

/* ===================== START ===================== */
app.listen(PORT, () => {
  console.log("Agente rodando na porta " + PORT);
});

