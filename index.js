import express from "express";
import { google } from "googleapis";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ====== GOOGLE OAUTH ======
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// MVP: guarda token em memória (se o Render reiniciar, você autoriza de novo)
let tokens = null;

// ====== ROTAS ======
app.get("/", (req, res) => {
  res.status(200).send("OK - agente online");
});

// Inicia login Google
app.get("/auth/google", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar"],
    prompt: "consent",
  });
  res.redirect(url);
});

// Callback do Google (redirect URI)
app.get("/oauth2/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Faltou o code no callback.");

    const { tokens: t } = await oauth2Client.getToken(code);
    tokens = t;
    oauth2Client.setCredentials(tokens);

    res.send("Google Calendar conectado ✅ Pode voltar pro WhatsApp.");
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("Erro ao conectar no Google. Veja logs no Render.");
  }
});

// Webhook do WhatsApp (Twilio)
app.post("/whatsapp", async (req, res) => {
  const texto = (req.body.Body || "").trim();

  // Se ainda não conectou o Google, manda o link certo
  if (!tokens) {
    const baseUrl = process.env.PUBLIC_BASE_URL || "https://SEU-SERVICO.onrender.com";
    res.set("Content-Type", "text/xml");
    return res.send(`
      <Response>
        <Message>
          Preciso conectar sua agenda primeiro.
          Abra: ${baseUrl}/auth/google
        </Message>
      </Response>
    `);
  }

  try {
    oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    // TESTE: cria um evento simples "daqui a 10 min" com 30 min de duração
    const start = new Date(Date.now() + 10 * 60 * 1000);
    const end = new Date(start.getTime() + 30 * 60 * 1000);

    await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: `Compromisso via WhatsApp`,
        description: `Mensagem: ${texto || "(sem texto)"}`,
        start: { dateTime: start.toISOString(), timeZone: "America/Sao_Paulo" },
        end: { dateTime: end.toISOString(), timeZone: "America/Sao_Paulo" },
        reminders: {
          useDefault: false,
          overrides: [
            { method: "popup", minutes: 60 },
            { method: "popup", minutes: 1440 },
          ],
        },
      },
    });

    res.set("Content-Type", "text/xml");
    res.send(`
      <Response>
        <Message>Agendado no Google Calendar ✅ (teste: daqui 10 min)</Message>
      </Response>
    `);
  } catch (err) {
    console.error("Calendar insert error:", err);
    res.set("Content-Type", "text/xml");
    res.send(`
      <Response>
        <Message>Deu erro ao criar evento. Veja os logs no Render.</Message>
      </Response>
    `);
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Agente rodando"));
