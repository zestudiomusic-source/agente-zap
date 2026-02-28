const cron = require("node-cron");
const { buildDailyReport, buildWeeklyReport } = require("./reports");

const TZ = "America/Sao_Paulo";

function startSchedulers({ db, tg }) {
  const ADM_CHAT_ID = Number(process.env.ADM_CHAT_ID);
  const PROD_CHAT_ID = Number(process.env.PROD_CHAT_ID);

  cron.schedule(
    "30 18 * * *",
    async () => {
      try {
        const rep = await buildDailyReport(db);
        await tg.sendMessage(ADM_CHAT_ID, rep);
        await tg.sendMessage(PROD_CHAT_ID, rep);
      } catch (e) {
        console.error("Daily report error:", e);
      }
    },
    { timezone: TZ }
  );

  cron.schedule(
    "30 8 * * 1",
    async () => {
      try {
        const rep = await buildWeeklyReport(db);
        await tg.sendMessage(ADM_CHAT_ID, rep);
        await tg.sendMessage(PROD_CHAT_ID, rep);
      } catch (e) {
        console.error("Weekly report error:", e);
      }
    },
    { timezone: TZ }
  );

  console.log("⏰ Schedulers ligados (diário e semanal).");
}

module.exports = { startSchedulers };
