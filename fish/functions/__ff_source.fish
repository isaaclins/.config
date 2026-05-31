function __ff_source --description 'ff source: cached fd list, fzf --filter for fuzzy, rg for "quoted" content search'
    set -l query $argv[1]
    set -l root $argv[2]
    set -l cache $argv[3]

    if not test -s $cache
        fd --hidden \
            --exclude .git --exclude node_modules --exclude .venv \
            --exclude target --exclude dist --exclude build \
            --exclude .next --exclude .turbo --exclude .cache \
            . $root >$cache 2>/dev/null
    end

    if string match -qr '^".+"$' -- $query
        set -l term (string sub -s 2 -e -1 -- $query)
        rg --hidden --files-with-matches --smart-case --color=never \
            --glob='!.git' --glob='!node_modules' --glob='!.venv' \
            --glob='!target' --glob='!dist' --glob='!build' \
            --glob='!.next' --glob='!.turbo' --glob='!.cache' \
            -- $term $root 2>/dev/null
    else if test -z "$query"
        cat $cache
    else
        fzf --filter=$query <$cache
    end
end
