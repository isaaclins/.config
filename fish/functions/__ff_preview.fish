function __ff_preview --description "Preview helper for ff: tre for dirs, bat for files"
    set -l path $argv[1]
    if test -d $path
        tre -a -c always -l 3 $path 2>/dev/null
    else if test -f $path
        bat --color=always --style=numbers,changes --line-range=:200 -- $path 2>/dev/null
        or cat -- $path 2>/dev/null
    end
end
