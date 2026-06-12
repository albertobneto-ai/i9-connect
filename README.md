# i9 Connect

Plataforma de comunicacao em tempo real integrada ao ecossistema Ever i9.

## Funcionalidades

- Messaging: Canais de texto e mensagens diretas (DMs)
- Presenca: Status online/ausente/ocupado em tempo real
- Audio: Chamadas de voz via WebRTC (1-on-1 e grupo ate 6)
- Bot IA: Assistente DeepSeek integrado ao canal bot-ia
- Notificacoes: Eventos do Ever i9 (deploys, tasks, refinamentos)
- Webhooks: POST /api/webhook/everi9 para integracao

## Stack

- Backend: Node.js 18 + Express + Socket.io + Postgres
- Frontend: SPA vanilla (HTML/CSS/JS + Socket.io client + WebRTC)
- Auth: JWT (bcrypt + jsonwebtoken)
- IA: DeepSeek via OpenRouter
- Hosting: Heroku

## Config Vars (Heroku)

- JWT_SECRET
- DATABASE_URL (auto via addon)
- EVERI9_URL
- OPENROUTER_KEY
- BOT_MODEL (opcional)
