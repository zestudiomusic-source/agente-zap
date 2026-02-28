// src/openai.js
// Cliente simples OpenAI via fetch (Node 18+ já tem fetch)

function createLogger(name = "OPENAI") {
  return {
    info: (...args) => console.log(`[${name}]`, ...args),
    error: (...args) => console.error(`[${name}]`, ...args),
  };
}

async function askOpenAI({ apiKey, model, messages, maxTokens = 900, temperature = 0.2 }) {
  const logger = createLogger("OPENAI");

  if (!apiKey) throw new Error("OPENAI_API_KEY não configurado!");

  const usedModel = model || process.env.OPENAI_MODEL || "gpt-4o-mini";

  const body = {
    model: usedModel,
    messages,
    max_tokens: maxTokens,
    temperature,
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    logger.error("Erro OpenAI:", res.status, txt);
    throw new Error(`OpenAI falhou (${res.status})`);
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content || "";
  return content.trim();
}

module.exports = { askOpenAI };
