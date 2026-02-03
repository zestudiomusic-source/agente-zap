const express = require("express");

const app = express();

/* ===============================
   MIDDLEWARES (OBRIGATÓRIO)
================================ */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ===============================
   WEBHOOK KOMMO
================================ */
app.post("/kommo/webhook", async (req, res) => {
  try {
    console.log("======== WEBHOOK KOMMO ========");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("================================");

    // ✅ CAMPOS CORRETOS DO KOMMO
    const message = req.body.text || "Mensagem não identificada";
    const leadId = req.body.entity_id || null;
    const contactId = req.body.contact_id || null;
    const author = req.body.author?.name || "Desconhecido";

    console.log("Mensagem:", message);
    console.log("Lead ID:", leadId);
    console.log("Contact ID:", contactId);
    console.log("Autor:", author);

    // Aqui depois entra ChatGPT + resposta no WhatsApp

    return res.sendStatus(200);
  } catch (error) {
    console.error("ERRO NO WEBHOOK:", error);
    return res.sendStatus(500);
  }
});

/* ===============================
   ROTA DE TESTE
================================ */
app.get("/", (req, res) => {
  res.send("Servidor Kommo rodando corretamente 🚀");
});

/* ===============================


