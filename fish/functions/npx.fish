function npx --description "Passthrough wrapper for npx that reroutes `npx skills ...` through the `skills` fish function, so global installs land in the canonical store (~/.config/agents/skills via the ~/.agents/skills symlink). All other npx usage is forwarded unchanged."
    # Only intercept when the FIRST argument is `skills` or a pinned form like
    # `skills@latest`. Drop that token and hand the rest to the `skills`
    # function, which injects -g and honours --project. Because skills.fish calls
    # `command npx` (not the function), there is no recursion.
    #
    # Known limitation: this only matches when `skills` is the FIRST argument.
    # `npx --yes skills ...` (flags before the package name) is NOT intercepted
    # and falls through to plain npx.
    set -l first $argv[1]
    if test "$first" = skills; or string match -q 'skills@*' -- "$first"
        skills $argv[2..-1]
        return $status
    end

    command npx $argv
end
