# ~/.config/fish/conf.d/java.fish
# Purpose: Re-apply persisted Java formula selection for interactive fish shells.
# Usage: Auto-loaded by fish; `setjava <version>` persists default unless `--session` is used.
if status is-interactive
    set -l java_default
    set -l default_file (__java_default_file)

    if set -q __setjava_default_formula
        set java_default "$__setjava_default_formula"
    else if test -r "$default_file"
        set java_default (head -n1 "$default_file" | string trim)
        if test -n "$java_default"
            set -U __setjava_default_formula "$java_default" 2>/dev/null
        end
    end

    if test -n "$java_default"
        __java_activate --quiet "$java_default" >/dev/null 2>/dev/null
        if test $status -ne 0
            echo "setjava: saved default '$java_default' could not be activated; run 'setjava list'." >&2
        end
    end
end
