# ERP Telegram (produção/vendas)

## O que este projeto faz
- Bot Telegram para grupos (vendas, produção, financeiro, compras, relatórios, backups)
- Comando `menu` (sem /) abre painel
- Pergunta "serviços de hoje" retorna lista de pedidos do dia + ordem sugerida de produção (IA via OpenAI se tiver chave, senão heurística)
- `/setgroup <chave>` registra o chat/grupo no banco

## Variáveis de ambiente (Render)
Obrigatórias:
- `TELEGRAM_BOT_TOKEN` (ou `BOT_TOKEN`)
- `TELEGRAM_ADMIN_ID` (opcional para futuros controles)
- `DATABASE_URL`

Opcionais:
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (default: gpt-4o-mini)
- `TELEGRAM_GLOBAL_AI=1` (default: 1)
- `COMPANY_CONTEXT` (texto com contexto da empresa)
- `CRON_TOKEN` (para acessar rotas /cron/* e /debug/bot)

## Como usar
1) Suba no Render como Web Service (Node)
2) Configure env vars
3) No Telegram, dentro do grupo, rode:

`/setgroup producao`

4) Digite:

`menu`

ou

`serviços de hoje`

