const express = require("express");
const { createDb } = require("./src/db");
const { makeTelegram } = require("./src/telegram");
const { startSchedulers } = require("./src/schedulers");

const PORT = process.env.PORT || 3000;

async function main() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  const db = await createDb();
  const tg = makeTelegram({ db });

  app.get("/", (req, res) => res.status(200).send("OK"));

  app.post("/webhook", async (req, res) => {
    try {
      await tg.handleUpdate(req.body);
      res.status(200).send("ok");
    } catch (e) {
      console.error("Webhook error:", e);
      res.status(200).send("ok");
    }
  });

  startSchedulers({ db, tg });

  app.listen(PORT, () => console.log("✅ Server up on", PORT));
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
