function ff --description "Fuzzy-find files and dirs (pretty); quoted query searches file contents"
    set -l root .
    test (count $argv) -ge 1; and set root $argv[1]
    if not test -d $root
        echo "ff: not a directory: $root" >&2
        return 1
    end

    set -l cache (mktemp -t ff.XXXXXX)
    set -l target (
        fzf --disabled \
            --height=~80% \
            --no-mouse \
            --prompt='ff> ' \
            --border=sharp \
            --border-label='  ff  ' \
            --header='enter:open    "term":search file contents
ctrl-/:toggle preview    ctrl-r:rebuild cache' \
            --info=inline \
            --layout=reverse \
            --padding=1,0,0,0 \
            --color=label:bold \
            --preview='__ff_preview {}' \
            --preview-window='right,60%,border-sharp,wrap' \
            --bind='ctrl-/:toggle-preview' \
            --bind='tab:down,btab:up' \
            --bind="start:reload(__ff_source '' '$root' '$cache')" \
            --bind="change:reload(__ff_source {q} '$root' '$cache')" \
            --bind="ctrl-r:reload(rm -f '$cache'; __ff_source {q} '$root' '$cache')" \
            </dev/null
    )
    rm -f $cache
    test -z "$target"; and return 0

    if test -d $target
        cd $target
    else
        set -l editor vim
        test -n "$EDITOR"; and set editor $EDITOR
        $editor $target
    end
end
