import express from "express";

const app = express();

// 🔹 Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔹 Log de TODAS as requisições
app.use((req, res, next) => {
  console.log("==== NOVA REQUISIÇÃO ====");
  console.log(req.method, req.url);
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);
  next();
});

const PORT = process.env.PORT || 10000;

// 🔹 Rota raiz
app.get("/", (req, res) => {
  res.send("Agente online 🚀");
});

// 🔹 Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Agente rodando",
    time: new Date().toISOString()
  });
});

// 🔹 WEBHOOK DO KOMMO (ESSA É A CHAVE)
app.post("/kommo/webhook", (req, res) => {
  console.log("🔥 Kommo webhook recebido com sucesso!");
  console.log(JSON.stringify(req.body, null, 2));

  return res.status(200).json({ ok: true });
});

// 🔹 Start server
app.listen(PORT, () => {
  console.log("Agente rodando na porta", PORT);
});
teste
