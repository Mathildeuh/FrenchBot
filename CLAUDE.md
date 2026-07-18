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
2. While **not** live, each poll opens a fresh `TikTokLiveConnection` and calls `.connect()`. Success means the account just went live — the connection is deliberately **not** torn down (no `finally`/`disconnect()` on this path); it's kept open and handed to `attachLiveListeners()` to track the live in real time. A thrown error means still not live, and that throwaway connection is disconnected.
3. While live, `checkTikTokLive()` no-ops (just refreshes the bot's presence from `liveStats.lastViewerCount`) — the persistent connection from step 2 owns detecting the end of the live via its own `WebcastEvent.STREAM_END`/`ControlEvent.DISCONNECTED` events (see `attachLiveListeners`), not the poller. As a fallback, the poller also checks `liveConnection.isConnected` each tick in case a disconnect never fired an event.
4. `isCurrentlyLive` is the primary state flag; `liveConnection` (the open connection) and `liveStats` (accumulators for the recap, see below) are the other two pieces of live-session state, all three set together when a live starts and cleared together in `finalizeLiveEnd()`. `isCurrentlyLive` gates notifications so a live session triggers exactly one Discord alert, no matter how many polling intervals it spans; the alert only fires on the false→true transition.
5. `sendLiveAlert()` fetches the target channel and posts an embed (author/avatar, title, stream title, cover image, viewer count) plus an `@everyone` content string. Note: `allowedMentions: { parse: ['everyone'] }` is required or Discord silently suppresses the actual ping.

When changing polling/alerting behavior, the false→true edge detection in `checkTikTokLive` is the key invariant to preserve — don't let it re-fire on every interval while still live. Likewise, don't reintroduce a `disconnect()` on the live-tracking connection path — that's what feeds `attachLiveListeners()`.

### Bot presence & end-of-live recap

- `updateBotPresence(isLive, viewerCount)` sets the bot's Discord activity to a `ActivityType.Custom` status (no "Playing/Watching" prefix) — `🔴 En live avec N viewers` or `⚪ Pas en live actuellement`. Called on every transition and, while live, refreshed each poll tick from `liveStats.lastViewerCount`.
- `attachLiveListeners(connection)` is called once, right after a live is detected, and wires up `tiktok-live-connector`'s real-time `WebcastEvent`/`ControlEvent` handlers (imported from `tiktok-live-connector`'s main export, backed by `tiktok-live-proto/v3`'s raw protobuf message shapes — **not** the friendlier field names shown in that package's README, which only apply to its `/legacy` entry point) onto `liveStats`:
  - `WebcastEvent.GIFT` → `gift.diamondCount` accumulates into `totalDiamonds`; combo gifts (`gift.type === 1`) only count once, on the event where `repeatEnd` is truthy, to avoid double-counting mid-streak events.
  - `WebcastEvent.LIKE` → `msg.total` is already the live's cumulative like count, so `likeTotal` is overwritten (not summed) each event.
  - `WebcastEvent.FOLLOW` / `WebcastEvent.SHARE` → both distinguished purely by which event name fired (both carry the same `WebcastSocialMessage` payload shape), each increments its own counter by 1.
  - `WebcastEvent.ROOM_USER` → `msg.total` is the current viewer count; tracked into `viewerMax` and a running sum/count for the average.
  - `WebcastEvent.CHAT` → messages containing `?` are bucketed by lowercased/whitespace-normalized text in `questionCounts`, a plain frequency count (no semantic grouping) used for the "most asked questions" recap field.
  - `WebcastEvent.STREAM_END` and `ControlEvent.DISCONNECTED` both funnel into ending the live: `STREAM_END` finalizes immediately; a bare `DISCONNECTED` (which could be a transient drop) waits 5s and attempts one `connection.connect(connection.roomId)` reconnect before giving up and finalizing. `liveEndHandled` guards against both firing and finalizing twice (`STREAM_END` triggers a `DISCONNECTED` right after it per the library's docs).
- `finalizeLiveEnd()` is the single exit point for "live is over" regardless of which path triggered it: resets `isCurrentlyLive`/`liveConnection`/`liveStats`, updates topic/presence, disconnects the connection, and calls `sendLiveRecapDM(stats)`.
- `sendLiveRecapDM()` DMs an embed recap (duration, gifts, diamonds/"pièces", likes, follows, shares, viewer max/avg, top 5 questions) to every ID in `SCHEDULE_ADMIN_IDS` — the same admin list used for schedule editing, reused here as "who should get the live recap" rather than adding a separate config var.
- Record detection: `checkAndUpdateRecords(stats, durationMs)` compares the just-ended live against `records.json` (gitignored, same load/save pattern as the other `*.json` files — missing file just means "no record yet", every positive stat becomes a first record) across `durationMs`, `viewerMax`, `totalGifts`, `totalDiamonds`, `likeTotal`, `followCount`, `shareCount`. Each key that's a new high both updates `records.json` and is returned in a `Set`; `sendLiveRecapDM()` appends "🆕 record !" to that specific field's value (not a separate summary — the flag sits on the stat it belongs to) and adds a one-line "🎉 N nouveau(x) record(s)" description when at least one broke. A stat of `0` never counts as a record (strict `>` comparison), so a quiet live with no gifts doesn't falsely claim a "0 gifts" record.

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

## Deployment (Debian)

`deploy/frenchbot.service` is a systemd unit template for running the bot 24/7 with auto-restart on crash and on boot (`Restart=always`). To install on the target server: copy the repo, edit the `WorkingDirectory`/`User`/`EnvironmentFile` placeholders, then:

```
sudo cp deploy/frenchbot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now frenchbot
```

The bot itself also has in-process resilience for long-running uptime: Discord client errors/reconnects are logged (discord.js auto-reconnects on its own), and `unhandledRejection` is caught so one bad poll doesn't kill the whole process.
