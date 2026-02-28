# ERP IA Central (Telegram) — ADM + PRODUÇÃO

## O que faz
- Apenas 2 grupos: **ADM** e **PRODUÇÃO** (IDs configurados no .env / Render).
- A **IA é o “cérebro” central**: lê tudo, interpreta e organiza pedidos, prioridades e próximos passos.
- **Relatório diário e semanal** automáticos (cron).
- **Leitura de arquivos PDF e CSV** enviados no Telegram (documentos): extrai texto/dados, resume e sugere ações.
- Pede **confirmação super resumida** quando a ação for “mudança crítica” (ex.: criar pedido, alterar status para concluído/cancelado, alterar valor, definir prazo).

## Variáveis de ambiente (Render)
- BOT_TOKEN=...
- TELEGRAM_ADMIN_ID=123...
- ADM_CHAT_ID=-100...
- PROD_CHAT_ID=-100...
- DATABASE_URL=postgres://...
- OPENAI_API_KEY=sk-...
- OPENAI_MODEL=gpt-4.1-mini

## Webhook (Render)
Configure o webhook do Telegram para:
`https://SEU-SERVICE.onrender.com/webhook`

## Comandos (ADM ou Produção)
- `/status` -> resumo geral
- `/hoje` -> relatório do dia
- `/semana` -> relatório da semana
- `/pedidos` -> lista de pedidos abertos
