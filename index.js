require("dotenv").config();

const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { MongoClient } = require("mongodb");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is missing.");
}

if (!MONGODB_URI) {
  throw new Error("MONGODB_URI is missing.");
}

const app = express();
const bot = new Telegraf(BOT_TOKEN);
const mongoClient = new MongoClient(MONGODB_URI);

let db;

app.get("/", (req, res) => {
  res.status(200).send("Telegram File Store Bot is running.");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    database: db ? "connected" : "not connected"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("HTTP server is running.");
});

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
    "নিচের একটি অপশন নির্বাচন করুন:",
    Markup.inlineKeyboard([
      [
        Markup.button.callback("📁 File Management", "admin_files"),
        Markup.button.callback("👥 Users", "admin_users")
      ],
      [
        Markup.button.callback("🔗 Generate Link", "admin_genlink"),
        Markup.button.callback("📦 Batch", "admin_batch")
      ],
      [
        Markup.button.callback("📢 Broadcast", "admin_broadcast"),
        Markup.button.callback("🚫 Ban / Unban", "admin_ban")
      ],
      [
        Markup.button.callback("⚙️ Settings", "admin_settings"),
        Markup.button.callback("📊 Statistics", "admin_stats")
      ]
    ])
  );
});

bot.catch((err) => {
  console.error("Telegram bot error:", err.message);
});

async function main() {
  await mongoClient.connect();
  await mongoClient.db("admin").command({ ping: 1 });

  db = mongoClient.db(
    process.env.DB_NAME || "telegram_file_store"
  );

  console.log("MongoDB Atlas connected successfully.");

  await bot.launch();

  console.log("Telegram bot started successfully.");
}

main().catch((err) => {
  console.error("Startup failed:", err.message);
  process.exit(1);
});

async function shutdown(signal) {
  bot.stop(signal);

  try {
    await mongoClient.close();
  } catch (err) {
    console.error("MongoDB shutdown error:", err.message);
  }

  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
