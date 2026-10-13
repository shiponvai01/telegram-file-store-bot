require("dotenv").config();

const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { MongoClient, ObjectId } = require("mongodb");

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
// Temporary pending files (memory only)
const pendingFiles = new Map();

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
  const payload = ctx.startPayload;

  if (payload && payload.startsWith("file_")) {
    if (!ctx.chat || ctx.chat.type !== "private") {
      return ctx.reply("ফাইল পেতে Bot-কে Private Chat-এ খুলুন।");
    }

    const fileId = payload.slice(5);

    if (!ObjectId.isValid(fileId)) {
      return ctx.reply("❌ Share Link সঠিক নয়।");
    }

    try {
      const file = await db.collection("files").findOne({
        _id: new ObjectId(fileId)
      });

      if (!file) {
        return ctx.reply("❌ ফাইলটি পাওয়া যায়নি।");
      }

      await ctx.telegram.copyMessage(
        ctx.chat.id,
        file.storageChannelId,
        file.storageMessageId
      );
    } catch (error) {
      console.error("File delivery error:", error.message);
      await ctx.reply(
        "❌ ফাইল পাঠানো যায়নি। পরে আবার চেষ্টা করুন।"
      );
    }

    return;
  }

  await ctx.reply(
    "👋 Welcome to Telegram File Store Bot!\n\n" +
    "ফাইল পেতে একটি বৈধ Share Link খুলুন।"
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


const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;


bot.on(
  ["document", "video", "audio", "photo", "animation", "voice", "video_note"],
  async (ctx) => {
    if (!isAdmin(ctx)) return;

    const pending = pendingFiles.get(ctx.from.id);

    if (!pending || !pending.waitingForFile) {
      return ctx.reply(
        "ℹ️ প্রথমে /genlink পাঠাও, তারপর ফাইল পাঠাও।"
      );
    }

    let fileType;

    if (ctx.message.document) fileType = "document";
    else if (ctx.message.video) fileType = "video";
    else if (ctx.message.audio) fileType = "audio";
    else if (ctx.message.photo) fileType = "photo";
    else if (ctx.message.animation) fileType = "animation";
    else if (ctx.message.voice) fileType = "voice";
    else if (ctx.message.video_note) fileType = "video_note";

    pendingFiles.set(ctx.from.id, {
      waitingForFile: false,
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id,
      fileType,
      caption: ctx.message.caption || "",
      createdAt: Date.now()
    });

    return ctx.reply(
      `📦 Are you sure you want to store this ${fileType}?\n\n` +
      "Generate Link চাপলে ফাইলটি Store হবে।",
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🔗 Generate Link",
            "genlink_confirm"
          ),
          Markup.button.callback(
            "❌ Cancel",
            "genlink_cancel"
          )
        ]
      ])
    );
  }
);





bot.command("genlink", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("⛔ You are not authorized.");
  }

  pendingFiles.set(ctx.from.id, {
    waitingForFile: true,
    createdAt: Date.now()
  });

  return ctx.reply(
    "📤 Send me the file, video, document, photo, APK, or other item you want to store.\n\n" +
    "❌ Cancel করতে /cancel পাঠাও।"
  );
});



bot.action("genlink_cancel", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("⛔ Not authorized.");
  }

  pendingFiles.delete(ctx.from.id);

  await ctx.answerCbQuery("Cancelled.");
  return ctx.editMessageText(
    "❌ Cancelled. ফাইলটি Store করা হয়নি।\n\n" +
    "আবার শুরু করতে /genlink পাঠাও।"
  );
});

bot.action("genlink_confirm", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("⛔ Not authorized.");
  }

  const pending = pendingFiles.get(ctx.from.id);

  if (!pending || pending.waitingForFile) {
    await ctx.answerCbQuery("কোনো অপেক্ষমাণ ফাইল পাওয়া যায়নি।");
    return ctx.editMessageText(
      "❌ ফাইলের তথ্য পাওয়া যায়নি। আবার /genlink পাঠাও।"
    );
  }

  if (Date.now() - pending.createdAt > 30 * 60 * 1000) {
    pendingFiles.delete(ctx.from.id);
    await ctx.answerCbQuery("Confirmation expired.");
    return ctx.editMessageText(
      "⌛ সময় শেষ হয়েছে। আবার /genlink পাঠাও।"
    );
  }

  if (!STORAGE_CHANNEL_ID) {
    return ctx.answerCbQuery(
      "Storage channel configure করা নেই।",
      { show_alert: true }
    );
  }

  await ctx.answerCbQuery("ফাইল Store করা হচ্ছে...");

  try {
    const copied = await ctx.telegram.copyMessage(
      STORAGE_CHANNEL_ID,
      pending.chatId,
      pending.messageId
    );

    const result = await db.collection("files").insertOne({
      fileType: pending.fileType,
      storageChannelId: String(STORAGE_CHANNEL_ID),
      storageMessageId: copied.message_id,
      uploadedBy: ctx.from.id,
      caption: pending.caption,
      createdAt: new Date()
    });

    const me = await ctx.telegram.getMe();
    const link =
      `https://t.me/${me.username}?start=file_${result.insertedId}`;

    pendingFiles.delete(ctx.from.id);

    return ctx.editMessageText(
      "✅ File stored successfully!\n\n" +
      "🔗 Share Link তৈরি হয়েছে!\n\n" +
      link
    );
  } catch (error) {
    console.error("File storage error:", error.message);

    return ctx.reply(
      "❌ ফাইল Store করা যায়নি।\n" +
      "সমস্যা ঠিক করে আবার Generate Link চাপো।"
    );
  }
});


bot.command("cancel", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("⛔ You are not authorized.");
  }

  const pending = pendingFiles.get(ctx.from.id);

  if (!pending) {
    return ctx.reply("ℹ️ বাতিল করার মতো কোনো কাজ নেই।");
  }

  pendingFiles.delete(ctx.from.id);

  return ctx.reply(
    "❌ Cancelled. ফাইলটি Store করা হয়নি।\n\n" +
    "আবার শুরু করতে /genlink পাঠাও।"
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
