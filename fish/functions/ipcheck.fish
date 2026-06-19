# ~/.config/fish/functions/ipcheck.fish
# Purpose: Aggregate IP intelligence (geo, proxy/VPN/Tor/hosting, VirusTotal, AbuseIPDB)
#          plus a set of per-IP reference links to open in the browser.
# Usage: ipcheck [-m|--markdown] [-j|--json] [-x|--no-links] [-c|--copy] [ip ...]   (no arg = your own public IP)
function ipcheck --description 'Aggregate IP intelligence (geo, proxy/VPN/Tor/hosting, VT, AbuseIPDB) + reference links'
    # --- dependencies -----------------------------------------------------
    if not command -q curl
        echo "ipcheck: requires 'curl' (not found in PATH)." >&2
        return 127
    end
    if not command -q jq
        echo "ipcheck: requires 'jq' (not found in PATH)." >&2
        return 127
    end

    # --- help -------------------------------------------------------------
    if contains -- -h $argv; or contains -- --help $argv
        echo "Usage: ipcheck [-m|--markdown] [-j|--json] [-x|--no-links] [-c|--copy] [ip ...]"
        echo "       (no arg = your own public IP)"
        echo
        echo "Aggregates IP intelligence into a compact report:"
        echo "  - Geolocation (country/region/city/ISP/ASN/reverse) via ip-api.com   [keyless]"
        echo "  - Proxy / VPN / Tor / hosting + risk via proxycheck.io               [keyless, 100/day]"
        echo "  - VirusTotal reputation        (set IPCHECK_VIRUSTOTAL_KEY)          [optional]"
        echo "  - AbuseIPDB abuse reports      (set IPCHECK_ABUSEIPDB_KEY)           [optional]"
        echo "  - Reference links per IP (VirusTotal, AbuseIPDB, GreyNoise, Talos, Tor,"
        echo "    Shodan, Censys, Scamalytics, IPinfo, BGP, blacklists) — cmd-click to open"
        echo
        echo "Output flags (compose; -m and -j are mutually exclusive):"
        echo "  -m, --markdown   emit a clean Markdown report instead of the colored TTY report"
        echo "  -j, --json       emit structured JSON instead of the colored TTY report"
        echo "  -x, --no-links   omit the reference-links section (works in all modes)"
        echo "  -c, --copy       also copy the report to the clipboard (composes with all modes)"
        echo
        echo "proxycheck limit can be raised with IPCHECK_PROXYCHECK_KEY (optional)."
        echo "Put keys in $__fish_config_dir/ipcheck-keys.local.fish (gitignored)."
        return 0
    end

    # --- parse output flags ----------------------------------------------
    set -l out_mode pretty
    set -l show_links 1
    set -l do_copy 0
    set -l saw_md 0
    set -l saw_json 0
    set -l rest
    for tok in $argv
        switch $tok
            case -m --markdown
                set saw_md 1
                set out_mode markdown
            case -j --json
                set saw_json 1
                set out_mode json
            case -x --no-links
                set show_links 0
            case -c --copy
                set do_copy 1
            case '*'
                set -a rest $tok
        end
    end
    if test $saw_md -eq 1; and test $saw_json -eq 1
        echo "ipcheck: --markdown and --json are mutually exclusive" >&2
        return 2
    end

    # --- palette (Tokyo Night) -------------------------------------------
    set -l c_blue 7aa2f7
    set -l c_green 9ece6a
    set -l c_yellow e0af68
    set -l c_orange ff9e64
    set -l c_red f7768e
    set -l c_dim 565f89
    set -l c_fg c0caf5

    # --- color helpers (respect NO_COLOR) --------------------------------
    # __ipcheck_col <hex> : begin a color (bold), no-op if NO_COLOR set
    # __ipcheck_rst       : reset, no-op if NO_COLOR set
    function __ipcheck_col --no-scope-shadowing
        set -q NO_COLOR; and return 0
        set_color -o $argv[1]
    end
    function __ipcheck_rst --no-scope-shadowing
        set -q NO_COLOR; and return 0
        set_color normal
    end

    # --- resolve target IPs ----------------------------------------------
    set -l ips
    set -l had_error 0
    set -l json_objs

    if test (count $rest) -eq 0
        set -l myip (command curl -fsS https://api.ipify.org 2>/dev/null)
        if test -z "$myip"
            set myip (command curl -fsS https://ifconfig.me/ip 2>/dev/null | string trim)
        end
        if test -z "$myip"
            echo "ipcheck: could not determine your public IP (both ipify and ifconfig.me failed)." >&2
            return 1
        end
        if test "$out_mode" = pretty
            __ipcheck_col $c_blue
            echo -n "Your public IP: "
            __ipcheck_col $c_fg
            echo $myip
            __ipcheck_rst
            echo
        end
        set ips $myip
    else
        set ips $rest
    end

    # --- choose output sink ----------------------------------------------
    # Default: stream straight to the terminal exactly like today.
    # Copy mode: redirect the whole render to a temp file so we can both
    # cat it to the terminal and pipe an ANSI-stripped copy to the clipboard.
    # A redirected `begin ... end` block does NOT fork in fish, so had_error,
    # json_objs, ips and first written inside still persist (unlike a pipeline).
    set -l sink /dev/stdout
    set -l tmp ""
    if test $do_copy -eq 1
        set tmp (command mktemp -t ipcheck.XXXXXX)
        set sink $tmp
    end

    # --- per-IP report ----------------------------------------------------
    set -l first 1
    begin
        for ip in $ips
            # validation: IPv4 (strict octets) or permissive IPv6 heuristic
            set -l valid 0
            if string match -rq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' -- "$ip"
                set -l ok 1
                for oct in (string split '.' -- "$ip")
                    if test "$oct" -gt 255 2>/dev/null
                        set ok 0
                    end
                end
                test $ok -eq 1; and set valid 1
            else if string match -rq '^[0-9A-Fa-f:]+:[0-9A-Fa-f:]+$' -- "$ip"
                set valid 1
            end

            if test $valid -eq 0
                echo "ipcheck: invalid IP '$ip'" >&2
                set had_error 1
                continue
            end

            # separator between blocks
            if test "$out_mode" = pretty
                if test $first -eq 0
                    __ipcheck_col $c_dim
                    echo "  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄"
                    __ipcheck_rst
                end
            end
            set first 0

            # ---- header rule (fixed ~54 wide) -------------------------------
            if test "$out_mode" = pretty
                set -l prefix "━━ $ip "
                set -l fill (math 54 - (string length -- "$prefix"))
                test $fill -lt 3; and set fill 3
                set -l tail (string repeat -n $fill '━')
                __ipcheck_col $c_blue
                echo "$prefix$tail"
                __ipcheck_rst
                echo
            end

            # ================= A) ip-api.com (geo) =======================
            set -l geo_ok 0
            set -l g_country ""; set -l g_cc ""; set -l g_region ""; set -l g_city ""
            set -l g_isp ""; set -l g_org ""; set -l g_as ""; set -l g_reverse ""
            set -l g_mobile ""; set -l g_proxy ""; set -l g_hosting ""

            set -l geo_raw (command curl -fsS "http://ip-api.com/json/$ip?fields=status,message,country,countryCode,regionName,city,isp,org,as,asname,reverse,mobile,proxy,hosting,query" 2>/dev/null)
            if test -n "$geo_raw"
                set -l gstatus (printf '%s' "$geo_raw" | command jq -r '.status // empty' 2>/dev/null)
                if test "$gstatus" = "success"
                    set geo_ok 1
                    set -l gtsv (printf '%s' "$geo_raw" | command jq -r '[.country // "", .countryCode // "", .regionName // "", .city // "", .isp // "", .org // "", .as // "", .reverse // "", (.mobile|tostring), (.proxy|tostring), (.hosting|tostring)] | @tsv' 2>/dev/null)
                    set -l gf (string split \t -- "$gtsv")
                    set g_country $gf[1]; set g_cc $gf[2]; set g_region $gf[3]; set g_city $gf[4]
                    set g_isp $gf[5]; set g_org $gf[6]; set g_as $gf[7]; set g_reverse $gf[8]
                    set g_mobile $gf[9]; set g_proxy $gf[10]; set g_hosting $gf[11]
                else
                    set -l gmsg (printf '%s' "$geo_raw" | command jq -r '.message // "lookup failed"' 2>/dev/null)
                    if test "$out_mode" = pretty
                        __ipcheck_col $c_dim
                        echo "  ip-api: $gmsg (geolocation unavailable)"
                        __ipcheck_rst
                    end
                end
            else
                if test "$out_mode" = pretty
                    __ipcheck_col $c_dim
                    echo "  ip-api: request failed (geolocation unavailable)"
                    __ipcheck_rst
                end
            end

            # ---- geo rows ---------------------------------------------------
            if test "$out_mode" = pretty; and test $geo_ok -eq 1
                # Location = city, regionName, country (CC)
                set -l locparts
                test -n "$g_city"; and set -a locparts "$g_city"
                test -n "$g_region"; and set -a locparts "$g_region"
                test -n "$g_country"; and set -a locparts "$g_country"
                set -l loc (string join ", " $locparts)
                test -n "$g_cc"; and set loc "$loc ($g_cc)"
                test -z "$loc"; and set loc "—"
                __ipcheck_row $c_blue $c_fg "Location" "$loc"

                test -n "$g_isp"; and __ipcheck_row $c_blue $c_fg "ISP" "$g_isp"
                test -n "$g_org"; and __ipcheck_row $c_blue $c_fg "Org" "$g_org"
                test -n "$g_as"; and __ipcheck_row $c_blue $c_fg "ASN" "$g_as"
                set -l rev "$g_reverse"
                test -z "$rev"; and set rev "—"
                __ipcheck_row $c_blue $c_fg "Reverse" "$rev"
            end

            # ================= B) proxycheck.io ==========================
            set -l pc_ok 0
            set -l pc_proxy ""; set -l pc_type ""; set -l pc_risk ""
            set -l pc_url "https://proxycheck.io/v2/$ip?vpn=1&asn=1&risk=1"
            if set -q IPCHECK_PROXYCHECK_KEY; and test -n "$IPCHECK_PROXYCHECK_KEY"
                set pc_url "$pc_url&key=$IPCHECK_PROXYCHECK_KEY"
            end
            set -l pc_raw (command curl -fsS "$pc_url" 2>/dev/null)
            if test -n "$pc_raw"
                set -l pcstatus (printf '%s' "$pc_raw" | command jq -r '.status // empty' 2>/dev/null)
                if test "$pcstatus" = "ok"
                    set -l ptsv (printf '%s' "$pc_raw" | command jq -r --arg ip "$ip" '(.[$ip] // {}) | [(.proxy // ""), (.type // ""), ((.risk // 0)|tostring)] | @tsv' 2>/dev/null)
                    set -l pf (string split \t -- "$ptsv")
                    set pc_proxy $pf[1]; set pc_type $pf[2]; set pc_risk $pf[3]
                    set pc_ok 1
                end
            end

            # blank line before flags section
            if test "$out_mode" = pretty
                echo
            end

            # ---- compute flag verdicts -------------------------------------
            # proxy
            set -l v_proxy "no"; set -l v_proxy_danger 0
            if test $pc_ok -eq 1
                if test "$pc_proxy" = "yes"
                    set v_proxy "yes"; set v_proxy_danger 1
                end
            else if test "$g_proxy" = "true"
                set v_proxy "yes"; set v_proxy_danger 1
            end

            # vpn / tor
            set -l v_vpn ""; set -l v_vpn_danger 0
            set -l v_tor ""; set -l v_tor_danger 0
            if test $pc_ok -eq 1
                if test "$pc_type" = "VPN"
                    set v_vpn "yes"; set v_vpn_danger 1
                else
                    set v_vpn "no"
                end
                if test "$pc_type" = "TOR"
                    set v_tor "yes"; set v_tor_danger 1
                else
                    set v_tor "no"
                end
            else
                set v_vpn "unknown (proxycheck unavailable)"
                set v_tor "unknown (proxycheck unavailable)"
            end

            # hosting/DC : ip-api .hosting OR proxycheck type contains Hosting
            set -l v_hosting "no"; set -l v_hosting_flag 0
            if test "$g_hosting" = "true"
                set v_hosting "yes"; set v_hosting_flag 1
            else if test $pc_ok -eq 1; and string match -qi '*Hosting*' -- "$pc_type"
                set v_hosting "yes"; set v_hosting_flag 1
            end

            # mobile (ip-api only)
            set -l v_mobile "no"
            test "$g_mobile" = "true"; and set v_mobile "yes"

            # risk
            set -l v_risk ""
            if test $pc_ok -eq 1
                set v_risk $pc_risk
            end

            # ---- flag rows --------------------------------------------------
            if test "$out_mode" = pretty
                __ipcheck_bool_row $c_blue "x" "Proxy" "$v_proxy" $v_proxy_danger 0
                # VPN
                if test "$v_vpn" = "unknown (proxycheck unavailable)"
                    __ipcheck_row $c_blue $c_dim "VPN" "$v_vpn"
                else
                    __ipcheck_bool_row $c_blue "x" "VPN" "$v_vpn" $v_vpn_danger 0
                end
                # Tor
                if test "$v_tor" = "unknown (proxycheck unavailable)"
                    __ipcheck_row $c_blue $c_dim "Tor" "$v_tor"
                else
                    __ipcheck_bool_row $c_blue "x" "Tor" "$v_tor" $v_tor_danger 0
                end
                # Hosting/DC (orange when yes)
                __ipcheck_bool_row $c_blue "x" "Hosting/DC" "$v_hosting" 0 $v_hosting_flag
                # Mobile
                __ipcheck_bool_row $c_blue "x" "Mobile" "$v_mobile" 0 0

                # Risk row (colored by threshold)
                if test -n "$v_risk"
                    set -l risk_col $c_green
                    if test "$v_risk" -ge 66 2>/dev/null
                        set risk_col $c_red
                    else if test "$v_risk" -ge 33 2>/dev/null
                        set risk_col $c_orange
                    else if test "$v_risk" -ge 1 2>/dev/null
                        set risk_col $c_yellow
                    end
                    __ipcheck_row $c_blue $risk_col "Risk" "$v_risk/100"
                else if test $pc_ok -eq 0
                    __ipcheck_col $c_dim
                    echo "  proxycheck: rate-limited/unavailable"
                    __ipcheck_rst
                end
            end

            # ================= C) VirusTotal =============================
            if test "$out_mode" = pretty
                echo
            end
            set -l vt_malicious -1   # -1 = did not run / unknown
            set -l vt_suspicious -1
            set -l vt_harmless -1
            set -l vt_undetected -1
            set -l vt_reputation 0
            set -l vt_state skipped
            if set -q IPCHECK_VIRUSTOTAL_KEY; and test -n "$IPCHECK_VIRUSTOTAL_KEY"
                set -l vt_body (command curl -fsS "https://www.virustotal.com/api/v3/ip_addresses/$ip" -H "x-apikey: $IPCHECK_VIRUSTOTAL_KEY" 2>/dev/null)
                if test -z "$vt_body"
                    set vt_state error
                    if test "$out_mode" = pretty
                        __ipcheck_col $c_blue; printf "  %-13s" "VirusTotal"; __ipcheck_rst
                        __ipcheck_col $c_dim; echo "error (bad key / rate limit / network)"; __ipcheck_rst
                    end
                else
                    set -l vtsv (printf '%s' "$vt_body" | command jq -r '(.data.attributes.last_analysis_stats // {}) as $s | [($s.malicious // 0), ($s.suspicious // 0), ($s.harmless // 0), ($s.undetected // 0), (.data.attributes.reputation // 0)] | @tsv' 2>/dev/null)
                    if test -z "$vtsv"
                        set vt_state error
                        # likely an error JSON (401/429) — surface the message
                        set -l vterr (printf '%s' "$vt_body" | command jq -r '.error.message // "unavailable"' 2>/dev/null)
                        if test "$out_mode" = pretty
                            __ipcheck_col $c_blue; printf "  %-13s" "VirusTotal"; __ipcheck_rst
                            __ipcheck_col $c_dim; echo "$vterr"; __ipcheck_rst
                        end
                    else
                        set vt_state ok
                        set -l vf (string split \t -- "$vtsv")
                        set -l mal $vf[1]; set -l sus $vf[2]; set -l harm $vf[3]; set -l und $vf[4]; set -l rep $vf[5]
                        set vt_malicious $mal
                        set vt_suspicious $sus
                        set vt_harmless $harm
                        set vt_undetected $und
                        set vt_reputation $rep
                        set -l flagged (math "$mal + $sus")
                        set -l total (math "$mal + $sus + $harm + $und")
                        if test "$out_mode" = pretty
                            __ipcheck_col $c_blue; printf "  %-13s" "VirusTotal"; __ipcheck_rst
                            if test $flagged -eq 0
                                __ipcheck_col $c_green; echo -n "clean"; __ipcheck_rst
                                __ipcheck_col $c_fg; echo " ($total engines)"; __ipcheck_rst
                            else
                                if test $flagged -ge 5
                                    __ipcheck_col $c_red
                                else
                                    __ipcheck_col $c_orange
                                end
                                echo -n "flagged by $flagged engines"; __ipcheck_rst
                                __ipcheck_col $c_fg; echo " · reputation $rep"; __ipcheck_rst
                            end
                        end
                    end
                end
            else
                if test "$out_mode" = pretty
                    __ipcheck_col $c_blue; printf "  %-13s" "VirusTotal"; __ipcheck_rst
                    __ipcheck_col $c_dim; echo "skipped (set IPCHECK_VIRUSTOTAL_KEY)"; __ipcheck_rst
                end
            end

            # ================= D) AbuseIPDB ==============================
            set -l ab_score -1   # -1 = did not run / unknown
            set -l ab_reports -1
            set -l ab_last ""
            set -l ab_usage ""
            set -l ab_state skipped
            if set -q IPCHECK_ABUSEIPDB_KEY; and test -n "$IPCHECK_ABUSEIPDB_KEY"
                set -l ab_body (command curl -fsS -G "https://api.abuseipdb.com/api/v2/check" --data-urlencode "ipAddress=$ip" --data-urlencode "maxAgeInDays=90" -H "Key: $IPCHECK_ABUSEIPDB_KEY" -H "Accept: application/json" 2>/dev/null)
                if test -z "$ab_body"
                    set ab_state error
                    if test "$out_mode" = pretty
                        __ipcheck_col $c_blue; printf "  %-13s" "AbuseIPDB"; __ipcheck_rst
                        __ipcheck_col $c_dim; echo "error (bad key / rate limit / network)"; __ipcheck_rst
                    end
                else
                    set -l atsv (printf '%s' "$ab_body" | command jq -r '(.data // {}) as $d | (if ($d|has("abuseConfidenceScore")) then [($d.abuseConfidenceScore), ($d.totalReports // 0), ($d.lastReportedAt // ""), ($d.usageType // "")] else empty end) | @tsv' 2>/dev/null)
                    if test -z "$atsv"
                        set ab_state error
                        set -l aberr (printf '%s' "$ab_body" | command jq -r '(.errors[0].detail // "unavailable")' 2>/dev/null)
                        if test "$out_mode" = pretty
                            __ipcheck_col $c_blue; printf "  %-13s" "AbuseIPDB"; __ipcheck_rst
                            __ipcheck_col $c_dim; echo "$aberr"; __ipcheck_rst
                        end
                    else
                        set ab_state ok
                        set -l af (string split \t -- "$atsv")
                        set -l score $af[1]; set -l reports $af[2]; set -l usage $af[4]
                        set ab_score $score
                        set ab_reports $reports
                        set ab_last $af[3]
                        test -z "$usage"; and set usage "unknown"
                        set ab_usage $usage
                        set -l ab_col $c_green
                        if test "$score" -ge 100 2>/dev/null
                            set ab_col $c_red
                        else if test "$score" -ge 25 2>/dev/null
                            set ab_col $c_orange
                        else if test "$score" -ge 1 2>/dev/null
                            set ab_col $c_yellow
                        end
                        if test "$out_mode" = pretty
                            __ipcheck_col $c_blue; printf "  %-13s" "AbuseIPDB"; __ipcheck_rst
                            __ipcheck_col $ab_col; echo "score $score/100 · $reports reports · $usage"; __ipcheck_rst
                        end
                    end
                end
            else
                if test "$out_mode" = pretty
                    __ipcheck_col $c_blue; printf "  %-13s" "AbuseIPDB"; __ipcheck_rst
                    __ipcheck_col $c_dim; echo "skipped (set IPCHECK_ABUSEIPDB_KEY)"; __ipcheck_rst
                end
            end

            # ================= Verdict ===================================
            if test "$out_mode" = pretty
                echo
            end
            set -l reasons
            set -l level 0   # 0 clean, 1 caution, 2 malicious

            # malicious triggers
            if test "$vt_malicious" -gt 0 2>/dev/null
                set level 2; set -a reasons "VirusTotal hits"
            end
            if test "$ab_score" -ge 25 2>/dev/null
                set level 2; set -a reasons "abuse reports"
            end
            if test "$v_tor" = "yes"
                set level 2; set -a reasons "Tor"
            end

            # caution triggers (only escalate to 1 if not already 2)
            if test $level -lt 2
                if test "$v_proxy" = "yes"
                    set level 1; set -a reasons "proxy"
                end
                if test "$v_vpn" = "yes"
                    set level 1; set -a reasons "VPN"
                end
                if test -n "$v_risk"; and test "$v_risk" -ge 33 2>/dev/null
                    set level 1; set -a reasons "elevated risk"
                end
                if test "$ab_score" -ge 1 2>/dev/null; and test "$ab_score" -lt 25 2>/dev/null
                    set level 1; set -a reasons "minor abuse reports"
                end
            end

            # benign context note
            if test $level -eq 0; and test "$v_hosting" = "yes"
                set -a reasons "hosting/datacenter"
            end

            # plain (no-glyph) verdict word for markdown / json
            set -l verdict_word clean
            switch $level
                case 2
                    set verdict_word malicious
                case 1
                    set verdict_word caution
                case '*'
                    set verdict_word clean
            end

            if test "$out_mode" = pretty
                set -l verdict_text
                set -l verdict_col
                switch $level
                    case 2
                        set verdict_col $c_red
                        set verdict_text "⚠ malicious"
                    case 1
                        set verdict_col $c_orange
                        set verdict_text "⚠ caution"
                    case '*'
                        set verdict_col $c_green
                        set verdict_text "✓ clean"
                end

                set -l paren ""
                if test (count $reasons) -gt 0
                    set paren " ("(string join " + " $reasons)")"
                end

                __ipcheck_col $c_blue; printf "  %-13s" "Verdict"; __ipcheck_rst
                __ipcheck_col $verdict_col; echo -n "$verdict_text"; __ipcheck_rst
                if test -n "$paren"
                    __ipcheck_col $c_fg; echo "$paren"; __ipcheck_rst
                else
                    echo
                end
            end

            # ================= Reference links ===========================
            # Printed (not auto-opened) so you cmd-click only the ones you want.
            if test "$out_mode" = pretty; and test $show_links -eq 1
                echo
                __ipcheck_col $c_blue; echo "  Links"; __ipcheck_rst
                # reputation
                __ipcheck_row $c_blue $c_fg "VirusTotal" "https://www.virustotal.com/gui/ip-address/$ip"
                __ipcheck_row $c_blue $c_fg "AbuseIPDB" "https://www.abuseipdb.com/check/$ip"
                __ipcheck_row $c_blue $c_fg "GreyNoise" "https://viz.greynoise.io/ip/$ip"
                __ipcheck_row $c_blue $c_fg "Talos" "https://talosintelligence.com/reputation_center/lookup?search=$ip"
                # tor
                __ipcheck_row $c_blue $c_fg "Tor Relay" "https://metrics.torproject.org/rs.html#search/$ip"
                __ipcheck_row $c_blue $c_fg "ExoneraTor" "https://metrics.torproject.org/exonerator.html?ip=$ip"
                # recon
                __ipcheck_row $c_blue $c_fg "Shodan" "https://www.shodan.io/host/$ip"
                __ipcheck_row $c_blue $c_fg "Censys" "https://search.censys.io/hosts/$ip"
                # fraud / geo
                __ipcheck_row $c_blue $c_fg "Scamalytics" "https://scamalytics.com/ip/$ip"
                __ipcheck_row $c_blue $c_fg "IPinfo" "https://ipinfo.io/$ip"
                # network / abuse
                __ipcheck_row $c_blue $c_fg "BGP (HE)" "https://bgp.he.net/ip/$ip"
                __ipcheck_row $c_blue $c_fg "Blacklists" "https://mxtoolbox.com/SuperTool.aspx?action=blacklist%3a$ip&run=toolpage"
            end
            if test "$out_mode" = pretty
                echo
            end

            # ================= Markdown report ===========================
            if test "$out_mode" = markdown
                # Location (same compose logic as pretty)
                set -l md_loc "—"
                if test $geo_ok -eq 1
                    set -l locparts
                    test -n "$g_city"; and set -a locparts "$g_city"
                    test -n "$g_region"; and set -a locparts "$g_region"
                    test -n "$g_country"; and set -a locparts "$g_country"
                    set md_loc (string join ", " $locparts)
                    test -n "$g_cc"; and set md_loc "$md_loc ($g_cc)"
                    test -z "$md_loc"; and set md_loc "—"
                end
                # Reverse
                set -l md_rev "$g_reverse"
                test -z "$md_rev"; and set md_rev "—"
                # VPN / Tor display (drop the parenthetical for markdown)
                set -l md_vpn "$v_vpn"
                set -l md_tor "$v_tor"
                if test "$v_vpn" = "unknown (proxycheck unavailable)"
                    set md_vpn "unknown"
                end
                if test "$v_tor" = "unknown (proxycheck unavailable)"
                    set md_tor "unknown"
                end
                # VirusTotal cell
                set -l md_vt
                switch $vt_state
                    case ok
                        set -l flagged (math "$vt_malicious + $vt_suspicious")
                        set -l total (math "$vt_malicious + $vt_suspicious + $vt_harmless + $vt_undetected")
                        if test $flagged -eq 0
                            set md_vt "clean ($total engines)"
                        else
                            set md_vt "flagged by $flagged engines · reputation $vt_reputation"
                        end
                    case error
                        set md_vt "error"
                    case '*'
                        set md_vt "skipped"
                end
                # AbuseIPDB cell
                set -l md_ab
                switch $ab_state
                    case ok
                        set md_ab "score $ab_score/100 · $ab_reports reports · $ab_usage"
                    case error
                        set md_ab "error"
                    case '*'
                        set md_ab "skipped"
                end
                # Verdict cell
                set -l md_verdict "$verdict_word"
                if test (count $reasons) -gt 0
                    set md_verdict "$verdict_word ("(string join " + " $reasons)")"
                end

                echo "## $ip"
                echo
                echo "| Field | Value |"
                echo "| --- | --- |"
                echo "| Location | $md_loc |"
                test -n "$g_isp"; and echo "| ISP | $g_isp |"
                test -n "$g_org"; and echo "| Org | $g_org |"
                test -n "$g_as"; and echo "| ASN | $g_as |"
                echo "| Reverse | $md_rev |"
                echo "| Proxy | $v_proxy |"
                echo "| VPN | $md_vpn |"
                echo "| Tor | $md_tor |"
                echo "| Hosting/DC | $v_hosting |"
                echo "| Mobile | $v_mobile |"
                test -n "$v_risk"; and echo "| Risk | $v_risk/100 |"
                echo "| VirusTotal | $md_vt |"
                echo "| AbuseIPDB | $md_ab |"
                echo "| Verdict | $md_verdict |"

                if test $show_links -eq 1
                    echo
                    echo "### Links"
                    echo "- [VirusTotal](https://www.virustotal.com/gui/ip-address/$ip)"
                    echo "- [AbuseIPDB](https://www.abuseipdb.com/check/$ip)"
                    echo "- [GreyNoise](https://viz.greynoise.io/ip/$ip)"
                    echo "- [Talos](https://talosintelligence.com/reputation_center/lookup?search=$ip)"
                    echo "- [Tor Relay](https://metrics.torproject.org/rs.html#search/$ip)"
                    echo "- [ExoneraTor](https://metrics.torproject.org/exonerator.html?ip=$ip)"
                    echo "- [Shodan](https://www.shodan.io/host/$ip)"
                    echo "- [Censys](https://search.censys.io/hosts/$ip)"
                    echo "- [Scamalytics](https://scamalytics.com/ip/$ip)"
                    echo "- [IPinfo](https://ipinfo.io/$ip)"
                    echo "- [BGP (HE)](https://bgp.he.net/ip/$ip)"
                    echo "- [Blacklists](https://mxtoolbox.com/SuperTool.aspx?action=blacklist%3a$ip&run=toolpage)"
                end
                echo
            end

            # ================= JSON object ===============================
            if test "$out_mode" = json
                # geo mobile boolean
                set -l j_geo_mobile false
                test "$g_mobile" = "true"; and set j_geo_mobile true
                # flags.proxy
                set -l j_proxy false
                test "$v_proxy" = "yes"; and set j_proxy true
                # flags.vpn / flags.tor (null when proxycheck unavailable)
                set -l j_vpn null
                set -l j_tor null
                if test $pc_ok -eq 1
                    set j_vpn false
                    test "$v_vpn" = "yes"; and set j_vpn true
                    set j_tor false
                    test "$v_tor" = "yes"; and set j_tor true
                end
                # flags.hosting / flags.mobile
                set -l j_hosting false
                test "$v_hosting" = "yes"; and set j_hosting true
                set -l j_mobile_flag false
                test "$v_mobile" = "yes"; and set j_mobile_flag true
                # flags.risk
                set -l j_risk null
                test -n "$v_risk"; and set j_risk $v_risk
                # virustotal object
                set -l j_vt null
                if test "$vt_state" = ok
                    set j_vt (command jq -nc --argjson m $vt_malicious --argjson s $vt_suspicious --argjson h $vt_harmless --argjson u $vt_undetected --argjson r $vt_reputation '{malicious:$m,suspicious:$s,harmless:$h,undetected:$u,reputation:$r}')
                end
                # abuseipdb object
                set -l j_ab null
                if test "$ab_state" = ok
                    set j_ab (command jq -nc --argjson sc $ab_score --argjson rp $ab_reports --arg la "$ab_last" --arg ut "$ab_usage" '{score:$sc,reports:$rp,lastReportedAt:$la,usageType:$ut}')
                end
                # verdict reasons array
                set -l j_reasons "[]"
                if test (count $reasons) -gt 0
                    set j_reasons (printf '%s\n' $reasons | command jq -R . | command jq -s .)
                end
                # geo object
                set -l j_geo (command jq -nc \
                    --arg country "$g_country" --arg cc "$g_cc" --arg region "$g_region" \
                    --arg city "$g_city" --arg isp "$g_isp" --arg org "$g_org" \
                    --arg asn "$g_as" --arg reverse "$g_reverse" --argjson mobile $j_geo_mobile \
                    '{country:$country,countryCode:$cc,region:$region,city:$city,isp:$isp,org:$org,asn:$asn,reverse:$reverse,mobile:$mobile}')
                # flags object
                set -l j_flags (command jq -nc \
                    --argjson proxy $j_proxy --argjson vpn $j_vpn --argjson tor $j_tor \
                    --argjson hosting $j_hosting --argjson mobile $j_mobile_flag --argjson risk $j_risk \
                    '{proxy:$proxy,vpn:$vpn,tor:$tor,hosting:$hosting,mobile:$mobile,risk:$risk}')
                # verdict object
                set -l j_verdict (command jq -nc --arg level "$verdict_word" --argjson reasons "$j_reasons" \
                    '{level:$level,reasons:$reasons}')
                # final object (links optional)
                set -l obj
                if test $show_links -eq 1
                    set -l j_links (command jq -nc --arg ip "$ip" '{virustotal:("https://www.virustotal.com/gui/ip-address/"+$ip), abuseipdb:("https://www.abuseipdb.com/check/"+$ip), greynoise:("https://viz.greynoise.io/ip/"+$ip), talos:("https://talosintelligence.com/reputation_center/lookup?search="+$ip), torRelay:("https://metrics.torproject.org/rs.html#search/"+$ip), exonerator:("https://metrics.torproject.org/exonerator.html?ip="+$ip), shodan:("https://www.shodan.io/host/"+$ip), censys:("https://search.censys.io/hosts/"+$ip), scamalytics:("https://scamalytics.com/ip/"+$ip), ipinfo:("https://ipinfo.io/"+$ip), bgp:("https://bgp.he.net/ip/"+$ip), blacklists:("https://mxtoolbox.com/SuperTool.aspx?action=blacklist%3a"+$ip+"&run=toolpage")}')
                    set obj (command jq -nc --arg ip "$ip" --argjson geo "$j_geo" --argjson flags "$j_flags" \
                        --argjson virustotal "$j_vt" --argjson abuseipdb "$j_ab" --argjson verdict "$j_verdict" \
                        --argjson links "$j_links" \
                        '{ip:$ip,geo:$geo,flags:$flags,virustotal:$virustotal,abuseipdb:$abuseipdb,verdict:$verdict,links:$links}')
                else
                    set obj (command jq -nc --arg ip "$ip" --argjson geo "$j_geo" --argjson flags "$j_flags" \
                        --argjson virustotal "$j_vt" --argjson abuseipdb "$j_ab" --argjson verdict "$j_verdict" \
                        '{ip:$ip,geo:$geo,flags:$flags,virustotal:$virustotal,abuseipdb:$abuseipdb,verdict:$verdict}')
                end
                set -a json_objs $obj
            end
        end

        if test "$out_mode" = json
            if test (count $json_objs) -eq 0
                echo '[]'
            else
                printf '%s\n' $json_objs | command jq -s '.'
            end
        end
    end > $sink

    # --- copy mode: echo to terminal + clean copy to clipboard ------------
    if test $do_copy -eq 1
        command cat $tmp
        # Strip SGR sequences and the \e(B charset reset so the clipboard
        # holds clean plain text (no-op in markdown/json, which have no ANSI).
        string replace -ra '\x1b\[[0-9;]*m' '' < $tmp \
            | string replace -ra '\x1b\(B' '' \
            | copy
        command rm -f $tmp
        echo "ipcheck: report copied to clipboard" >&2
    end

    return $had_error
end

# Print a label/value row. args: <label_hex> <value_hex> <label> <value>
function __ipcheck_row --no-scope-shadowing
    set -l lcol $argv[1]
    set -l vcol $argv[2]
    set -l label $argv[3]
    set -l value $argv[4]
    if set -q NO_COLOR
        printf "  %-13s%s\n" "$label" "$value"
        return 0
    end
    set_color -o $lcol
    printf "  %-13s" "$label"
    set_color normal
    set_color -o $vcol
    echo "$value"
    set_color normal
end

# Print a boolean row with sentiment coloring.
# args: <label_hex> <unused> <label> <value yes/no> <danger_if_yes 0/1> <hosting_if_yes 0/1>
function __ipcheck_bool_row --no-scope-shadowing
    set -l lcol $argv[1]
    set -l label $argv[3]
    set -l value $argv[4]
    set -l danger $argv[5]
    set -l hosting $argv[6]

    # decide value color
    set -l vcol c0caf5
    if test "$value" = "yes"
        if test "$danger" -eq 1
            set vcol f7768e   # red
        else if test "$hosting" -eq 1
            set vcol ff9e64   # orange
        else
            set vcol c0caf5
        end
    else if test "$value" = "no"
        set vcol 9ece6a       # green
    end

    if set -q NO_COLOR
        printf "  %-13s%s\n" "$label" "$value"
        return 0
    end
    set_color -o $lcol
    printf "  %-13s" "$label"
    set_color normal
    set_color -o $vcol
    echo "$value"
    set_color normal
end
