#!/usr/bin/env bash
# m3-check.sh — is the custom domain ready?   Run: npm run m3
#
# Three facts, in the order they become true:
#   1. Machinio's CNAME resolves      (Matt's send: host `fleet` -> mlancourt.github.io)
#   2. GitHub Pages knows the domain   (docs/CNAME merged from branch m3-cname)
#   3. HTTPS answers on the domain     (GitHub issues the cert minutes-to-hours after 1+2)
set -u
D=fleet.wisconsinscrubandsweep.com
WANT=mlancourt.github.io.

echo "1. DNS  ($D)"
target=$(dig +short CNAME "$D" 2>/dev/null | tail -1)
if [ "$target" = "$WANT" ]; then echo "   ✓ CNAME -> $target"
elif [ -n "$target" ]; then echo "   ✗ CNAME -> $target   (want $WANT)"
else echo "   ✗ no CNAME yet — waiting on Machinio"; fi

echo "2. GitHub Pages"
gh api repos/mlancourt/wss-fleet-dashboard/pages \
  --jq '"   cname=\(.cname // "none")  https_enforced=\(.https_enforced)  domain_state=\(.protected_domain_state // "n/a")"' 2>/dev/null \
  || echo "   (gh not authed)"

echo "3. HTTPS"
code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "https://$D/" 2>/dev/null || true)
case "$code" in
  200) echo "   ✓ https://$D/ -> 200" ;;
  "")  echo "   ✗ no HTTPS response yet" ;;
  *)   echo "   ~ https://$D/ -> $code" ;;
esac
