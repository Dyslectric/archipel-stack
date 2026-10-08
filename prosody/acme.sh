#!/bin/sh
# Obtains and renews Prosody's certificate with lego. `lego run` issues the first
# certificate and afterwards only renews one that is due; settings arrive as LEGO_* variables.
for name in LEGO_DNS LEGO_SERVER; do
  eval "[ -n \"\${$name:-}\" ] || unset $name"
done
while :; do
  if /lego run; then
    sleep 43200
  else
    # A first attempt that failed before registration leaves an account lego cannot resume.
    for account in "$LEGO_PATH"/accounts/*/*/account.json; do
      if grep -q '"registration": null' "$account" 2>/dev/null; then rm -rf "$(dirname "$account")"; fi
    done
    echo "acme.sh: no certificate was obtained; retrying in an hour." >&2
    sleep 3600
  fi
done
