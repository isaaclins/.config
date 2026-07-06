# ~/.config/fish/functions/togglehidden.fish
# Purpose: Toggle Finder's display of hidden files (dotfiles) on or off.
# Usage: togglehidden
function togglehidden --description 'Toggle showing hidden files in Finder'
    set -l current (defaults read com.apple.finder AppleShowAllFiles 2>/dev/null)

    set -l next true
    switch "$current"
        case 1 YES TRUE true
            set next false
    end

    defaults write com.apple.finder AppleShowAllFiles -bool $next
    killall Finder

    if test "$next" = true
        echo "Finder: hidden files shown"
    else
        echo "Finder: hidden files hidden"
    end
end
