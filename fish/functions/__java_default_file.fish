# ~/.config/fish/functions/__java_default_file.fish
# Purpose: Return the persisted Java default state file path.
# Usage: Internal helper for Java persistence across sessions.
function __java_default_file --description "Print Java default state file path"
    echo "$HOME/.config/.java-default"
end
