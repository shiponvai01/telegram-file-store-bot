require("dotenv").config();

const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { MongoClient, ObjectId } = require("mongodb");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const MONGODB_URI = process.env.MONGODB_URI;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;
const PORT = process.env.PORT || 3000;
const DB_NAME = process.env.DB_NAME || "telegram_file_store";

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is missing.");
}

if (!Number.isSafeInteger(ADMIN_ID) || ADMIN_ID <= 0) {
  throw new Error("ADMIN_ID is missing or invalid.");
}

if (!MONGODB_URI) {
  throw new Error("MONGODB_URI is missing.");
}

const app = express();
const bot = new Telegraf(BOT_TOKEN);
const mongoClient = new MongoClient(MONGODB_URI);

// MongoDB connection
let db;

// Pending operations stay in memory until confirmation.
const pendingFiles = new Map();
const pendingBatches = new Map();

// Admin setup input states are temporary; saved settings are stored in MongoDB.
const adminInputStates = new Map();

const DEFAULT_START_TEXT =
  "👋 Welcome to Telegram File Store Bot!\n\n" +
  "ফাইল পেতে একটি বৈধ Share Link খুলুন।";

// HTTP health endpoints
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
  return ctx.from?.id === ADMIN_ID;
}

// Create/read the persistent bot settings document.
async function getBotSettings() {
  if (!db) {
    throw new Error("Database is not connected.");
  }

  const settingsCollection = db.collection("settings");

  await settingsCollection.updateOne(
    { _id: "botSettings" },
    {
      $setOnInsert: {
        startText: DEFAULT_START_TEXT,
        startPhotoFileId: null,
        startButtons: [],
        createdAt: new Date()
      }
    },
    { upsert: true }
  );

  const settings = await settingsCollection.findOne({ _id: "botSettings" });

  // Safe defaults for settings created by older versions.
  return {
    startText: typeof settings?.startText === "string"
      ? settings.startText
      : DEFAULT_START_TEXT,
    startPhotoFileId: settings?.startPhotoFileId || null,
    startButtons: Array.isArray(settings?.startButtons)
      ? settings.startButtons.filter((button) =>
          button &&
          typeof button.text === "string" &&
          typeof button.url === "string"
        )
      : []
  };
}

function buildStartKeyboard(buttons) {
  if (!Array.isArray(buttons) || buttons.length === 0) {
    return undefined;
  }

  // One URL button per row keeps the start screen readable on mobile.
  const rows = buttons
    .filter((button) => button && button.text && button.url)
    .slice(0, 20)
    .map((button) => [Markup.button.url(button.text, button.url)]);

  return rows.length ? Markup.inlineKeyboard(rows) : undefined;
}

async function sendConfiguredStartMessage(ctx) {
  const settings = await getBotSettings();
  const messageText = settings.startText || DEFAULT_START_TEXT;
  const keyboard = buildStartKeyboard(settings.startButtons);

  if (settings.startPhotoFileId) {
    const options = {
      caption: messageText
    };

    if (keyboard) {
      options.reply_markup = keyboard.reply_markup;
    }

    return ctx.replyWithPhoto(settings.startPhotoFileId, options);
  }

  if (keyboard) {
    return ctx.reply(messageText, keyboard);
  }

  return ctx.reply(messageText);
}

function adminPanelKeyboard() {
  return Markup.inlineKeyboard([
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
  ]);
}

function settingsMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📝 Start Message", "settings_start_message")],
    [Markup.button.callback("⬅️ Admin Panel", "admin_back")]
  ]);
}

function startMessageSettingsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📝 Start Text", "settings_start_text")],
    [Markup.button.callback("🖼️ Start Photo", "settings_start_photo")],
    [Markup.button.callback("🔘 Add Button", "settings_add_button")],
    [Markup.button.callback("⬅️ Settings", "settings_back")]
  ]);
}

async function showSettingsMenu(ctx, edit = false) {
  const message = "⚙️ <b>Settings</b>\n\nনিচের অপশন নির্বাচন করুন:";

  if (edit) {
    return ctx.editMessageText(message, {
      parse_mode: "HTML",
      ...settingsMenuKeyboard()
    });
  }

  return ctx.reply(message, {
    parse_mode: "HTML",
    ...settingsMenuKeyboard()
  });
}

async function showStartMessageSettings(ctx, edit = false) {
  const settings = await getBotSettings();
  const photoStatus = settings.startPhotoFileId ? "সেট করা আছে ✅" : "সেট করা নেই";
  const buttonCount = settings.startButtons.length;
  const message =
    "<b>Start Message</b>\n\n" +
    "<i>Customize your start message using the following buttons</i>\n\n" +
    `📝 Start Text: ${settings.startText ? "সেট করা আছে ✅" : "সেট করা নেই"}\n` +
    `🖼️ Start Photo: ${photoStatus}\n` +
    `🔘 Link Buttons: ${buttonCount}`;

  if (edit) {
    return ctx.editMessageText(message, {
      parse_mode: "HTML",
      ...startMessageSettingsKeyboard()
    });
  }

  return ctx.reply(message, {
    parse_mode: "HTML",
    ...startMessageSettingsKeyboard()
  });
}

bot.use(async (ctx, next) => {
  try {
    if (db && ctx.from && ctx.chat?.type === "private") {
      const now = new Date();

      await db.collection("users").updateOne(
        { telegramId: ctx.from.id },
        {
          $set: {
            firstName: ctx.from.first_name || "",
            lastName: ctx.from.last_name || "",
            username: ctx.from.username || "",
            languageCode: ctx.from.language_code || "",
            lastSeenAt: now
          },
          $setOnInsert: {
            telegramId: ctx.from.id,
            firstSeenAt: now
          }
        },
        { upsert: true }
      );
    }
  } catch (error) {
    console.error("User tracking error:", error.message);
  }

  return next();
});

// Telegram /start and share-link delivery
bot.start(async (ctx) => {
  const payload = ctx.startPayload;

  if (payload && payload.startsWith("file_")) {
    if (ctx.chat?.type !== "private") {
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
      await ctx.reply("❌ ফাইল পাঠানো যায়নি। পরে আবার চেষ্টা করুন।");
    }

    return;
  }

  if (payload && payload.startsWith("batch_")) {
    if (ctx.chat?.type !== "private") {
      return ctx.reply("ফাইল পেতে Bot-কে Private Chat-এ খুলুন।");
    }

    const batchId = payload.slice(6);

    if (!ObjectId.isValid(batchId)) {
      return ctx.reply("❌ Batch Share Link সঠিক নয়।");
    }

    try {
      const batch = await db.collection("batches").findOne({
        _id: new ObjectId(batchId)
      });

      // Allow older completed batches without a status field.
      // Never deliver an explicitly processing batch.
      if (
        !batch ||
        (batch.status && batch.status !== "ready") ||
        !Array.isArray(batch.files) ||
        batch.files.length === 0
      ) {
        return ctx.reply(
          "❌ Batch পাওয়া যায়নি, অথবা Store সম্পূর্ণ হয়নি।"
        );
      }

      await ctx.reply(
        `📦 Batch পাওয়া গেছে!\n` +
        `মোট ফাইল: ${batch.files.length}\n\n` +
        "ফাইল পাঠানো হচ্ছে..."
      );

      for (const file of batch.files) {
        await ctx.telegram.copyMessage(
          ctx.chat.id,
          file.storageChannelId,
          file.storageMessageId
        );
      }
    } catch (error) {
      console.error("Batch delivery error:", error.message);
      await ctx.reply(
        "❌ Batch-এর ফাইল পাঠানো যায়নি। পরে আবার চেষ্টা করুন।"
      );
    }

    return;
  }

  try {
    return await sendConfiguredStartMessage(ctx);
  } catch (error) {
    console.error("Start message delivery error:", error.message);
    return ctx.reply(DEFAULT_START_TEXT);
  }
});

// Help
bot.command("help", async (ctx) => {
  return ctx.reply(
    "📚 Available Commands:\n\n" +
    "/start - Start the bot\n" +
    "/help - Show commands\n" +
    "/admin - Open admin panel\n" +
    "/genlink - Generate a single-file link\n" +
    "/cancel - Cancel single-file upload or current admin input\n" +
    "/batch - Start batch upload\n" +
    "/finishbatch - Review batch files\n" +
    "/cancelbatch - Cancel batch upload"
  );
});

// Admin panel
bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("⛔ You are not authorized.");
  }

  return ctx.reply(
    "👑 Admin Panel\n\nনিচের একটি অপশন নির্বাচন করুন:",
    adminPanelKeyboard()
  );
});

// Settings -> Start Message
bot.action("admin_settings", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("Not authorized.");
  }

  try {
    await ctx.answerCbQuery();
    return await showSettingsMenu(ctx, true);
  } catch (error) {
    console.error("Settings menu error:", error.message);
    return ctx.reply("❌ Settings menu খোলা যায়নি। আবার চেষ্টা করো।");
  }
});

bot.action("settings_start_message", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("Not authorized.");
  }

  try {
    await ctx.answerCbQuery();
    return await showStartMessageSettings(ctx, true);
  } catch (error) {
    console.error("Start message settings menu error:", error.message);
    return ctx.reply("❌ Start Message menu খোলা যায়নি। আবার চেষ্টা করো।");
  }
});

bot.action("settings_back", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("Not authorized.");
  }

  await ctx.answerCbQuery();
  return showSettingsMenu(ctx, true);
});

bot.action("settings_start_text", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("Not authorized.");
  }

  adminInputStates.set(ctx.from.id, { type: "start_text" });
  await ctx.answerCbQuery();

  return ctx.reply(
    "📝 নতুন Start Text পাঠাও।\n\n" +
    "আগের text পরিবর্তন হবে। সর্বোচ্চ ১০২৪ অক্ষর ব্যবহার করো।\n" +
    "বাতিল করতে /cancel পাঠাও।"
  );
});

bot.action("settings_start_photo", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("Not authorized.");
  }

  adminInputStates.set(ctx.from.id, { type: "start_photo" });
  await ctx.answerCbQuery();

  return ctx.reply(
    "🖼️ এখন নতুন Start Photo হিসেবে একটি ছবি পাঠাও।\n\n" +
    "ছবিটি আগের photo-কে replace করবে।\n" +
    "বাতিল করতে /cancel পাঠাও।"
  );
});

bot.action("settings_add_button", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("Not authorized.");
  }

  try {
    const settings = await getBotSettings();
    if (settings.startButtons.length >= 20) {
      await ctx.answerCbQuery("সর্বোচ্চ ২০টি link button রাখা যাবে।", {
        show_alert: true
      });
      return;
    }

    adminInputStates.set(ctx.from.id, { type: "button_title" });
    await ctx.answerCbQuery();

    return ctx.reply(
      "🔘 Button-এর নাম পাঠাও।\n\n" +
      "উদাহরণ: 🎬 Watch Movies\n" +
      "সর্বোচ্চ ৬৪ অক্ষর।\n" +
      "বাতিল করতে /cancel পাঠাও।"
    );
  } catch (error) {
    console.error("Add button setup error:", error.message);
    return ctx.answerCbQuery("Button setup শুরু করা যায়নি।", {
      show_alert: true
    });
  }
});

// Receive text for Start Text or Add Button setup.
bot.on("text", async (ctx, next) => {
  if (!isAdmin(ctx) || ctx.chat?.type !== "private") {
    return next();
  }

  const state = adminInputStates.get(ctx.from.id);
  if (!state) {
    return next();
  }

  // Let bot commands run their normal handlers. /cancel handles setup cancellation below.
  if (ctx.message.text.startsWith("/")) {
    return next();
  }

  const value = ctx.message.text.trim();

  if (state.type === "start_photo") {
    return ctx.reply(
      "🖼️ একটি photo পাঠাও, text নয়।\n" +
      "বাতিল করতে /cancel পাঠাও।"
    );
  }

  if (state.type === "start_text") {
    if (!value) {
      return ctx.reply("⚠️ Start Text খালি রাখা যাবে না। আবার text পাঠাও।");
    }

    if (value.length > 1024) {
      return ctx.reply(
        "⚠️ Start Text সর্বোচ্চ ১০২৪ অক্ষর হতে পারবে। ছোট করে আবার পাঠাও।"
      );
    }

    try {
      await db.collection("settings").updateOne(
        { _id: "botSettings" },
        {
          $set: { startText: value, updatedAt: new Date() },
          $setOnInsert: {
            startPhotoFileId: null,
            startButtons: [],
            createdAt: new Date()
          }
        },
        { upsert: true }
      );

      adminInputStates.delete(ctx.from.id);
      await ctx.reply("✅ Start Text সফলভাবে save হয়েছে।");
      return showStartMessageSettings(ctx, false);
    } catch (error) {
      console.error("Save start text error:", error.message);
      return ctx.reply("❌ Start Text save করা যায়নি। আবার চেষ্টা করো।");
    }
  }

  if (state.type === "button_title") {
    if (!value || value.length > 64) {
      return ctx.reply("⚠️ Button-এর নাম ১ থেকে ৬৪ অক্ষরের মধ্যে দাও।");
    }

    adminInputStates.set(ctx.from.id, {
      type: "button_url",
      buttonText: value
    });

    return ctx.reply(
      `Button name: ${value}\n\n` +
      "এখন button-এর website URL পাঠাও।\n" +
      "উদাহরণ: https://spmovies.top\n" +
      "URL অবশ্যই https:// অথবা http:// দিয়ে শুরু হতে হবে।"
    );
  }

  if (state.type === "button_url") {
    let parsedUrl;

    try {
      parsedUrl = new URL(value);
    } catch (error) {
      return ctx.reply(
        "⚠️ URL সঠিক নয়। সম্পূর্ণ link পাঠাও, যেমন https://spmovies.top"
      );
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return ctx.reply("⚠️ শুধু http:// অথবা https:// website link গ্রহণ করা হবে।");
    }

    try {
      const settings = await getBotSettings();
      if (settings.startButtons.length >= 20) {
        adminInputStates.delete(ctx.from.id);
        return ctx.reply("⚠️ সর্বোচ্চ ২০টি link button রাখা যাবে।");
      }

      await db.collection("settings").updateOne(
        { _id: "botSettings" },
        {
          $push: {
            startButtons: {
              text: state.buttonText,
              url: parsedUrl.toString()
            }
          },
          $set: { updatedAt: new Date() },
          $setOnInsert: {
            startText: DEFAULT_START_TEXT,
            startPhotoFileId: null,
            createdAt: new Date()
          }
        },
        { upsert: true }
      );

      adminInputStates.delete(ctx.from.id);
      await ctx.reply(
        "✅ Link button যোগ হয়েছে।\n\n" +
        `🔘 ${state.buttonText}\n🔗 ${parsedUrl.toString()}`
      );
      return showStartMessageSettings(ctx, false);
    } catch (error) {
      console.error("Save start button error:", error.message);
      return ctx.reply("❌ Link button save করা যায়নি। আবার চেষ্টা করো।");
    }
  }

  return next();
});

bot.action("admin_users", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("Not authorized.");
  }

  try {
    await ctx.answerCbQuery();

    const users = db.collection("users");
    const total = await users.countDocuments();

    const list = await users
      .find({})
      .sort({ lastSeenAt: -1 })
      .limit(10)
      .toArray();

    let message =
      "👥 USER MANAGEMENT\n\n" +
      `মোট ব্যবহারকারী: ${total}\n\n`;

    if (list.length === 0) {
      message +=
        "এখনো কোনো ব্যবহারকারীর রেকর্ড নেই।\n\n" +
        "ব্যবহারকারীরা বটের সঙ্গে যোগাযোগ করলে এখানে দেখা যাবে।";
    } else {
      list.forEach((user, index) => {
        const name = [user.firstName, user.lastName]
          .filter(Boolean)
          .join(" ") || "নাম নেই";

        message +=
          `${index + 1}. ${name}\n` +
          `🆔 ID: ${user.telegramId}\n` +
          `👤 Username: ${user.username ? "@" + user.username : "নেই"}\n\n`;
      });

      if (total > 10) {
        message += "ℹ️ এখানে সর্বশেষ ১০ জন দেখানো হচ্ছে।\n\n";
      }
    }

    return await ctx.editMessageText(
      message,
      Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Refresh", "admin_users")],
        [Markup.button.callback("⬅️ Admin Panel", "admin_back")]
      ])
    );
  } catch (error) {
    if (error.description?.includes("message is not modified")) {
      return;
    }

    console.error("Admin users error:", error.message);
    return ctx.reply("❌ ব্যবহারকারীদের তালিকা লোড করা যায়নি।");
  }
});

// Return to Admin Panel
bot.action("admin_back", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("Not authorized.");
  }

  await ctx.answerCbQuery();

  return ctx.editMessageText(
    "👑 Admin Panel\n\nনিচের একটি অপশন নির্বাচন করুন:",
    adminPanelKeyboard()
  );
});

// Receive files for single or batch uploads, and Start Photo setup.
bot.on(
  ["document", "video", "audio", "photo", "animation", "voice", "video_note"],
  async (ctx) => {
    if (!isAdmin(ctx)) return;

    const userId = ctx.from.id;
    const adminState = adminInputStates.get(userId);

    // Start Photo setup takes priority over normal file/batch upload collection.
    if (adminState?.type === "start_photo") {
      if (!ctx.message.photo || ctx.message.photo.length === 0) {
        return ctx.reply(
          "⚠️ Start Photo হিসেবে একটি সাধারণ Telegram photo পাঠাও।\n" +
          "বাতিল করতে /cancel পাঠাও।"
        );
      }

      try {
        const photo = ctx.message.photo[ctx.message.photo.length - 1];

        await db.collection("settings").updateOne(
          { _id: "botSettings" },
          {
            $set: {
              startPhotoFileId: photo.file_id,
              updatedAt: new Date()
            },
            $setOnInsert: {
              startText: DEFAULT_START_TEXT,
              startButtons: [],
              createdAt: new Date()
            }
          },
          { upsert: true }
        );

        adminInputStates.delete(userId);
        await ctx.reply("✅ Start Photo সফলভাবে save হয়েছে।");
        return showStartMessageSettings(ctx, false);
      } catch (error) {
        console.error("Save start photo error:", error.message);
        return ctx.reply("❌ Start Photo save করা যায়নি। আবার চেষ্টা করো।");
      }
    }

    let fileType;
    if (ctx.message.document) fileType = "document";
    else if (ctx.message.video) fileType = "video";
    else if (ctx.message.audio) fileType = "audio";
    else if (ctx.message.photo) fileType = "photo";
    else if (ctx.message.animation) fileType = "animation";
    else if (ctx.message.voice) fileType = "voice";
    else if (ctx.message.video_note) fileType = "video_note";

    const batch = pendingBatches.get(userId);

    // Collect files only while a batch is collecting.
    if (batch && batch.status === "collecting") {
      batch.files.push({
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
        fileType,
        caption: ctx.message.caption || ""
      });

      return ctx.reply(
        `✅ Batch-এ ${batch.files.length}টি ফাইল যোগ হয়েছে।\n\n` +
        "আরও ফাইল পাঠাতে পারো।\n" +
        "সব শেষ হলে /finishbatch পাঠাও।\n" +
        "বাতিল করতে /cancelbatch পাঠাও।"
      );
    }

    // Do not silently treat files as single uploads while an existing batch is under review or being stored.
    if (batch) {
      return ctx.reply(
        "⚠️ একটি Batch-এর কাজ চলছে।\n" +
        "আগে সেই Batch সম্পন্ন করো অথবা বাতিল করো।"
      );
    }

    const pending = pendingFiles.get(userId);

    if (!pending || !pending.waitingForFile) {
      return ctx.reply(
        "ℹ️ প্রথমে /genlink অথবা /batch পাঠাও, তারপর ফাইল পাঠাও।"
      );
    }

    pendingFiles.set(userId, {
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
          Markup.button.callback("🔗 Generate Link", "genlink_confirm"),
          Markup.button.callback("❌ Cancel", "genlink_cancel")
        ]
      ])
    );
  }
);

// Start single-file upload
bot.command("genlink", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("⛔ You are not authorized.");
  }

  const userId = ctx.from.id;

  if (pendingBatches.has(userId)) {
    return ctx.reply(
      "⚠️ আগে চলমান Batch সম্পন্ন করো অথবা /cancelbatch পাঠাও।"
    );
  }

  if (pendingFiles.has(userId)) {
    return ctx.reply(
      "⚠️ একটি Single File Upload অপেক্ষায় আছে।\n" +
      "আগে সেটি সম্পন্ন করো অথবা /cancel পাঠাও।"
    );
  }

  pendingFiles.set(userId, {
    waitingForFile: true,
    createdAt: Date.now()
  });

  return ctx.reply(
    "📤 Send me the file, video, document, photo, APK, or other item you want to store.\n\n" +
    "❌ Cancel করতে /cancel পাঠাও।"
  );
});

// Cancel single-file confirmation
bot.action("genlink_cancel", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("⛔ Not authorized.");
  }

  const pending = pendingFiles.get(ctx.from.id);

  if (pending?.inProgress) {
    return ctx.answerCbQuery("ফাইল Store হচ্ছে। অপেক্ষা করো।", {
      show_alert: true
    });
  }

  pendingFiles.delete(ctx.from.id);
  await ctx.answerCbQuery("Cancelled.");

  return ctx.editMessageText(
    "❌ Cancelled. ফাইলটি Store করা হয়নি।\n\n" +
    "আবার শুরু করতে /genlink পাঠাও।"
  );
});

// Confirm single-file storage
bot.action("genlink_confirm", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("⛔ Not authorized.");
  }

  const userId = ctx.from.id;
  const pending = pendingFiles.get(userId);

  if (!pending || pending.waitingForFile) {
    return ctx.answerCbQuery("কোনো অপেক্ষমাণ ফাইল পাওয়া যায়নি।", {
      show_alert: true
    });
  }

  if (pending.inProgress) {
    return ctx.answerCbQuery("ফাইল Store হচ্ছে। অপেক্ষা করো।");
  }

  if (Date.now() - pending.createdAt > 30 * 60 * 1000) {
    pendingFiles.delete(userId);
    await ctx.answerCbQuery("Confirmation expired.");
    return ctx.editMessageText("⌛ সময় শেষ হয়েছে। আবার /genlink পাঠাও।");
  }

  if (!STORAGE_CHANNEL_ID) {
    return ctx.answerCbQuery("Storage channel configure করা নেই।", {
      show_alert: true
    });
  }

  if (!db) {
    return ctx.answerCbQuery("Database প্রস্তুত নয়।", { show_alert: true });
  }

  pending.inProgress = true;

  try {
    await ctx.answerCbQuery("ফাইল Store করা হচ্ছে...");

    const copied = await ctx.telegram.copyMessage(
      STORAGE_CHANNEL_ID,
      pending.chatId,
      pending.messageId
    );

    const result = await db.collection("files").insertOne({
      fileType: pending.fileType,
      storageChannelId: String(STORAGE_CHANNEL_ID),
      storageMessageId: copied.message_id,
      uploadedBy: userId,
      caption: pending.caption || "",
      createdAt: new Date()
    });

    const me = await ctx.telegram.getMe();
    const link = `https://t.me/${me.username}?start=file_${result.insertedId}`;

    pendingFiles.delete(userId);

    try {
      return await ctx.editMessageText(
        "✅ File stored successfully!\n\n" +
        "🔗 Share Link তৈরি হয়েছে!\n\n" +
        link
      );
    } catch (editError) {
      console.error("Single confirmation message error:", editError.message);
      return ctx.reply("🔗 Share Link:\n" + link);
    }
  } catch (error) {
    console.error("File storage error:", error.message);
    return ctx.reply(
      "❌ ফাইল Store সম্পূর্ণ হয়েছে কি না নিশ্চিত করা যায়নি।\n" +
      "আবার চেষ্টা করার আগে Render Logs ও MongoDB পরীক্ষা করো।"
    );
  } finally {
    pending.inProgress = false;
  }
});

// Cancel single upload or Start Message admin input
bot.command("cancel", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("⛔ You are not authorized.");
  }

  if (adminInputStates.has(ctx.from.id)) {
    adminInputStates.delete(ctx.from.id);
    return ctx.reply(
      "❌ বর্তমান Settings input বাতিল করা হয়েছে।\n\n" +
      "আবার শুরু করতে /admin → Settings → Start Message খোলো।"
    );
  }

  const pending = pendingFiles.get(ctx.from.id);

  if (!pending) {
    return ctx.reply("ℹ️ বাতিল করার মতো কোনো Single Upload নেই।");
  }

  if (pending.inProgress) {
    return ctx.reply("⚠️ ফাইল Store হচ্ছে। এখন Cancel করা যাবে না।");
  }

  pendingFiles.delete(ctx.from.id);

  return ctx.reply(
    "❌ Cancelled. ফাইলটি Store করা হয়নি।\n\n" +
    "আবার শুরু করতে /genlink পাঠাও।"
  );
});

// Start batch upload
bot.command("batch", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("⛔ You are not authorized.");
  }

  const userId = ctx.from.id;

  if (pendingFiles.has(userId)) {
    return ctx.reply("⚠️ আগে Single Upload সম্পন্ন করো অথবা /cancel পাঠাও।");
  }

  if (pendingBatches.has(userId)) {
    return ctx.reply(
      "⚠️ একটি Batch-এর কাজ ইতিমধ্যে চলছে।\n" +
      "আগে সেটি সম্পন্ন করো অথবা বাতিল করো।"
    );
  }

  pendingBatches.set(userId, {
    files: [],
    status: "collecting",
    createdAt: Date.now(),
    inProgress: false
  });

  return ctx.reply(
    "📦 Batch Upload শুরু হয়েছে!\n\n" +
    "এখন একে একে তোমার ফাইলগুলো পাঠাও।\n" +
    "সব ফাইল পাঠানো হলে /finishbatch পাঠাও।\n\n" +
    "❌ বাতিল করতে /cancelbatch পাঠাও।"
  );
});

// Review batch
bot.command("finishbatch", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("⛔ You are not authorized.");
  }

  const batch = pendingBatches.get(ctx.from.id);

  if (!batch || batch.status !== "collecting") {
    return ctx.reply("ℹ️ কোনো চলমান Batch নেই। শুরু করতে /batch পাঠাও।");
  }

  if (batch.files.length === 0) {
    return ctx.reply(
      "⚠️ Batch-এ কোনো ফাইল যোগ করা হয়নি।\n" +
      "আগে ফাইল পাঠাও, তারপর /finishbatch পাঠাও।"
    );
  }

  batch.status = "review";

  return ctx.reply(
    "📦 Batch Review\n\n" +
    `মোট ফাইল: ${batch.files.length}\n\n` +
    "ফাইলগুলো ঠিক থাকলে Generate Batch Link চাপো।\n" +
    "এখনো কোনো ফাইল Store করা হয়নি।",
    Markup.inlineKeyboard([
      [Markup.button.callback("🔗 Generate Batch Link", "batch_confirm")],
      [Markup.button.callback("❌ Cancel Batch", "batch_cancel")]
    ])
  );
});

// Cancel batch from review keyboard
bot.action("batch_cancel", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("⛔ Not authorized.");
  }

  const userId = ctx.from.id;
  const batch = pendingBatches.get(userId);

  if (!batch) {
    await ctx.answerCbQuery("কোনো চলমান Batch নেই।");
    return ctx.editMessageText("ℹ️ বাতিল করার মতো কোনো Batch নেই।");
  }

  if (batch.inProgress || batch.databaseId) {
    return ctx.answerCbQuery(
      "⚠️ Store প্রক্রিয়া শুরু হয়েছে। এখন Cancel করা যাবে না।",
      { show_alert: true }
    );
  }

  pendingBatches.delete(userId);
  await ctx.answerCbQuery("Batch cancelled.");

  return ctx.editMessageText(
    "❌ Batch Cancelled!\n\n" +
    "কোনো ফাইল Store করা হয়নি।\n" +
    "আবার শুরু করতে /batch পাঠাও।"
  );
});

// Cancel batch by command
bot.command("cancelbatch", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("⛔ You are not authorized.");
  }

  const userId = ctx.from.id;
  const batch = pendingBatches.get(userId);

  if (!batch) {
    return ctx.reply("ℹ️ বাতিল করার মতো কোনো Batch নেই।");
  }

  if (batch.inProgress || batch.databaseId) {
    return ctx.reply(
      "⚠️ Batch Store প্রক্রিয়া শুরু হয়েছে।\n" +
      "আগে সেটি সম্পন্ন বা পরীক্ষা করতে হবে।"
    );
  }

  pendingBatches.delete(userId);

  return ctx.reply(
    "❌ Batch Cancelled!\n\n" +
    "কোনো ফাইল Store করা হয়নি।\n" +
    "আবার শুরু করতে /batch পাঠাও।"
  );
});

// Confirm and store batch
bot.action("batch_confirm", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("⛔ Not authorized.");
  }

  const userId = ctx.from.id;
  const batch = pendingBatches.get(userId);

  if (!batch || !["review", "processing"].includes(batch.status)) {
    return ctx.answerCbQuery("Batch পাওয়া যায়নি। আবার /batch পাঠাও।", {
      show_alert: true
    });
  }

  if (batch.inProgress) {
    return ctx.answerCbQuery("ফাইলগুলো ইতিমধ্যে Store হচ্ছে। অপেক্ষা করো।");
  }

  if (!STORAGE_CHANNEL_ID) {
    return ctx.answerCbQuery("Storage channel configure করা নেই।", {
      show_alert: true
    });
  }

  if (!db) {
    return ctx.answerCbQuery("Database প্রস্তুত নয়।", { show_alert: true });
  }

  if (!Array.isArray(batch.files) || batch.files.length === 0) {
    return ctx.answerCbQuery("Batch-এ কোনো ফাইল নেই।", { show_alert: true });
  }

  batch.inProgress = true;

  try {
    await ctx.answerCbQuery("ফাইলগুলো Store করা হচ্ছে...");

    const collection = db.collection("batches");
    const me = await ctx.telegram.getMe();

    if (!batch.databaseId) {
      const result = await collection.insertOne({
        uploadedBy: userId,
        status: "processing",
        sourceFiles: batch.files.map((file) => ({
          chatId: file.chatId,
          messageId: file.messageId,
          fileType: file.fileType,
          caption: file.caption || ""
        })),
        files: [],
        storedCount: 0,
        fileCount: batch.files.length,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      batch.databaseId = result.insertedId;
    }

    batch.status = "processing";
    const batchId = batch.databaseId;
    let savedBatch = await collection.findOne({ _id: batchId });

    if (!savedBatch) {
      throw new Error("Batch database record not found");
    }

    if (savedBatch.status === "ready") {
      const link = `https://t.me/${me.username}?start=batch_${batchId}`;
      pendingBatches.delete(userId);

      try {
        return await ctx.editMessageText(
          "✅ Batch আগে থেকেই Store হয়েছে!\n\n" +
          `📦 মোট ফাইল: ${savedBatch.fileCount}\n\n` +
          "🔗 Batch Share Link:\n" +
          link
        );
      } catch (error) {
        return ctx.reply("🔗 Batch Share Link:\n" + link);
      }
    }

    if (
      savedBatch.status !== "processing" ||
      !Array.isArray(savedBatch.sourceFiles) ||
      !Array.isArray(savedBatch.files) ||
      savedBatch.sourceFiles.length === 0
    ) {
      throw new Error("Batch information is incomplete");
    }

    let storedCount = Number.isInteger(savedBatch.storedCount)
      ? savedBatch.storedCount
      : savedBatch.files.length;

    if (
      storedCount !== savedBatch.files.length ||
      storedCount > savedBatch.sourceFiles.length
    ) {
      throw new Error("Batch progress information is inconsistent");
    }

    if (savedBatch.storedCount !== storedCount) {
      await collection.updateOne(
        { _id: batchId, status: "processing" },
        { $set: { storedCount, updatedAt: new Date() } }
      );
    }

    for (let i = storedCount; i < savedBatch.sourceFiles.length; i++) {
      const file = savedBatch.sourceFiles[i];
      const copied = await ctx.telegram.copyMessage(
        STORAGE_CHANNEL_ID,
        file.chatId,
        file.messageId
      );

      const storedFile = {
        fileType: file.fileType,
        storageChannelId: String(STORAGE_CHANNEL_ID),
        storageMessageId: copied.message_id,
        caption: file.caption || ""
      };

      const updateResult = await collection.updateOne(
        { _id: batchId, status: "processing", storedCount: i },
        {
          $push: { files: storedFile },
          $inc: { storedCount: 1 },
          $set: { updatedAt: new Date() }
        }
      );

      if (updateResult.modifiedCount !== 1) {
        savedBatch = await collection.findOne({ _id: batchId });
        if (
          !savedBatch ||
          savedBatch.storedCount < i + 1 ||
          savedBatch.files.length < i + 1
        ) {
          throw new Error("Could not verify saved file progress");
        }
      }

      savedBatch = await collection.findOne({ _id: batchId });
      if (
        !savedBatch ||
        savedBatch.storedCount !== i + 1 ||
        savedBatch.files.length !== i + 1
      ) {
        throw new Error("Batch progress verification failed");
      }
    }

    savedBatch = await collection.findOne({ _id: batchId });
    if (
      !savedBatch ||
      savedBatch.storedCount !== savedBatch.sourceFiles.length ||
      savedBatch.files.length !== savedBatch.sourceFiles.length
    ) {
      throw new Error("Not all batch files were stored");
    }

    await collection.updateOne(
      {
        _id: batchId,
        status: "processing",
        storedCount: savedBatch.sourceFiles.length
      },
      {
        $set: {
          status: "ready",
          fileCount: savedBatch.files.length,
          readyAt: new Date(),
          updatedAt: new Date()
        }
      }
    );

    const finalBatch = await collection.findOne({ _id: batchId, status: "ready" });
    if (!finalBatch) {
      throw new Error("Batch could not be marked ready");
    }

    const link = `https://t.me/${me.username}?start=batch_${batchId}`;
    pendingBatches.delete(userId);

    try {
      return await ctx.editMessageText(
        "✅ Batch Stored Successfully!\n\n" +
        `📦 মোট ফাইল: ${finalBatch.fileCount}\n\n` +
        "🔗 Batch Share Link:\n" +
        link
      );
    } catch (error) {
      console.error("Batch confirmation message error:", error.message);
      return ctx.reply("🔗 Batch Share Link:\n" + link);
    }
  } catch (error) {
    console.error("Batch storage error:", error.message);
    return ctx.reply(
      "⚠️ Batch Store সম্পূর্ণ হয়নি বা যাচাই করা যায়নি।\n\n" +
      "এই Batch-এর তথ্য পরীক্ষা না করে নতুন Batch শুরু কোরো না।\n" +
      "Render Logs পরীক্ষা করে তারপর আবার চেষ্টা করো।"
    );
  } finally {
    batch.inProgress = false;
  }
});

// Global Telegram error handler
bot.catch((error) => {
  console.error("Telegram bot error:", error.message);
});

// Connect MongoDB before starting the bot.
async function main() {
  await mongoClient.connect();
  await mongoClient.db("admin").command({ ping: 1 });

  db = mongoClient.db(DB_NAME);
  console.log("MongoDB Atlas connected successfully.");

  // Ensure settings exist and are readable before launching the bot.
  await getBotSettings();
  await bot.launch();

  console.log("Telegram bot started successfully.");
}

main().catch((error) => {
  console.error("Startup failed:", error.message);
  process.exit(1);
});

// Graceful shutdown
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Received ${signal}. Shutting down...`);

  try {
    bot.stop(signal);
  } catch (error) {
    console.error("Bot shutdown error:", error.message);
  }

  try {
    await mongoClient.close();
  } catch (error) {
    console.error("MongoDB shutdown error:", error.message);
  }

  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
