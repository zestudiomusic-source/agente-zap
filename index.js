import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

// Coloque sua chave no Render depois (Environment Variables)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Rota raiz (só pra ver online)
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

/**
 * Extrai texto e um identificador do contato do payload do Kommo.
 * (Kommo muda bastante o formato dependendo do evento, então isso é "tolerante")
 */
function extrairMensagemKommo(body) {
  let texto = "";
  let contato = "";

  // Alguns payloads vem em body.message.add[0] (como apareceu no seu log)
  const msg0 = body?.message?.add?.[0];

  // Texto
  texto =
    msg0?.text ||
    msg0?.message?.text ||
    msg0?.data?.text ||
    body?.text ||
    body?.message?.text ||
    "";

  // Identificador do contato / chat / telefone (Kommo às vezes manda ids)
  contato =
    msg0?.contact_id ||
    msg0?.contact?.id ||
    msg0?.chat_id ||
    msg0?.source?.external_id ||
    msg0?.phone ||
    body?.contact_id ||
    body?.phone ||
    "contato_desconhecido";

  // Nome (se existir)
  const nome =
    msg0?.contact_name ||
    msg0?.contact?.name ||
    body?.contact?.name ||
    "Contato sem nome";

  return { texto, contato, nome };
}

/**
 * Chama OpenAI e devolve uma resposta curta.
 */
async function gerarRespostaIA(texto) {
  if (!OPENAI_API_KEY) {
    return "Falta configurar OPENAI_API_KEY no Render.";
  }

  const promptSistema =
    "Você é um atendente do WhatsApp. Responda curto, claro e direto, em português do Brasil.";

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": Bearer ${OPENAI_API_KEY},
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: promptSistema },
        { role: "user", content: texto }
      ],
      temperature: 0.4,
      max_tokens: 200
    })
  });

  if (!resp.ok) {
    const errTxt = await resp.text();
    return Erro ao chamar IA: ${resp.status} ${errTxt};
  }

  const data = await resp.json();
  const resposta = data?.choices?.[0]?.message?.content?.trim() || "";
  return resposta || "Não consegui gerar resposta agora.";
}

/**
 * Webhook do Kommo
 * Configure no Kommo para apontar para:
 * https://SEU-SERVICO.onrender.com/kommo/webhook
 */
app.post("/kommo/webhook", async (req, res) => {
  try {
    const body = req.body || {};
    const { texto, contato, nome } = extrairMensagemKommo(body);

    console.log("====================================");
    console.log("Webhook do Kommo recebido");
    console.log("Nome:", nome);
    console.log("Contato:", contato);
    console.log("Texto:", texto);
    console.log("Keys:", Object.keys(body));
    console.log("====================================");

    if (!texto) {
      // Quando vier evento sem texto (alguns eventos são assim)
      return res.status(200).json({ ok: true, info: "Sem texto no evento." });
    }

    const respostaIA = await gerarRespostaIA(texto);

    // Aqui a gente ainda não está mandando de volta pro Kommo/WhatsApp,
    // porque o envio depende do endpoint correto da API do Kommo (canal WhatsApp).
    // Por enquanto, só mostra no log que a IA respondeu.
    console.log("Resposta IA:", respostaIA);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.log("Erro no webhook:", err?.message || err);
    return res.status(200).json({ ok: true, error: "Erro interno" });
  }
});

app.listen(PORT, () => {
  console.log("Agente rodando na porta", PORT);
});
