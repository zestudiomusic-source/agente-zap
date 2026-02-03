import express from "express";
const app = express();
app.use(express.json({ limit: "2mb" })); app.use(express.urlencoded({ extended: true })); // caso o Kommo envie form
const PORT = process.env.PORT || 10000;
// Loga qualquer requisição (pra confirmar se o Kommo está batendo no servidor) app.use((req, res, next) => { console.log(">> REQ", req.method, req.url); next(); });
// Função única para tratar webhook function handleKommoWebhook(req, res) { console.log("================================="); console.log("Webhook do Kommo recebido");
const body = req.body;
// Log do body bruto console.log("BODY RAW:", body);
// Tenta extrair mensagem no formato comum do Kommo let texto = ""; let telefone = ""; let nome = "";
try { if (body && body.message && body.message.add && body.message.add.length > 0) { const msg = body.message.add[0];
texto = msg.text || msg.message || msg.body || "";
  telefone = msg.contact_id || msg.phone || "";
  nome = (msg.contact && msg.contact.name) || "";
}
} catch (e) { console.log("Erro ao extrair campos:", e.message); }
if (!texto) texto = "Nenhuma mensagem encontrada"; if (!telefone) telefone = "Telefone nao identificado"; if (!nome) nome = "Contato sem nome";
console.log("Texto:", texto); console.log("Telefone:", telefone); console.log("Nome:", nome);
console.log("================================="); return res.status(200).json({ ok: true }); }
// ✅ Aceita as duas rotas (pra não depender do que está no Kommo) app.post("/kommo/webhook", handleKommoWebhook); app.post("/webhook/kommo", handleKommoWebhook);
// Raiz app.get("/", (req, res) => res.send("Agente ativo")); app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));
app.listen(PORT, () => { console.log("Agente rodando na porta " + PORT); });
