function __zoxide_edit_interactive --description "zoxide edit: Enter=print path, Alt-Enter/Ctrl-O=cd"
    set -l raw (fzf --expect=alt-enter,ctrl-o --read0 --delimiter=\t \
        --exact --no-sort --cycle --keep-right \
        --border=sharp \
        --border-label='  zoxide-edit  ' \
        --header='enter:print     alt-enter/ctrl-o:cd
ctrl-r:reload   ctrl-d:delete
ctrl-w:increment ctrl-s:decrement

 SCORE	PATH' \
        --info=inline --layout=reverse --padding=1,0,0,0 \
        --color=label:bold --tabstop=1 \
        --bind='tab:down,btab:up,ctrl-z:ignore,double-click:ignore' \
        --bind='start:reload(command zoxide edit reload)' \
        --bind='ctrl-r:reload(command zoxide edit reload)' \
        --bind='ctrl-d:reload(command zoxide edit delete {2..})' \
        --bind='ctrl-w:reload(command zoxide edit increment {2..})' \
        --bind='ctrl-s:reload(command zoxide edit decrement {2..})' \
        < /dev/null | string collect --allow-empty)
    test -z "$raw"; and return 0
    set -l lines (string split \n -- $raw)
    set -l key $lines[1]
    set -l line $lines[2]
    test -z "$line"; and return 0
    set -l target (string split -m 1 \t -- $line)[2]
    test -z "$target"; and return 0
    switch $key
        case alt-enter ctrl-o
            cd $target
        case '*'
            echo $target
    end
end
