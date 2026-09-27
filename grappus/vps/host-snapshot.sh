#!/usr/bin/env bash
# Snapshot every paperclip-owned *configuration and script* outside the instance
# data dir: systemd units, cron entries, Caddyfile, the /usr/local/bin helpers,
# the agent/scheduler scripts, the skills, the Slack bridge and the secrets
# needed to restore auth. -> /var/backups/paperclip/host-<ts>.tgz (keep 14)
#
# Complements /usr/local/bin/paperclip-backup, which holds the pg_dump and the
# instance data/storage. Run as root.
set -euo pipefail
D=/var/backups/paperclip
KEEP=${KEEP:-14}
mkdir -p "$D"
TS=$(date +%Y%m%d-%H%M%S)
L=$(mktemp -d)
trap 'rm -rf "$L"' EXIT

mkdir -p "$L/etc/systemd" "$L/etc/cron.d" "$L/etc/caddy" "$L/etc/claude-code" \
         "$L/usr-local-bin" "$L/home/paperclip"

# host units, cron, web front door
cp -a /etc/systemd/system/paperclip.service \
      /etc/systemd/system/preview-router.service \
      /etc/systemd/system/cswap-auto.service "$L/etc/systemd/" 2>/dev/null || true
cp -a /etc/cron.d/paperclip-backup "$L/etc/cron.d/" 2>/dev/null || true
cp -a /etc/caddy/Caddyfile "$L/etc/caddy/" 2>/dev/null || true
cp -a /etc/claude-code/managed-settings.json "$L/etc/claude-code/" 2>/dev/null || true
crontab -l -u paperclip > "$L/etc/cron.d/crontab-paperclip" 2>/dev/null || true
crontab -l > "$L/etc/cron.d/crontab-root" 2>/dev/null || true

# host helpers
cp -a /usr/local/bin/build-start /usr/local/bin/preview-reap /usr/local/bin/preview-url \
      /usr/local/bin/provision-worktree /usr/local/bin/rtk-claude-hook \
      /usr/local/bin/paperclip-backup /usr/local/bin/paperclip-export \
      /usr/local/bin/host-snapshot "$L/usr-local-bin/" 2>/dev/null || true

# home: scripts, agents, skills, bridge, sandbox settings, auth material
EXCL=(--exclude='__pycache__' --exclude='*.log' --exclude='node_modules' --exclude='.git')
for p in pc native-token.sh native-token.log recreate.sh runner-shim.sh acpx-thinking-patch.sh \
         agents skills slack-bridge preview-router deploy workspace workspace-b \
         .gitconfig .bashrc .profile .typesafe_key .github_pat .gitlab_pat .native-token.sha \
         .ssh; do
  [ -e "/home/paperclip/$p" ] || continue
  tar -C /home/paperclip "${EXCL[@]}" -cf - "$p" 2>/dev/null | tar -C "$L/home/paperclip" -xf - 2>/dev/null || true
done

# .local/bin is mostly re-installable toolchain (uv ~50 MB, rtk ~11 MB); keep only the scripts.
mkdir -p "$L/home/paperclip/.local/bin"
tar -C /home/paperclip/.local/bin "${EXCL[@]}" --exclude='uv' --exclude='uvx' --exclude='rtk' \
    -cf - . 2>/dev/null | tar -C "$L/home/paperclip/.local/bin" -xf - 2>/dev/null || true

# sandbox + user Claude settings (skip plugins/caches/session transcripts)
for s in clarifier-sandbox clarifier-sandbox-b productguide-sandbox productguide-sandbox-b \
         qa-sandbox qa-sandbox-b native-test-sandbox; do
  [ -d "/home/paperclip/$s/.claude" ] || continue
  mkdir -p "$L/home/paperclip/$s"
  tar -C "/home/paperclip/$s" -cf - .claude 2>/dev/null | tar -C "$L/home/paperclip/$s" -xf - 2>/dev/null || true
done
mkdir -p "$L/home/paperclip/.claude"
cp -a /home/paperclip/.claude/settings.json /home/paperclip/.claude/RTK.md \
      /home/paperclip/.claude/CLAUDE.md /home/paperclip/.claude/.credentials.json \
      "$L/home/paperclip/.claude/" 2>/dev/null || true

# instance config + secrets (the instance data/storage payload stays in paperclip-backup)
mkdir -p "$L/home/paperclip/.paperclip/instances/default"
cp -a /home/paperclip/.paperclip/instances/default/config.json \
      /home/paperclip/.paperclip/instances/default/.env \
      /home/paperclip/.paperclip/instances/default/runtime-info.json \
      "$L/home/paperclip/.paperclip/instances/default/" 2>/dev/null || true
cp -a /home/paperclip/.paperclip/instances/default/secrets \
      "$L/home/paperclip/.paperclip/instances/default/" 2>/dev/null || true
cp -a /home/paperclip/.paperclip/instances/default/skills \
      "$L/home/paperclip/.paperclip/instances/default/" 2>/dev/null || true
cp -a /home/paperclip/.paperclip/auth.json "$L/home/paperclip/.paperclip/" 2>/dev/null || true

tar -czf "$D/host-$TS.tgz" -C "$L" .
ls -1t "$D"/host-*.tgz | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "host snapshot: $D/host-$TS.tgz ($(du -h "$D/host-$TS.tgz" | cut -f1))"
