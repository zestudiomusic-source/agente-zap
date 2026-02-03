import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// Porta (Render usa process.env.PORT)
const PORT = process.env.PORT || 10000;

// ==============================
// ROTA RAIZ
// ==============================
app.get("/", (req, res) => {
  res.send("Agente online");
});

// ==============================
// HEALTH CHECK
// ==============================
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Agente rodando",
    time: new Date().toISOString()
  });
});

// ==============================
// WEBHOOK KOMMO
// ==============================
app.post("/kommo/webhook", async (req, res) => {
  console.log("================================");
  console.log("Webhook do Kommo recebido");

  const body = req.body;
  console.log("BODY:", body);

  try {
    // Verifica se existe mensagem
    if (
      !body ||
      !body.message ||
      !body.message.add ||
      !body.message.add[0] ||
      !body.message.add[0].text
    ) {
      console.log("Nenhuma mensagem encontrada");
      console.log("================================");
      return res.status(200).json({ ok: true });
    }

    const mensagem = body.message.add[0].text;
    const telefone = body.message.add[0].contact_id || "desconhecido";
    const nome =
      body.message.add[0].contact_name || "Contato sem nome";

    console.log("Texto:", mensagem);
    console.log("Telefone:", telefone);
    console.log("Nome:", nome);

    // ==============================
    // CHAMADA PARA OPENAI
    // ==============================
    const openaiResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization":
            "Bearer " + process.env.OPENAI_API_KEY
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "Você é um assistente educado e profissional."
            },
            {
              role: "user",
              content: mensagem
            }
          ]
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
        : "Não consegui responder agora.";

    console.log("Resposta IA:", respostaIA);

    // ==============================
    // ENVIO DA RESPOSTA PARA KOMMO
    // ==============================
    const kommoUrl =
      "https://" +
      process.env.KOMMO_SUBDOMAIN +
      ".kommo.com/api/v4/messages";

    await fetch(kommoUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization":
          "Bearer " + process.env.KOMMO_TOKEN
      },
      body: JSON.stringify({
        message: {
          type: "text",
          text: respostaIA
        },
        contact_id: telefone
      })
    });

    console.log("Mensagem enviada ao Kommo");
    console.log("================================");

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Erro no webhook:", err);
    console.log("================================");
    return res.status(500).json({ error: "Erro interno" });
  }
});

// ==============================
// START SERVER
// ==============================
app.listen(PORT, () => {
  console.log("Agente rodando na porta " + PORT);
});

