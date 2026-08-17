#!/bin/sh
set -eu

image="${1:-mirror-mirror:local}"

docker run --rm --interactive --user node --entrypoint sh "$image" -s <<'CONTAINER_SCRIPT'
set -eu
git lfs version >/dev/null
test "$(id -u)" = "1000"
test "$(id -g)" = "1000"

fixture="$(mktemp -d /tmp/mirrormirror-lfs.XXXXXX)"
server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$fixture"
}
trap cleanup EXIT INT TERM

export HOME="$fixture/home"
source_repository="$fixture/source"
upstream_repository="$fixture/upstream.git"
data_directory="$fixture/data"
mirror_path="$data_directory/mirrors/42.git"
capture_path="$fixture/captured-requests"
port_path="$fixture/capture-port"
mkdir -p "$HOME" "$source_repository" "$data_directory/mirrors"

git config --global user.name "MirrorMirror LFS Test"
git config --global user.email "mirror-lfs@example.com"

node -e '
const fs = require("node:fs");
const http = require("node:http");
const [portPath, capturePath] = process.argv.slice(1);
const server = http.createServer((request, response) => {
  fs.appendFileSync(
    capturePath,
    JSON.stringify({ url: request.url, authorization: request.headers.authorization }) + "\n",
  );
  response.statusCode = 500;
  response.end("unexpected request");
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(portPath, String(server.address().port));
});
' "$port_path" "$capture_path" &
server_pid="$!"

attempts=0
while [ ! -s "$port_path" ]; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 200 ]; then
    echo "capture server did not start" >&2
    exit 1
  fi
  sleep 0.01
done
capture_port="$(cat "$port_path")"

cd "$source_repository"
git init --initial-branch=main >/dev/null
git lfs install --local >/dev/null
git lfs track "*.bin" >/dev/null
printf "main-lfs-payload\n" > main.bin
git add .gitattributes main.bin
git commit -m "add main LFS payload" >/dev/null

git init --bare "$upstream_repository" >/dev/null
upstream_url="file://$upstream_repository"
git remote add origin "$upstream_url"
git -c "lfs.url=$upstream_url" push -u origin main >/dev/null
git --git-dir="$upstream_repository" symbolic-ref HEAD refs/heads/main

git switch -c feature >/dev/null
printf "feature-lfs-payload\n" > feature.bin
git add feature.bin
git commit -m "add feature LFS payload" >/dev/null
git -c "lfs.url=$upstream_url" push -u origin feature >/dev/null

printf "tag-lfs-payload\n" > tag.bin
git add tag.bin
git commit -m "add tag-only LFS payload" >/dev/null
git tag lfs-archive
git -c "lfs.url=$upstream_url" push origin refs/tags/lfs-archive >/dev/null
git reset --hard HEAD^ >/dev/null
git -c "lfs.url=$upstream_url" push --force origin feature >/dev/null

git switch main >/dev/null
printf "[lfs]\n\turl = http://127.0.0.1:%s/steal\n" "$capture_port" > .lfsconfig
git add .lfsconfig
git commit -m "add repository-controlled LFS endpoint" >/dev/null
git -c "lfs.url=$upstream_url" push origin main >/dev/null

oid_for_ref() {
  git show "$1:$2" | sed -n "s/^oid sha256://p"
}
main_oid="$(oid_for_ref refs/heads/main main.bin)"
feature_oid="$(oid_for_ref refs/heads/feature feature.bin)"
tag_oid="$(oid_for_ref refs/tags/lfs-archive tag.bin)"

object_path() {
  object_id="$1"
  first="$(printf "%s" "$object_id" | cut -c 1-2)"
  second="$(printf "%s" "$object_id" | cut -c 3-4)"
  printf "%s/lfs/objects/%s/%s/%s" "$mirror_path" "$first" "$second" "$object_id"
}

run_sync() {
  DATA_DIR="$data_directory" CLONE_URL="$upstream_url" \
    GITHUB_TOKEN_VALUE="container-pat-do-not-leak" node -e '
const { syncMirror } = require("/app/dist-worker/lib/git-mirror.js");
syncMirror(
  {
    repositoryId: 42,
    fullName: "YumaIT/lfs-container",
    cloneUrl: process.env.CLONE_URL,
    mirrorPath: `${process.env.DATA_DIR}/mirrors/42.git`,
  },
  {
    dataDir: process.env.DATA_DIR,
    token: process.env.GITHUB_TOKEN_VALUE,
    gitOperationTimeoutMs: 10_000,
  },
  { askPassPath: "/app/scripts/git-askpass.sh" },
).then(
  (size) => process.stdout.write(String(size)),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
'
}

first_size="$(run_sync)"
test -f "$(object_path "$main_oid")"
test -f "$(object_path "$feature_oid")"
test -f "$(object_path "$tag_oid")"
git --git-dir="$mirror_path" show HEAD:.lfsconfig | grep -q "127.0.0.1:$capture_port/steal"
test ! -s "$capture_path"

measured_size="$(find "$mirror_path" -type f -exec stat -c %s {} + | awk '{ total += $1 } END { print total + 0 }')"
test "$first_size" = "$measured_size"

upstream_main_object="$(printf "%s/lfs/objects/%s/%s/%s" \
  "$upstream_repository" \
  "$(printf "%s" "$main_oid" | cut -c 1-2)" \
  "$(printf "%s" "$main_oid" | cut -c 3-4)" \
  "$main_oid")"
rm "$upstream_main_object"

printf "new-lfs-payload\n" > new.bin
git add new.bin
git commit -m "add another LFS payload" >/dev/null
git -c "lfs.url=$upstream_url" push origin main >/dev/null
new_oid="$(oid_for_ref refs/heads/main new.bin)"

run_sync >/dev/null
test -f "$(object_path "$main_oid")"
test -f "$(object_path "$new_oid")"

git -c "lfs.url=$upstream_url" push origin --delete feature >/dev/null
run_sync >/dev/null
test -f "$(object_path "$feature_oid")"
test -f "$(object_path "$tag_oid")"
test ! -s "$capture_path"
CONTAINER_SCRIPT
