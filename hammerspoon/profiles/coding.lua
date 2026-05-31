return {
  name = "Coding",
  icon = "💻",
  iconBundle = "com.mitchellh.ghostty",
  apps = {
    { bundle = "company.thebrowser.Browser", name = "Arc" },
    { bundle = "com.mitchellh.ghostty", name = "Ghostty" },
  },
  commands = {
    { name = "Claude split in Ghostty", command = "open -na Ghostty && sleep 1 && osascript -e 'tell application \"Ghostty\" to activate' -e 'tell application \"System Events\" to tell process \"Ghostty\"' -e 'keystroke “ cd ~ && clear && caffeinate -dis claude --dangerously-skip-permissions\"' -e 'key code 36' -e 'delay 0.5' -e 'keystroke \"d\" using command down' -e 'delay 0.5' -e 'keystroke \"clear && caffeinate -dis claude --dangerously-skip-permissions\"' -e 'key code 36' -e 'end tell'" },
  },
}
