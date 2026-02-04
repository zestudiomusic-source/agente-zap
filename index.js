const express = require("express");
const fetch = require("node-fetch");

const app = express();

/* =========================
   MIDDLEWARES
========================= */
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/* =========================
   ROTA DE TESTE
========================= */
app.get("/", (req, res) => {
  res.status(200).send("Servidor Kommo rodando corretamente 🚀");
});

/* =========================
   CHATGPT (OPENAI RESPONSES API)
========================= */
async function gerarRespostaChatGPT(userText) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  if (!apiKey) {
    return "OPENAI_API_KEY não configurada.";
  }

  try {
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: model,
        input: [
          {
            role: "system",
            content: "Você é um atendente rápido, educado e objetivo. Responda em português do Brasil."
          },
          {
            role: "user",
            content: userText
          }
        ]
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      return "Erro OpenAI: " + err;
    }

    const data = await resp.json();

    if (data.output_text) {
      return data.output_text;
    }

    // fallback seguro
    let chunks = [];
    for (const item of data.output || []) {
      for (const c of item.content || []) {
        if (c.type === "output_text" && c.text) {
          chunks.push(c.text);
        }
      }
    }

    return chunks.join("\n").trim() || "Não consegui gerar resposta agora.";

  } catch (error) {
    console.error("Erro ChatGPT:", error);
    return "Erro ao gerar resposta.";
  }
}

/* =========================
   WEBHOOK KOMMO
========================= */
app.post("/kommo/webhook", async (req, res) => {
  try {
    console.log("===== WEBHOOK KOMMO =====");
    console.log(JSON.stringify(req.body, null, 2));

    // formato real do Kommo (chat)
    const event = req.body?.message?.add?.[0];

    if (!event || !event.text) {
      return res.sendStatus(200);
    }

    const message = event.text;
    const chatId = event.chat_id;
    const talkId = event.talk_id;

    console.log("Mensagem:", message);
    console.log("Chat ID:", chatId);
    console.log("Talk ID:", talkId);

    // ChatGPT
    const resposta = await gerarRespostaChatGPT(message);
    console.log("Resposta ChatGPT:", resposta);

    /*
      🚨 ENVIO PARA WHATSAPP VIA KOMMO
      Aqui entra a chamada da API do Kommo (depende do seu token privado).
      Exemplo (pseudo-código):

      await fetch("https://SEU_SUBDOMINIO.amocrm.com/api/v4/chats/" + chatId + "/messages", {
        method: "POST",
        headers: {
          "Authorization": "Bearer SEU_TOKEN_KOMMO",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: resposta,
          talk_id: talkId
        })
      });
    */

    return res.sendStatus(200);

  } catch (error) {
    console.error("ERRO NO WEBHOOK:", error);
    return res.sendStatus(500);
  }
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});
