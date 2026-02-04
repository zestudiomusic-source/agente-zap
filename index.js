const express = require("express");
const fetch = require("node-fetch");

const app = express();

/* =========================
   MIDDLEWARES
========================= */
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/* =========================
   ROTA DE TESTE
========================= */
app.get("/", (req, res) => {
  res.status(200).send("Servidor Kommo rodando corretamente 🚀");
});

/* =========================
   AJUDANTES (INTENÇÃO / EXTRAÇÃO)
========================= */

// Identifica intenções comuns no WhatsApp (vendas/suporte)
function detectarIntencao(texto) {
  const t = (texto || "").toLowerCase();

  const wantsHuman =
    t.includes("humano") || t.includes("atendente") || t.includes("vendedor") || t.includes("gerente") ||
    t.includes("ligar") || t.includes("telefone") || t.includes("contato");

  const pricing =
    t.includes("preço") || t.includes("valor") || t.includes("quanto") || t.includes("orçamento") || t.includes("custa");

  const schedule =
    t.includes("prazo") || t.includes("entrega") || t.includes("instala") || t.includes("agendar") || t.includes("horário");

  const address =
    t.includes("endereço") || t.includes("localização") || t.includes("onde fica") || t.includes("loja") || t.includes("mapa");

  const support =
    t.includes("garantia") || t.includes("defeito") || t.includes("problema") || t.includes("reclama") ||
    t.includes("assistência") || t.includes("troca") || t.includes("devolução");

  const product =
    t.includes("persiana") || t.includes("cortina") || t.includes("papel de parede") ||
    t.includes("tapete") || t.includes("decoração") || t.includes("instalação");

  if (wantsHuman) return "HUMANO";
  if (support) return "SUPORTE";
  if (pricing) return "ORCAMENTO";
  if (schedule) return "PRAZO_AGENDAMENTO";
  if (address) return "ENDERECO";
  if (product) return "PRODUTO";
  return "GERAL";
}

// Tenta puxar infos úteis do texto (simples, mas já ajuda)
function extrairDados(texto) {
  const t = (texto || "").trim();

  // capturar medidas (ex: 2,50 x 1,80 / 250x180 / 2.5m)
  const medidas = [];
  const regexMed = /(\d+(?:[.,]\d+)?)\s*(m|cm)?\s*(x|×)\s*(\d+(?:[.,]\d+)?)\s*(m|cm)?/gi;
  let m;
  while ((m = regexMed.exec(t))) {
    medidas.push(m[0]);
  }

  // capturar orçamento aproximado (R$ 500, 800 etc)
  const orc = t.match(/r\$\s*\d+([.,]\d+)?/i);

  // capturar cidade (bem simples: "sou de X", "moro em X")
  const cidade = t.match(/(sou de|moro em|aqui em)\s+([A-Za-zÀ-ÿ\s-]{2,30})/i);

  return {
    medidas: medidas.length ? medidas : null,
    orcamento: orc ? orc[0] : null,
    cidade: cidade ? cidade[2].trim() : null
  };
}

/* =========================
   AGENTE (OPENAI RESPONSES API)
========================= */
async function gerarRespostaAgente({ userText, contexto }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  if (!apiKey) return "OPENAI_API_KEY não configurada.";

  const { intencao, dados, leadId, contactId, chatId, talkId, author } = contexto;

  // “base” do agente — aqui é onde você personaliza de verdade
  const system = `
Você é um atendente de WhatsApp de uma empresa de decoração (cortinas/persianas e afins).
Fale em pt-BR, curto, educado, objetivo e com foco em conversão.

REGRAS:
1) Faça 1 pergunta por vez.
2) Se for ORÇAMENTO, colete: produto, medidas (LxA), cidade/bairro, tipo de instalação, e prazo.
3) Se faltar medida, peça medida. Se faltar cidade, peça cidade.
4) Se o cliente pedir HUMANO, responda confirmando e peça um melhor horário.
5) Se for SUPORTE, peça: número do pedido (se houver), descrição do problema e fotos (se possível).
6) Nunca invente preço. Se não tiver tabela, diga que precisa das medidas e cidade para cotar.
7) Sempre finalize com uma pergunta simples para avançar.
`;

  const contextoCompacto = `
CONTEXTO TÉCNICO (não cite isso pro cliente):
- intencao: ${intencao}
- leadId: ${leadId || "null"}
- contactId: ${contactId || "null"}
- chatId: ${chatId || "null"}
- talkId: ${talkId || "null"}
- autor: ${author || "Desconhecido"}
- dados_extraidos: ${JSON.stringify(dados)}
`.trim();

  try {
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: system },
          { role: "system", content: contextoCompacto },
          { role: "user", content: userText }
        ]
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      return "Erro OpenAI: " + err;
    }

    const data = await resp.json();

    if (data.output_text) return data.output_text;

    // fallback seguro
    let chunks = [];
    for (const item of data.output || []) {
      for (const c of item.content || []) {
        if (c.type === "output_text" && c.text) chunks.push(c.text);
      }
    }
    return chunks.join("\n").trim() || "Não consegui gerar resposta agora.";

  } catch (error) {
    console.error("Erro OpenAI:", error);
    return "Erro ao gerar resposta agora. Pode repetir por favor?";
  }
}

/* =========================
   WEBHOOK KOMMO
========================= */
app.post("/kommo/webhook", async (req, res) => {
  try {
    console.log("===== WEBHOOK KOMMO =====");
    console.log(JSON.stringify(req.body, null, 2));

    // formato real do Kommo (chat)
    const event = req.body?.message?.add?.[0];

    // se não tiver mensagem, sempre responde 200 pra não dar erro no Kommo
    if (!event || !event.text) return res.sendStatus(200);

    const userText = event.text;

    // ids úteis
    const leadId = event.entity_id ?? null;
    const contactId = event.contact_id ?? null;
    const chatId = event.chat_id ?? null;
    const talkId = event.talk_id ?? null;
    const author = event.author?.name ?? "Desconhecido";

    // intenção + dados
    const intencao = detectarIntencao(userText);
    const dados = extrairDados(userText);

    console.log("Mensagem:", userText);
    console.log("Intenção:", intencao);
    console.log("Extraído:", dados);

    // resposta do agente
    const resposta = await gerarRespostaAgente({
      userText,
      contexto: { intencao, dados, leadId, contactId, chatId, talkId, author }
    });

    console.log("Resposta Agente:", resposta);

    /*
      ✅ AQUI VOCÊ ENVIA A RESPOSTA PRO WHATSAPP VIA KOMMO
      Isso depende do seu token/endpoint do Kommo.

      Exemplo (pseudo):

      await fetch("https://SEU_SUBDOMINIO.amocrm.com/api/v4/chats/" + chatId + "/messages", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + process.env.KOMMO_TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: resposta,
          talk_id: talkId
        })
      });
    */

    return res.sendStatus(200);

  } catch (error) {
    console.error("ERRO NO WEBHOOK:", error);
    return res.sendStatus(500);
  }
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});
