const express = require("express");
const fetch = require("node-fetch");

const app = express();

/* ===============================
   MIDDLEWARES (OBRIGATÓRIOS)
================================ */
app.use(express.json()); // <<< SEM ISSO O BODY VEM {}
app.use(express.urlencoded({ extended: true }));

/* ===============================
   WEBHOOK DO KOMMO
================================ */
app.post("/kommo/webhook", async (req, res) => {
  try {
    console.log("======== WEBHOOK KOMMO ========");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("================================");

    const message =
      req.body?.message?.text ||
      req.body?.message?.body ||
      "Mensagem não identificada";

    const chatId = req.body?.chat?.id;
    const leadId = req.body?.lead?.id;

    // Aqui depois entra o ChatGPT
    console.log("Mensagem:", message);
    console.log("Chat ID:", chatId);
    console.log("Lead ID:", leadId);

    return res.sendStatus(200);
  } catch (error) {
    console.error("ERRO NO WEBHOOK:", error);
    return res.sendStatus(500);
  }
});

/* ===============================
   ROTA DE TESTE (OPCIONAL)
================================ */
app.get("/", (req, res) => {
  res.send("Servidor Kommo + ChatGPT rodando 🚀");
});

/* ===============================
   START DO SERVIDOR
================================ */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});

