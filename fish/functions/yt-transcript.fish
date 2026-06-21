function yt-transcript --description 'Download a clean plain-text transcript of a YouTube video'
    if test (count $argv) -eq 0
        echo "Usage: yt-transcript <youtube-url> [lang]   (lang defaults to 'en')" >&2
        return 1
    end

    set -l url $argv[1]
    set -l lang en
    test (count $argv) -ge 2; and set lang $argv[2]

    set -l tmp (mktemp -d)

    # Subtitles only (manual + auto-generated), no video, as VTT.
    yt-dlp --skip-download \
        --write-subs --write-auto-subs \
        --sub-langs $lang --sub-format vtt \
        --no-warnings \
        -o "$tmp/%(title)s.%(ext)s" \
        $url

    set -l vtt (find $tmp -name '*.vtt' | head -n1)
    if test -z "$vtt"
        echo "No '$lang' subtitles available for that video." >&2
        rm -rf $tmp
        return 1
    end

    # Output next to where you ran the command.
    set -l out (basename $vtt .vtt).txt

    # VTT -> clean text: drop headers/timestamps, strip inline tags,
    # trim whitespace, drop blanks, collapse the rolling-caption duplicates.
    sed -E -e '/-->/d' -e '/^WEBVTT/d' -e '/^(Kind|Language):/d' \
           -e 's/<[^>]*>//g' -e 's/^[[:space:]]+//' -e 's/[[:space:]]+$//' \
           -e '/^$/d' $vtt \
        | awk '!seen[$0]++' >$out

    rm -rf $tmp
    echo "Saved transcript -> $out"
end
