function prettier --description "Project-first Prettier with fallback config and message"
    # path to your personal global config
    set CONFIG "$HOME/.config/prettier/global.prettier.config.js"
    set -l IGNORE_ARGS

    # if .gitignore exists, let Prettier use it as default ignore list
    if test -f .gitignore
        set IGNORE_ARGS --ignore-path .gitignore
    end

    # check if a project-local prettier exists
    set LOCAL_FOUND 0
    if test -f package.json
        # optionally check node_modules/.bin/prettier exists too
        if test -x "node_modules/.bin/prettier"
            set LOCAL_FOUND 1
        end
    end

    if test $LOCAL_FOUND -eq 1
        # local Prettier exists, use it
        pnpm exec prettier \
            --config $CONFIG \
            --config-precedence prefer-file \
            $IGNORE_ARGS \
            $argv
    else
        # no local prettier, print friendly message
        echo "⚠️  No project-local Prettier found, using global fallback..."
        pnpm dlx prettier \
            --config $CONFIG \
            --config-precedence prefer-file \
            $IGNORE_ARGS \
            $argv
    end
end