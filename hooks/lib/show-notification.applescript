-- omc-lens: display a macOS notification.
-- Invoked as: osascript show-notification.applescript "<title>" "<body>"

on run argv
  if (count of argv) < 2 then
    return
  end if
  set theTitle to item 1 of argv
  set theBody to item 2 of argv
  display notification theBody with title theTitle
end run
