import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

app.post("/webhook/kommo", (req, res) => {
  console.log("=================================");
  console.log("Webhook do Kommo recebido");

  const body = req.body;

  if (
    !body ||
    !body.message ||
    !body.message.add ||
    body.message.add.length === 0
  ) {
    console.log("Nenhuma mensagem encontrada");
    console.log("BODY:", JSON.stringify(body, null, 2));
    console.log("=================================");
    return res.status(200).json({ ok: true });
  }

  const msg = body.message.add[0];

  const texto =
    msg.text || msg.message || msg.body || "Mensagem sem texto";

  const telefone =
    msg.contact_id || msg.phone || "Telefone não identificado";

  const nome =
    (msg.contact && msg.contact.name) || "Contato sem nome";

  console.log("Texto:", texto);
  console.log("Telefone:", telefone);
  console.log("Nome:", nome);
  console.log("=================================");

  return res.status(200).json({ ok: true });
});

app.get("/", (req, res) => {
  res.send("Agente ativo");
});

app.listen(PORT, () => {
  console.log("Agente rodando na porta " + PORT);
});
