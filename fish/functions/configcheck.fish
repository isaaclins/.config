function configcheck --description 'shellcheck bootstrap.sh and every script under ~/.config/bootstrap'
    if not command -q shellcheck
        echo "shellcheck not found. Install it with: brew install shellcheck"
        return 1
    end
    set -l root ~/.config
    shellcheck $root/bootstrap.sh
    and find $root/bootstrap -type f -name '*.sh' -print0 | xargs -0 shellcheck
end
