
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

if (
  !Number.isSafeInteger(ADMIN_ID) ||
  ADMIN_ID <= 0
) {
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

// Telegram /start and share-link delivery
bot.start(async (ctx) => {
  const payload = ctx.startPayload;

  if (payload && payload.startsWith("file_")) {
    if (ctx.chat?.type !== "private") {
      return ctx.reply(
        "ফাইল পেতে Bot-কে Private Chat-এ খুলুন।"
      );
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

  if (payload && payload.startsWith("batch_")) {
    if (ctx.chat?.type !== "private") {
      return ctx.reply(
        "ফাইল পেতে Bot-কে Private Chat-এ খুলুন।"
      );
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

  return ctx.reply(
    "👋 Welcome to Telegram File Store Bot!\n\n" +
    "ফাইল পেতে একটি বৈধ Share Link খুলুন।"
  );
});

// Help
bot.command("help", async (ctx) => {
  return ctx.reply(
    "📚 Available Commands:\n\n" +
    "/start - Start the bot\n" +
    "/help - Show commands\n" +
    "/genlink - Generate a single-file link\n" +
    "/cancel - Cancel single-file upload\n" +
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

// Receive files for single or batch uploads
bot.on(
  [
    "document",
    "video",
    "audio",
    "photo",
    "animation",
    "voice",
    "video_note"
  ],
  async (ctx) => {
    if (!isAdmin(ctx)) return;

    let fileType;

    if (ctx.message.document) fileType = "document";
    else if (ctx.message.video) fileType = "video";
    else if (ctx.message.audio) fileType = "audio";
    else if (ctx.message.photo) fileType = "photo";
    else if (ctx.message.animation) fileType = "animation";
    else if (ctx.message.voice) fileType = "voice";
    else if (ctx.message.video_note) fileType = "video_note";

    const userId = ctx.from.id;
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

    // Do not silently treat files as single uploads while
    // an existing batch is under review or being stored.
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
    return ctx.answerCbQuery(
      "ফাইল Store হচ্ছে। অপেক্ষা করো।",
      { show_alert: true }
    );
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
    return ctx.answerCbQuery(
      "কোনো অপেক্ষমাণ ফাইল পাওয়া যায়নি।",
      { show_alert: true }
    );
  }

  if (pending.inProgress) {
    return ctx.answerCbQuery(
      "ফাইল Store হচ্ছে। অপেক্ষা করো।"
    );
  }

  if (Date.now() - pending.createdAt > 30 * 60 * 1000) {
    pendingFiles.delete(userId);

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

  if (!db) {
    return ctx.answerCbQuery(
      "Database প্রস্তুত নয়।",
      { show_alert: true }
    );
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

    const link =
      `https://t.me/${me.username}?start=file_${result.insertedId}`;

    pendingFiles.delete(userId);

    try {
      return await ctx.editMessageText(
        "✅ File stored successfully!\n\n" +
        "🔗 Share Link তৈরি হয়েছে!\n\n" +
        link
      );
    } catch (editError) {
      console.error(
        "Single confirmation message error:",
        editError.message
      );

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

// Cancel single upload
bot.command("cancel", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("⛔ You are not authorized.");
  }

  const pending = pendingFiles.get(ctx.from.id);

  if (!pending) {
    return ctx.reply(
      "ℹ️ বাতিল করার মতো কোনো Single Upload নেই।"
    );
  }

  if (pending.inProgress) {
    return ctx.reply(
      "⚠️ ফাইল Store হচ্ছে। এখন Cancel করা যাবে না।"
    );
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
    return ctx.reply(
      "⚠️ আগে Single Upload সম্পন্ন করো অথবা /cancel পাঠাও।"
    );
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
    return ctx.reply(
      "ℹ️ কোনো চলমান Batch নেই। শুরু করতে /batch পাঠাও।"
    );
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
      [
        Markup.button.callback(
          "🔗 Generate Batch Link",
          "batch_confirm"
        )
      ],
      [
        Markup.button.callback(
          "❌ Cancel Batch",
          "batch_cancel"
        )
      ]
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

    return ctx.editMessageText(
      "ℹ️ বাতিল করার মতো কোনো Batch নেই।"
    );
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
    return ctx.reply(
      "ℹ️ বাতিল করার মতো কোনো Batch নেই।"
    );
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

  if (
    !batch ||
    !["review", "processing"].includes(batch.status)
  ) {
    return ctx.answerCbQuery(
      "Batch পাওয়া যায়নি। আবার /batch পাঠাও।",
      { show_alert: true }
    );
  }

  // Prevent simultaneous callbacks in this running process.
  if (batch.inProgress) {
    return ctx.answerCbQuery(
      "ফাইলগুলো ইতিমধ্যে Store হচ্ছে। অপেক্ষা করো।"
    );
  }

  if (!STORAGE_CHANNEL_ID) {
    return ctx.answerCbQuery(
      "Storage channel configure করা নেই।",
      { show_alert: true }
    );
  }

  if (!db) {
    return ctx.answerCbQuery(
      "Database প্রস্তুত নয়।",
      { show_alert: true }
    );
  }

  if (!Array.isArray(batch.files) || batch.files.length === 0) {
    return ctx.answerCbQuery(
      "Batch-এ কোনো ফাইল নেই।",
      { show_alert: true }
    );
  }

  batch.inProgress = true;

  try {
    await ctx.answerCbQuery("ফাইলগুলো Store করা হচ্ছে...");

    const collection = db.collection("batches");
    const me = await ctx.telegram.getMe();

    // Create the record only after Generate is pressed.
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

    let savedBatch = await collection.findOne({
      _id: batchId
    });

    if (!savedBatch) {
      throw new Error("Batch database record not found");
    }

    // If storage completed but the confirmation message failed,
    // show the existing link rather than storing files again.
    if (savedBatch.status === "ready") {
      const link =
        `https://t.me/${me.username}?start=batch_${batchId}`;

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

    // Support processing records created by an earlier version.
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
        {
          _id: batchId,
          status: "processing"
        },
        {
          $set: {
            storedCount,
            updatedAt: new Date()
          }
        }
      );
    }

    // Copy remaining files sequentially and save each result.
    for (
      let i = storedCount;
      i < savedBatch.sourceFiles.length;
      i++
    ) {
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
        {
          _id: batchId,
          status: "processing",
          storedCount: i
        },
        {
          $push: {
            files: storedFile
          },
          $inc: {
            storedCount: 1
          },
          $set: {
            updatedAt: new Date()
          }
        }
      );

      if (updateResult.modifiedCount !== 1) {
        // The database response may have failed after the write.
        // Check the saved progress before deciding what happened.
        savedBatch = await collection.findOne({
          _id: batchId
        });

        if (
          !savedBatch ||
          savedBatch.storedCount < i + 1 ||
          savedBatch.files.length < i + 1
        ) {
          throw new Error(
            "Could not verify saved file progress"
          );
        }
      }

      savedBatch = await collection.findOne({
        _id: batchId
      });

      if (
        !savedBatch ||
        savedBatch.storedCount !== i + 1 ||
        savedBatch.files.length !== i + 1
      ) {
        throw new Error(
          "Batch progress verification failed"
        );
      }
    }

    savedBatch = await collection.findOne({
      _id: batchId
    });

    if (
      !savedBatch ||
      savedBatch.storedCount !== savedBatch.sourceFiles.length ||
      savedBatch.files.length !== savedBatch.sourceFiles.length
    ) {
      throw new Error("Not all batch files were stored");
    }

    // Only mark the batch ready after every file is verified.
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

    const finalBatch = await collection.findOne({
      _id: batchId,
      status: "ready"
    });

    if (!finalBatch) {
      throw new Error("Batch could not be marked ready");
    }

    const link =
      `https://t.me/${me.username}?start=batch_${batchId}`;

    pendingBatches.delete(userId);

    try {
      return await ctx.editMessageText(
        "✅ Batch Stored Successfully!\n\n" +
        `📦 মোট ফাইল: ${finalBatch.fileCount}\n\n` +
        "🔗 Batch Share Link:\n" +
        link
      );
    } catch (error) {
      console.error(
        "Batch confirmation message error:",
        error.message
      );

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
