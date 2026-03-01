# ~/.config/fish/conf.d/zoxide.fish
# Purpose: Initializes zoxide and maps `cd` to zoxide's smart directory jump behavior.
# Usage: Auto-loaded in new fish shells; run `exec fish` after edits to apply.
if status is-interactive
    if type -q zoxide
        zoxide init fish --cmd cd | source
    end
end
