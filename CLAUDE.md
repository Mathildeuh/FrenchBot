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
- `GUILD_ID` — optional; if set, the `/prochain-stream` slash command is registered to that guild (instant propagation) instead of globally (up to 1h the first time)

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

### Schedule commands & DM/slash interactions

- `SCHEDULE_ADMIN_IDS` (hardcoded array of two Discord user IDs) are the only users who can edit any schedule data. Everyone else is read-only.
- Dates are always entered/edited as `JJ/MM/AAAA HH:mm` **in Paris local time**, parsed by `parseParisDateTime()` into a Unix timestamp (seconds) and stored that way — never as a raw string — so the DST-aware offset (`parisOffsetMinutes()`, computed via `Intl.DateTimeFormat` with `timeZoneName: 'shortOffset'`, no external tz library) only needs to run once at write time. Display always uses Discord's native `<t:TIMESTAMP:F>`/`<t:TIMESTAMP:R>` markdown so every viewer sees it in their own timezone. `formatParisDateTime()` is the inverse (timestamp → `JJ/MM/AAAA HH:mm`), used only to pre-fill edit modals with human-editable text.
- `/prochain-stream`: admins get a single-field modal (one `TextInputBuilder`, `JJ/MM/AAAA HH:mm`) that overwrites `prochain-stream.json` (`{ timestamp }`) via `saveNextStream()`. Non-admins just get the current value read back via `formatNextStreamText()`.
- `/streams`: shows a styled embed (`buildStreamsEmbed()`) with current live status, the recurring weekly schedule, and upcoming one-off dates (past dates in `streams.json` are filtered out at display time, not deleted from storage). Backed by `streams.json` (`{ weekly: string[], dates: number[] }`) via `loadStreamsPlanning()`/`saveStreamsPlanning()`. If the invoker is an admin, a `✏️ Modifier le planning` button is sent as an ephemeral follow-up; clicking it (`streams-edit-button`, permission-checked again on click since the public embed itself has no button) opens a two-field paragraph modal (`streams-edit-modal`, one line per weekly entry / per date) pre-filled from the current data via `.setValue()`. On submit, each date line is parsed independently; if any line is invalid the whole save is rejected with the offending lines listed, rather than silently dropping them.
- Both `*.json` schedule files are gitignored and live next to `bot.js`; deleting/missing files just means "nothing set yet" (`loadNextStream()`/`loadStreamsPlanning()` return `null`/empty arrays rather than throwing).
- DM auto-reply: any non-bot message received in a DM channel (`message.guild` is falsy) triggers a reply combining `formatNextStreamText()` and `formatLiveStatusText()` (the latter reads the same `isCurrentlyLive` flag used for the live-alert edge detection). Message content is intentionally never inspected — the reply is the same regardless of what was sent.
- Requires the `GatewayIntentBits.DirectMessages` intent and `Partials.Channel` (so DMs on an uncached channel still fire `messageCreate` after a restart).

### Counting channel (`compteur.json`)

- `COUNTING_CHANNEL_ID` (hardcoded, same style as `SCHEDULE_ADMIN_IDS`) is the one channel where `handleCountingMessage()` runs on every non-bot message.
- The rule: a message must be exactly the last successful count + 1 (checked via `/^\d+$/` then numeric equality — no leading text, decimals, or negative numbers). Correct messages just persist the new count to `compteur.json` (`{ count }`) with no bot reply. Any miss (wrong number or non-numeric content) resets `count` to `0` and posts an embed (`buildCountingRulesEmbed()`) naming who broke it, at what count, and restating the rules.
- There's no "same person can't count twice in a row" rule — only the sequential-number check described above.
- The channel topic (`COUNTING_TOPIC`) is set once at startup via `ensureCountingChannelTopic()`, which skips the API call if the topic already matches (Discord rate-limits topic edits to ~2/10min).

## Deployment (Debian)

`deploy/frenchbot.service` is a systemd unit template for running the bot 24/7 with auto-restart on crash and on boot (`Restart=always`). To install on the target server: copy the repo, edit the `WorkingDirectory`/`User`/`EnvironmentFile` placeholders, then:

```
sudo cp deploy/frenchbot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now frenchbot
```

The bot itself also has in-process resilience for long-running uptime: Discord client errors/reconnects are logged (discord.js auto-reconnects on its own), and `unhandledRejection` is caught so one bad poll doesn't kill the whole process.
