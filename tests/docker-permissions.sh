#!/bin/sh
set -eu

image="${1:-mirror-mirror:local}"
test_directory="$(mktemp -d "${TMPDIR:-/tmp}/mirrormirror-permissions.XXXXXX")"
sentinel_directory="$(mktemp -d "${TMPDIR:-/tmp}/mirrormirror-sentinel.XXXXXX")"
host_uid="$(id -u)"
host_gid="$(id -g)"

cleanup() {
  docker run --rm --user root --entrypoint sh \
    --volume "$test_directory:/data" \
    --volume "$sentinel_directory:/escape" \
    "$image" -c '
      if [ -L /data/mirrors ]; then
        unlink /data/mirrors
      elif [ -d /data/mirrors ]; then
        rmdir /data/mirrors
      fi
      chown "$1:$2" /data /escape
      chmod u+rwx /data /escape
    ' cleanup "$host_uid" "$host_gid" >/dev/null 2>&1 || true
  rmdir "$test_directory" "$sentinel_directory"
}
trap cleanup EXIT

chmod 0555 "$test_directory"
chmod 0555 "$sentinel_directory"
docker run --rm \
  --volume "$test_directory:/data" \
  --env GITHUB_ORG=YumaIT \
  --env GITHUB_TOKEN=permission-test-token \
  --env MIRROR_DATA_DIR=/data \
  "$image" \
  node -e '
    const fs = require("node:fs");
    fs.mkdirSync("/data/mirrors", { recursive: true });
    fs.writeFileSync("/data/.permission-probe", "ok");
    fs.unlinkSync("/data/.permission-probe");
    if (process.getuid() !== 1000 || process.getgid() !== 1000) process.exit(2);
  '

docker run --rm --user root --entrypoint rmdir \
  --volume "$test_directory:/data" "$image" /data/mirrors
docker run --rm --user root --entrypoint ln \
  --volume "$test_directory:/data" "$image" -s /escape /data/mirrors

sentinel_mode_before="$(docker run --rm --user root --entrypoint stat \
  --volume "$sentinel_directory:/escape" "$image" -c %a /escape)"
if docker run --rm \
  --volume "$test_directory:/data" \
  --volume "$sentinel_directory:/escape" \
  "$image" node -e 'process.exit(0)' >/dev/null 2>&1; then
  echo "container startup followed a /data/mirrors symlink" >&2
  exit 1
fi
sentinel_mode_after="$(docker run --rm --user root --entrypoint stat \
  --volume "$sentinel_directory:/escape" "$image" -c %a /escape)"
test "$sentinel_mode_after" = "$sentinel_mode_before"
