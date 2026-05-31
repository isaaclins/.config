function zoxide --description "Wrapper: bare 'zoxide edit' prints the selected path on Enter"
    if test (count $argv) -eq 1; and test "$argv[1]" = "edit"
        __zoxide_edit_interactive
        return 0
    end
    command zoxide $argv
end
