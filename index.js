const express = require("express");

const app = express();

/* ===============================
   MIDDLEWARES (OBRIGATORIO)
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

    const message = req.body.text || "Mensagem nao identificada";
    const leadId = req.body.entity_id || null;
    const contactId = req.body.contact_id || null;
    const author = (req.body.author && req.body.author.name) ? req.body.author.name : "Desconhecido";

    console.log("Mensagem:", message);
    console.log("Lead ID:", leadId);
    console.log("Contact ID:", contactId);
    console.log("Autor:", author);

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
  res.send("Servidor Kommo rodando corretamente");
});

/* ===============================
   START
================================ */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});
