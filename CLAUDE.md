# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file Discord bot that polls a TikTok account's live status and posts an `@everyone` alert with an embed to a Discord channel when that account goes live. Written in French (console logs, comments, `.env` docs) for a French-speaking streamer's community.

## Commands

- Install: `npm install`
- Run: `npm start` (runs `node bot.js`)

There is no build step, linter, or test suite in this project.

## Configuration

Runtime config comes entirely from a `.env` file (see `env.example` for the template), loaded via `dotenv`:

- `DISCORD_TOKEN` — Discord bot token
- `CHANNEL_ID` — Discord channel to post alerts into
- `TIKTOK_USERNAME` — TikTok handle to watch (no `@`)
- `EULER_API_KEY` — Euler Stream API key, required by `tiktok-live-connector` to sign TikTok requests

The bot exits at startup (`process.exit(1)`) if `DISCORD_TOKEN`, `CHANNEL_ID`, or `TIKTOK_USERNAME` are missing.

## Architecture

Everything lives in `bot.js`. The core loop:

1. On Discord client `ready`, `checkTikTokLive()` runs immediately, then again every `CHECK_INTERVAL` (60s, hardcoded).
2. Each check opens a fresh `TikTokLiveConnection` and calls `.connect()`. Success means the account is live; a thrown error means it isn't (or the connection failed) — both are treated as "not live" in the `catch` block, and the connection is always torn down in `finally` since the bot only needs a point-in-time status, not a persistent chat connection.
3. `isCurrentlyLive` is the only state the bot keeps. It gates notifications so a live session triggers exactly one Discord alert, no matter how many polling intervals it spans; the alert only fires on the false→true transition.
4. `sendLiveAlert()` fetches the target channel and posts an embed (author/avatar, title, stream title, cover image, viewer count) plus an `@everyone` content string. Note: `allowedMentions: { parse: ['everyone'] }` is required or Discord silently suppresses the actual ping.

When changing polling/alerting behavior, the false→true edge detection in `checkTikTokLive` is the key invariant to preserve — don't let it re-fire on every interval while still live.

### `state.roomInfo` field shapes

`tiktok-live-connector`'s `connection.connect()` resolves with the raw TikTok webcast API response, which is **snake_case**, not the camelCase you'd guess from JS convention. The fields actually used in `sendLiveAlert`:

- `roomInfo.title` — stream title
- `roomInfo.user_count` — live viewer count (number; guard with `typeof === 'number'` since it's absent outside an active room)
- `roomInfo.cover.url_list[0]` — stream cover image
- `roomInfo.owner.nickname` — streamer's display name
- `roomInfo.owner.avatar_thumb.url_list[0]` — streamer's avatar

There's no local TypeScript types for `RoomInfo` (it's `Record<string, any>`); the authoritative shape is `WebcastFeedResponseRoomData` in `node_modules/tiktok-live-api-sdk/dist/index.d.ts`.

## Deployment (Debian)

`deploy/frenchbot.service` is a systemd unit template for running the bot 24/7 with auto-restart on crash and on boot (`Restart=always`). To install on the target server: copy the repo, edit the `WorkingDirectory`/`User`/`EnvironmentFile` placeholders, then:

```
sudo cp deploy/frenchbot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now frenchbot
```

The bot itself also has in-process resilience for long-running uptime: Discord client errors/reconnects are logged (discord.js auto-reconnects on its own), and `unhandledRejection` is caught so one bad poll doesn't kill the whole process.
