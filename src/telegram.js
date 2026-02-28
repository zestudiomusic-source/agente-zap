const TelegramBot = require("node-telegram-bot-api");
const db = require("./db");

function createTelegramBot() {
  const TELEGRAM_TOKEN =
    process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;

  if (!TELEGRAM_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN não configurado!");
  }

  const bot = new TelegramBot(TELEGRAM_TOKEN, {
    polling: true,
  });

  console.log("[TELEGRAM] 🤖 IA global ativada (todos os grupos)");

  // ===== MENU SIMPLES (SEM /MENU) =====
  function getMenuTexto(grupo) {
    return `🤖 ERP Inteligente - ${grupo.toUpperCase()}

Comandos naturais (sem barra):

• menu
• serviços de hoje
• pedidos de hoje
• relatório
• status

Exemplos:
"quais os serviços de hoje"
"pedidos de hoje"
"status da produção"`;
  }

  // ===== IA DE ESTRATÉGIA DE PRODUÇÃO =====
  function calcularEstrategia(pedidos) {
    const lista = pedidos.map((p) => ({
      id: p.id,
      descricao: p.description || "Serviço sem descrição",
      valor: Number(p.value) || 0,
      data: p.created_at,
    }));

    // Estratégia inteligente:
    // 1) Maior valor primeiro (financeiro)
    // 2) Depois ordem de chegada (organização)
    const ordenado = lista.sort((a, b) => {
      if (b.valor !== a.valor) return b.valor - a.valor;
      return new Date(a.data) - new Date(b.data);
    });

    let texto = "📋 SERVIÇOS DE HOJE (Ordem estratégica de produção)\n\n";

    ordenado.forEach((p, i) => {
      let prioridade = "🟢 Baixa";
      let estrategia = "Produção normal";

      if (p.valor >= 4000) {
        prioridade = "🔴 PRIORIDADE MÁXIMA";
        estrategia = "Produzir primeiro (maior impacto financeiro)";
      } else if (p.valor >= 2000) {
        prioridade = "🟡 PRIORIDADE MÉDIA";
        estrategia = "Encaixar após os serviços principais";
      } else {
        prioridade = "🟢 PRIORIDADE BAIXA";
        estrategia = "Serviço rápido para fluxo da produção";
      }

      texto += `${i + 1}️⃣ ${p.descricao}
💰 Valor: R$ ${p.valor.toFixed(2)}
🎯 ${prioridade}
🧠 Estratégia: ${estrategia}

`;
    });

    texto +=
      "📊 Análise automática da IA:\n" +
      "• Priorizar maior valor\n" +
      "• Evitar gargalos na produção\n" +
      "• Intercalar serviços rápidos\n";

    return texto;
  }

  // ===== IA GLOBAL (RESPONDE EM QUALQUER GRUPO) =====
  bot.on("message", async (msg) => {
    try {
      const chatId = msg.chat.id;
      const textoOriginal = msg.text;

      if (!textoOriginal) return;

      const text = textoOriginal.toLowerCase();

      // ===== MENU (SEM /) =====
      if (text === "menu") {
        const grupo = msg.chat.title || "Sistema";
        return bot.sendMessage(chatId, getMenuTexto(grupo));
      }

      // ===== CONSULTA: SERVIÇOS DO DIA COM ESTRATÉGIA =====
      if (
        text.includes("serviços de hoje") ||
        text.includes("servicos de hoje") ||
        text.includes("serviços do dia") ||
        text.includes("servicos do dia") ||
        text.includes("pedidos de hoje") ||
        text.includes("agenda de hoje")
      ) {
        const hoje = new Date().toISOString().slice(0, 10);

        const result = await db.query(
          `SELECT id, description, value, created_at 
           FROM orders 
           WHERE DATE(created_at) = $1 
           ORDER BY created_at ASC`,
          [hoje]
        );

        if (result.rows.length === 0) {
          return bot.sendMessage(
            chatId,
            "📭 Nenhum serviço registrado hoje."
          );
        }

        const resposta = calcularEstrategia(result.rows);
        return bot.sendMessage(chatId, resposta);
      }

      // ===== RELATÓRIO =====
      if (text.includes("relatório") || text.includes("relatorio")) {
        const result = await db.query(
          `SELECT COUNT(*) as total, COALESCE(SUM(value),0) as faturamento FROM orders`
        );

        const total = result.rows[0].total;
        const faturamento = result.rows[0].faturamento;

        return bot.sendMessage(
          chatId,
          `📊 RELATÓRIO GERAL

📦 Total de pedidos: ${total}
💰 Faturamento: R$ ${Number(faturamento).toFixed(2)}`
        );
      }

      // ===== STATUS =====
      if (text.includes("status")) {
        return bot.sendMessage(
          chatId,
          `⚙️ STATUS DO ERP

🟢 Sistema: Online
🤖 IA estratégica: Ativa
📡 Resposta automática: Todos os grupos`
        );
      }
    } catch (err) {
      console.error("[ERRO IA TELEGRAM]", err);
    }
  });

  return bot;
}

module.exports = { createTelegramBot };
