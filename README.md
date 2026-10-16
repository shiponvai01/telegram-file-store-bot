# Telegram File Store Bot

Production-oriented Telegram File Store Bot built with Node.js, Telegraf, Express and MongoDB Atlas.

## Current features

- Single-file share links
- Batch share links
- Admin broadcast with confirmation/progress and retry handling
- Ban / Unban
- Force Subscribe
- Auto Delete with persisted recovery after restart
- No Forward / Protect Content
- Custom Caption and Custom Buttons
- Link Shortener configuration
- Admin File Management and paginated Users
- Moderator management with a limited Moderator Panel
- Graceful restart request
- Personal user storage
- Free/Premium storage limits
- User buttons + commands for personal storage
- Admin can remove personal or shared files
- MongoDB indexes for common high-traffic queries
- User profile creation is performed once; normal activity writes are throttled

## Environment variables

Required:

- `BOT_TOKEN`
- `ADMIN_ID`
- `MONGODB_URI`
- `STORAGE_CHANNEL_ID`
- `PORT`
- `DB_NAME`

Optional:

- `PERSONAL_STORAGE_CHANNEL_IDS` — comma-separated Telegram channel IDs used for personal user files. The bot must be an administrator in every listed channel. If omitted, personal files fall back to `STORAGE_CHANNEL_ID`.

See `.env.example`.

## Personal storage

A user can press **📁 My Files → 📤 Upload File** or use `/upload` and send a document, video, audio, APK, photo, animation, voice or video note.

The actual media is copied to a configured Telegram storage channel. MongoDB stores only metadata such as owner ID, storage channel ID, storage message ID, filename and size.

Personal links use `/start pfile_<id>` and are owner-only by design.

Default plans:

- Free: 500 MB / 50 files
- Premium: 10 GB / 1000 files / 30 days

Premium activation is currently admin-controlled. A payment provider can be integrated later without changing the storage model.

## User menu

The bot provides a native Telegram Reply Keyboard:

- 📁 My Files
- 💎 Subscription
- 💾 My Storage
- 🔗 My Links
- 👤 My Account
- ℹ️ Help

Main commands:

- `/start`
- `/help`
- `/myfiles`
- `/upload`
- `/storage`
- `/subscription`
- `/mylinks`
- `/account`
- `/deletefile FILE_ID`

## Admin / Moderator

Owner-only controls include Settings, Subscription management, Moderator management and Restart.

Moderators receive a limited panel for operational tasks such as Users, File Management, Broadcast, Ban/Unban and Statistics.

## Deployment

Node.js 20+ is recommended.

```bash
npm install
npm start
```

For Render/Railway/VPS/cPanel, configure the environment variables in the platform's environment settings. Never commit `.env` or real secrets.

## Scaling notes

This project is designed to avoid unnecessary repeated user writes, use database indexes, stream broadcast users with a MongoDB cursor, retry Telegram flood-limit responses, and keep actual file bytes out of MongoDB.

Very large deployments still require adequate MongoDB capacity, Telegram API rate-limit handling, storage-channel capacity and a suitable always-on hosting/process manager. No application code alone can guarantee a specific number of daily users.
