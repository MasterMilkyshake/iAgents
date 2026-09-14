# Transcript handling and recovery

Verified against the installed Grok Bot **0.47.0** app on September 13, 2026.
The integration dependency remains pinned to `grok-bot-cli` **0.2.3**.

## Evidence for placeholders

`test/fixtures/grokbot-posts.json` contains sanitized entries captured using
`getAgentTranscriptTail` (limit 1000) from the signed-in gateway. It preserves
wrapper fields and discriminants; private text, IDs and URLs are replaced.
Captured shapes: widget, connector, local-tool-permission (allowed),
auto-review-approval (approved/expired), automation-changed and name-changed events.
Raw transcripts are not included in this repository.

Other fixtures in `test/posts.test.ts` are **bundle-derived**, not captured posts.
The user approved enabling fixed placeholders for these verified types.
The source is `dist/renderer/assets/index-C57MhV1e.js` inside
`/Applications/Grok Bot.app/Contents/Resources/app.asar`, SHA-256:
`15e2677c0f73eb93ea895a5350669c8bd39fcbe1ae67d9cda2018870f9f9ba73`.

The `dpt` registry lists message types, `upt` lists event types, and `qet`/`XN`
reference their wrapper fields. The renderer uses `notice.text` and
`feedback.state`; `opt` distinguishes voted feedback from the feedback card.
Images/files use `attachment.url`; image-only text messages use `images[].url`.
There is no verified standalone `image`, `file` or `card` message discriminant.

Known cards produce short, fixed descriptions directing the owner to Grok Bot.
Resolved approvals and voted feedback stay silent. Unknown/malformed cards stay
silent with a fixed diagnostic logged once per reason per process. Tool calls
and internal chatter never become bot replies merely because they have an author.

## Runtime cost and limits

No dependencies, processes or streaming connections were added. Watch renewal
runs every five minutes through the existing relay loop, with a 30-second retry
after failure; file events are debounced. Polling remains the fallback.
After a pause over one minute, the relay reopens Messages, renews its watcher,
invalidates the cached gateway session and fetches up to 1000 entries per bot
once. Ordinary transcript limits resume afterward. Concurrent gateway calls
share session acquisition; 401/403 responses refresh the app session once.

The relay log is truncated **in place** at 5 MiB, checked at startup and once per
minute. This preserves launchd's append descriptors; the log may briefly exceed
the threshold between checks. Error logs retain machine-readable codes rather
than error text that could contain a message or subprocess arguments.

The larger wake window is bounded. If more than 1000 entries arrive during sleep,
older posts can fall outside it; a missing overlap produces a diagnostic. The
existing 15-minute age limit for incoming texts and `relay: replies` active window
still apply. Exact-once iMessage delivery across a crash between sending and
saving the acknowledgment cannot be guaranteed by AppleScript.

## Manual overnight check

Automated tests cover watcher re-arming, gateway token refresh, simulated overnight
catch-up, owner-only delivery, and duplicate suppression. They cannot establish
actual macOS sleep behavior, TCC permissions or real token rotation while asleep.
After syncing and restarting in the `iagents` account:

1. Text `/ping`, then send a normal bot prompt and confirm each reply arrives once.
2. Allow the Mac to sleep overnight. Have a bot routine post during sleep. Send an
   owner text within 15 minutes of waking, then another just after wake.
3. Confirm the new texts and routine posts arrive once, subject to quiet hours and
   the configured relay mode. Confirm further texts continue arriving promptly.
4. Check `~/Library/Logs/iAgents/relay.log` in the relay account for the resume
   diagnostic, watcher failures or a catch-up gap. Do not copy message contents
   into logs when investigating. Use `iagents probe <bot-id>` privately if needed.

Streaming remains deferred to keep the integration small and stable.
