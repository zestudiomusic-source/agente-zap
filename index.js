import express from "express";

const app = express();

// Precisa pegar JSON e também texto cru (alguns webhooks mandam diferente)
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// Rota raiz (pra ver no navegador)
app.get("/", (req, res) => {
  res.send("Agente online");
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Agente rodando",
    time: new Date().toISOString()
  });
});

// ---------------------------
// WEBHOOK KOMMO
// ---------------------------
app.post("/kommo/webhook", async (req, res) => {
  try {
    console.log("====================================");
    console.log("Webhook do Kommo recebido");
    console.log("BODY (raw object):");
    console.log(req.body);

    // Tentativa de extrair texto, telefone e nome
    // (o Kommo pode mudar o formato dependendo do evento)
    let texto = "";
    let telefone = "";
    let nome = "";

    // Caso comum que você mostrou: body.message.add[0]
    if (req.body && req.body.message && req.body.message.add && req.body.message.add.length > 0) {
      const item = req.body.message.add[0];

      // Texto
      if (item && item.message && typeof item.message.text === "string") {
        texto = item.message.text;
      }

      // Nome
      if (item && item.contact && item.contact.name) {
        nome = item.contact.name;
      }

      // Telefone (às vezes vem como id, às vezes phone)
      if (item && item.contact && item.contact.id) {
        telefone = String(item.contact.id);
      }
      if (item && item.contact && item.contact.phone) {
        telefone = String(item.contact.phone);
      }
    }

    // Logs bonitos
    if (!texto) {
      console.log("Nenhuma mensagem encontrada");
    } else {
      console.log("Texto: " + texto);
      console.log("Telefone: " + (telefone || "nao encontrado"));
      console.log("Nome: " + (nome || "Contato sem nome"));
    }

    console.log("====================================");

    // Resposta OK pro Kommo
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.log("Erro no webhook:");
    console.log(err);
    return res.status(500).json({ ok: false });
  }
});

// ---------------------------
// START
// ---------------------------
app.listen(PORT, () => {
  console.log("Agente rodando na porta " + PORT);
});
