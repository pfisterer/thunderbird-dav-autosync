#!/usr/bin/env bash
# Ephemeral Nextcloud for tests (no volume: everything is gone after "stop").
#   scripts/nc-test.sh start   start container and create test users, calendars, shares, address books
#   scripts/nc-test.sh env     print DAV_URL/DAV_USER/DAV_PASSWORD for alice (eval "$(scripts/nc-test.sh env)")
#   scripts/nc-test.sh stop    remove container
# Passwords are generated once and kept in .local/nc/ (git-ignored).
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=nc-test
PORT=8088
DIR=.local/nc
B="http://127.0.0.1:$PORT/remote.php/dav"
mkdir -p "$DIR"
umask 077

pw() { [ -f "$DIR/$1.pw" ] || openssl rand -base64 18 | tr -d '/+=' > "$DIR/$1.pw"; cat "$DIR/$1.pw"; }
occ() { docker exec -u www-data "$NAME" php occ "$@"; }

mkcal() { # user slug displayname color component
  curl -s -o /dev/null -w "  %{http_code} Kalender $1/$2\n" -u "$1:$(pw "$1")" -X MKCALENDAR "$B/calendars/$1/$2/" -H 'Content-Type: application/xml' --data "<?xml version=\"1.0\"?><c:mkcalendar xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\" xmlns:a=\"http://apple.com/ns/ical/\"><d:set><d:prop><d:displayname>$3</d:displayname><a:calendar-color>$4</a:calendar-color><c:supported-calendar-component-set><c:comp name=\"$5\"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>"
}
mkbook() { # user slug displayname
  curl -s -o /dev/null -w "  %{http_code} Adressbuch $1/$2\n" -u "$1:$(pw "$1")" -X MKCOL "$B/addressbooks/users/$1/$2/" -H 'Content-Type: application/xml' --data "<?xml version=\"1.0\"?><d:mkcol xmlns:d=\"DAV:\" xmlns:card=\"urn:ietf:params:xml:ns:carddav\"><d:set><d:prop><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>$3</d:displayname></d:prop></d:set></d:mkcol>"
}
share() { # owner path sharee [rw]
  local extra=""; [ "${4:-}" = rw ] && extra="<o:read-write/>"
  curl -s -o /dev/null -w "  %{http_code} Freigabe $2 → $3 ${4:-ro}\n" -u "$1:$(pw "$1")" -X POST "$B/$2" -H 'Content-Type: application/xml; charset=utf-8' --data "<?xml version=\"1.0\"?><o:share xmlns:d=\"DAV:\" xmlns:o=\"http://owncloud.org/ns\"><o:set><d:href>principal:principals/users/$3</d:href>$extra</o:set></o:share>"
}
unshare() { # owner path sharee
  curl -s -o /dev/null -w "  %{http_code} Freigabe entfernt $2 → $3\n" -u "$1:$(pw "$1")" -X POST "$B/$2" -H 'Content-Type: application/xml; charset=utf-8' --data "<?xml version=\"1.0\"?><o:share xmlns:d=\"DAV:\" xmlns:o=\"http://owncloud.org/ns\"><o:remove><d:href>principal:principals/users/$3</d:href></o:remove></o:share>"
}

case "${1:-}" in
  start)
    if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
      docker run -d --rm --name "$NAME" -p "127.0.0.1:$PORT:80" \
        -e SQLITE_DATABASE=nc -e NEXTCLOUD_ADMIN_USER=admin -e NEXTCLOUD_ADMIN_PASSWORD="$(pw admin)" \
        -e NEXTCLOUD_TRUSTED_DOMAINS="localhost 127.0.0.1" nextcloud:stable >/dev/null
    fi
    for _ in $(seq 1 60); do occ status 2>/dev/null | grep -q 'installed: true' && break; sleep 3; done
    # Tests log in with wrong passwords on purpose; keep the brute-force throttle from slowing everything down.
    occ config:system:set auth.bruteforce.protection.enabled --type=boolean --value=false >/dev/null
    # Repeated e2e runs share and unshare a lot; Nextcloud would answer with HTTP 429.
    occ config:system:set ratelimit.protection.enabled --type=boolean --value=false >/dev/null
    occ config:app:set dav rateLimitShareAddressbookOrCalendar --type=integer --value=100000 >/dev/null
    occ config:app:set dav rateLimitPeriodShareAddressbookOrCalendar --type=integer --value=1 >/dev/null
    for u in alice bob; do
      occ user:info "$u" >/dev/null 2>&1 || docker exec -u www-data -e OC_PASS="$(pw "$u")" "$NAME" php occ user:add --password-from-env --display-name="${u^}" "$u" >/dev/null
    done
    mkcal alice projekte "Projekte" "#1E88E5" VEVENT
    mkcal alice aufgaben "Aufgaben" "#43A047" VTODO
    mkcal bob urlaub "Urlaubsplan" "#E53935" VEVENT
    mkcal bob montage "Montagetermine" "#FB8C00" VEVENT
    share bob calendars/bob/urlaub/ alice
    share bob calendars/bob/montage/ alice rw
    mkbook bob lieferanten "Lieferanten"
    share bob addressbooks/users/bob/lieferanten/ alice
    curl -s -o /dev/null -u "bob:$(pw bob)" -X PUT "$B/addressbooks/users/bob/lieferanten/holzhandel.vcf" -H 'Content-Type: text/vcard' --data-binary $'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:holzhandel-1\r\nFN:Holzhandel Muster GmbH\r\nEMAIL:info@holzhandel.example\r\nEND:VCARD\r\n'
    curl -s -o /dev/null -u "bob:$(pw bob)" -X PUT "$B/calendars/bob/montage/m1.ics" -H 'Content-Type: text/calendar' --data-binary $'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//dav-autosync test//EN\r\nBEGIN:VEVENT\r\nUID:m1\r\nDTSTAMP:20261015T080000Z\r\nDTSTART:20261020T070000Z\r\nDTEND:20261020T150000Z\r\nSUMMARY:Montage Kunde Beispiel\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
    echo "Nextcloud $(occ status | awk '/versionstring/{print $3}') läuft auf http://127.0.0.1:$PORT (Kennwörter in $DIR/)"
    ;;
  env)
    echo "export DAV_URL=$B/ DAV_USER=alice DAV_PASSWORD=$(pw alice)"
    ;;
  # Helpers for manual tests of the sync behaviour
  mkcal) shift; mkcal "$@" ;;
  rmcal) curl -s -o /dev/null -w "  %{http_code} Kalender gelöscht $2/$3\n" -u "$2:$(pw "$2")" -X DELETE "$B/calendars/$2/$3/" ;;
  share) shift; share "$@" ;;
  unshare) shift; unshare "$@" ;;
  stop)
    docker rm -f "$NAME" >/dev/null && echo "gestoppt"
    ;;
  *)
    sed -n '2,7p' "$0"; exit 1 ;;
esac
