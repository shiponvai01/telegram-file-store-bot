require("dotenv").config();

const { Telegraf } = require("telegraf");

if (!process.env.BOT_TOKEN) {
throw new Error("BOT_TOKEN is missing. Set it in your environment variables.");
}

const bot = new Telegraf(process.env.BOT_TOKEN);

const ADMIN_ID = Number(process.env.ADMIN_ID);

function isAdmin(ctx) {
return Number.isSafeInteger(ADMIN_ID) &&
ctx.from?.id === ADMIN_ID;
}

bot.start(async (ctx) => {
await ctx.reply(
"👋 Welcome to Telegram File Store Bot!\n\n" +
"Send a file to get started."
);
});

bot.command("help", async (ctx) => {
await ctx.reply(
"📚 Available Commands:\n" +
"/start - Start the bot\n" +
"/help - Show available commands"
);
});

bot.command("admin", async (ctx) => {
if (!isAdmin(ctx)) {
return ctx.reply("⛔ You are not authorized to use this command.");
}

await ctx.reply(
"👑 Admin Panel\n\n" +
"The admin controls will be added in the next steps."
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
process.exitCode = 1;
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
