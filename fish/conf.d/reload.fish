# ~/.config/fish/conf.d/reload.fish
# Purpose: Adds `reload_fish` to reload both `conf.d/*.fish` and `config.fish` in the current session.
# Usage: Run `reload_fish` (or abbreviation `r`) after editing fish config files.
function reload_fish --description 'Reload fish conf.d and config.fish'
    for f in ~/.config/fish/conf.d/*.fish
        source $f
    end

    source ~/.config/fish/config.fish
    echo "Fish config reloaded (conf.d + config.fish)."
end

