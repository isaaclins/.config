# ~/.config/fish/conf.d/fzf.fish
# Purpose: Initialize fzf key bindings (Ctrl-T file, Alt-C cd; Ctrl-R is overridden by atuin).
# Usage: Auto-loaded; reload with `exec fish`. Tokyo Night palette is applied via FZF_DEFAULT_OPTS.
if type -q fzf
    set -gx FZF_DEFAULT_OPTS '--height=40% --layout=reverse --border --color=bg+:#283457,bg:#1a1b26,spinner:#bb9af7,hl:#7aa2f7,fg:#c0caf5,header:#7aa2f7,info:#bb9af7,pointer:#7dcfff,marker:#9ece6a,fg+:#c0caf5,prompt:#7dcfff,hl+:#bb9af7'
    if type -q fd
        set -gx FZF_DEFAULT_COMMAND 'fd --type f --hidden --follow --exclude .git'
        set -gx FZF_CTRL_T_COMMAND "$FZF_DEFAULT_COMMAND"
        set -gx FZF_ALT_C_COMMAND 'fd --type d --hidden --follow --exclude .git'
    end
    fzf --fish | source
end
