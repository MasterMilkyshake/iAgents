-- Sends one iMessage through Messages.app.
-- Usage: osascript send.applescript chat <chat-guid> <text>
--        osascript send.applescript handle <phone-or-email> <text>
-- Arguments are passed as argv so message text never needs escaping.
on run argv
	set mode to item 1 of argv
	set target to item 2 of argv
	set msg to item 3 of argv
	tell application "Messages"
		if mode is "chat" then
			send msg to chat id target
		else
			set svc to 1st account whose service type = iMessage
			send msg to participant target of svc
		end if
	end tell
end run
