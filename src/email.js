// src/email.js (envio real via Resend)
async function sendEmail({ to, subject, text, attachments = [] }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.FROM_EMAIL;

  if (!key || !from) {
    return false; // não configurado
  }

  // Resend API
  const payload = {
    from,
    to,
    subject,
    text,
  };

  // (opcional) attachments base64 — por enquanto deixo sem anexos reais
  // Se quiser, a gente integra anexos depois com base64.
  // payload.attachments = ...

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Resend error: ${res.status} ${t}`);
  }

  return true;
}

module.exports = { sendEmail };
