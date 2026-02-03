import express from "express";
import fetch from "node-fetch";

const app = express();

/* Aceitar JSON + FORM + TEXTO */
app.use(express.json({ limit: "2mb", type: ["application/json", "application/*+json"] }));
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: ["text/*", "application/x-www-form-urlencoded"] }));

const PORT = process.env.PORT || 10000;

const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN;
const KOMMO_TOKEN = process.env.KOMMO_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/* ============== HEALTH ============== */
app.get("/health", (req, res) => {
  return res.json({ status: "ok", message: "Agente rodando" });
});

/* ============== HELPERS ============== */
function tryParseBody(req) {
  // Se já veio como objeto
  if (req.body && typeof req.body === "object") return req.body;

  // Se veio como texto, tentar JSON.parse
  if (typeof req.body === "string") {
    const raw = req.body.trim();

    // Tenta JSON
    try {
      return JSON.parse(raw);
    } catch (e) {
      // tenta "converter" formato key=value (bem simples)
      // mas normalmente o Kommo manda JSON mesmo, só muda o content-type
      return { _raw: raw };
    }
  }

  return {};
}

function extractMessage(body) {
  // Formato esperado do Kommo (mais comum)
  if (body && body.message && body.message.add && Array.isArray(body.message.add) && body.message.add.length > 0) {
    const msg = body.message.add[0];

    const texto =
      msg.text ||
      msg.message ||
      msg.body ||
      msg.content ||
      "";

    const telefone =
      (msg.contact && (msg.contact.id || msg.contact.phone || msg.contact.tel)) ||
      (msg.sender && (msg.sender.id || msg.sender.phone)) ||
      "";

    const nome =
      (msg.contact && (msg.contact.name || msg.contact.first_name)) ||
      (msg.sender && (msg.sender.name || msg.sender.username)) ||
      "Contato sem nome";

    return { texto, telefone, nome };
  }

  // Se vier em outro formato, retorna vazio
  return { texto: "", telefone: "", nome: "" };
}

/* ============== WEBHOOK ============== */
app.post("/webhook", async (req, res) => {
  console.log("================================");
  console.log("Webhook do Kommo recebido");
  console.log("Content-Type:", req.headers["content-type"] || "sem content-type");

  try {
    const body = tryParseBody(req);

    // Loga um pedaço do body pra debug (sem explodir log)
    try {
      console.log("BODY keys:", body && typeof body === "object" ? Object.keys(body) : "nao-objeto");
    } catch (e) {}

    const data = extractMessage(body);

    if (!data.texto) {
      console.log("Nenhuma mensagem encontrada");
      console.log("BODY (debug):", body && typeof body === "object" ? JSON.stringify(body).slice(0, 600) : String(body).slice(0, 600));
      console.log("================================");
      return res.status(200).json({ ok: true });
    }

    console.log("Texto:", data.texto);
    console.log("Telefone:", data.telefone || "vazio");
    console.log("Nome:", data.nome);

    /* ======= CHAMAR OPENAI ======= */
    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Você é um atendente de WhatsApp. Responda curto, claro e educado." },
          { role: "user", content: data.texto }
        ],
        temperature: 0.5
      })
    });

    const openaiData = await openaiResp.json();

    const respostaIA =
      openaiData &&
      openaiData.choices &&
      openaiData.choices[0] &&
      openaiData.choices[0].message &&
      openaiData.choices[0].message.content
        ? openaiData.choices[0].message.content
        : "Desculpa, não consegui responder agora.";

    console.log("Resposta IA:", respostaIA);

    /* ======= ENVIAR PRO KOMMO ======= */
    const kommoUrl = "https://" + KOMMO_SUBDOMAIN + ".kommo.com/api/v4/messages";

    // ATENCAO: o campo exato pode variar por canal.
    // Mantive um formato simples; se seu Kommo exigir outro, a gente ajusta com base no payload real.
    await fetch(kommoUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + KOMMO_TOKEN
      },
      body: JSON.stringify({
        message_type: "text",
        text: respostaIA,
        contact_id: data.telefone
      })
    });

    console.log("Resposta enviada ao WhatsApp");
    console.log("================================");
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.log("Erro no webhook:", err.message);
    console.log("================================");
    return res.status(200).json({ ok: true });
  }
});

/* ============== START ============== */
app.listen(PORT, () => {
  console.log("Agente rodando na porta " + PORT);
});


