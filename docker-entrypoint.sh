#!/bin/sh
set -eu

database=/app/data/tahoma.sqlite

fail() {
  echo "Database startup check failed: $*" >&2
  exit 1
}

validate_id() {
  case "$2" in
    ''|0*|*[!0-9]*) fail "$1 must be a decimal integer between 1 and 2147483647 (without leading zeros)." ;;
  esac
  [ "${#2}" -le 10 ] && [ "$2" -le 2147483647 ] \
    || fail "$1 must be a decimal integer between 1 and 2147483647."
}

startup_uid=$(id -u)
startup_gid=$(id -g)
if [ "$startup_uid" -eq 0 ]; then
  app_uid=${PUID-$(id -u node)}
  app_gid=${PGID-$(id -g node)}
else
  app_uid=${PUID-$startup_uid}
  app_gid=${PGID-$startup_gid}
fi
validate_id PUID "$app_uid"
validate_id PGID "$app_gid"
if [ "$startup_uid" -ne 0 ] && { [ "$app_uid" -ne "$startup_uid" ] || [ "$app_gid" -ne "$startup_gid" ]; }; then
  fail "PUID/PGID must match the current user when starting without root; remove Docker's --user override to switch IDs."
fi
app_identity="$app_uid:$app_gid"

as_app_user() {
  if [ "$startup_uid" -eq 0 ]; then
    gosu "$app_identity" "$@"
  else
    "$@"
  fi
}

check_access() {
  as_app_user sh -c '
    [ -w /app/data ] && [ -x /app/data ] || exit 1
    for file in "$1" "$1-wal" "$1-shm" "$1-journal"; do
      if [ -e "$file" ] || [ -L "$file" ]; then
        [ -f "$file" ] && [ -r "$file" ] && [ -w "$file" ] || exit 1
      fi
    done
  ' sh "$database"
}

if [ -e "$database" ] || [ -L "$database" ]; then
  [ -f "$database" ] || fail "$database is not a regular file."
fi

if ! check_access; then
  echo "Database access is insufficient; attempting to repair ownership and permissions." >&2
  for file in /app/data "$database" "$database-wal" "$database-shm" "$database-journal"; do
    [ -e "$file" ] || continue
    if [ "$startup_uid" -eq 0 ]; then
      chown "$app_identity" "$file" || fail "Cannot repair ownership of $file."
    fi
    if [ "$file" = /app/data ]; then
      chmod u+rwx "$file" || fail "Cannot repair permissions on $file."
    else
      [ -f "$file" ] || fail "$file is not a regular file."
      chmod u+rw "$file" || fail "Cannot repair permissions on $file."
    fi
  done
fi

check_access || fail "$database or its directory/sidecar files are still inaccessible to the application user."
if [ ! -e "$database" ]; then
  echo "No database found; creating $database as the application user." >&2
fi
as_app_user sqlite3 -bail "$database" 'BEGIN IMMEDIATE; ROLLBACK;' \
  || fail "SQLite cannot create or open $database for writing."

if [ "$startup_uid" -eq 0 ]; then
  exec gosu "$app_identity" "$@"
fi
exec "$@"
