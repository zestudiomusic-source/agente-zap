import express from "express";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.post("/whatsapp", (req, res) => {
  const msg = req.body.Body;
  console.log("Recebi:", msg);

  res.set("Content-Type", "text/xml");
  res.send(`
    <Response>
      <Message>Ok 👍 vou cuidar da agenda</Message>
    </Response>
  `);
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Agente rodando")
);
