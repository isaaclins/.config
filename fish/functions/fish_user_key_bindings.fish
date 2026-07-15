# ~/.config/fish/functions/fish_user_key_bindings.fish
# Purpose: Custom interactive key bindings, autoloaded by fish.

function fish_user_key_bindings
    # Ghostty forwards cmd+w as the two-key sequence ctrl+b x (see
    # ghostty/config). Inside tmux that kills the focused pane before the
    # shell ever sees it. Outside tmux the sequence reaches fish, where it
    # should mean "close this Ghostty window", with a confirmation prompt.
    bind ctrl-b,x __confirm_close_window
end

function __confirm_close_window
    # Repaint a clean line, ask, and exit the shell on confirmation.
    # Ghostty closes the window when its child process exits.
    commandline -f repaint
    echo
    read -l -P "Close this window? [y/N] " answer
    if string match -qi 'y*' -- $answer
        exit
    end
    commandline -f repaint
end
