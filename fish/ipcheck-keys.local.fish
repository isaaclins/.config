# ~/.config/fish/ipcheck-keys.local.fish
# Purpose: Local, per-user API keys for `ipcheck`. NOT committed (gitignored).
# Usage: Fill in keys, then `exec fish`. All optional — ipcheck works key-free.
#   VirusTotal → https://www.virustotal.com/gui/my-apikey   (free 500/day)
#   AbuseIPDB  → https://www.abuseipdb.com/account/api       (free 1000/day)
#   proxycheck → https://proxycheck.io/  (optional; raises the free 100/day no-key limit)
set -gx IPCHECK_VIRUSTOTAL_KEY ""
set -gx IPCHECK_ABUSEIPDB_KEY  ""
set -gx IPCHECK_PROXYCHECK_KEY ""
