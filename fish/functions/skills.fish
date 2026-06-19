function skills --description "Wrapper for `npx skills@latest` that defaults `add`/`remove`/`update`/`list` to --global so installs land in $CLAUDE_CONFIG_DIR (~/.config/agents/claude/skills -> ~/.config/agents/skills) and sync via dotfiles. Pass `--project` (or `-p`) to override and install project-locally."
    set -l args $argv

    # Strip a leading `--project` / `-p` so we can use it as an opt-out without
    # forwarding it to `npx skills`, which doesn't recognise it on `add`.
    set -l want_project 0
    set -l filtered
    for a in $args
        switch $a
            case --project -p
                set want_project 1
            case '*'
                set filtered $filtered $a
        end
    end
    set args $filtered

    # Inject -g unless: user opted out, already passed -g/--global, or running a
    # subcommand where global makes no sense (init, experimental_*, find, etc.).
    if test $want_project -eq 0
        set -l sub $args[1]
        switch $sub
            case add a remove rm update upgrade list ls
                if not contains -- -g $args; and not contains -- --global $args
                    set args $args[1] -g $args[2..-1]
                end
        end
    end

    command npx -y skills@latest $args
end
