require("dotenv").config();

const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { MongoClient, ObjectId } = require("mongodb");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const MONGODB_URI = process.env.MONGODB_URI;
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;
const PORT = process.env.PORT || "telegram_file_store";
const DB_NAME = process.env.DB_NAME || 3000;

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
const broadcastStates = new Map();

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
        forceSubChannels: [],
        forceSubMessage: "⚠️ {mention} দয়া করে সব channel-এ join করুন।\nবাকি channel: {count}",
        autoDeleteEnabled: false,
        autoDeleteMinutes: 5,
        autoDeleteMessage: "⏳ এই ফাইলটি {time} মিনিট পরে মুছে ফেলা হবে।",
        noForwardEnabled: false,
        protectContentEnabled: false,
        customCaptionEnabled: false,
        customCaption: "{caption}",
        customButtons: [],
        linkShortener: { enabled: false, name: "", apiUrl: "", apiKey: "" },
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
      ? settings.startButtons.filter((button) => button && typeof button.text === "string" && typeof button.url === "string")
      : [],
    forceSubChannels: Array.isArray(settings?.forceSubChannels) ? settings.forceSubChannels : [],
    forceSubMessage: typeof settings?.forceSubMessage === "string" ? settings.forceSubMessage : "⚠️ {mention} দয়া করে সব channel-এ join করুন।\nবাকি channel: {count}",
    autoDeleteEnabled: settings?.autoDeleteEnabled === true,
    autoDeleteMinutes: Number.isInteger(settings?.autoDeleteMinutes) && settings.autoDeleteMinutes > 0 ? Math.min(settings.autoDeleteMinutes, 10080) : 5,
    autoDeleteMessage: typeof settings?.autoDeleteMessage === "string" ? settings.autoDeleteMessage : "⏳ এই ফাইলটি {time} মিনিট পরে মুছে ফেলা হবে।",
    noForwardEnabled: settings?.noForwardEnabled === true,
    protectContentEnabled: settings?.protectContentEnabled === true,
    customCaptionEnabled: settings?.customCaptionEnabled === true,
    customCaption: typeof settings?.customCaption === "string" ? settings.customCaption : "{caption}",
    customButtons: Array.isArray(settings?.customButtons) ? settings.customButtons.filter((button) => button && typeof button.text === "string" && typeof button.url === "string").slice(0, 20) : [],
    linkShortener: settings?.linkShortener && typeof settings.linkShortener === "object" ? { enabled: settings.linkShortener.enabled === true, name: settings.linkShortener.name || "", apiUrl: settings.linkShortener.apiUrl || "", apiKey: settings.linkShortener.apiKey || "" } : { enabled: false, name: "", apiUrl: "", apiKey: "" }
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
    [Markup.button.callback("📢 Force Subscribe", "settings_force_sub")],
    [Markup.button.callback("⏱️ Auto Delete", "settings_auto_delete")],
    [Markup.button.callback("🚫 No Forward", "settings_no_forward")],
    [Markup.button.callback("🛡️ Protect Content", "settings_protect_content")],
    [Markup.button.callback("✍️ Custom Caption", "settings_custom_caption")],
    [Markup.button.callback("🔘 Custom Button", "settings_custom_button")],
    [Markup.button.callback("🔗 Link Shortener", "settings_link_shortener")],
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

function escapeHtml(value = "") {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getMessageFileMeta(message) {
  const media = message.document || message.video || message.audio || message.animation || message.voice || message.video_note || (message.photo && message.photo[message.photo.length - 1]) || null;
  return {
    fileName: message.document?.file_name || message.video?.file_name || message.audio?.file_name || message.animation?.file_name || "",
    fileSize: media?.file_size || 0,
    caption: message.caption || ""
  };
}

function renderCustomCaption(template, file) {
  const original = file.caption || "";
  const name = file.fileName || "";
  const size = Number(file.fileSize) || 0;
  const sizeText = size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(2)} MB` : size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : size ? `${size} B` : "Unknown";
  return String(template || "{caption}")
    .replace(/\{file_name\}/g, name)
    .replace(/\{file_size\}/g, sizeText)
    .replace(/\{caption\}/g, original)
    .slice(0, 1024);
}

function makeDeliveryOptions(file, settings) {
  const options = {
    protect_content: Boolean(file.protectContent || settings.noForwardEnabled || settings.protectContentEnabled)
  };
  if (settings.customCaptionEnabled && file.fileType !== "voice" && file.fileType !== "video_note") {
    options.caption = renderCustomCaption(settings.customCaption, file);
  }
  if (settings.customButtons.length) {
    options.reply_markup = Markup.inlineKeyboard(
      settings.customButtons.slice(0, 20).map((button) => [Markup.button.url(button.text, button.url)])
    ).reply_markup;
  }
  return options;
}

async function scheduleDelete(ctx, message, minutes) {
  if (!message?.message_id || !ctx.chat?.id || !Number.isFinite(minutes) || minutes <= 0) return;
  const chatId = ctx.chat.id;
  const messageId = message.message_id;
  const delay = Math.min(minutes, 10080) * 60 * 1000;
  const deleteAt = new Date(Date.now() + delay);

  // Persist delete tasks so they can be recovered after a Render restart/sleep.
  if (db) {
    try {
      await db.collection("scheduledDeletes").insertOne({ chatId, messageId, deleteAt, createdAt: new Date() });
    } catch (error) {
      console.error("Persist auto-delete task error:", error.message);
    }
  }

  setTimeout(async () => {
    try { await ctx.telegram.deleteMessage(chatId, messageId); }
    catch (error) { console.error("Auto-delete error:", error.message); }
    if (db) {
      try { await db.collection("scheduledDeletes").deleteOne({ chatId, messageId }); }
      catch (error) { console.error("Clear auto-delete task error:", error.message); }
    }
  }, delay).unref?.();
}

async function processDueDeletes() {
  if (!db) return;
  const due = await db.collection("scheduledDeletes")
    .find({ deleteAt: { $lte: new Date() } })
    .sort({ deleteAt: 1 })
    .limit(100)
    .toArray();

  for (const task of due) {
    try {
      await bot.telegram.deleteMessage(task.chatId, task.messageId);
    } catch (error) {
      // It may already have been deleted or become too old to delete.
      console.error("Recovered auto-delete error:", error.message);
    } finally {
      await db.collection("scheduledDeletes").deleteOne({ _id: task._id });
    }
  }
}

async function sendDeliveredCopy(ctx, file) {
  const settings = await getBotSettings();
  const options = makeDeliveryOptions(file, settings);
  const sent = await ctx.telegram.copyMessage(ctx.chat.id, file.storageChannelId, file.storageMessageId, options);
  if (settings.autoDeleteEnabled) {
    const noticeText = settings.autoDeleteMessage.replace(/\{time\}/g, String(settings.autoDeleteMinutes));
    const notice = await ctx.reply(noticeText);
    await scheduleDelete(ctx, sent, settings.autoDeleteMinutes);
    await scheduleDelete(ctx, notice, settings.autoDeleteMinutes);
  }
  return sent;
}


function getTodayStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

async function recordLinkOpen(userId, linkType, linkId) {
  if (!db) return;
  try {
    await db.collection("linkEvents").insertOne({
      userId,
      type: linkType,
      linkId: String(linkId),
      createdAt: new Date()
    });
  } catch (error) {
    console.error("Link event error:", error.message);
  }
}

async function startSingleLinkFlow(ctx) {
  if (!isAdmin(ctx)) return ctx.reply("⛔ You are not authorized.");

  const userId = ctx.from.id;
  if (pendingBatches.has(userId)) {
    return ctx.reply("⚠️ আগে চলমান Batch সম্পন্ন করো অথবা /cancelbatch পাঠাও।");
  }
  if (pendingFiles.has(userId)) {
    return ctx.reply("⚠️ একটি Single File Upload অপেক্ষায় আছে।\nআগে সেটি সম্পন্ন করো অথবা /cancel পাঠাও।");
  }

  pendingFiles.set(userId, { waitingForFile: true, createdAt: Date.now() });
  return ctx.reply(
    "📤 Send me the file, video, document, photo, APK, or other item you want to store.\n\n" +
    "❌ Cancel করতে /cancel পাঠাও।"
  );
}

async function startBatchFlow(ctx) {
  if (!isAdmin(ctx)) return ctx.reply("⛔ You are not authorized.");

  const userId = ctx.from.id;
  if (pendingFiles.has(userId)) {
    return ctx.reply("⚠️ আগে Single Upload সম্পন্ন করো অথবা /cancel পাঠাও।");
  }
  if (pendingBatches.has(userId)) {
    return ctx.reply("⚠️ একটি Batch-এর কাজ ইতিমধ্যে চলছে।\nআগে সেটি সম্পন্ন করো অথবা বাতিল করো।");
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
}

function broadcastChoiceKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("➕ ADD More", "broadcast_add_more"),
      Markup.button.callback("No", "broadcast_done")
    ]
  ]);
}

function broadcastConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Start Broadcast", "broadcast_start")],
    [Markup.button.callback("❌ Cancel", "broadcast_cancel")]
  ]);
}

async function promptBroadcast(ctx) {
  broadcastStates.set(ctx.from.id, {
    status: "collecting",
    messages: [],
    createdAt: Date.now()
  });
  return ctx.reply(
    "দয়া করে আপনি যে মেসেজটি ব্রডকাস্ট করতে চান (লেখা, ফটো, ভিডিও বা অডিও), সেটি এখানে ফরোয়ার্ড করুন বা টাইপ করে পাঠান। বাতিল করতে /cancel লিখুন।"
  );
}

async function addBroadcastMessage(ctx) {
  const state = broadcastStates.get(ctx.from.id);
  if (!state || state.status !== "collecting") return false;
  if (state.messages.length >= 20) {
    await ctx.reply("⚠️ সর্বোচ্চ ২০টি message একসাথে broadcast করা যাবে।");
    return true;
  }

  state.messages.push({
    chatId: ctx.chat.id,
    messageId: ctx.message.message_id,
    type: ctx.message.text ? "text" : "media"
  });

  await ctx.reply(
    `✅ Broadcast message ${state.messages.length} যোগ হয়েছে।\n\nআরও কিছু পাঠাতে চাইলে ➕ ADD More চাপো। সব শেষ হলে No চাপো।`,
    broadcastChoiceKeyboard()
  );
  return true;
}

async function showBroadcastConfirmation(ctx) {
  const state = broadcastStates.get(ctx.from.id);
  if (!state || state.status !== "collecting" || state.messages.length === 0) {
    return ctx.reply("⚠️ Broadcast করার মতো কোনো message নেই।");
  }
  state.status = "review";
  return ctx.reply(
    `📢 Broadcast Confirmation\n\nমোট message: ${state.messages.length}\n\n` +
    "সব ঠিক থাকলে নিচের Start Broadcast button চাপো।",
    broadcastConfirmKeyboard()
  );
}

async function executeBroadcast(ctx) {
  const userId = ctx.from.id;
  const state = broadcastStates.get(userId);
  if (!state || state.status !== "review" || !state.messages.length) {
    return ctx.answerCbQuery("কোনো Broadcast প্রস্তুত নেই।", { show_alert: true });
  }
  if (state.inProgress) {
    return ctx.answerCbQuery("Broadcast ইতিমধ্যে চলছে।", { show_alert: true });
  }

  state.inProgress = true;
  state.status = "sending";

  try {
    const users = await db.collection("users")
      .find({ telegramId: { $ne: ADMIN_ID }, banned: { $ne: true } }, { projection: { telegramId: 1 } })
      .toArray();

    const total = users.length;
    let success = 0;
    let failed = 0;

    await ctx.answerCbQuery("Broadcast শুরু হয়েছে...");
    const progressMessage = await ctx.reply(`Sending to 0/${total} users...`);

    for (let i = 0; i < users.length; i++) {
      const targetId = users[i].telegramId;
      let userSuccess = true;

      for (const item of state.messages) {
        try {
          await ctx.telegram.copyMessage(targetId, item.chatId, item.messageId);
        } catch (error) {
          userSuccess = false;
          console.error(`Broadcast delivery error for ${targetId}:`, error.message);
          break;
        }
      }

      if (userSuccess) success++;
      else failed++;

      if ((i + 1) % 10 === 0 || i === users.length - 1) {
        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            progressMessage.message_id,
            undefined,
            `Sending to ${i + 1}/${total} users...`
          );
        } catch (error) {
          console.error("Broadcast progress update error:", error.message);
        }
      }

      // Keep a small gap between users to reduce Telegram flood-limit risk.
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        progressMessage.message_id,
        undefined,
        `Broadcast completed successfully to ${success} users!` +
        (failed ? `\nFailed: ${failed} users.` : "")
      );
    } catch (error) {
      await ctx.reply(
        `Broadcast completed successfully to ${success} users!` +
        (failed ? `\nFailed: ${failed} users.` : "")
      );
    }
  } catch (error) {
    console.error("Broadcast error:", error.message);
    await ctx.reply("❌ Broadcast সম্পন্ন করা যায়নি। Render Logs পরীক্ষা করো।");
  } finally {
    broadcastStates.delete(userId);
  }
}

function forceSubKeyboard(channels) {
  const rows = channels.map((channel, index) => [Markup.button.url(`📢 Join Channel ${index + 1}`, channel.joinUrl)]);
  rows.push([Markup.button.callback("✅ আমি Join করেছি — Check", "force_sub_check")]);
  return Markup.inlineKeyboard(rows);
}

async function getMissingForceSubChannels(ctx, settings) {
  if (!settings.forceSubChannels.length || ctx.from?.id === ADMIN_ID) return [];
  const missing = [];
  for (const channel of settings.forceSubChannels) {
    try {
      const member = await ctx.telegram.getChatMember(channel.chatId, ctx.from.id);
      if (!["creator", "administrator", "member"].includes(member.status) && !(member.status === "restricted" && member.is_member)) missing.push(channel);
    } catch (error) {
      console.error("Force-sub membership check error:", error.message);
      missing.push(channel);
    }
  }
  return missing;
}

async function enforceForceSub(ctx, next) {
  if (!ctx.from || ctx.from.id === ADMIN_ID || ctx.chat?.type !== "private") return next();
  if (ctx.callbackQuery?.data === "force_sub_check") return next();
  try {
    const settings = await getBotSettings();
    const missing = await getMissingForceSubChannels(ctx, settings);
    if (!missing.length) return next();
    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || "বন্ধু";
    const text = settings.forceSubMessage
      .replace(/\{mention\}/g, escapeHtml(name))
      .replace(/\{count\}/g, String(missing.length));
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery("আগে সব channel-এ join করুন।", { show_alert: true }).catch(() => {});
      return;
    }
    return ctx.reply(text, forceSubKeyboard(missing));
  } catch (error) {
    console.error("Force-sub enforcement error:", error.message);
    return next();
  }
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
            firstSeenAt: now,
            banned: false
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


bot.use(async (ctx, next) => {
  if (!ctx.from || ctx.from.id === ADMIN_ID || ctx.chat?.type !== "private") return next();
  try {
    const user = await db.collection("users").findOne(
      { telegramId: ctx.from.id },
      { projection: { banned: 1 } }
    );
    if (user?.banned === true) {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery("⛔ You are banned from using this bot.", { show_alert: true }).catch(() => {});
      } else {
        await ctx.reply("⛔ You are banned from using this bot.");
      }
      return;
    }
  } catch (error) {
    console.error("Ban check error:", error.message);
  }
  return next();
});

bot.use(enforceForceSub);

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

      await sendDeliveredCopy(ctx, {
        ...file,
        fileName: file.fileName || "",
        fileSize: file.fileSize || 0,
        caption: file.caption || ""
      });
      await recordLinkOpen(ctx.from.id, "file", fileId);
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
        await sendDeliveredCopy(ctx, {
          ...file,
          fileName: file.fileName || "",
          fileSize: file.fileSize || 0,
          caption: file.caption || ""
        });
      }
      await recordLinkOpen(ctx.from.id, "batch", batchId);
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

// Admin panel actions
bot.action("admin_files", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
  await ctx.answerCbQuery();
  return ctx.reply("📁 File Management এখনো configure করা হয়নি। পরে এই section-এ feature যোগ করা হবে।");
});

bot.action("admin_genlink", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
  await ctx.answerCbQuery();
  return startSingleLinkFlow(ctx);
});

bot.action("admin_batch", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
  await ctx.answerCbQuery();
  return startBatchFlow(ctx);
});

bot.action("admin_broadcast", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
  await ctx.answerCbQuery();
  return promptBroadcast(ctx);
});

bot.action("admin_ban", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
  await ctx.answerCbQuery();
  return ctx.reply(
    "🚫 Ban / Unban\n\nনিচের একটি অপশন নির্বাচন করুন:",
    Markup.inlineKeyboard([
      [Markup.button.callback("🚫 Ban User", "ban_user")],
      [Markup.button.callback("✅ Unban User", "unban_user")],
      [Markup.button.callback("⬅️ Admin Panel", "admin_back")]
    ])
  );
});

bot.action("ban_user", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
  await ctx.answerCbQuery();
  adminInputStates.set(ctx.from.id, { type: "ban_user" });
  return ctx.reply("দয়া করে যে ইউজারকে ব্যান করতে চান, তার Telegram User ID-টি পাঠান।\n\nবাতিল করতে /cancel লিখুন।");
});

bot.action("unban_user", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
  await ctx.answerCbQuery();
  adminInputStates.set(ctx.from.id, { type: "unban_user" });
  return ctx.reply("দয়া করে যে ইউজারকে UnBan করতে চান, তার Telegram User ID-টি পাঠান।\n\nবাতিল করতে /cancel লিখুন।");
});

bot.action("admin_stats", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
  await ctx.answerCbQuery();

  try {
    const today = getTodayStart();
    const [totalUsers, activeUsers, bannedUsers, totalFiles, todayLinks] = await Promise.all([
      db.collection("users").countDocuments(),
      db.collection("users").countDocuments({ lastSeenAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }),
      db.collection("users").countDocuments({ banned: true }),
      db.collection("files").countDocuments(),
      db.collection("linkEvents").countDocuments({ createdAt: { $gte: today } })
    ]);

    return ctx.reply(
      "📊 BOT STATISTICS REPORT 📊\n" +
      "---------------------------------\n" +
      `👥 Total Users: ${totalUsers}\n` +
      `🟢 Active Users (24h): ${activeUsers}\n` +
      `🚫 Banned Users: ${bannedUsers}\n\n` +
      `📁 Total Files in DB: ${totalFiles}\n` +
      `📥 Total Links Open /Downloads Today: ${todayLinks}\n` +
      "---------------------------------"
    );
  } catch (error) {
    console.error("Statistics error:", error.message);
    return ctx.reply("❌ Statistics তৈরি করা যায়নি।");
  }
});

bot.action("broadcast_add_more", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
  const state = broadcastStates.get(ctx.from.id);
  if (!state || state.status !== "collecting") return ctx.answerCbQuery("Broadcast session পাওয়া যায়নি।", { show_alert: true });
  await ctx.answerCbQuery();
  return ctx.reply("➕ আরও একটি message/file পাঠাও। সব শেষ হলে No চাপো।");
});

bot.action("broadcast_done", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
  await ctx.answerCbQuery();
  return showBroadcastConfirmation(ctx);
});

bot.action("broadcast_cancel", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
  broadcastStates.delete(ctx.from.id);
  await ctx.answerCbQuery("Broadcast cancelled.");
  return ctx.editMessageText("❌ Broadcast Cancelled. কোনো user-কে message পাঠানো হয়নি।");
});

bot.action("broadcast_start", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
  return executeBroadcast(ctx);
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

function settingsBackKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("⬅️ Settings", "settings_back")]]);
}

async function showForceSubSettings(ctx) {
  const s = await getBotSettings();
  return ctx.editMessageText(
    "<b>Force Sub</b>\n\n<i>Users can only use your bot after joining all force sub channels. Add channels below. For private channels, provide a join URL.</i>\n\n" +
    `Channels: ${s.forceSubChannels.length}\n\n` +
    "<i>Custom message placeholders: {mention}, {count}</i>",
    { parse_mode: "HTML", ...Markup.inlineKeyboard([
      [Markup.button.callback("➕ Add Channel", "force_sub_add_channel")],
      [Markup.button.callback("🗑️ Remove Channel", "force_sub_remove_channel")],
      [Markup.button.callback("💬 Message", "force_sub_message")],
      [Markup.button.callback("⬅️ Settings", "settings_back")]
    ]) }
  );
}

async function showAutoDeleteSettings(ctx) {
  const s = await getBotSettings();
  return ctx.editMessageText(
    "<b>Auto Delete</b>\n\n<i>Automatically delete messages sent to users after the selected number of minutes.</i>\n\n" +
    `Status: ${s.autoDeleteEnabled ? "Enabled ✅" : "Disabled ❌"}\nTime: ${s.autoDeleteMinutes} minute(s)`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard([
      [Markup.button.callback("⏱️ Change Time", "auto_delete_time")],
      [Markup.button.callback("💬 Message", "auto_delete_message")],
      [Markup.button.callback(s.autoDeleteEnabled ? "❌ Disable" : "✅ Enable", "auto_delete_toggle")],
      [Markup.button.callback("⬅️ Settings", "settings_back")]
    ]) }
  );
}

async function showSimpleToggle(ctx, key, title, description, callback) {
  const s = await getBotSettings();
  const enabled = s[key] === true;
  return ctx.editMessageText(
    `<b>${title}</b>\n\n${description}\n\nStatus: ${enabled ? "Enabled ✅" : "Disabled ❌"}`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard([
      [Markup.button.callback(enabled ? "❌ Disable" : "✅ Enable", callback)],
      [Markup.button.callback("⬅️ Settings", "settings_back")]
    ]) }
  );
}

async function showCustomCaptionSettings(ctx) {
  const s = await getBotSettings();
  return ctx.editMessageText(
    "<b>Custom Caption</b>\n\n<i>Use placeholders in captions:</i>\n• <code>{file_name}</code> — File Name\n• <code>{file_size}</code> — File size\n• <code>{caption}</code> — Original Caption\n\n" +
    `Status: ${s.customCaptionEnabled ? "Enabled ✅" : "Disabled ❌"}\n\nCurrent template:\n${escapeHtml(s.customCaption)}` ,
    { parse_mode: "HTML", ...Markup.inlineKeyboard([
      [Markup.button.callback("✏️ Add / Change Caption", "custom_caption_edit")],
      [Markup.button.callback(s.customCaptionEnabled ? "❌ Disable" : "✅ Enable", "custom_caption_toggle")],
      [Markup.button.callback("⬅️ Settings", "settings_back")]
    ]) }
  );
}

async function showCustomButtonsSettings(ctx) {
  const s = await getBotSettings();
  const list = s.customButtons.length ? s.customButtons.map((b, i) => `${i + 1}. ${escapeHtml(b.text)} — ${escapeHtml(b.url)}`).join("\n") : "এখনো কোনো custom button নেই।";
  return ctx.editMessageText(
    "<b>Custom Button</b>\n\n<i>You can add custom URL buttons under delivered file messages.</i>\n\n" + list,
    { parse_mode: "HTML", ...Markup.inlineKeyboard([
      [Markup.button.callback("➕ Add Button", "custom_button_add")],
      [Markup.button.callback("🗑️ Delete Button", "custom_button_delete")],
      [Markup.button.callback("⬅️ Settings", "settings_back")]
    ]) }
  );
}

async function showShortenerSettings(ctx) {
  const s = await getBotSettings();
  const x = s.linkShortener;
  return ctx.editMessageText(
    "<b>Link Shortener</b>\n\n<i>Connect a provider using an API URL template. Use {url} for the original URL and {api_key} for the API key if required.</i>\n\n" +
    `Provider: ${escapeHtml(x.name || "Not configured")}\nStatus: ${x.enabled ? "Enabled ✅" : "Disabled ❌"}`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard([
      [Markup.button.callback("➕ Add / Change Shortener", "shortener_setup")],
      [Markup.button.callback("🗑️ Remove Shortener", "shortener_remove")],
      [Markup.button.callback(x.enabled ? "❌ Disable" : "✅ Enable", "shortener_toggle")],
      [Markup.button.callback("⬅️ Settings", "settings_back")]
    ]) }
  );
}

bot.action("settings_force_sub", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); return showForceSubSettings(ctx); });
bot.action("settings_auto_delete", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); return showAutoDeleteSettings(ctx); });
bot.action("settings_no_forward", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); return showSimpleToggle(ctx, "noForwardEnabled", "No Forward", "Restrict forwarding of messages sent through share links.", "no_forward_toggle"); });
bot.action("settings_protect_content", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); return showSimpleToggle(ctx, "protectContentEnabled", "Protect Content", "Enable: forwarding is blocked for new links and deliveries. Existing links retain their per-link protection. Disable: protection follows the No Forward setting.", "protect_content_toggle"); });
bot.action("settings_custom_caption", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); return showCustomCaptionSettings(ctx); });
bot.action("settings_custom_button", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); return showCustomButtonsSettings(ctx); });
bot.action("settings_link_shortener", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); return showShortenerSettings(ctx); });

function setAdminInput(ctx, state, prompt) {
  adminInputStates.set(ctx.from.id, state);
  return ctx.reply(prompt + "\n\nবাতিল করতে /cancel পাঠাও।");
}

bot.action("force_sub_add_channel", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); return setAdminInput(ctx, { type: "force_sub_channel" }, "Channel username/ID পাঠাও। Public channel হলে @channelname, private হলে -100... ID | https://t.me/+invite-link এই format ব্যবহার করো।"); });
bot.action("force_sub_remove_channel", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
  const s = await getBotSettings();
  if (!s.forceSubChannels.length) { await ctx.answerCbQuery("কোনো channel নেই।", { show_alert: true }); return; }
  await ctx.answerCbQuery();
  return setAdminInput(ctx, { type: "force_sub_remove_channel" }, "কোন channel মুছবে? নম্বর পাঠাও:\n" + s.forceSubChannels.map((c, i) => `${i + 1}. ${c.chatId}`).join("\n"));
});
bot.action("force_sub_message", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); return setAdminInput(ctx, { type: "force_sub_message" }, "Custom Force Sub Message পাঠাও। Placeholder: {mention}, {count}"); });
bot.action("auto_delete_time", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); return setAdminInput(ctx, { type: "auto_delete_time" }, "Auto Delete time মিনিটে পাঠাও (1–10080)।"); });
bot.action("auto_delete_message", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); return setAdminInput(ctx, { type: "auto_delete_message" }, "Auto Delete alert message পাঠাও। {time} placeholder ব্যবহার করতে পারো।"); });
bot.action("auto_delete_toggle", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); const s = await getBotSettings(); await db.collection("settings").updateOne({ _id: "botSettings" }, { $set: { autoDeleteEnabled: !s.autoDeleteEnabled, updatedAt: new Date() } }); await ctx.answerCbQuery("Updated"); return showAutoDeleteSettings(ctx); });
bot.action("no_forward_toggle", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); const s = await getBotSettings(); await db.collection("settings").updateOne({ _id: "botSettings" }, { $set: { noForwardEnabled: !s.noForwardEnabled, updatedAt: new Date() } }); await ctx.answerCbQuery("Updated"); return showSimpleToggle(ctx, "noForwardEnabled", "No Forward", "Restrict forwarding of messages sent through share links.", "no_forward_toggle"); });
bot.action("protect_content_toggle", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); const s = await getBotSettings(); await db.collection("settings").updateOne({ _id: "botSettings" }, { $set: { protectContentEnabled: !s.protectContentEnabled, updatedAt: new Date() } }); await ctx.answerCbQuery("Updated"); return showSimpleToggle(ctx, "protectContentEnabled", "Protect Content", "Enable: forwarding is blocked for new links and deliveries. Existing links retain their per-link protection. Disable: protection follows the No Forward setting.", "protect_content_toggle"); });
bot.action("custom_caption_edit", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); return setAdminInput(ctx, { type: "custom_caption" }, "Custom caption template পাঠাও। Placeholder: {file_name}, {file_size}, {caption}"); });
bot.action("custom_caption_toggle", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); const s = await getBotSettings(); await db.collection("settings").updateOne({ _id: "botSettings" }, { $set: { customCaptionEnabled: !s.customCaptionEnabled, updatedAt: new Date() } }); await ctx.answerCbQuery("Updated"); return showCustomCaptionSettings(ctx); });
bot.action("custom_button_add", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); return setAdminInput(ctx, { type: "custom_button_title" }, "নতুন custom button-এর নাম পাঠাও।"); });
bot.action("custom_button_delete", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); const s = await getBotSettings(); if (!s.customButtons.length) { await ctx.answerCbQuery("কোনো button নেই।", { show_alert: true }); return; } await ctx.answerCbQuery(); return setAdminInput(ctx, { type: "custom_button_delete" }, "যে button মুছবে তার নম্বর পাঠাও:\n" + s.customButtons.map((b, i) => `${i + 1}. ${b.text}`).join("\n")); });
bot.action("shortener_setup", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); return setAdminInput(ctx, { type: "shortener_name" }, "Provider-এর নাম পাঠাও (যেমন provider name)।"); });
bot.action("shortener_remove", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await db.collection("settings").updateOne({ _id: "botSettings" }, { $set: { linkShortener: { enabled: false, name: "", apiUrl: "", apiKey: "" }, updatedAt: new Date() } }); await ctx.answerCbQuery("Removed"); return showShortenerSettings(ctx); });
bot.action("shortener_toggle", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); const s = await getBotSettings(); const next = !s.linkShortener.enabled; if (next && !s.linkShortener.apiUrl) return ctx.answerCbQuery("আগে provider configure করো।", { show_alert: true }); await db.collection("settings").updateOne({ _id: "botSettings" }, { $set: { "linkShortener.enabled": next, updatedAt: new Date() } }); await ctx.answerCbQuery("Updated"); return showShortenerSettings(ctx); });

bot.action("force_sub_check", async (ctx) => {
  if (!isAdmin(ctx)) {
    try {
      const settings = await getBotSettings();
      const missing = await getMissingForceSubChannels(ctx, settings);
      if (missing.length) return ctx.answerCbQuery("এখনো সব channel-এ join করা হয়নি।", { show_alert: true });
    } catch (error) { return ctx.answerCbQuery("Check করা যায়নি।", { show_alert: true }); }
  }
  await ctx.answerCbQuery("Subscription verified.");
  return sendConfiguredStartMessage(ctx);
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


  const broadcast = broadcastStates.get(ctx.from.id);
  if (broadcast && broadcast.status === "collecting") {
    if (ctx.message.text === "/cancel") {
      broadcastStates.delete(ctx.from.id);
      return ctx.reply("❌ Broadcast Cancelled. কোনো user-কে message পাঠানো হয়নি।");
    }
    return addBroadcastMessage(ctx);
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

  if (state.type === "force_sub_channel") {
    const parts = value.split("|").map((x) => x.trim());
    const chatId = parts[0];
    const joinUrl = parts[1] || (chatId.startsWith("@") ? `https://t.me/${chatId.slice(1)}` : "");
    if (!chatId || !joinUrl || !/^https?:\/\//i.test(joinUrl)) return ctx.reply("⚠️ Channel input ঠিক নয়। @username অথবা -100... ID | https://t.me/invite-link পাঠাও।");
    try {
      await ctx.telegram.getChat(chatId);
      await db.collection("settings").updateOne({ _id: "botSettings" }, { $addToSet: { forceSubChannels: { chatId, joinUrl } }, $set: { updatedAt: new Date() } }, { upsert: true });
      adminInputStates.delete(ctx.from.id);
      await ctx.reply("✅ Force Subscribe channel যোগ হয়েছে। Bot-কে ওই channel-এ administrator করতে হবে যেন membership check করতে পারে।");
      return showForceSubSettings(ctx);
    } catch (error) { return ctx.reply("❌ Channel যাচাই করা যায়নি। Bot-কে channel-এ add/admin করে সঠিক @username বা ID পাঠাও।"); }
  }
  if (state.type === "force_sub_remove_channel") {
    const s = await getBotSettings(); const index = Number(value) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= s.forceSubChannels.length) return ctx.reply("সঠিক channel নম্বর পাঠাও।");
    const channel = s.forceSubChannels[index];
    await db.collection("settings").updateOne({ _id: "botSettings" }, { $pull: { forceSubChannels: { chatId: channel.chatId } }, $set: { updatedAt: new Date() } });
    adminInputStates.delete(ctx.from.id); await ctx.reply("✅ Channel remove হয়েছে।"); return showForceSubSettings(ctx);
  }
  if (state.type === "force_sub_message" || state.type === "auto_delete_message") {
    const key = state.type === "force_sub_message" ? "forceSubMessage" : "autoDeleteMessage";
    await db.collection("settings").updateOne({ _id: "botSettings" }, { $set: { [key]: value, updatedAt: new Date() } }, { upsert: true });
    adminInputStates.delete(ctx.from.id); await ctx.reply("✅ Message save হয়েছে।");
    if (state.type === "force_sub_message") return showForceSubSettings(ctx);
    return showAutoDeleteSettings(ctx);
  }
  if (state.type === "auto_delete_time") {
    const minutes = Number(value);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) return ctx.reply("১ থেকে ১০০৮০-এর মধ্যে পূর্ণ মিনিট পাঠাও।");
    await db.collection("settings").updateOne({ _id: "botSettings" }, { $set: { autoDeleteMinutes: minutes, updatedAt: new Date() } }, { upsert: true });
    adminInputStates.delete(ctx.from.id); await ctx.reply("✅ Auto Delete time update হয়েছে।"); return showAutoDeleteSettings(ctx);
  }
  if (state.type === "custom_caption") {
    if (value.length > 1024) return ctx.reply("Caption template সর্বোচ্চ ১০২৪ অক্ষর হতে পারবে।");
    await db.collection("settings").updateOne({ _id: "botSettings" }, { $set: { customCaption: value, customCaptionEnabled: true, updatedAt: new Date() } }, { upsert: true });
    adminInputStates.delete(ctx.from.id); await ctx.reply("✅ Custom Caption save ও enable হয়েছে।"); return showCustomCaptionSettings(ctx);
  }
  if (state.type === "custom_button_title") {
    if (!value || value.length > 64) return ctx.reply("Button-এর নাম ১–৬৪ অক্ষরের মধ্যে দাও।");
    adminInputStates.set(ctx.from.id, { type: "custom_button_url", buttonText: value });
    return ctx.reply("এখন button-এর website URL পাঠাও (https:// দিয়ে শুরু হবে)।");
  }
  if (state.type === "custom_button_url") {
    let u; try { u = new URL(value); } catch { return ctx.reply("সঠিক URL পাঠাও, যেমন https://example.com"); }
    if (!['http:', 'https:'].includes(u.protocol)) return ctx.reply("শুধু http/https URL ব্যবহার করা যাবে।");
    const s = await getBotSettings(); if (s.customButtons.length >= 20) { adminInputStates.delete(ctx.from.id); return ctx.reply("সর্বোচ্চ ২০টি custom button রাখা যাবে।"); }
    await db.collection("settings").updateOne({ _id: "botSettings" }, { $push: { customButtons: { text: state.buttonText, url: u.toString() } }, $set: { updatedAt: new Date() } }, { upsert: true });
    adminInputStates.delete(ctx.from.id); await ctx.reply("✅ Custom Button যোগ হয়েছে।"); return showCustomButtonsSettings(ctx);
  }
  if (state.type === "custom_button_delete") {
    const s = await getBotSettings(); const index = Number(value) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= s.customButtons.length) return ctx.reply("সঠিক button নম্বর পাঠাও।");
    const buttons = s.customButtons.filter((_, i) => i !== index);
    await db.collection("settings").updateOne({ _id: "botSettings" }, { $set: { customButtons: buttons, updatedAt: new Date() } });
    adminInputStates.delete(ctx.from.id); await ctx.reply("✅ Button delete হয়েছে।"); return showCustomButtonsSettings(ctx);
  }
  if (state.type === "shortener_name") {
    adminInputStates.set(ctx.from.id, { type: "shortener_api_url", name: value });
    return ctx.reply("Provider-এর API URL template পাঠাও। {url} এবং দরকার হলে {api_key} placeholder ব্যবহার করো। উদাহরণ: https://provider.example/api?key={api_key}&url={url}");
  }
  if (state.type === "shortener_api_url") {
    if (!value.startsWith("https://") || !value.includes("{url}")) return ctx.reply("HTTPS API URL এবং {url} placeholder থাকা দরকার।");
    adminInputStates.set(ctx.from.id, { type: "shortener_api_key", name: state.name, apiUrl: value });
    return ctx.reply("Provider API key পাঠাও। API key না লাগলে NONE পাঠাও।");
  }

  if (state.type === "ban_user" || state.type === "unban_user") {
    if (!/^\d+$/.test(value)) {
      return ctx.reply("⚠️ সঠিক Telegram User ID পাঠাও। উদাহরণ: 123456789");
    }
    const targetId = Number(value);
    if (!Number.isSafeInteger(targetId) || targetId <= 0) {
      return ctx.reply("⚠️ সঠিক Telegram User ID পাঠাও।");
    }
    if (targetId === ADMIN_ID) {
      return ctx.reply("⛔ Admin-কে Ban/Unban করা যাবে না।");
    }

    const isBan = state.type === "ban_user";
    await db.collection("users").updateOne(
      { telegramId: targetId },
      {
        $set: { banned: isBan, updatedAt: new Date() },
        $setOnInsert: { telegramId: targetId, firstSeenAt: new Date(), lastSeenAt: new Date() }
      },
      { upsert: true }
    );
    adminInputStates.delete(ctx.from.id);
    return ctx.reply(isBan
      ? `User ${targetId} has been banned successfully.`
      : `User ${targetId} has been unbanned successfully.`
    );
  }

  if (state.type === "shortener_api_key") {
    const apiKey = value.toUpperCase() === "NONE" ? "" : value;
    await db.collection("settings").updateOne({ _id: "botSettings" }, { $set: { linkShortener: { name: state.name, apiUrl: state.apiUrl, apiKey, enabled: false }, updatedAt: new Date() } }, { upsert: true });
    adminInputStates.delete(ctx.from.id); await ctx.reply("✅ Provider save হয়েছে। এখন Link Shortener menu থেকে Enable করো। Provider-এর API response format অনুযায়ী পরীক্ষা করতে হবে।"); return showShortenerSettings(ctx);
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


    const broadcast = broadcastStates.get(userId);
    if (broadcast && broadcast.status === "collecting") {
      return addBroadcastMessage(ctx);
    }

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
        ...getMessageFileMeta(ctx.message)
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
      ...getMessageFileMeta(ctx.message),
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
  return startSingleLinkFlow(ctx);
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

async function shortenUrl(originalUrl) {
  const settings = await getBotSettings();
  const provider = settings.linkShortener;
  if (!provider.enabled || !provider.apiUrl) return originalUrl;
  const apiUrl = provider.apiUrl.replace(/\{api_key\}/g, encodeURIComponent(provider.apiKey || "")).replace(/\{url\}/g, encodeURIComponent(originalUrl));
  const response = await fetch(apiUrl, { method: "GET", signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Shortener HTTP ${response.status}`);
  const body = await response.text();
  let result = body.trim();
  try {
    const json = JSON.parse(body);
    result = json.shortenedUrl || json.short_url || json.shorturl || json.shortUrl || json.url || json.data?.url || json.data?.short_url || "";
  } catch {}
  if (!/^https?:\/\//i.test(result)) throw new Error("Unrecognized shortener API response");
  return result;
}

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
      fileName: pending.fileName || "",
      fileSize: pending.fileSize || 0,
      protectContent: (await getBotSettings()).protectContentEnabled,
      createdAt: new Date()
    });

    const me = await ctx.telegram.getMe();
    let link = `https://t.me/${me.username}?start=file_${result.insertedId}`;
    try { link = await shortenUrl(link); }
    catch (shortError) { console.error("Link shortener error:", shortError.message); }

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

  if (broadcastStates.has(ctx.from.id)) {
    broadcastStates.delete(ctx.from.id);
    return ctx.reply("❌ Broadcast Cancelled. কোনো user-কে message পাঠানো হয়নি।");
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
  return startBatchFlow(ctx);
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
      const currentSettings = await getBotSettings();
      const result = await collection.insertOne({
        uploadedBy: userId,
        status: "processing",
        sourceFiles: batch.files.map((file) => ({
          chatId: file.chatId,
          messageId: file.messageId,
          fileType: file.fileType,
          caption: file.caption || "",
          fileName: file.fileName || "",
          fileSize: file.fileSize || 0,
          protectContent: currentSettings.protectContentEnabled
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
      let link = `https://t.me/${me.username}?start=batch_${batchId}`;
      try { link = await shortenUrl(link); } catch (shortError) { console.error("Link shortener error:", shortError.message); }
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
        caption: file.caption || "",
        fileName: file.fileName || "",
        fileSize: file.fileSize || 0,
        protectContent: (await getBotSettings()).protectContentEnabled
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

    let link = `https://t.me/${me.username}?start=batch_${batchId}`;
    try { link = await shortenUrl(link); } catch (shortError) { console.error("Link shortener error:", shortError.message); }
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
