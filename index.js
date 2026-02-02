import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();

// ================== MIDDLEWARE ==================
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ================== OPENAI ==================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ================== ROTAS TESTE ==================
app.get("/", (req, res) => {
  res.send("OK - agente com IA online");
});

// ================== WEBHOOK KOMMO ==================
app.post("/whatsapp", async (req, res) => {
  console.log("========== WEBHOOK KOMMO ==========");
  console.log(req.body);

  const texto =
    req.body["message[add][0][text]"] ||
    req.body?.message?.add?.[0]?.text ||
    "";

  const chatId = req.body["message[add][0][chat_id]"];

  if (!texto || !chatId) {
    return res.status(200).json({ ok: true });
  }

  console.log("Mensagem recebida:", texto);

  try {
    // ===== IA =====
    const aiResponse = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `Você é um assistente educado e objetivo.
Responda mensagens de WhatsApp de forma curta.

Mensagem do cliente: "${texto}"`,
    });

    const respostaIA =
      aiResponse.output_text || "Pode repetir, por favor?";

    console.log("Resposta IA:", respostaIA);

    // ===== ENVIA RESPOSTA PELO KOMMO =====
    await axios.post(
      https://${process.env.KOMMO_SUBDOMAIN}.kommo.com/api/v4/messages,
      [
        {
          chat_id: chatId,
          message: {
            type: "text",
            text: respostaIA,
          },
        },
      ],
      {
        headers: {
          Authorization: Bearer ${process.env.KOMMO_TOKEN},
          "Content-Type": "application/json",
        },
      }
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("ERRO IA:", err.message);
    return res.status(200).json({ ok: false });
  }
});

// ================== START SERVER ==================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(Agente rodando na porta ${PORT});
});
