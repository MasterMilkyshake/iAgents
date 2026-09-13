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
- One email address per bot, added to that Apple ID. Anything you can receive a verification code at works, such as extra Gmail addresses.

## Setup

### 1. Create the bot Apple ID and its addresses

1. Create a new Apple Account for the bots.
2. For each bot, add an email address to it: Apple Account → **Sign-In & Security** → **Email & Phone Numbers** → **Add**, then enter the verification code Apple sends.

### 2. Sign Messages into the bot account

Messages, the Grok Bot app, and iAgents all have to run in the **same macOS user account**. Pick one:

- **Dedicated Mac, or you don't use iMessage on this Mac:** in Messages → Settings → iMessage, sign out of your personal Apple ID and sign in with the bot Apple ID. Your own texts stay on your iPhone.
- **Keep your personal Messages on this Mac:** create a second macOS user (System Settings → Users & Groups), log into it, and do everything below there. Switch back to your own user with fast user switching; the bot user stays logged in and keeps running.

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

List the bot names:

```sh
iagents bots
```

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

### Why a message sometimes starts with `[Name]`

On the Mac, Messages merges your conversations with all the bot addresses into one chat, and it sends from whichever address you texted last. If Chief replies right after you texted Dev, the reply arrives from Dev's address, so iAgents labels it `[Chief]`. Swipe-replying to it still reaches Chief. Set `"tagReplies": "always"` or `"never"` to change this.

## How it works

- **Incoming:** iAgents polls `~/Library/Messages/chat.db` (read-only) for new texts to the bot addresses and drops anything not from `owner.handles`, as well as tapbacks, group chats, and messages more than 15 minutes old. The address you texted, an `@mention`, or the message you swipe-replied to decides which bot gets it. The prompt is sent through the Grok Bot gateway, using the iMessage ID as an idempotency key so a retry never posts twice.
- **Outgoing:** each bot's transcript is polled every few seconds after you text it and every 45 seconds otherwise. New bot messages are sent once they stop changing, in order, with Markdown converted to plain text and long replies split into several bubbles. Messages already in a transcript when iAgents first sees a bot are never replayed.
- **State** (last message seen, which bot sent which bubble, held messages) lives in `~/Library/Application Support/iAgents/state.db`. Message contents aren't written to the logs.

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
