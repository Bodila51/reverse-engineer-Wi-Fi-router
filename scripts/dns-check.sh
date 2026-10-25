#!/usr/bin/env bash
# Which company answers your DNS lookups? Run it before and after you turn on
# encrypted DNS. whoami.akamai.net replies with the address of the resolver
# that asked for it, so the owner of that address is who sees your lookups.
set -u

ip=""
if command -v dig >/dev/null 2>&1; then
  ip=$(dig +short whoami.akamai.net 2>/dev/null | grep -E '^[0-9.]+$' | tail -1)
fi
if [ -z "$ip" ] && command -v nslookup >/dev/null 2>&1; then
  ip=$(nslookup whoami.akamai.net 2>/dev/null | awk '/^Name:/ {found=1} found && /^Address/ {print $2}' | tail -1)
fi
if [ -z "$ip" ]; then
  echo "Could not resolve whoami.akamai.net"
  exit 1
fi

echo "Your DNS lookups are answered by: $(echo "$ip" | awk -F. '{print $1"."$2".x.x"}')"
if command -v whois >/dev/null 2>&1; then
  whois "$ip" 2>/dev/null | grep -iE '^(orgname|org-name|organization|descr|netname|owner):' | head -3
else
  echo "(install whois to see which company owns it)"
fi
