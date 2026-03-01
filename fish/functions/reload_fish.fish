# ~/.config/fish/functions/reload_fish.fish
# Purpose: Reloads all `conf.d/*.fish` snippets and `config.fish` in the current shell session.
# Usage: Autoloaded on first call; run `reload_fish` after editing startup files without opening a new terminal.
function reload_fish --description 'Reload fish conf.d and config.fish'
    for f in ~/.config/fish/conf.d/*.fish
        source $f
    end

    source ~/.config/fish/config.fish
    echo "Fish config reloaded (conf.d + config.fish)."
end
