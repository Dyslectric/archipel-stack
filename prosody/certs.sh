#!/bin/sh
# Starts Prosody with certificates issued elsewhere: lego's store (compose.xmpp-acme.yaml)
# or Traefik's acme.json (compose.xmpp-traefik-certs.yaml). Runs as root before the image
# entrypoint drops privileges, so the sources stay unreadable to Prosody itself.
set -eu
target="${XMPP_CERTS_PATH:?}"
next="$target.next"

collect() {
  rm -rf "$next"
  mkdir -p "$next"
  if [ "${XMPP_CERT_SOURCE:-}" = traefik ]; then
    lua /etc/prosody/traefik-certs.lua "${XMPP_TRAEFIK_ACME_FILE:?}" "$next" "${XMPP_DOMAIN:?}" || return 1
  else
    for kind in crt key; do
      cp "/acme/certificates/${XMPP_DOMAIN:?}.$kind" "$next/" 2>/dev/null || return 1
    done
  fi
  chown -R root:prosody "$next"
  chmod 750 "$next"
  chmod 640 "$next"/*
}
# True only when the source holds certificates that differ from the ones in use.
refresh() {
  collect || return 1
  if diff -rq "$next" "$target" >/dev/null 2>&1; then return 1; fi
  rm -rf "$target"
  mv "$next" "$target"
}

if ! refresh; then
  mkdir -p "$target"
  echo "certs.sh: no certificate for $XMPP_DOMAIN yet; Prosody reloads when one is issued." >&2
fi
(
  while sleep 60; do
    if refresh; then
      echo "certs.sh: certificates changed; reloading Prosody." >&2
      kill -HUP "$(cat /var/run/prosody/prosody.pid)" 2>/dev/null || true
    fi
  done
) &
exec /entrypoint.sh "$@"
