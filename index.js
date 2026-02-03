// index.js - Endpoint para Salesbot do Kommo chamar o ChatGPT
// CommonJS (require). NAO usar "type": "module"

const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Health check
app.get("/health", function (req, res) {
  res.status(200).send("OK");
});

// Endpoint chamado pelo Salesbot
app.post("/chatgpt", async function (req, res) {
  try {
    const texto = req.body && req.body.text ? req.body.text : "";
    const telefone = req.body && req.body.phone ? req.body.phone : "";

    if (!texto) {
      return res.json({ reply: "Nao entendi sua mensagem." });
    }

    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + process.env.OPENAI_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Voce e um atendente educado e objetivo." },
            { role: "user", content: texto }
          ]
        })
      }
    );

    const data = await response.json();
    const resposta =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content
        ? data.choices[0].message.content
        : "Nao consegui responder agora.";

    return res.json({ reply: resposta });
  } catch (err) {
    return res.json({ reply: "Erro ao responder." });
  }
});

app.listen(PORT, function () {
  console.log("Servidor rodando na porta " + PORT);
});
app.post("/kommo/webhook", (req, res) => {
  console.log("========== WEBHOOK KOMMO ==========");
  console.log(JSON.stringify(req.body, null, 2));
  console.log("===================================");
  res.status(200).json({ ok: true });
});

