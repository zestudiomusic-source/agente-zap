const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

/* Health check */
app.get("/health", function (req, res) {
  res.json({ status: "ok" });
});

/* Webhook Kommo */
app.post("/kommo/webhook", function (req, res) {
  console.log("==============================");
  console.log("Webhook do Kommo recebido");

  const body = req.body || {};

  if (!body.message || !body.message.add || body.message.add.length === 0) {
    console.log("Nenhuma mensagem encontrada");
    console.log("BODY:", body);
    console.log("==============================");
    return res.status(200).json({ ok: true });
  }

  const msg = body.message.add[0];

  const texto = msg.text || "";
  const telefone = msg.contact_id || "nao identificado";
  let nome = "Contato sem nome";

  if (msg.contact && msg.contact.name) {
    nome = msg.contact.name;
  }

  console.log("Texto:", texto);
  console.log("Telefone:", telefone);
  console.log("Nome:", nome);
  console.log("==============================");

  return res.status(200).json({ ok: true });
});

/* Start server */
app.listen(PORT, "0.0.0.0", function () {
  console.log("Agente rodando na porta " + PORT);
});
