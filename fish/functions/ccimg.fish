function ccimg --description "Upload the Mac clipboard image to homeserver and copy the remote path for pasting into remote Claude Code"
    # Host defaults to the same target as ccssh, but allow an override as the first argument.
    set -l remote_host isaaclins@homeserver
    if test (count $argv) -ge 1
        set remote_host $argv[1]
    end

    # pngpaste is required to read the image out of the macOS clipboard.
    if not command -v pngpaste >/dev/null 2>&1
        echo "ccimg: pngpaste is not installed. Run: brew install pngpaste"
        return 1
    end

    # Create a local temp file with a unique basename we can reuse for the remote name.
    set -l local_tmp (mktemp /tmp/ccimg-XXXXXXXX.png)
    set -l remote_path "/tmp/"(basename $local_tmp)

    # Extract the clipboard image into the temp file. pngpaste fails when there is no image.
    if not pngpaste $local_tmp >/dev/null 2>&1
        echo "ccimg: no image found in clipboard"
        rm -f $local_tmp
        return 1
    end

    # Upload quietly to the remote host.
    if not scp -q $local_tmp "$remote_host:$remote_path"
        echo "ccimg: scp upload to $remote_host failed"
        rm -f $local_tmp
        return 1
    end

    # Put the remote path on the local clipboard so it can be pasted as plain text over SSH.
    printf '%s' $remote_path | pbcopy
    rm -f $local_tmp
    echo "ccimg: uploaded to $remote_path (path copied to clipboard, paste it into Claude)"
end
