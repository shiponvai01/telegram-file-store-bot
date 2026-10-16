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
const PERSONAL_STORAGE_CHANNEL_IDS = String(process.env.PERSONAL_STORAGE_CHANNEL_IDS || "").split(",").map((value) => value.trim()).filter(Boolean);

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
const userActivityCache = new Map();
function rememberUserActivity(userId, timestamp) {
  userActivityCache.set(userId, timestamp);
  if (userActivityCache.size > 100000) {
    const firstKeys = userActivityCache.keys();
    for (let i = 0; i < 10000; i++) { const next = firstKeys.next(); if (next.done) break; userActivityCache.delete(next.value); }
  }
}
const personalUploadStates = new Map();
const forceSubCache = new Map();
const FORCE_SUB_CACHE_TTL_MS = 30 * 1000;
const USER_ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_FREE_STORAGE_BYTES = 500 * 1024 * 1024;
const DEFAULT_FREE_FILE_LIMIT = 50;
const DEFAULT_PREMIUM_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;
const DEFAULT_PREMIUM_FILE_LIMIT = 1000;
const BOT_SETTINGS_CACHE_TTL_MS = 15 * 1000;
let botSettingsCache = null;
let botSettingsCacheAt = 0;

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

async function isStaff(ctx) {
  if (isAdmin(ctx)) return true;
  if (!db || !ctx.from?.id) return false;
  try {
    const settings = await getBotSettings();
    return settings.moderators.includes(ctx.from.id);
  } catch { return false; }
}

// Create/read the persistent bot settings document.
async function getBotSettings(forceRefresh = false) {
  if (!db) {
    throw new Error("Database is not connected.");
  }

  if (!forceRefresh && botSettingsCache && Date.now() - botSettingsCacheAt < BOT_SETTINGS_CACHE_TTL_MS) {
    return botSettingsCache;
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
        moderators: [],
        subscriptionPlans: {
          free: { storageBytes: DEFAULT_FREE_STORAGE_BYTES, fileLimit: DEFAULT_FREE_FILE_LIMIT },
          premium: { storageBytes: DEFAULT_PREMIUM_STORAGE_BYTES, fileLimit: DEFAULT_PREMIUM_FILE_LIMIT, durationDays: 30 }
        },
        createdAt: new Date()
      }
    },
    { upsert: true }
  );

  const settings = await settingsCollection.findOne({ _id: "botSettings" });

  // Safe defaults for settings created by older versions.
  const result = {
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
    linkShortener: settings?.linkShortener && typeof settings.linkShortener === "object" ? { enabled: settings.linkShortener.enabled === true, name: settings.linkShortener.name || "", apiUrl: settings.linkShortener.apiUrl || "", apiKey: settings.linkShortener.apiKey || "" } : { enabled: false, name: "", apiUrl: "", apiKey: "" },
    moderators: Array.isArray(settings?.moderators) ? settings.moderators.map(Number).filter(Number.isSafeInteger).slice(0, 50) : [],
    subscriptionPlans: {
      free: {
        storageBytes: Number(settings?.subscriptionPlans?.free?.storageBytes) > 0 ? Number(settings.subscriptionPlans.free.storageBytes) : DEFAULT_FREE_STORAGE_BYTES,
        fileLimit: Number(settings?.subscriptionPlans?.free?.fileLimit) > 0 ? Number(settings.subscriptionPlans.free.fileLimit) : DEFAULT_FREE_FILE_LIMIT
      },
      premium: {
        storageBytes: Number(settings?.subscriptionPlans?.premium?.storageBytes) > 0 ? Number(settings.subscriptionPlans.premium.storageBytes) : DEFAULT_PREMIUM_STORAGE_BYTES,
        fileLimit: Number(settings?.subscriptionPlans?.premium?.fileLimit) > 0 ? Number(settings.subscriptionPlans.premium.fileLimit) : DEFAULT_PREMIUM_FILE_LIMIT,
        durationDays: Number(settings?.subscriptionPlans?.premium?.durationDays) > 0 ? Number(settings.subscriptionPlans.premium.durationDays) : 30
      }
    }
  };
  botSettingsCache = result;
  botSettingsCacheAt = Date.now();
  return result;
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
  let sent;
  if (settings.startPhotoFileId) {
    const options = { caption: messageText };
    if (keyboard) options.reply_markup = keyboard.reply_markup;
    sent = await ctx.replyWithPhoto(settings.startPhotoFileId, options);
  } else if (keyboard) {
    sent = await ctx.reply(messageText, keyboard);
  } else {
    sent = await ctx.reply(messageText);
  }
  await ctx.reply("🏠 Menu", userMainKeyboard());
  return sent;
}

function adminPanelKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📁 File Management", "admin_files"), Markup.button.callback("👥 Users", "admin_users")],
    [Markup.button.callback("🔗 Generate Link", "admin_genlink"), Markup.button.callback("📦 Batch", "admin_batch")],
    [Markup.button.callback("📢 Broadcast", "admin_broadcast"), Markup.button.callback("🚫 Ban / Unban", "admin_ban")],
    [Markup.button.callback("💎 Subscription", "admin_subscription"), Markup.button.callback("👮 Moderator", "admin_moderator")],
    [Markup.button.callback("⚙️ Settings", "admin_settings"), Markup.button.callback("📊 Statistics", "admin_stats")],
    [Markup.button.callback("🔄 Restart", "admin_restart")]
  ]);
}

function userMainKeyboard() {
  return Markup.keyboard([
    ["📁 My Files", "💎 Subscription"],
    ["💾 My Storage", "🔗 My Links"],
    ["👤 My Account", "ℹ️ Help"]
  ]).resize().persistent();
}

function getPersonalStorageChannels() {
  return PERSONAL_STORAGE_CHANNEL_IDS.length ? PERSONAL_STORAGE_CHANNEL_IDS : (STORAGE_CHANNEL_ID ? [String(STORAGE_CHANNEL_ID)] : []);
}

function bytesToText(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / (1024 ** 3)).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / (1024 ** 2)).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function isExpiredPaidUser(user, now = new Date()) {
  return user?.plan === "premium" && Boolean(user?.subscriptionExpiresAt) && new Date(user.subscriptionExpiresAt) <= now;
}

function getUserPlan(user) {
  return user?.plan === "premium" && user?.subscriptionStatus === "active" && (!user.subscriptionExpiresAt || new Date(user.subscriptionExpiresAt) > new Date()) ? "premium" : "free";
}

function getSubscriptionLabel(user) {
  if (isExpiredPaidUser(user)) return "Expired ⌛";
  return getUserPlan(user) === "premium" ? "Paid ⭐" : "Free 🆓";
}

function getPlanLimits(user, settings) {
  const plan = getUserPlan(user);
  const base = settings.subscriptionPlans[plan];
  const storageBytes = Number(user?.customStorageLimitBytes) > 0 ? Number(user.customStorageLimitBytes) : base.storageBytes;
  const fileLimit = Number(user?.customFileLimit) > 0 ? Number(user.customFileLimit) : base.fileLimit;
  return { plan, storageBytes, fileLimit, ...(plan === "premium" ? { durationDays: base.durationDays } : {}) };
}

// Quota usage includes personal files and user-created share-link batches.
// Admin-created batches are excluded from member quotas.
async function getQuotaUsage(user) {
  const userId = Number(user?.telegramId);
  const batchTotals = await db.collection("batches").aggregate([
    { $match: { uploadedBy: userId, countsTowardQuota: true } },
    { $group: {
      _id: null,
      fileCount: { $sum: { $ifNull: ["$quotaFileCount", 0] } },
      storageBytes: { $sum: { $ifNull: ["$quotaStorageBytes", 0] } }
    } }
  ]).toArray();
  return {
    fileCount: Math.max(0, Number(user?.personalFileCount) || 0) + Math.max(0, Number(batchTotals[0]?.fileCount) || 0),
    storageBytes: Math.max(0, Number(user?.storageUsedBytes) || 0) + Math.max(0, Number(batchTotals[0]?.storageBytes) || 0)
  };
}

async function validateBatchQuota(ctx, batch) {
  if (isAdmin(ctx)) return null;
  const user = await ensureUser(ctx.from);
  if (!user) return "❌ User তথ্য পাওয়া যায়নি। আবার /batch দিয়ে চেষ্টা করুন।";
  if (user.banned) return "⛔ আপনার account block করা হয়েছে।";
  if (isExpiredPaidUser(user)) return "⌛ আপনার Paid Subscription-এর মেয়াদ শেষ। পুরোনো ফাইল পাওয়া যাবে, কিন্তু নতুন Batch Upload বন্ধ। Renew করতে Admin-এর সঙ্গে যোগাযোগ করুন।";
  const settings = await getBotSettings();
  const limits = getPlanLimits(user, settings);
  const usage = await getQuotaUsage(user);
  const newFileCount = Array.isArray(batch?.files) ? batch.files.length : 0;
  const newStorageBytes = (batch?.files || []).reduce((sum, file) => sum + Math.max(0, Number(file.fileSize) || 0), 0);
  if (usage.fileCount + newFileCount > limits.fileLimit) {
    return `❌ File limit ছাড়িয়ে যাবে। বর্তমানে ${usage.fileCount}/${limits.fileLimit} files; এই Batch-এ ${newFileCount}টি ফাইল আছে।`;
  }
  if (usage.storageBytes + newStorageBytes > limits.storageBytes) {
    return `❌ Storage limit ছাড়িয়ে যাবে। বর্তমানে ${bytesToText(usage.storageBytes)} / ${bytesToText(limits.storageBytes)}; এই Batch-এর size ${bytesToText(newStorageBytes)}।`;
  }
  return null;
}

async function ensureIndexes() {
  const jobs = [
    db.collection("users").createIndex({ telegramId: 1 }, { unique: true, name: "users_telegramId_unique" }),
    db.collection("users").createIndex({ lastSeenAt: -1 }, { name: "users_lastSeenAt" }),
    db.collection("users").createIndex({ banned: 1 }, { name: "users_banned" }),
    db.collection("users").createIndex({ plan: 1, subscriptionExpiresAt: 1 }, { name: "users_subscription" }),
    db.collection("files").createIndex({ uploadedBy: 1, createdAt: -1 }, { name: "files_uploadedBy_createdAt" }),
    db.collection("files").createIndex({ storageChannelId: 1, storageMessageId: 1 }, { unique: true, name: "files_storage_message_unique" }),
    db.collection("personalFiles").createIndex({ ownerId: 1, createdAt: -1 }, { name: "personalFiles_owner_createdAt" }),
    db.collection("personalFiles").createIndex({ storageChannelId: 1, storageMessageId: 1 }, { unique: true, name: "personalFiles_storage_message_unique" }),
    db.collection("linkEvents").createIndex({ createdAt: -1 }, { name: "linkEvents_createdAt" }),
    db.collection("scheduledDeletes").createIndex({ deleteAt: 1 }, { name: "scheduledDeletes_deleteAt" }),
    db.collection("dailyStats").createIndex({ updatedAt: -1 }, { name: "dailyStats_updatedAt" }),
    db.collection("batches").createIndex({ uploadedBy: 1, createdAt: -1 }, { name: "batches_uploadedBy_createdAt" })
  ];
  for (const job of jobs) {
    try { await job; } catch (error) { console.error("Index creation warning:", error.message); }
  }
}

async function ensureUser(user) {
  if (!db || !user?.id) return null;
  const collection = db.collection("users");
  const now = new Date();
  const existing = await collection.findOne({ telegramId: user.id });

  if (!existing) {
    await collection.updateOne(
      { telegramId: user.id },
      {
        $set: {
          firstName: user.first_name || "",
          lastName: user.last_name || "",
          username: user.username || "",
          languageCode: user.language_code || "",
          firstSeenAt: now,
          lastSeenAt: now,
          storageUsedBytes: 0,
          personalFileCount: 0,
          plan: "free",
          subscriptionStatus: "free",
          subscriptionExpiresAt: null,
          updatedAt: now
        },
        $setOnInsert: { telegramId: user.id, banned: false }
      },
      { upsert: true }
    );
    rememberUserActivity(user.id, now.getTime());
    return collection.findOne({ telegramId: user.id });
  }

  const missingDefaults = existing.storageUsedBytes === undefined || existing.personalFileCount === undefined || !existing.plan || !existing.subscriptionStatus;
  if (missingDefaults) {
    await collection.updateOne(
      { telegramId: user.id },
      { $set: { storageUsedBytes: Number(existing.storageUsedBytes) || 0, personalFileCount: Number(existing.personalFileCount) || 0, plan: existing.plan || "free", subscriptionStatus: existing.subscriptionStatus || "free", subscriptionExpiresAt: existing.subscriptionExpiresAt || null, updatedAt: now } }
    );
  }

  const lastWrite = userActivityCache.get(user.id) || 0;
  if (now.getTime() - lastWrite >= USER_ACTIVITY_WRITE_INTERVAL_MS) {
    await collection.updateOne(
      { telegramId: user.id },
      { $set: { firstName: user.first_name || existing.firstName || "", lastName: user.last_name || existing.lastName || "", username: user.username || existing.username || "", languageCode: user.language_code || existing.languageCode || "", lastSeenAt: now, updatedAt: now } }
    );
    rememberUserActivity(user.id, now.getTime());
  }
  return collection.findOne({ telegramId: user.id });
}

function getUserFileInfo(message) {
  const meta = getMessageFileMeta(message);
  let fileType = "unknown";
  if (message.document) fileType = "document";
  else if (message.video) fileType = "video";
  else if (message.audio) fileType = "audio";
  else if (message.photo) fileType = "photo";
  else if (message.animation) fileType = "animation";
  else if (message.voice) fileType = "voice";
  else if (message.video_note) fileType = "video_note";
  return { fileType, ...meta };
}

async function choosePersonalStorageChannel(fileType) {
  const channels = getPersonalStorageChannels();
  if (!channels.length) throw new Error("No personal storage channel configured");
  const hash = String(fileType || "document").split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return channels[hash % channels.length];
}

function userFilesKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📤 Upload File", "user_upload")],
    [Markup.button.callback("🔗 My Links", "user_links"), Markup.button.callback("🔄 Refresh", "user_files")],
    [Markup.button.callback("⬅️ Main Menu", "user_menu")]
  ]);
}

async function showMyFiles(ctx) {
  const settings = await getBotSettings();
  const user = await ensureUser(ctx.from);
  const limits = getPlanLimits(user, settings);
  const files = await db.collection("personalFiles").find({ ownerId: ctx.from.id }).sort({ createdAt: -1 }).limit(10).toArray();
  let text = `📁 <b>My Files</b>\n\n💎 Plan: ${escapeHtml(getSubscriptionLabel(user))}\n📦 Files: ${user.personalFileCount}/${limits.fileLimit}\n💾 Storage: ${bytesToText(user.storageUsedBytes)} / ${bytesToText(limits.storageBytes)}\n\n`;
  text += files.length ? files.map((file, i) => `${i + 1}. ${escapeHtml(file.fileName || file.fileType || "File")} — ${bytesToText(file.fileSize)}`).join("\n") : "এখনো কোনো personal file নেই।";
  const rows = [
    [Markup.button.callback("🆔 My File IDs", "user_file_ids"), Markup.button.callback("🗑️ Delete File", "user_delete_file_prompt")],
    [Markup.button.callback("📤 Upload File", "user_upload")],
    [Markup.button.callback("🔗 My Links", "user_links"), Markup.button.callback("🔄 Refresh", "user_files")],
    [Markup.button.callback("⬅️ Main Menu", "user_menu")]
  ];
  return ctx.reply(text, { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) });
}

async function showUserFileIds(ctx, page = 0, edit = false) {
  const pageSize = 8;
  const filter = { ownerId: ctx.from.id };
  const total = await db.collection("personalFiles").countDocuments(filter);
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  page = Math.max(0, Math.min(Number(page) || 0, maxPage));
  const files = await db.collection("personalFiles").find(filter).sort({ createdAt: -1 }).skip(page * pageSize).limit(pageSize).toArray();
  const body = files.length ? files.map((f, i) => `${page * pageSize + i + 1}. <b>${escapeHtml(f.fileName || f.fileType || "File")}</b> — ${bytesToText(f.fileSize)}\n🆔 <code>${f._id}</code>`).join("\n\n") : "এখনো কোনো personal file নেই।";
  const rows = [];
  if (page > 0 || page < maxPage) rows.push([...(page > 0 ? [Markup.button.callback("⬅️ Previous", `user_file_ids_page_${page - 1}`)] : []), ...(page < maxPage ? [Markup.button.callback("Next ➡️", `user_file_ids_page_${page + 1}`)] : [])]);
  rows.push([Markup.button.callback("🗑️ Delete File", "user_delete_file_prompt"), Markup.button.callback("⬅️ My Files", "user_files")]);
  const text = `🆔 <b>My File IDs</b>\nPage ${page + 1}/${maxPage + 1} • Total: ${total}\n\n${body}\n\nএকবারে একটি File ID দিয়ে Delete করা যাবে।`;
  if (edit) return ctx.editMessageText(text, { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) });
  return ctx.reply(text, { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) });
}

async function showMyLinks(ctx) {
  const links = await db.collection("personalFiles").find({ ownerId: ctx.from.id }).sort({ createdAt: -1 }).limit(20).toArray();
  if (!links.length) return ctx.reply("🔗 এখনো কোনো personal file link নেই।", userMainKeyboard());
  const me = await ctx.telegram.getMe();
  return ctx.reply("🔗 <b>My Links</b>\n\n" + links.map((f, i) => `${i + 1}. ${escapeHtml(f.fileName || "File")}\nhttps://t.me/${me.username}?start=pfile_${f._id}`).join("\n\n"), { parse_mode: "HTML", ...userMainKeyboard() });
}

async function showStorage(ctx) {
  const settings = await getBotSettings();
  const user = await ensureUser(ctx.from);
  const limits = getPlanLimits(user, settings);
  const usage = await getQuotaUsage(user);
  const percent = Math.min(100, Math.round((usage.storageBytes / Math.max(1, limits.storageBytes)) * 100));
  const blocks = Math.round(percent / 10);
  return ctx.reply(`💾 <b>My Storage</b>\n\n💎 Plan: ${escapeHtml(getSubscriptionLabel(user))}\n📦 Files: ${usage.fileCount}/${limits.fileLimit}\n💾 Used: ${bytesToText(usage.storageBytes)} / ${bytesToText(limits.storageBytes)}\n\n${"█".repeat(blocks)}${"░".repeat(10 - blocks)} ${percent}%\n\nBatch Share Link-এর ফাইলও আপনার quota-তে গণনা করা হয়।`, { parse_mode: "HTML", ...userMainKeyboard() });
}

async function showSubscription(ctx) {
  const settings = await getBotSettings();
  const user = await ensureUser(ctx.from);
  const plan = getUserPlan(user);
  const expiry = user.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt).toLocaleString("en-GB") : "—";
  return ctx.reply(`💎 <b>Subscription</b>\n\nCurrent Status: <b>${escapeHtml(getSubscriptionLabel(user))}</b>\n${user.subscriptionExpiresAt ? `Expiry: ${escapeHtml(expiry)}\n` : ""}\n🆓 Free: ${bytesToText(settings.subscriptionPlans.free.storageBytes)}, ${settings.subscriptionPlans.free.fileLimit} files\n⭐ Paid: ${bytesToText(settings.subscriptionPlans.premium.storageBytes)}, ${settings.subscriptionPlans.premium.fileLimit} files\n\n${isExpiredPaidUser(user) ? "⌛ মেয়াদ শেষ। পুরোনো ফাইল দেখা/ডাউনলোড করা যাবে, কিন্তু নতুন Upload বন্ধ আছে। Renew করতে Admin-এর সঙ্গে যোগাযোগ করুন।" : "Paid Subscription Admin manually activate ও renew করেন।"}`, { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("📩 Contact Admin", "subscription_contact")], [Markup.button.callback("⬅️ Main Menu", "user_menu")]]) });
}

async function showAccount(ctx) {
  const settings = await getBotSettings();
  const user = await ensureUser(ctx.from);
  const limits = getPlanLimits(user, settings);
  return ctx.reply(`👤 <b>My Account</b>\n\n🆔 ID: <code>${ctx.from.id}</code>\n👤 Username: ${ctx.from.username ? "@" + escapeHtml(ctx.from.username) : "Not set"}\n💎 Plan: ${escapeHtml(getSubscriptionLabel(user))}\n📦 Files: ${user.personalFileCount}/${limits.fileLimit}\n💾 Storage: ${bytesToText(user.storageUsedBytes)} / ${bytesToText(limits.storageBytes)}`, { parse_mode: "HTML", ...userMainKeyboard() });
}

function moderatorPanelKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📁 File Management", "admin_files"), Markup.button.callback("👥 Users", "admin_users")],
    [Markup.button.callback("📢 Broadcast", "admin_broadcast"), Markup.button.callback("🚫 Ban / Unban", "admin_ban")],
    [Markup.button.callback("📊 Statistics", "admin_stats")]
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
    const date = new Date();
    const day = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    await db.collection("dailyStats").updateOne(
      { _id: day },
      { $inc: { linkOpens: 1, [`${linkType}Opens`]: 1 }, $set: { updatedAt: date } },
      { upsert: true }
    );
  } catch (error) {
    console.error("Link stats error:", error.message);
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
  if (ctx.chat?.type !== "private") return ctx.reply("📩 Batch Upload করতে Bot-এর Private Chat ব্যবহার করুন।");
  if (!isAdmin(ctx)) {
    const user = await ensureUser(ctx.from);
    if (user?.banned) return ctx.reply("⛔ আপনার account block করা হয়েছে।");
    if (isExpiredPaidUser(user)) return ctx.reply("⌛ আপনার Paid Subscription-এর মেয়াদ শেষ। পুরোনো ফাইল থাকবে, কিন্তু নতুন Batch Upload করতে Admin-এর মাধ্যমে Paid renew করতে হবে।", userMainKeyboard());
  }

  const userId = ctx.from.id;
  if (personalUploadStates.has(userId)) {
    return ctx.reply("⚠️ আগে Personal Upload শেষ বা /cancel দিয়ে বাতিল করুন। তারপর /batch শুরু করুন।");
  }
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
    "📦 Multi-File Share Upload শুরু হয়েছে!\n\n" +
    "✅ Album হিসেবে একসঙ্গে অথবা একটির পর একটি ফাইল পাঠাতে পারো।\n" +
    "🔢 প্রতি Batch-এ সর্বোচ্চ ১০টি ফাইল।\n" +
    "সব ফাইল পাঠানো হলে /finishbatch পাঠাও।\n\n" +
    "❌ বাতিল করতে /cancelbatch পাঠাও।\n" +
    (isAdmin(ctx) ? "" : "\nতোমার Subscription, File Limit ও Storage Limit প্রযোজ্য হবে।")
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

async function telegramWithRetry(task, maxAttempts = 4) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    try { return await task(); }
    catch (error) {
      attempt++;
      const retryAfter = Number(error?.response?.parameters?.retry_after || error?.parameters?.retry_after || 0);
      if (attempt >= maxAttempts) throw error;
      const waitMs = retryAfter > 0 ? retryAfter * 1000 + 250 : Math.min(2000 * attempt, 8000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
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
    const usersCollection = db.collection("users");
    const total = await usersCollection.countDocuments({ telegramId: { $ne: ADMIN_ID }, banned: { $ne: true } });
    let success = 0;
    let failed = 0;
    let processed = 0;

    await ctx.answerCbQuery("Broadcast শুরু হয়েছে...");
    const progressMessage = await ctx.reply(`Sending to 0/${total} users...`);
    const cursor = usersCollection.find({ telegramId: { $ne: ADMIN_ID }, banned: { $ne: true } }, { projection: { telegramId: 1 } }).sort({ telegramId: 1 }).batchSize(100);

    for await (const user of cursor) {
      const targetId = user.telegramId;
      let userSuccess = true;
      for (const item of state.messages) {
        try {
          await telegramWithRetry(() => ctx.telegram.copyMessage(targetId, item.chatId, item.messageId));
        } catch (error) {
          userSuccess = false;
          if (error?.response?.error_code === 403) {
            await usersCollection.updateOne({ telegramId: targetId }, { $set: { blockedBot: true, updatedAt: new Date() } }).catch(() => {});
          }
          console.error(`Broadcast delivery error for ${targetId}:`, error.message);
          break;
        }
      }
      processed++;
      if (userSuccess) success++; else failed++;
      if (processed % 10 === 0 || processed === total) {
        try { await ctx.telegram.editMessageText(ctx.chat.id, progressMessage.message_id, undefined, `Sending to ${processed}/${total} users...`); } catch {}
      }
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
  const cached = forceSubCache.get(ctx.from.id);
  if (cached && Date.now() - cached.at < FORCE_SUB_CACHE_TTL_MS) return cached.missing;
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
  forceSubCache.set(ctx.from.id, { missing, at: Date.now() });
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
    if (db && ctx.from && ctx.chat?.type === "private") await ensureUser(ctx.from);
  } catch (error) { console.error("User tracking error:", error.message); }
  return next();
});bot.use(async (ctx, next) => {
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

  if (payload && payload.startsWith("pfile_")) {
    if (ctx.chat?.type !== "private") return ctx.reply("ফাইল পেতে Bot-কে Private Chat-এ খুলুন।"); const id = payload.slice(6); if (!ObjectId.isValid(id)) return ctx.reply("❌ Personal File Link সঠিক নয়।");
    try { const file = await db.collection("personalFiles").findOne({ _id: new ObjectId(id) }); if (!file) return ctx.reply("❌ File পাওয়া যায়নি।"); if (file.ownerId !== ctx.from.id) return ctx.reply("⛔ এই Personal File Link শুধু owner-এর জন্য।"); const settings = await getBotSettings(); const sent = await ctx.telegram.copyMessage(ctx.chat.id, file.storageChannelId, file.storageMessageId, makeDeliveryOptions(file, settings)); if (settings.autoDeleteEnabled) await scheduleDelete(ctx, sent, settings.autoDeleteMinutes); } catch (error) { console.error("Personal file delivery error:", error.message); return ctx.reply("❌ Personal file পাঠানো যায়নি।"); } return;
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
    "/batch - Upload up to 10 files (Album or Sequential) and create one Share Link\n" +
    "/finishbatch - Review batch files\n" +
    "/cancelbatch - Cancel batch upload\n" +
    "/myfiles - My personal files\n" +
    "/storage - Storage usage\n" +
    "/subscription - Subscription plans\n" +
    "/mylinks - My personal share links\n" +
    "/account - My account\n" +
    "/upload - Upload to personal storage\n" +
    "/deletefile FILE_ID - Delete a personal file",
    userMainKeyboard()
  );
});

// User personal storage menu and commands
bot.command("myfiles", showMyFiles);
bot.command("storage", showStorage);
bot.command("subscription", showSubscription);
bot.command("mylinks", showMyLinks);
bot.command("account", showAccount);
bot.command("upload", async (ctx) => { const user = await ensureUser(ctx.from); if (pendingBatches.has(ctx.from.id)) return ctx.reply("⚠️ আগে চলমান Batch শেষ করুন অথবা /cancelbatch দিয়ে বাতিল করুন।"); if (isExpiredPaidUser(user)) return ctx.reply("⌛ Paid Subscription শেষ। পুরোনো ফাইল থাকবে, কিন্তু নতুন Upload-এর জন্য Admin-এর মাধ্যমে Renew করতে হবে।", userMainKeyboard()); personalUploadStates.set(ctx.from.id, { createdAt: Date.now() }); return ctx.reply("📤 আপনার personal storage-এ file পাঠান। /cancel দিয়ে বাতিল করুন।", userMainKeyboard()); });
bot.command("deletefile", async (ctx) => {
  const parts = String(ctx.message?.text || "").trim().split(/\s+/);
  const id = parts[1];
  if (!id || !ObjectId.isValid(id)) return ctx.reply("ব্যবহার: /deletefile FILE_ID\nFile ID দেখতে /myfiles ব্যবহার করুন।", userMainKeyboard());
  const file = await db.collection("personalFiles").findOne({ _id: new ObjectId(id), ownerId: ctx.from.id });
  if (!file) return ctx.reply("❌ আপনার এই File ID-এর file পাওয়া যায়নি।", userMainKeyboard());
  try { await ctx.telegram.deleteMessage(file.storageChannelId, file.storageMessageId); } catch (error) { console.error("User delete command storage error:", error.message); }
  await db.collection("personalFiles").deleteOne({ _id: file._id });
  await db.collection("users").updateOne({ telegramId: ctx.from.id, personalFileCount: { $gt: 0 } }, { $inc: { storageUsedBytes: -(Number(file.fileSize) || 0), personalFileCount: -1 }, $set: { updatedAt: new Date() } });
  return ctx.reply("✅ File deleted successfully.", userMainKeyboard());
});
bot.hears("📁 My Files", showMyFiles);
bot.hears("💎 Subscription", showSubscription);
bot.hears("💾 My Storage", showStorage);
bot.hears("🔗 My Links", showMyLinks);
bot.hears("👤 My Account", showAccount);
bot.hears("ℹ️ Help", (ctx) => ctx.reply("📚 Commands\n\n/start - Start\n/myfiles - My Files\n/storage - Storage\n/subscription - Subscription\n/mylinks - My Links\n/account - My Account\n/help - Help", userMainKeyboard()));
bot.action("user_menu", async (ctx) => { await ctx.answerCbQuery(); return ctx.reply("🏠 Main Menu", userMainKeyboard()); });
bot.action("user_files", async (ctx) => { await ctx.answerCbQuery(); return showMyFiles(ctx); });
bot.action("user_file_ids", async (ctx) => { await ctx.answerCbQuery(); return showUserFileIds(ctx, 0, false); });
bot.action(/^user_file_ids_page_(\d+)$/, async (ctx) => { await ctx.answerCbQuery(); return showUserFileIds(ctx, Number(ctx.match[1]), true); });
bot.action("user_delete_file_prompt", async (ctx) => { await ctx.answerCbQuery(); personalUploadStates.delete(ctx.from.id); adminInputStates.set(ctx.from.id, { type: "user_delete_file_id" }); return ctx.reply("🗑️ যে একটি File delete করতে চান, তার MongoDB File ID পাঠান।\n\nFile ID দেখতে 🆔 My File IDs চাপুন।\nবাতিল করতে /cancel লিখুন।", userMainKeyboard()); });
bot.action("user_upload", async (ctx) => { const user = await ensureUser(ctx.from); await ctx.answerCbQuery(); if (pendingBatches.has(ctx.from.id)) return ctx.reply("⚠️ আগে চলমান Batch শেষ করুন অথবা /cancelbatch দিয়ে বাতিল করুন।", userMainKeyboard()); if (isExpiredPaidUser(user)) return ctx.reply("⌛ Paid Subscription শেষ। পুরোনো ফাইল থাকবে, কিন্তু নতুন Upload-এর জন্য Admin-এর মাধ্যমে Renew করতে হবে।", userMainKeyboard()); personalUploadStates.set(ctx.from.id, { createdAt: Date.now() }); return ctx.reply("📤 আপনার personal storage-এ যে file/video/audio/APK/document রাখতে চান সেটি পাঠান।\n\nবাতিল করতে /cancel লিখুন।", userMainKeyboard()); });
bot.action("user_links", async (ctx) => { await ctx.answerCbQuery(); return showMyLinks(ctx); });
bot.action("subscription_contact", async (ctx) => { await ctx.answerCbQuery(); return ctx.reply(`💎 Premium Subscription\n\nআপনার Telegram ID: <code>${ctx.from.id}</code>\nএই ID Admin-কে পাঠিয়ে Premium activation/payment সম্পর্কে যোগাযোগ করুন।`, { parse_mode: "HTML", ...userMainKeyboard() }); });

// Admin panel
bot.command("admin", async (ctx) => {
  const owner = isAdmin(ctx);
  if (!owner && !(await isStaff(ctx))) return ctx.reply("⛔ You are not authorized.");
  return ctx.reply(owner ? "👑 Admin Panel\n\nনিচের একটি অপশন নির্বাচন করুন:" : "👮 Moderator Panel\n\nআপনার অনুমোদিত অপশন নির্বাচন করুন:", owner ? adminPanelKeyboard() : moderatorPanelKeyboard());
});

// Admin panel actions
async function showAdminFiles(ctx, edit = false) {
  const [sharedCount, personalCount] = await Promise.all([db.collection("files").countDocuments(), db.collection("personalFiles").countDocuments()]);
  const text = `📁 <b>File Management</b>\n\n🔗 Shared Files: ${sharedCount}\n👤 Personal Files: ${personalCount}`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🔎 Search File", "admin_file_search")],
    [Markup.button.callback("👤 User Files", "admin_user_files")],
    [Markup.button.callback("🗑️ Delete File", "admin_file_delete")],
    [Markup.button.callback("📊 Storage Stats", "admin_storage_stats")],
    [Markup.button.callback("⬅️ Admin Panel", "admin_back")]
  ]);
  return edit ? ctx.editMessageText(text, { parse_mode: "HTML", ...keyboard }) : ctx.reply(text, { parse_mode: "HTML", ...keyboard });
}
bot.action("admin_files", async (ctx) => { if (!(await isStaff(ctx))) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); return showAdminFiles(ctx); });
bot.action("admin_file_search", async (ctx) => { if (!(await isStaff(ctx))) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); adminInputStates.set(ctx.from.id, { type: "admin_file_search" }); return ctx.reply("🔎 MongoDB File ID, User ID বা filename পাঠাও. /cancel দিয়ে বাতিল করো।"); });
bot.action("admin_user_files", async (ctx) => { if (!(await isStaff(ctx))) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); adminInputStates.set(ctx.from.id, { type: "admin_user_files" }); return ctx.reply("👤 User-এর Telegram ID পাঠাও।"); });
bot.action("admin_file_delete", async (ctx) => { if (!(await isStaff(ctx))) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); adminInputStates.set(ctx.from.id, { type: "admin_file_delete" }); return ctx.reply("🗑️ Personal বা Shared file-এর MongoDB ID পাঠাও।"); });
bot.action("admin_storage_stats", async (ctx) => { if (!(await isStaff(ctx))) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); const [count, agg] = await Promise.all([db.collection("personalFiles").countDocuments(), db.collection("personalFiles").aggregate([{ $group: { _id: null, bytes: { $sum: "$fileSize" } } }]).toArray()]); return ctx.reply(`📊 Personal Storage\n\nFiles: ${count}\nStored: ${bytesToText(agg[0]?.bytes || 0)}`); });

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
      db.collection("dailyStats").findOne({ _id: `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}` })
    ]);

    return ctx.reply(
      "📊 BOT STATISTICS REPORT 📊\n" +
      "---------------------------------\n" +
      `👥 Total Users: ${totalUsers}\n` +
      `🟢 Active Users (24h): ${activeUsers}\n` +
      `🚫 Banned Users: ${bannedUsers}\n\n` +
      `📁 Total Files in DB: ${totalFiles}\n` +
      `📥 Total Links Open /Downloads Today: ${todayLinks?.linkOpens || 0}\n` +
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
  forceSubCache.delete(ctx.from.id);
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

// Personal users delete exactly one owned file by ID; ownership is always checked.
bot.on("text", async (ctx, next) => {
  if (!ctx.from || ctx.chat?.type !== "private" || isAdmin(ctx)) return next();
  const text = String(ctx.message?.text || "").trim();
  if (text.startsWith("/")) return next();
  const state = adminInputStates.get(ctx.from.id);
  if (state?.type !== "user_delete_file_id") return next();
  if (!ObjectId.isValid(text)) return ctx.reply("সঠিক File ID পাঠাও। বাতিল করতে /cancel লিখুন।", userMainKeyboard());
  try {
    const file = await db.collection("personalFiles").findOne({ _id: new ObjectId(text), ownerId: ctx.from.id });
    if (!file) return ctx.reply("❌ আপনার এই File ID-এর file পাওয়া যায়নি। সঠিক ID পাঠাও অথবা /cancel লিখুন।", userMainKeyboard());
    try { await ctx.telegram.deleteMessage(file.storageChannelId, file.storageMessageId); } catch (error) { console.error("User file delete storage error:", error.message); }
    await db.collection("personalFiles").deleteOne({ _id: file._id, ownerId: ctx.from.id });
    await db.collection("users").updateOne({ telegramId: ctx.from.id, personalFileCount: { $gt: 0 } }, { $inc: { storageUsedBytes: -(Number(file.fileSize) || 0), personalFileCount: -1 }, $set: { updatedAt: new Date() } });
    adminInputStates.delete(ctx.from.id);
    return ctx.reply(`✅ File deleted successfully.\n\nID: ${text}`, userMainKeyboard());
  } catch (error) {
    console.error("User file ID delete error:", error.message);
    return ctx.reply("❌ File delete করা যায়নি। আবার চেষ্টা করো।", userMainKeyboard());
  }
});

// Receive text for Start Text or Add Button setup.
bot.on("text", async (ctx, next) => {
  if (!(await isStaff(ctx)) || ctx.chat?.type !== "private") {
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
  if (String(state.type).startsWith("admin_premium_") || String(state.type).startsWith("admin_set_limits_") || String(state.type).startsWith("admin_reset_limits_")) {
    if (!isAdmin(ctx)) return ctx.reply("⛔ Only Admin can manage subscriptions and custom limits.");
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

  if (state.type === "admin_user_search") {
    const query = value.replace(/^@/, ""); adminInputStates.delete(ctx.from.id); const user = /^\d+$/.test(query) ? await db.collection("users").findOne({ telegramId: Number(query) }) : await db.collection("users").findOne({ username: query });
    if (!user) return ctx.reply("❌ User পাওয়া যায়নি।"); const settings = await getBotSettings(); const limits = getPlanLimits(user, settings); const expiryText = user.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt).toLocaleString("en-GB") : "—"; return ctx.reply(`👤 User Details\n\nID: <code>${user.telegramId}</code>\nUsername: ${user.username ? "@" + escapeHtml(user.username) : "—"}\nPlan: ${escapeHtml(getSubscriptionLabel(user))}\nExpiry: ${escapeHtml(expiryText)}\nStorage: ${bytesToText(user.storageUsedBytes)} / ${bytesToText(limits.storageBytes)}\nFiles: ${user.personalFileCount}/${limits.fileLimit}\nCustom Storage Limit: ${Number(user.customStorageLimitBytes) > 0 ? bytesToText(user.customStorageLimitBytes) : "Plan default"}\nCustom File Limit: ${Number(user.customFileLimit) > 0 ? user.customFileLimit : "Plan default"}\nBanned: ${user.banned ? "Yes" : "No"}`, { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("⭐ Activate / Renew Paid", "admin_premium_activate")], [Markup.button.callback("⚖️ Set Member Limits", "admin_set_user_limits")], [Markup.button.callback("♻️ Reset Member Limits", "admin_reset_user_limits")]]) });
  }

  if (state.type === "admin_file_search") {
    adminInputStates.delete(ctx.from.id);
    const query = value;
    let personal = [];
    let shared = [];
    if (ObjectId.isValid(query)) {
      const oid = new ObjectId(query);
      personal = await db.collection("personalFiles").find({ _id: oid }).limit(10).toArray();
      shared = await db.collection("files").find({ _id: oid }).limit(10).toArray();
    } else if (/^\d+$/.test(query)) {
      personal = await db.collection("personalFiles").find({ ownerId: Number(query) }).sort({ createdAt: -1 }).limit(10).toArray();
      shared = await db.collection("files").find({ uploadedBy: Number(query) }).sort({ createdAt: -1 }).limit(10).toArray();
    } else {
      const safe = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      personal = await db.collection("personalFiles").find({ fileName: { $regex: safe, $options: "i" } }).sort({ createdAt: -1 }).limit(10).toArray();
      shared = await db.collection("files").find({ fileName: { $regex: safe, $options: "i" } }).sort({ createdAt: -1 }).limit(10).toArray();
    }
    const rows = [
      ...personal.map((f) => `👤 Personal | ${escapeHtml(f.fileName || f.fileType)}\nID: <code>${f._id}</code>\nUser: <code>${f.ownerId}</code>\nSize: ${bytesToText(f.fileSize)}`),
      ...shared.map((f) => `🔗 Shared | ${escapeHtml(f.fileName || f.fileType)}\nID: <code>${f._id}</code>\nUser: <code>${f.uploadedBy}</code>\nSize: ${bytesToText(f.fileSize)}`)
    ];
    return ctx.reply(rows.length ? "📁 Search Result\n\n" + rows.join("\n\n") : "❌ File পাওয়া যায়নি।", { parse_mode: "HTML" });
  }

  if (state.type === "admin_user_files") {
    if (!/^\d+$/.test(value)) return ctx.reply("সঠিক User ID পাঠাও।"); adminInputStates.delete(ctx.from.id); const files = await db.collection("personalFiles").find({ ownerId: Number(value) }).sort({ createdAt: -1 }).limit(20).toArray(); return ctx.reply(files.length ? "👤 User Files\n\n" + files.map((f, i) => `${i + 1}. ${escapeHtml(f.fileName || f.fileType)}\nID: <code>${f._id}</code>\nSize: ${bytesToText(f.fileSize)}`).join("\n\n") : "এই User-এর কোনো personal file নেই।", { parse_mode: "HTML" });
  }

  if (state.type === "admin_file_delete") {
    if (!ObjectId.isValid(value)) return ctx.reply("সঠিক MongoDB File ID পাঠাও।");
    adminInputStates.delete(ctx.from.id);
    const objectId = new ObjectId(value);
    const personal = await db.collection("personalFiles").findOne({ _id: objectId });
    if (personal) {
      try { await ctx.telegram.deleteMessage(personal.storageChannelId, personal.storageMessageId); } catch (error) { console.error("Admin personal file delete error:", error.message); }
      await db.collection("personalFiles").deleteOne({ _id: objectId });
      await db.collection("users").updateOne({ telegramId: personal.ownerId, personalFileCount: { $gt: 0 } }, { $inc: { storageUsedBytes: -(Number(personal.fileSize) || 0), personalFileCount: -1 }, $set: { updatedAt: new Date() } });
      return ctx.reply(`✅ Personal file ${value} delete হয়েছে।`);
    }
    const shared = await db.collection("files").findOne({ _id: objectId });
    if (shared) {
      try { await ctx.telegram.deleteMessage(shared.storageChannelId, shared.storageMessageId); } catch (error) { console.error("Admin shared file delete error:", error.message); }
      await db.collection("files").deleteOne({ _id: objectId });
      return ctx.reply(`✅ Shared file ${value} delete হয়েছে।`);
    }
    return ctx.reply("❌ File পাওয়া যায়নি।");
  }

  if (state.type === "moderator_add" || state.type === "moderator_remove") {
    if (!/^\d+$/.test(value)) return ctx.reply("সঠিক Telegram User ID পাঠাও।"); const id = Number(value); if (id === ADMIN_ID) return ctx.reply("Admin-কে Moderator করা যাবে না."); const settings = await getBotSettings(); const mods = settings.moderators || []; const next = state.type === "moderator_add" ? Array.from(new Set([...mods, id])).slice(0, 50) : mods.filter((x) => x !== id); await db.collection("settings").updateOne({ _id: "botSettings" }, { $set: { moderators: next, updatedAt: new Date() } }, { upsert: true }); adminInputStates.delete(ctx.from.id); return ctx.reply(state.type === "moderator_add" ? "✅ Moderator added." : "✅ Moderator removed.");
  }

  if (state.type === "admin_premium_activate" || state.type === "admin_premium_remove" || state.type === "admin_set_limits_user" || state.type === "admin_reset_limits_user") {
    if (!/^\d+$/.test(value)) return ctx.reply("সঠিক Telegram User ID পাঠাও।");
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) return ctx.reply("সঠিক Telegram User ID পাঠাও।");
    if (state.type === "admin_premium_activate") {
      adminInputStates.set(ctx.from.id, { type: "admin_premium_duration", targetUserId: id });
      const existing = await db.collection("users").findOne({ telegramId: id });
      const currentExpiry = existing?.subscriptionExpiresAt ? new Date(existing.subscriptionExpiresAt) : null;
      return ctx.reply(`User ID: ${id}\nCurrent status: ${existing ? getSubscriptionLabel(existing) : "New user"}${currentExpiry ? `\nCurrent expiry: ${currentExpiry.toLocaleString("en-GB")}` : ""}\n\nPaid মেয়াদ কত দিন হবে? 1 থেকে 36500-এর মধ্যে পূর্ণ সংখ্যা পাঠাও।\nActive Paid থাকলে নতুন মেয়াদ বর্তমান expiry-এর সঙ্গে যোগ হবে; মেয়াদ শেষ হলে আজ থেকে শুরু হবে।`);
    }
    if (state.type === "admin_premium_remove") {
      const result = await db.collection("users").updateOne({ telegramId: id }, { $set: { plan: "free", subscriptionStatus: "free", subscriptionExpiresAt: null, updatedAt: new Date() } });
      adminInputStates.delete(ctx.from.id);
      return ctx.reply(result.matchedCount ? `✅ User ${id}-এর Paid remove হয়েছে। পুরোনো ফাইল থাকবে।` : `⚠️ User ${id} এখনো database-এ নেই।`);
    }
    if (state.type === "admin_set_limits_user") {
      adminInputStates.set(ctx.from.id, { type: "admin_set_limits_storage", targetUserId: id });
      return ctx.reply(`User ID: ${id}\nCustom Storage limit কত MB হবে? 1 থেকে 1000000-এর মধ্যে সংখ্যা পাঠাও।`);
    }
    const result = await db.collection("users").updateOne({ telegramId: id }, { $unset: { customStorageLimitBytes: "", customFileLimit: "" }, $set: { updatedAt: new Date() } });
    adminInputStates.delete(ctx.from.id);
    return ctx.reply(result.matchedCount ? `✅ User ${id}-এর custom limits reset হয়েছে। এখন Plan default limit কার্যকর হবে।` : `⚠️ User ${id} এখনো database-এ নেই।`);
  }

  if (state.type === "admin_premium_duration") {
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1 || days > 36500) return ctx.reply("মেয়াদ 1 থেকে 36500 দিনের মধ্যে পূর্ণ সংখ্যা হতে হবে।");
    const id = Number(state.targetUserId);
    const now = new Date();
    const existing = await db.collection("users").findOne({ telegramId: id });
    const oldExpiry = existing?.subscriptionExpiresAt ? new Date(existing.subscriptionExpiresAt) : null;
    const base = oldExpiry && oldExpiry > now && getUserPlan(existing) === "premium" ? oldExpiry : now;
    const expires = new Date(base.getTime() + days * 86400000);
    await db.collection("users").updateOne({ telegramId: id }, { $set: { plan: "premium", subscriptionStatus: "active", subscriptionExpiresAt: expires, updatedAt: now }, $setOnInsert: { telegramId: id, firstSeenAt: now, lastSeenAt: now, storageUsedBytes: 0, personalFileCount: 0, banned: false } }, { upsert: true });
    adminInputStates.delete(ctx.from.id);
    return ctx.reply(`✅ Paid ${existing && oldExpiry && oldExpiry > now ? "renewed" : "activated"} successfully.\n\n🆔 User ID: ${id}\n⏳ Added: ${days} day(s)\n📅 New expiry: ${expires.toLocaleString("en-GB")}`);
  }

  if (state.type === "admin_set_limits_storage") {
    const mb = Number(value);
    if (!Number.isInteger(mb) || mb < 1 || mb > 1000000) return ctx.reply("Storage limit 1 থেকে 1000000 MB-এর মধ্যে পূর্ণ সংখ্যা পাঠাও।");
    adminInputStates.set(ctx.from.id, { type: "admin_set_limits_files", targetUserId: state.targetUserId, storageBytes: mb * 1024 * 1024 });
    return ctx.reply(`Custom Storage: ${mb} MB\nএখন File limit কতটি হবে? 1 থেকে 1000000-এর মধ্যে পূর্ণ সংখ্যা পাঠাও।`);
  }

  if (state.type === "admin_set_limits_files") {
    const files = Number(value);
    if (!Number.isInteger(files) || files < 1 || files > 1000000) return ctx.reply("File limit 1 থেকে 1000000-এর মধ্যে পূর্ণ সংখ্যা পাঠাও।");
    const id = Number(state.targetUserId);
    const result = await db.collection("users").updateOne({ telegramId: id }, { $set: { customStorageLimitBytes: state.storageBytes, customFileLimit: files, updatedAt: new Date() } });
    adminInputStates.delete(ctx.from.id);
    return ctx.reply(result.matchedCount ? `✅ Custom limits save হয়েছে।\n\n🆔 User ID: ${id}\n💾 Storage: ${bytesToText(state.storageBytes)}\n📁 File limit: ${files}` : `⚠️ User ${id} database-এ নেই। User-কে আগে /start করতে হবে।`);
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

async function renderAdminUsers(ctx, page = 0) {
  const pageSize = 10; const total = await db.collection("users").countDocuments(); const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1); page = Math.max(0, Math.min(page, maxPage));
  const list = await db.collection("users").find({}, { projection: { telegramId: 1, firstName: 1, lastName: 1, username: 1, lastSeenAt: 1, banned: 1, plan: 1, subscriptionStatus: 1, subscriptionExpiresAt: 1 } }).sort({ lastSeenAt: -1 }).skip(page * pageSize).limit(pageSize).toArray();
  let message = `👥 <b>USER MANAGEMENT</b>\n\nTotal Users: ${total}\nPage: ${page + 1}/${maxPage + 1}\n\n`;
  message += list.length ? list.map((u, i) => `${page * pageSize + i + 1}. ${escapeHtml([u.firstName, u.lastName].filter(Boolean).join(" ") || "No Name")}\n🆔 <code>${u.telegramId}</code> ${u.banned ? "🚫" : "🟢"} ${getUserPlan(u) === "premium" ? "⭐ Paid" : isExpiredPaidUser(u) ? "⌛ Expired" : "🆓 Free"}`).join("\n\n") : "কোনো user নেই।";
  const rows = []; if (page > 0 || page < maxPage) rows.push([...(page > 0 ? [Markup.button.callback("⬅️ Previous", `admin_users_page_${page - 1}`)] : []), ...(page < maxPage ? [Markup.button.callback("Next ➡️", `admin_users_page_${page + 1}`)] : [])]);
  rows.push([Markup.button.callback("🔎 Search User", "admin_user_search"), Markup.button.callback("🔄 Refresh", `admin_users_page_${page}`)]); rows.push([Markup.button.callback("⬅️ Admin Panel", "admin_back")]);
  return ctx.editMessageText(message, { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) });
}
bot.action("admin_users", async (ctx) => { if (!(await isStaff(ctx))) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); return renderAdminUsers(ctx, 0); });
bot.action(/^admin_users_page_(\d+)$/, async (ctx) => { if (!(await isStaff(ctx))) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); return renderAdminUsers(ctx, Number(ctx.match[1])); });
bot.action("admin_user_search", async (ctx) => { if (!(await isStaff(ctx))) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); adminInputStates.set(ctx.from.id, { type: "admin_user_search" }); return ctx.reply("🔎 Telegram User ID বা username পাঠাও।"); });

bot.action("admin_subscription", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
  await ctx.answerCbQuery();
  const now = new Date();
  const [totalUsers, paidCount, expiredCount] = await Promise.all([
    db.collection("users").countDocuments(),
    db.collection("users").countDocuments({ plan: "premium", subscriptionStatus: "active", $or: [{ subscriptionExpiresAt: { $gt: now } }, { subscriptionExpiresAt: null }, { subscriptionExpiresAt: { $exists: false } }] }),
    db.collection("users").countDocuments({ plan: "premium", subscriptionExpiresAt: { $type: "date", $lte: now } })
  ]);
  const freeCount = Math.max(0, totalUsers - paidCount);
  return ctx.reply(`💎 <b>Subscription Management</b>\n\n⭐ Active Paid: ${paidCount}\n🆓 Free / inactive: ${freeCount}\n⌛ Expired Paid: ${expiredCount}\n\nAdmin নিজে User ID ও মেয়াদ দিয়ে Paid চালু/Renew করতে পারবেন।`, { parse_mode: "HTML", ...Markup.inlineKeyboard([
    [Markup.button.callback("⭐ Activate / Renew Paid", "admin_premium_activate")],
    [Markup.button.callback("❌ Remove Paid", "admin_premium_remove")],
    [Markup.button.callback("📋 Active Paid Members", "admin_paid_members")],
    [Markup.button.callback("📋 Free Members", "admin_free_members")],
    [Markup.button.callback("⚖️ Set Member Limits", "admin_set_user_limits")],
    [Markup.button.callback("♻️ Reset Member Limits", "admin_reset_user_limits")],
    [Markup.button.callback("🔎 Search / Manage User", "admin_user_search")],
    [Markup.button.callback("⬅️ Admin Panel", "admin_back")]
  ]) });
});
bot.action("admin_premium_activate", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); adminInputStates.set(ctx.from.id, { type: "admin_premium_activate" }); return ctx.reply("Paid activate বা renew করতে User-এর Telegram ID পাঠাও।\n\nএরপর মেয়াদ কত দিন হবে তা চাইবে। বাতিল করতে /cancel পাঠাও।"); });
bot.action("admin_premium_remove", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); adminInputStates.set(ctx.from.id, { type: "admin_premium_remove" }); return ctx.reply("Paid remove করতে User ID পাঠাও। পুরোনো ফাইল মুছে যাবে না।"); });
bot.action("admin_set_user_limits", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); adminInputStates.set(ctx.from.id, { type: "admin_set_limits_user" }); return ctx.reply("যে User-এর Storage ও File limit পরিবর্তন করতে চান, তার Telegram User ID পাঠাও।"); });
bot.action("admin_reset_user_limits", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); adminInputStates.set(ctx.from.id, { type: "admin_reset_limits_user" }); return ctx.reply("যে User-এর custom limit reset করতে চান, তার Telegram User ID পাঠাও। Reset করলে তার বর্তমান Plan-এর default limit কার্যকর হবে।"); });
async function showSubscriptionMembers(ctx, type) {
  const now = new Date();
  const filter = type === "paid"
    ? { plan: "premium", subscriptionStatus: "active", $or: [{ subscriptionExpiresAt: { $gt: now } }, { subscriptionExpiresAt: null }, { subscriptionExpiresAt: { $exists: false } }] }
    : { $or: [{ plan: { $ne: "premium" } }, { subscriptionStatus: { $ne: "active" } }, { subscriptionExpiresAt: { $type: "date", $lte: now } }] };
  const selected = await db.collection("users").find(filter).sort({ lastSeenAt: -1 }).limit(40).toArray();
  const title = type === "paid" ? "⭐ Active Paid Members" : "🆓 Free / Expired Members";
  const body = selected.length ? selected.map((u, i) => `${i + 1}. ${escapeHtml([u.firstName, u.lastName].filter(Boolean).join(" ") || "No Name")}\n🆔 <code>${u.telegramId}</code>\nStatus: ${escapeHtml(getSubscriptionLabel(u))}${u.subscriptionExpiresAt ? `\nExpiry: ${escapeHtml(new Date(u.subscriptionExpiresAt).toLocaleString("en-GB"))}` : ""}`).join("\n\n") : "এই তালিকায় কোনো user পাওয়া যায়নি।";
  return ctx.reply(`<b>${title}</b>\n\nShowing ${selected.length} latest matching users (maximum 40).\n\n${body}`, { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("🔎 Search / Manage User", "admin_user_search")], [Markup.button.callback("⬅️ Subscription", "admin_subscription")]]) });
}
bot.action("admin_paid_members", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); return showSubscriptionMembers(ctx, "paid"); });
bot.action("admin_free_members", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); return showSubscriptionMembers(ctx, "free"); });
bot.action("admin_moderator", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); return ctx.reply("👮 <b>Moderator Management</b>", { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("➕ Add Moderator", "moderator_add")], [Markup.button.callback("🗑️ Remove Moderator", "moderator_remove")], [Markup.button.callback("📋 List Moderators", "moderator_list")], [Markup.button.callback("⬅️ Admin Panel", "admin_back")]]) }); });
bot.action("moderator_add", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); adminInputStates.set(ctx.from.id, { type: "moderator_add" }); return ctx.reply("Moderator-এর Telegram User ID পাঠাও।"); });
bot.action("moderator_remove", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); adminInputStates.set(ctx.from.id, { type: "moderator_remove" }); return ctx.reply("Moderator-এর Telegram User ID পাঠাও।"); });
bot.action("moderator_list", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); const settings = await getBotSettings(); const mods = settings.moderators || []; return ctx.reply("👮 Moderators\n\n" + (mods.length ? mods.join("\n") : "কোনো Moderator নেই।")); });
bot.action("admin_restart", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery(); return ctx.reply("⚠️ <b>Restart Bot?</b>\n\nBot graceful shutdown করবে। Render/Railway/PM2-এর মতো process manager configured থাকলে process আবার চালু হবে।", { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("✅ Yes, Restart", "admin_restart_confirm")], [Markup.button.callback("❌ Cancel", "admin_restart_cancel")]]) }); });
bot.action("admin_restart_cancel", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery("Cancelled."); return ctx.editMessageText("❌ Restart cancelled."); });
bot.action("admin_restart_confirm", async (ctx) => { if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized."); await ctx.answerCbQuery("Restarting..."); await ctx.editMessageText("🔄 Restarting bot gracefully..."); setTimeout(() => shutdown("ADMIN_RESTART"), 500); });

// Return to Admin Panel
bot.action("admin_back", async (ctx) => {
  if (!(await isStaff(ctx))) {
    return ctx.answerCbQuery("Not authorized.");
  }

  await ctx.answerCbQuery();

  const owner = isAdmin(ctx);
  return ctx.editMessageText(
    owner ? "👑 Admin Panel\n\nনিচের একটি অপশন নির্বাচন করুন:" : "👮 Moderator Panel\n\nআপনার অনুমোদিত অপশন নির্বাচন করুন:",
    owner ? adminPanelKeyboard() : moderatorPanelKeyboard()
  );
});

// Receive files for single or batch uploads, and Start Photo setup.
bot.on(
  ["document", "video", "audio", "photo", "animation", "voice", "video_note"],
  async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || ctx.chat?.type !== "private") return next();

    const adminState = isAdmin(ctx) ? adminInputStates.get(userId) : null;
    const broadcast = isAdmin(ctx) ? broadcastStates.get(userId) : null;
    if (broadcast && broadcast.status === "collecting") {
      return addBroadcastMessage(ctx);
    }

    // Start Photo setup is an admin-only action and takes priority over uploads.
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
      if (batch.files.length >= 10) {
        return ctx.reply("⚠️ প্রতি Batch-এ সর্বোচ্চ ১০টি ফাইল রাখা যাবে।\nএই Batch শেষ করতে /finishbatch পাঠাও, অথবা /cancelbatch দিয়ে বাতিল করো।");
      }
      batch.files.push({
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
        fileType,
        mediaGroupId: ctx.message.media_group_id || null,
        ...getMessageFileMeta(ctx.message)
      });

      return ctx.reply(
        `✅ Batch-এ ${batch.files.length}/10টি ফাইল যোগ হয়েছে।\n\n` +
        "Album অথবা একটির পর একটি ফাইল পাঠাতে পারো।\n" +
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

    // Non-admin files without an active share-batch belong to the personal-upload middleware below.
    if (!isAdmin(ctx)) return next();

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
    let link = `https://telefile4your.blogspot.com?start=file_${result.insertedId}`;
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
    if (personalUploadStates.has(ctx.from.id)) {
      personalUploadStates.delete(ctx.from.id);
      return ctx.reply("❌ Personal upload cancelled.", userMainKeyboard());
    }
    if (adminInputStates.has(ctx.from.id)) {
      adminInputStates.delete(ctx.from.id);
      return ctx.reply("❌ Delete/input request cancelled.", userMainKeyboard());
    }
    return ctx.reply("ℹ️ বাতিল করার মতো কোনো চলমান কাজ নেই।", userMainKeyboard());
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
  if (batch.files.length > 10) return ctx.reply("❌ প্রতি Batch-এ সর্বোচ্চ ১০টি ফাইল অনুমোদিত।");
  const quotaError = await validateBatchQuota(ctx, batch);
  if (quotaError) return ctx.reply(quotaError, userMainKeyboard());

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

  if (!Array.isArray(batch.files) || batch.files.length === 0 || batch.files.length > 10) {
    return ctx.answerCbQuery("Batch-এ ১ থেকে ১০টি ফাইল থাকতে হবে।", { show_alert: true });
  }
  batch.inProgress = true;
  if (!batch.databaseId) {
    try {
      const quotaError = await validateBatchQuota(ctx, batch);
      if (quotaError) {
        batch.inProgress = false;
        return ctx.answerCbQuery(quotaError.slice(0, 190), { show_alert: true });
      }
    } catch (error) {
      batch.inProgress = false;
      console.error("Batch quota validation error:", error.message);
      return ctx.answerCbQuery("Quota যাচাই করা যায়নি। একটু পরে আবার চেষ্টা করুন।", { show_alert: true });
    }
  }

  try {
    await ctx.answerCbQuery("ফাইলগুলো Store করা হচ্ছে...");

    const collection = db.collection("batches");
    const me = await ctx.telegram.getMe();

    if (!batch.databaseId) {
      const currentSettings = await getBotSettings();
      const isQuotaUserBatch = !isAdmin(ctx);
      const quotaStorageBytes = batch.files.reduce((sum, file) => sum + Math.max(0, Number(file.fileSize) || 0), 0);
      const result = await collection.insertOne({
        uploadedBy: userId,
        countsTowardQuota: isQuotaUserBatch,
        quotaFileCount: isQuotaUserBatch ? batch.files.length : 0,
        quotaStorageBytes: isQuotaUserBatch ? quotaStorageBytes : 0,
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

// Personal storage uploads. User starts an upload session from the button first.
bot.on(["document", "video", "audio", "photo", "animation", "voice", "video_note"], async (ctx, next) => {
  if (!ctx.from || ctx.chat?.type !== "private" || isAdmin(ctx)) return next();
  const state = personalUploadStates.get(ctx.from.id); if (!state) return next();
  if (Date.now() - state.createdAt > 30 * 60 * 1000) { personalUploadStates.delete(ctx.from.id); return ctx.reply("⌛ Upload session expired. আবার 📤 Upload File চাপুন.", userMainKeyboard()); }
  try {
    const settings = await getBotSettings(); const user = await ensureUser(ctx.from); const info = getUserFileInfo(ctx.message); const limits = getPlanLimits(user, settings); const size = Math.max(0, Number(info.fileSize) || 0); const usage = await getQuotaUsage(user);
    if (isExpiredPaidUser(user)) return ctx.reply("⌛ আপনার Paid Subscription-এর মেয়াদ শেষ হয়েছে।\n\nআপনার পুরোনো ফাইল ও লিংক থাকবে এবং দেখা/ডাউনলোড করা যাবে। নতুন Upload চালু করতে Admin-এর মাধ্যমে Paid renew করুন।", userMainKeyboard());
    if (usage.fileCount + 1 > limits.fileLimit) return ctx.reply(`❌ File limit পূর্ণ: ${usage.fileCount}/${limits.fileLimit} files.`, userMainKeyboard());
    if (usage.storageBytes + size > limits.storageBytes) return ctx.reply(`❌ Storage limit পূর্ণ: ${bytesToText(usage.storageBytes)} / ${bytesToText(limits.storageBytes)}.`, userMainKeyboard());
    const storageChannelId = await choosePersonalStorageChannel(info.fileType); const copied = await ctx.telegram.copyMessage(storageChannelId, ctx.chat.id, ctx.message.message_id);
    const inserted = await db.collection("personalFiles").insertOne({ ownerId: ctx.from.id, fileType: info.fileType, storageChannelId: String(storageChannelId), storageMessageId: copied.message_id, fileName: info.fileName || "", fileSize: size, caption: info.caption || "", createdAt: new Date() });
    const quotaUpdate = await db.collection("users").updateOne({ telegramId: ctx.from.id, storageUsedBytes: { $lte: limits.storageBytes - size }, personalFileCount: { $lt: limits.fileLimit } }, { $inc: { storageUsedBytes: size, personalFileCount: 1 }, $set: { updatedAt: new Date() } });
    if (quotaUpdate.modifiedCount !== 1) { try { await ctx.telegram.deleteMessage(storageChannelId, copied.message_id); } catch {} await db.collection("personalFiles").deleteOne({ _id: inserted.insertedId }); return ctx.reply("❌ Storage quota change হয়ে গেছে। আবার চেষ্টা করুন।", userMainKeyboard()); }
    personalUploadStates.delete(ctx.from.id); const me = await ctx.telegram.getMe(); const link = `https://t.me/${me.username}?start=pfile_${inserted.insertedId}`; return ctx.reply(`✅ <b>File saved!</b>\n\n📄 ${escapeHtml(info.fileName || info.fileType)}\n💾 ${bytesToText(size)}\n\n🔗 ${link}`, { parse_mode: "HTML", ...userMainKeyboard() });
  } catch (error) { console.error("Personal storage upload error:", error.message); return ctx.reply("❌ File personal storage-এ save করা যায়নি।", userMainKeyboard()); }
});

// Global Telegram error handler
bot.catch((error) => {
  console.error("Telegram bot error:", error.message);
});

// Connect MongoDB before starting the bot.
async function expireDueSubscriptions() {
  if (!db) return;
  const now = new Date();
  const result = await db.collection("users").updateMany(
    { plan: "premium", subscriptionStatus: "active", subscriptionExpiresAt: { $lte: now } },
    { $set: { subscriptionStatus: "expired", updatedAt: now } }
  );
  if (result.modifiedCount) console.log(`Marked ${result.modifiedCount} subscription(s) as expired.`);
}

async function main() {
  await mongoClient.connect();
  await mongoClient.db("admin").command({ ping: 1 });

  db = mongoClient.db(DB_NAME);
  console.log("MongoDB Atlas connected successfully.");
  await ensureIndexes();
  await getBotSettings();
  await processDueDeletes();
  await expireDueSubscriptions();
  await bot.launch();
  setInterval(() => processDueDeletes().catch((error) => console.error("Scheduled delete recovery error:", error.message)), 60 * 1000).unref?.();
  setInterval(() => expireDueSubscriptions().catch((error) => console.error("Subscription expiry recovery error:", error.message)), 60 * 1000).unref?.();

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
