const express = require("express");

const app = express();

/* ============================
   MIDDLEWARES (OBRIGATÓRIO)
============================ */
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/* ============================
   ROTA DE TESTE
============================ */
app.get("/", (req, res) => {
  res.status(200).send("Servidor Kommo rodando corretamente 🚀");
});

/* ============================
   WEBHOOK KOMMO
   Endpoint: POST /kommo/webhook
============================ */
app.post("/kommo/webhook", async (req, res) => {
  try {
    console.log("========== WEBHOOK KOMMO ==========");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("==================================");

    // Kommo (chats) envia normalmente em: req.body.message.add[0]
    const event = req.body?.message?.add?.[0];

    const message   = event?.text || "Mensagem não identificada";
    const leadId    = event?.entity_id || null;
    const contactId = event?.contact_id || null;
    const chatId    = event?.chat_id || null;
    const talkId    = event?.talk_id || null;
    const author    = event?.author?.name || "Desconhecido";
    const origin    = event?.origin || null; // ex: "waba"

    console.log("Mensagem:", message);
    console.log("Lead ID:", leadId);
    console.log("Contact ID:", contactId);
    console.log("Chat ID:", chatId);
    console.log("Talk ID:", talkId);
    console.log("Autor:", author);
    console.log("Origin:", origin);

    // Aqui depois entra ChatGPT + resposta no WhatsApp

    return res.sendStatus(200);

  } catch (error) {
    console.error("ERRO NO WEBHOOK:", error);
    return res.sendStatus(500);
  }
});

/* ============================
   START SERVER
============================ */
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});
