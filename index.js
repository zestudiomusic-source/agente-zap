import express from "express";
import axios from "axios";

const app = express();

/**
 * Middleware para aceitar JSON e dados de formulário (Kommo envia assim)
 */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * Rota principal de webhook (Kommo)
 */
app.post("/whatsapp", async (req, res) => {
  try {
    console.log("==== NOVO EVENTO KOMMO ====");
    console.log("BODY:", JSON.stringify(req.body, null, 2));

    // Captura segura do texto da mensagem
    const texto =
      req.body?.message?.text ||
      req.body?.["message[add][0][text]"] ||
      "";

    console.log("TEXTO RECEBIDO:", texto);

    // Se não houver texto, apenas ignora (ajuste defensivo)
    if (!texto) {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "evento sem texto",
      });
    }

    // =========================
    // RESPOSTA DE TESTE
    // =========================
    // Se isso aparecer no WhatsApp, a integração está OK
    await axios.post(
      "https://api.kommo.com/api/v4/leads",
      {},
      {
        headers: {
          Authorization: `Bearer ${process.env.KOMMO_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    return res.status(200).json({
      ok: true,
      resposta: "Recebi sua mensagem ✅",
    });
  } catch (err) {
    console.error("ERRO IA:", err.message);
    return res.status(200).json({ ok: false });
  }
});

/**
 * START SERVER (OBRIGATÓRIO PARA O RENDER)
 */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Agente rodando na porta ${PORT}`);
}); 
//teste
