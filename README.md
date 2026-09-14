# iAgents

Text your [Grok Bot](https://docs.x.ai/grok-bot/overview) bots from iMessage.

Each bot gets its own contact on your phone ("Chief", "Dev", …). Texting a contact sends the message to that bot in Grok Bot, and everything the bot posts comes back as a text: replies, routine results, daily reports, and progress from the Cursor agents it runs. People and bots end up in the same Messages app, and it all runs on your existing Grok Bot plan, with no API bill.

```
iPhone ──iMessage──▶ Mac signed into a "bot" Apple ID
                      │  Messages database (read-only)     ▲ Messages.app (AppleScript)
                      ▼                                     │
                    iAgents relay ──── your Grok Bot session ────▶ Grok Bot bots
                                                                    (routines, Cursor agents, …)
```

> **Read this first.** Grok Bot has no public API. iAgents reaches your bots through the Grok Bot desktop app's signed-in session, using the community [grok-bot-cli](https://github.com/ScriptedAlchemy/grok-bot-cli) gateway client (pinned to a reviewed version). That is not an officially supported use: an app update can break it, and it may not be allowed by the app's terms. You're relying on it at your own risk.

## What you need

- A Mac that stays on and logged in, with Node.js 23.6+ (`brew install node`) and the Grok Bot app signed in.
- A second Apple ID just for the bots. Messages can't send as several people, so the bots share this account and each bot gets its own address on it.
- One email address per bot, added to that Apple ID and enabled in Messages. Receiving Apple's verification email is the first step; confirm that each address appears in Messages and receives an iMessage before relying on it.

## Setup

### 1. Create the bot Apple ID and its addresses

1. Create a new Apple Account for the bots.
2. For each bot, add an email address to it: Apple Account → **Sign-In & Security** → **Email & Phone Numbers** → **Add**, then enter the verification code Apple sends.

### 2. Sign Messages into the bot account

**A second macOS user is optional.** Messages, the Grok Bot app, and iAgents all have to run in the **same macOS user account**. Pick the setup that fits how you use this Mac:

| What you want | Setup | Tradeoff |
| --- | --- | --- |
| No extra macOS user | In Messages → Settings → iMessage, sign out and sign in with the bot Apple Account. | Your current Mac session stops receiving personal iMessages; your iPhone keeps them. This changes the Messages login, not your Mac's iCloud login. |
| Personal and bot Messages running on this Mac together | Create a standard macOS user for the relay in System Settings → Users & Groups. | One additional logged-in session. Recommended if you use personal Messages on this Mac. |
| Keep the relay off your everyday Mac | Use another always-on Mac signed into the bot account. | Requires another machine. |

Messages exposes one signed-in iMessage account per macOS user session. Duplicating Messages.app or running another relay process doesn't create another messaging identity. See Apple's [iMessage account settings](https://support.apple.com/guide/messages/icht39422/mac).

For the separate-user setup, log into that user's desktop and install/configure iAgents there, with Grok Bot signed in there too. Use a checkout in that user's home folder, rather than pointing at your personal user's Messages database or Keychain. You don't need a separate Grok subscription: sign into your existing Grok account. Switching back with [fast user switching](https://support.apple.com/guide/mac-help/mchlp2439/mac) leaves the relay user's processes running ([Apple's explanation](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPMultipleUsers/Concepts/FastUserSwitching.html)). Logging that user out stops the relay. After restarting the Mac, log into the relay user once before switching back.

Then, in Messages → Settings → iMessage:

- Under **You can be reached for messages at**, tick every bot address.
- Set **Start new conversations from** to your main bot's address.

To keep the Mac awake, open System Settings → Energy (on a laptop, Battery → Options) and turn on **Prevent automatic sleeping when the display is off**.

### 3. Install iAgents

```sh
git clone https://github.com/MasterMilkyshake/iAgents.git
cd iAgents
npm install
npm link            # makes the `iagents` command available
cp config.example.jsonc config.jsonc
```

Open the Grok Bot app, sign in, and create the bots you want to text. For repo work, set up a bot (say, **Dev**) in Grok Bot with access to your Cursor and GitHub accounts, so it can start Cursor agents and report on them. iAgents only relays that conversation.

List your bots and their ids:

```sh
iagents bots
```

Put the **id** in `config.jsonc` rather than the name — ids survive renaming a bot in the app.

When you run this, macOS asks whether `security` may use **"Grok Bot Safe Storage"**. Choose **Always Allow**, or the background service can't run unattended.

Edit `config.jsonc`: your own number under `owner.handles`, and one entry per bot with its iMessage `address` and its Grok Bot name (`grokBot`).

### 4. Grant permissions

In System Settings → Privacy & Security:

- **Full Disk Access**: add your terminal app (for manual runs) and the Node binary used by the background service. `iagents doctor` prints that Node path.
- **Automation → Messages**: allow it when prompted the first time iAgents sends a text.

### 5. Check, test, and install

```sh
iagents doctor                       # checks every piece and says how to fix what's missing
iagents simulate Chief "hi, who are you?"   # talks to the bot without iMessage
iagents run --dry-run                # reads your texts to the bots but prints replies instead of sending them
iagents install                      # runs the relay in the background, starting at login
```

Logs are at `~/Library/Logs/iAgents/relay.log`.
The installer validates your config before replacing the service. If you use `IAGENTS_CONFIG=/absolute/path/config.jsonc`, it preserves that path for background runs. Complete the permission prompts in the relay user's desktop session before switching away.

### 6. On your iPhone

Save each bot address as a contact named after the bot. Text it.

## Using it

- **Text a contact** and it goes to that bot. Replies come back in the same thread.
- **Swipe-reply** to a bot's message to answer it specifically. The bot gets the quoted text as context.
- **`@Dev fix the flaky login test`** at the start of any text sends it to that bot, whichever contact you're in.
- **Reports and routines**: anything a bot posts on its own (Grok Bot routines, finished agent runs, approval requests) is texted to you. Approvals still need to be tapped in the Grok Bot app.
- **Scheduled prompts**: `schedules` in `config.jsonc` sends a prompt at a set time, such as a 7:30 weekday briefing. Grok Bot routines do the same thing without needing the Mac.
- **Quiet hours**: unprompted messages wait until `quietHours` ends. Replies to your own texts always go through.
- **`/ping`** checks the relay is alive without involving Grok Bot.

Only text is forwarded. Photos and other attachments get a short "text only" reply. Group chats are ignored.

### Letting one bot speak for another

Set `"deliverVia": "Secretary"` on a bot and everything it says **on its own** — reports, routine
results, finished agent runs — arrives in Secretary's thread labelled `[Manager]`, instead of
turning up wherever you last texted. Replies to your own texts are untouched: they come back in the
thread you texted. Swipe-replying to a `[Manager]` message still reaches Manager.

This is worth doing when one bot is your point of contact and the others report through it.

### Why a message sometimes starts with `[Name]`

On the Mac, Messages merges your conversations with all the bot addresses into one chat, and it sends from whichever address you texted last. If Chief replies right after you texted Dev, the reply arrives from Dev's address, so iAgents labels it `[Chief]`. Swipe-replying to it still reaches Chief. Set `"tagReplies": "always"` or `"never"` to change this.

## How it works

- **Incoming:** iAgents watches `~/Library/Messages/chat.db` (read-only) and reads new texts the moment Messages writes them, with a 500 ms poll as a safety net. It drops anything not from `owner.handles`, as well as tapbacks, group chats, and messages more than 15 minutes old. The address you texted, an `@mention`, or the message you swipe-replied to decides which bot gets it. The prompt is sent through the Grok Bot gateway, using the iMessage ID as an idempotency key so a retry never posts twice.
- **Outgoing:** each bot's transcript is polled every 2 seconds after you text it and every 15 seconds otherwise, with an earlier check after a new prompt or when text reaches its 2.5-second settling deadline. Ordinary bot messages (`send-message` entries) are written in one go and go out on the first read; only entries that can stream — `message` entries carrying `isStreaming` — wait to settle. Replies are sent in order, with Markdown converted to plain text and long replies split into several bubbles. During a run, if an already-relayed message grows, its new text goes through the same settling and routing rules. Messages already in a transcript when iAgents first sees a bot are never replayed.
- **Responsiveness:** incoming-message checks continue while the gateway connects, a transcript request stalls, or Messages.app is sending. Each bot has at most one transcript poll in flight; a slow bot doesn't hold up other bots. Repeated transcript failures back off up to 60 seconds between attempts. These are relay polling intervals, not guarantees of end-to-end delivery time. Override them through `poll.chatDbMs`, `poll.grokBotActiveMs`, `poll.grokBotIdleMs`, and `poll.stableMs` if needed.
- **Delivery:** outgoing messages are saved before sending. Failed sends retry after 30 seconds, and queued messages survive restarts. Each successful bubble is acknowledged separately so retries resume a partially sent long reply. Messages.app doesn't provide an idempotency key: a timeout or crash after it accepts a bubble but before the relay records success can still cause a duplicate. Quiet hours hold proactive messages while allowing direct replies through.
- **State** (last message seen, which bot sent which bubble, queued message contents) lives in `~/Library/Application Support/iAgents/state.db`. Message contents aren't written to the logs.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Can't read the Messages database` | Give Full Disk Access to the Node path shown by `iagents doctor` (and your terminal). After `brew upgrade node`, the path changes: run `iagents install` again and re-grant access. |
| Texts reach the Mac but nothing is sent back | Run `iagents probe <bot>`. It shows the raw transcript and how iAgents reads each entry; only entries shown as `bot` are texted. If the Grok Bot app changed its format, that output is what's needed to fix the parser. |
| `Can't reach Grok Bot` | Open the Grok Bot app and make sure you're signed in. Re-run `iagents bots` and choose **Always Allow** on the Keychain prompt. |
| A bot address never receives texts | Check that it's added to the bot Apple ID and ticked under Messages → Settings → iMessage. `iagents doctor` shows which addresses have received messages. |
| `Ignoring a message from …` in the logs | Add that number or email to `owner.handles`. |

## Development

```sh
npm test            # node:test; uses a fake Messages database and a fake Grok Bot
npm run typecheck
```

TypeScript runs directly on Node (type stripping); there's no build step. The only runtime dependency is `grok-bot-cli`, pinned to an exact version.
