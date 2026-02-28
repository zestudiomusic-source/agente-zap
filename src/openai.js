function envStr(name, required = true) {
  const v = process.env[name];
  if (!v && required) throw new Error(`${name} não configurado`);
  return v || null;
}

async function callOpenAI(messages) {
  const apiKey = envStr("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: messages.map((m) => ({
        role: m.role,
        content: [{ type: "input_text", text: m.content }],
      })),
      temperature: 0.2,
    }),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenAI error: ${r.status} ${t}`);
  }

  const data = await r.json();
  const text = data.output?.[0]?.content?.find((c) => c.type === "output_text")?.text || "";
  return (text || "").trim();
}

module.exports = { callOpenAI };
