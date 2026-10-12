import os
import asyncio
from pyrogram import Client, filters
from pyrogram.types import InlineKeyboardMarkup, InlineKeyboardButton
from motor.motor_asyncio import AsyncIOMotorClient

# --- পরিবেশ ভেরিয়েবল (Koyeb থেকে লোড হবে) ---
API_ID = int(os.environ.get("API_ID", 0))
API_HASH = os.environ.get("API_HASH", "")
BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
ADMIN_ID = int(os.environ.get("ADMIN_ID", 0))
MONGO_URL = os.environ.get("MONGO_URL", "")

# --- ডাটাবেজ কানেকশন ---
db_client = AsyncIOMotorClient(MONGO_URL)
db = db_client["FileStoreBot"]
config_db = db["settings"]

# --- বট ক্লায়েন্ট ইনিশিয়ালাইজ ---
app = Client("FileStoreBot", api_id=API_ID, api_hash=API_HASH, bot_token=BOT_TOKEN)

# --- ডিফল্ট সেটিংস লোডার ---
async def get_settings():
    settings = await config_db.find_one({"_id": "bot_config"})
    if not settings:
        default = {
            "_id": "bot_config",
            "db_channel": "",
            "fsub_channels": [],
            "auto_delete_time": 0, # ০ মানে অফ
            "shortener_api": "",
            "shortener_url": "",
            "protect_content": False,
            "custom_caption": "",
            "banned_users": []
        }
        await config_db.insert_one(default)
        return default
    return settings

# --- স্টার্ট কমান্ড এবং লিংক ডেলিভারি ---
@app.on_message(filters.command("start") & filters.private)
async def start_command(client, message):
    user_id = message.from_user.id
    settings = await get_settings()
    
    # ব্যান চেক
    if user_id in settings.get("banned_users", []):
        return await message.reply_text("🔴 দুঃখিত, আপনাকে এই বট থেকে ব্যান করা হয়েছে।")
        
    text = message.text.split()
    
    # সাধারণ স্টার্ট মেসেজ
    if len(text) == 1:
        await message.reply_text(
            "👋 **স্বাগতম!**\n\nআমি একটি প্রফেশনাল ফাইল স্টোর বট। ফাইল ডাউনলোড করতে অনুগ্রহ করে সঠিক শেয়ারিং লিংকে ক্লিক করুন।",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔍 আমাদের চ্যানেলসমূহ", callback_data="view_channels")]])
        )
        return

    # লিংকের মাধ্যমে ফাইল রিলিজ লজিক (File Delivery)
    file_id_in_db = text[1]
    
    # এখানে Force Subscribe চেক করার লজিক বসবে (পরবর্তী ধাপে বিস্তারিত করা হবে)
    
    file_data = await db["files"].find_one({"_id": file_id_in_db})
    if file_data:
        sent_msg = await client.send_cached_media(
            chat_id=message.chat.id,
            file_id=file_data["file_id"],
            caption=settings.get("custom_caption") or file_data.get("caption"),
            protect_content=settings.get("protect_content", False)
        )
        
        # অটো ডিলিট অপশন চালু থাকলে
        del_time = settings.get("auto_delete_time", 0)
        if del_time > 0:
            notice = await message.reply_text(f"⚠️ কপিরাইট এড়াতে এই ফাইলটি {del_time} মিনিট পর অটোমেটিক ডিলিট হয়ে যাবে। দ্রুত সেভ করুন!")
            await asyncio.sleep(del_time * 60)
            await sent_msg.delete()
            await notice.delete()
    else:
        await message.reply_text("❌ ফাইলটি খুঁজে পাওয়া যায়নি বা ডাটাবেজ থেকে মুছে ফেলা হয়েছে।")

# --- টেলিগ্রাম ভিত্তিক সেটিংস প্যানেল (শুধুমাত্র এডমিনের জন্য) ---
@app.on_message(filters.command("settings") & filters.user(ADMIN_ID))
async def settings_panel(client, message):
    buttons = [
        [InlineKeyboardButton("📝 START MSG", callback_data="set_start"), InlineKeyboardButton("📢 FORCE SUB", callback_data="set_fsub")],
        [InlineKeyboardButton("⏱️ AUTO DELETE", callback_data="set_autodel"), InlineKeyboardButton("🛡️ NO FORWARD", callback_data="toggle_forward")],
        [InlineKeyboardButton("🔑 ACCESS TOKEN", callback_data="set_token"), InlineKeyboardButton("📊 STATS", callback_data="view_stats")],
        [InlineKeyboardButton("🔗 LINK SHORTENER", callback_data="set_shortener")],
        [InlineKeyboardButton("❌ CLOSE", callback_data="close_menu")]
    ]
    await message.reply_text(
        "🛠️ **Settings**\n\n*Customize your settings as your need*",
        reply_markup=InlineKeyboardMarkup(buttons)
    )

# --- এডমিন কলব্যাক কোয়েরি হ্যান্ডলার (টেলিগ্রাম সেটিংস ইন্টারফেস) ---
@app.on_callback_query()
async def cb_handler(client, query):
    user_id = query.from_user.id
    settings = await get_settings()
    
    if query.data == "toggle_forward":
        if user_id != ADMIN_ID: return
        new_status = not settings.get("protect_content", False)
        await config_db.update_one({"_id": "bot_config"}, {"\$set": {"protect_content": new_status}})
        await query.answer(f"No Forward / Protect Content: {'চালু' if new_status else 'বন্ধ'}")
        
    elif query.data == "view_stats":
        total_files = await db["files"].count_documents({})
        await query.message.edit_text(f"📊 **বটের বর্তমান পরিসংখ্যান:**\n\n📁 মোট ফাইল সংরক্ষিত: {total_files}টি\n⚡ সার্ভার স্ট্যাটাস: সচল")

# --- ফাইল স্টোর লজিক (লিংক জেনারেটর) ---
@app.on_message(filters.private & (filters.document | filters.video | filters.audio) & filters.user(ADMIN_ID))
async def store_file(client, message):
    settings = await get_settings()
    db_channel = settings.get("db_channel")
    
    if not db_channel:
        return await message.reply_text("⚠️ প্রথমে সেটিংসে গিয়ে আপনার Private Database Channel ID যুক্ত করুন।")
        
    # মেইন ডেটাবেজ চ্যানেলে ফাইল ব্যাকআপ পাঠানো
    copied_msg = await message.forward(chat_id=int(db_channel))
    
    import string, random
    unique_id = ''.join(random.choices(string.ascii_letters + string.digits, k=10))
    
    # ডাটাবেজে ফাইল সেভ
    await db["files"].insert_one({
        "_id": unique_id,
        "file_id": copied_msg.document.file_id if copied_msg.document else copied_msg.video.file_id,
        "caption": message.caption or ""
    })
    
    bot_user = await client.get_me()
    share_link = f"https://t.me{bot_user.username}?start={unique_id}"
    
    await message.reply_text(f"✅ **ফাইল সফলভাবে সংরক্ষিত হয়েছে!**\n\n🔗 আপনার শেয়ারিং লিংক:\n`{share_link}`")

# বট রান করা
app.run()
