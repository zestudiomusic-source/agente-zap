const express = require("express");

const app = express();

/* ==========================
   MIDDLEWARES (OBRIGATÓRIO)
========================== */
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/* ==========================
   ROTA DE TESTE
========================== */
app.get("/", (req, res) => {
  res.status(200).send("Servidor Kommo rodando corretamente 🚀");
});

/* ==========================
   OPENAI (Responses API)
   Docs: /v1/responses
========================== */
async function gerarRespostaChatGPT(userText) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini"; // troque se quiser

  if (!apiKey) return "OPENAI_API_KEY não configurada.";

  const prompt = [
    {
      role: "system",
      content:
        "Você é um atendente rápido e objetivo. Responda em pt-BR, curto, educado e claro.",
    },
    { role: "user", content: userText },
  ];

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: Bearer ${apiKey},
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: prompt,
    }),
  });

  if (!resp.ok) {
    const errTxt = await resp.text();
    return Erro OpenAI (${resp.status}): ${errTxt};
  }

  const data = await resp.json();

  // A Responses API costuma disponibilizar o texto consolidado em output_text
  // (se não vier, fazemos fallback varrendo o output)
  if (data.output_text) return data.output_text;

  // fallback seguro
  try {
    const chunks = [];
    for (const item of data.output || []) {
      for (const c of item.content || []) {
        if (c.type === "output_text" && c.text) chunks.push(c.text);
      }
    }
    return chunks.join("\n").trim() || "Não consegui gerar resposta agora.";
  } catch {
    return "Não consegui interpretar a resposta do modelo.";
  }
}

/* ==========================
   WEBHOOK KOMMO
   Endpoint: POST /kommo/webhook
========================== */
app.post("/kommo/webhook", async (req, res) => {
  try {
    console.log("========== WEBHOOK KOMMO ==========");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("===================================");

    // ✅ FORMATO REAL DO KOMMO (chats): req.body.message.add[0]
    const event = req.body?.message?.add?.[0];

    const message = event?.text || "Mensagem não identificada";
    const leadId = event?.entity_id ?? null;      // normalmente Lead ID quando entity_type="lead"
    const contactId = event?.contact_id ?? null;
    const chatId = event?.chat_id ?? null;
    const talkId = event?.talk_id ?? null;
    const author = event?.author?.name || "Desconhecido";
    const origin = event?.origin ?? null;         // ex: "waba"

    console.log("Mensagem:", message);
    console.log("Lead ID:", leadId);
    console.log("Contact ID:", contactId);
    console.log("Chat ID:", chatId);
    console.log("Talk ID:", talkId);
    console.log("Autor:", author);
    console.log("Origin:", origin);

    // Se não veio mensagem (ou não é evento esperado), só responde 200
    if (!event || !event.text) {
      return res.sendStatus(200);
    }

    // ✅ ChatGPT
    const resposta = await gerarRespostaChatGPT(message);
    console.log("Resposta ChatGPT:", resposta);

    // ==========================
    // ✅ AQUI entra enviar a resposta pro WhatsApp via Kommo
    // (depende do seu token/endpoint do Kommo)
    //
    // Exemplo (PSEUDO):
    // await enviarMensagemKommo({ chatId, talkId, text: resposta });
    //
    // ==========================

    return res.sendStatus(200);
  } catch (error) {
    console.error("ERRO NO WEBHOOK:", error);
    return res.sendStatus(500);
  }
});

/* ==========================
   START SERVER
========================== */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});

