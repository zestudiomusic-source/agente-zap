import express from "express";
const app = express(); app.use(express.json());
const PORT = process.env.PORT || 10000;
/* Health check */ app.get("/health", (req, res) => { return res.json({ status: "ok" }); });
/* Webhook do Kommo */ app.post("/kommo/webhook", (req, res) => { console.log("=============================="); console.log("Webhook do Kommo recebido");
const body = req.body || {};
if (!body.message || !body.message.add || body.message.add.length === 0) { console.log("Nenhuma mensagem encontrada"); console.log("=============================="); return res.status(200).json({ ok: true }); }
const msg = body.message.add[0];
const texto = msg.text || ""; const telefone = msg.contact_id || "nao informado"; const nome = msg.contact && msg.contact.name ? msg.contact.name : "Contato sem nome";
console.log("Texto:", texto); console.log("Telefone:", telefone); console.log("Nome:", nome); console.log("==============================");
return res.status(200).json({ ok: true }); });

