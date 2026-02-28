const { formatOrderLine, formatMoneyBRL } = require('./orders');

function heuristicPlan(orders) {
  // Strategy:
  // 1) Due date first
  // 2) Larger jobs earlier only if no due date
  // 3) Otherwise FIFO
  const score = (o) => {
    let s = 0;
    if (o.due_date) {
      const d = new Date(o.due_date);
      s += d.getTime() / 1e11; // smaller earlier
    } else {
      s += 1e6;
    }
    // prioritize higher value slightly
    if (o.value_cents != null) s -= Math.min(o.value_cents / 100000, 50);
    // earlier created first
    s += new Date(o.created_at).getTime() / 1e12;
    return s;
  };

  const sorted = [...orders].sort((a, b) => score(a) - score(b));
  const lines = sorted.map((o, idx) => `${idx + 1}. ${formatOrderLine(o)}`);

  const reasoning = [
    'Priorizei primeiro os pedidos com prazo (📅) mais próximo.',
    'Quando não há prazo, puxei primeiro os de maior valor (para melhorar fluxo de caixa), mantendo a sequência de entrada.',
    'Se algum pedido tiver urgência real, me diga e eu subo ele para o topo.'
  ].join('\n');

  return {
    mode: 'heuristic',
    order: sorted,
    message: `📋 *Serviços do dia*\n\n${lines.join('\n')}\n\n🧠 *Ordem sugerida (estratégia)*\n${reasoning}`
  };
}

async function openaiPlan({ orders, companyContext, question }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const url = 'https://api.openai.com/v1/chat/completions';

  const orderText = orders.map((o) => {
    return JSON.stringify({
      id: o.id,
      cliente: o.client_name,
      descricao: o.description,
      observacao: o.notes,
      valor: o.value_cents != null ? formatMoneyBRL(o.value_cents) : null,
      prazo: o.due_date,
      criado_em: o.created_at
    });
  }).join('\n');

  const system = `Você é um gestor de produção de estofaria/marcenaria.
Você recebe uma lista de pedidos do dia e deve:
1) Listar os pedidos em formato curto.
2) Sugerir a melhor ordem de produção com estratégia (prazo, complexidade, dependências, fluxo de caixa, logística).
3) Ser bem objetivo. Use português (Brasil).`;

  const user = `Contexto da empresa: ${companyContext || 'não informado'}
\nPergunta do usuário: ${question || 'quais os serviços do dia'}
\nPedidos (JSON por linha):\n${orderText}`;

  const body = {
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`OpenAI error: ${resp.status} ${t}`);
  }

  const json = await resp.json();
  const text = json?.choices?.[0]?.message?.content;
  if (!text) return null;
  return { mode: 'openai', message: text };
}

async function planProduction({ orders, companyContext, question }) {
  // Prefer OpenAI if configured, else heuristic
  try {
    const ai = await openaiPlan({ orders, companyContext, question });
    if (ai?.message) return ai;
  } catch (e) {
    // fallback silently
  }
  return heuristicPlan(orders);
}

module.exports = {
  planProduction
};
