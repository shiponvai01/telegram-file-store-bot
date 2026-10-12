require("dotenv").config();

const express = require("express");
const { Telegraf } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
throw new Error("BOT_TOKEN environment variable is missing.");
}

const app = express();

app.get("/", (req, res) => {
res.status(200).send("Telegram File Store Bot is running.");
});

app.get("/health", (req, res) => {
res.status(200).json({ status: "ok" });
});

app.listen(PORT, "0.0.0.0", () => {
console.log("HTTP server listening on port ${PORT}");
});

const bot = new Telegraf(BOT_TOKEN);

function isAdmin(ctx) {
return Number.isSafeInteger(ADMIN_ID) &&
ADMIN_ID > 0 &&
ctx.from?.id === ADMIN_ID;
}

bot.start(async (ctx) => {
await ctx.reply(
"👋 Welcome to Telegram File Store Bot!\n\n" +
"File sharing features are being set up."
);
});

bot.command("help", async (ctx) => {
await ctx.reply(
"📚 Available Commands:\n" +
"/start - Start the bot\n" +
"/help - Show commands"
);
});

bot.command("admin", async (ctx) => {
if (!isAdmin(ctx)) {
return ctx.reply("⛔ You are not authorized.");
}

await ctx.reply(
"👑 Admin Panel\n\n" +
"Admin controls will be added next."
);
});

bot.catch((err) => {
console.error("Telegram bot error:", err.message);
});

async function main() {
await bot.launch();
console.log("Telegram bot started successfully.");
}

main().catch((err) => {
console.error("Failed to start bot:", err.message);
process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
