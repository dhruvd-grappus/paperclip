# Grappus ops for the Paperclip VPS. Scripts live here in the fork (grappus/); the pipeline's markdown
# (skills/*/SKILL.md, agents/clarifier.md) stays in the dev-pipe repo, found via PIPELINE_DIR.
# dev-pipe's Makefile forwards every target here, so `make deploy` still works from dev-pipe.
VPS=root@187.126.114.172
PIPELINE_DIR?=$(HOME)/Desktop/dev-pipe/paperclip
# Backups land outside any repo so secrets (ssh keys, PATs, master.key, .env) never sit next to a git
# working tree. Override with BACKUP_DIR.
BACKUP_DIR?=$(HOME)/dev-pipe-backups

# make deploy: ship skills + AGENTS.md (dev-pipe) and host helpers (here) to the VPS, install the agent sandbox's
# Claude settings (vps/clarifier-settings.json: deny list, also hides unused tools from the prompt), run the native deploy
# as paperclip. deploy-native.py expects skills/, agents/clarifier.md and vps/ side by side, so the tarball
# is assembled from both trees.
deploy: install-skills-sync
	@test -f $(PIPELINE_DIR)/agents/clarifier.md || { echo "PIPELINE_DIR=$(PIPELINE_DIR) has no agents/clarifier.md"; exit 1; }
	@COPYFILE_DISABLE=1 tar cf - -C $(PIPELINE_DIR) skills agents/clarifier.md -C $(CURDIR) vps deploy-native.py 2>/dev/null | ssh $(VPS) 'rm -rf /home/paperclip/deploy.new && mkdir -p /home/paperclip/deploy.new && tar xf - -C /home/paperclip/deploy.new 2>/dev/null && rm -rf /home/paperclip/deploy && mv /home/paperclip/deploy.new /home/paperclip/deploy && chown -R paperclip:paperclip /home/paperclip/deploy && cp /home/paperclip/deploy/vps/build-start /usr/local/bin/build-start && chmod 755 /usr/local/bin/build-start && { su paperclip -c "bash /home/paperclip/deploy/vps/test-branch-map.sh /home/paperclip/deploy/vps/branch-map" > /tmp/branch-map-test.log 2>&1 || { grep -E "^FAIL|^pass" /tmp/branch-map-test.log; echo "branch-map tests failed, deploy stopped"; exit 1; }; } && tail -1 /tmp/branch-map-test.log && install -m 755 -o root -g root /home/paperclip/deploy/vps/branch-map /usr/local/bin/branch-map && su - paperclip -c "cd ~/deploy && python3 deploy-native.py $(ARGS)" && install -m 644 -o paperclip -g paperclip /home/paperclip/deploy/vps/clarifier-settings.json /home/paperclip/clarifier-sandbox/.claude/settings.json && echo "sandbox settings installed"'

# make install-backup: put the backup/snapshot/reasoning helpers on the host (idempotent).
install-backup:
	@COPYFILE_DISABLE=1 tar cf - vps/paperclip-backup vps/paperclip-export.sh vps/host-snapshot.sh vps/acpx-thinking-patch.sh | ssh $(VPS) 'set -e; D=/home/paperclip/deploy-backup; rm -rf $$D; mkdir -p $$D; tar xf - -C $$D; \
	  install -m 755 -o root -g root $$D/vps/paperclip-backup /usr/local/bin/paperclip-backup; \
	  install -m 755 -o root -g root $$D/vps/host-snapshot.sh /usr/local/bin/host-snapshot; \
	  install -m 755 -o paperclip -g paperclip $$D/vps/paperclip-export.sh /home/paperclip/paperclip-export.sh; \
	  install -m 755 -o paperclip -g paperclip $$D/vps/acpx-thinking-patch.sh /home/paperclip/acpx-thinking-patch.sh; \
	  rm -rf $$D; echo "installed: /usr/local/bin/paperclip-backup /usr/local/bin/host-snapshot /home/paperclip/paperclip-export.sh /home/paperclip/acpx-thinking-patch.sh"'

# make install-heal: the self-heal crons (worktree, project policy, recovery) and the Claude token sync.
# Installs files only; the paperclip crontab lines already exist (worktree/project-policy every minute,
# recovery-heal */2, native-token */10).
install-heal:
	@COPYFILE_DISABLE=1 tar cf - vps/worktree-heal.py vps/project-policy-heal.py vps/recovery-heal.py vps/native-token.sh | ssh $(VPS) 'set -e; D=/tmp/grappus-heal; rm -rf $$D; mkdir -p $$D; tar xf - -C $$D; \
	  for f in worktree-heal.py project-policy-heal.py recovery-heal.py; do install -m 755 -o paperclip -g paperclip $$D/vps/$$f /home/paperclip/agents/$$f; done; \
	  install -m 755 -o paperclip -g paperclip $$D/vps/native-token.sh /home/paperclip/native-token.sh; \
	  rm -rf $$D; su - paperclip -c "crontab -l" | grep -E "heal|native-token"'

# make install-skills-sync: mirror skills added in the Paperclip UI into /home/paperclip/skills
# (cron every 5 min; deploy runs it too, so a UI skill reaches the agent without a redeploy).
install-skills-sync:
	@COPYFILE_DISABLE=1 tar cf - vps/skills-sync.sh | ssh $(VPS) 'set -e; D=/tmp/grappus-skills; rm -rf $$D; mkdir -p $$D; tar xf - -C $$D; \
	  install -m 755 -o paperclip -g paperclip $$D/vps/skills-sync.sh /home/paperclip/skills-sync.sh; rm -rf $$D; \
	  su - paperclip -c "crontab -l | grep -v skills-sync.sh | { cat; echo \"*/5 * * * * /home/paperclip/skills-sync.sh >> /home/paperclip/skills-sync.log 2>&1\"; } | crontab -"; \
	  su - paperclip -c "crontab -l" | grep skills-sync'

# make install-preview: preview-url (production build + serve, dev fallback), preview-stack (multi-repo
# previews, recipes in ~/preview-stack.d), preview-reap and the preview router. Seed recipes never overwrite
# one the agent already saved.
install-preview:
	@COPYFILE_DISABLE=1 tar cf - vps/preview-url vps/preview-stack vps/preview-reap.sh vps/preview-router.js vps/preview-stack.d | ssh $(VPS) 'set -e; \
	  D=/tmp/grappus-preview; rm -rf $$D; mkdir -p $$D; tar xf - -C $$D; \
	  install -m 755 -o root -g root $$D/vps/preview-url /usr/local/bin/preview-url; \
	  install -m 755 -o root -g root $$D/vps/preview-stack /usr/local/bin/preview-stack; \
	  install -m 755 -o root -g root $$D/vps/preview-reap.sh /usr/local/bin/preview-reap; \
	  install -m 644 -o paperclip -g paperclip $$D/vps/preview-router.js /home/paperclip/preview-router/index.js; \
	  install -d -o paperclip -g paperclip /home/paperclip/preview-stack.d /home/paperclip/preview-stacks /home/paperclip/services /home/paperclip/services/bin; \
	  for f in $$D/vps/preview-stack.d/*.json; do [ -e "$$f" ] || continue; t=/home/paperclip/preview-stack.d/$$(basename $$f); \
	    [ -e "$$t" ] || install -m 644 -o paperclip -g paperclip "$$f" "$$t"; done; \
	  rm -rf $$D; systemctl restart preview-router; systemctl is-active preview-router; preview-stack help | head -1'

# make backup: run all backups on the host, then pull them down here.
backup:
	@stamp=$$(date +%Y%m%d-%H%M%S); dest="$(BACKUP_DIR)/$$stamp"; mkdir -p "$$dest"; \
	ssh $(VPS) '/usr/local/bin/paperclip-backup'; \
	rsync -a $(VPS):/var/backups/paperclip/ "$$dest/var-backups/"; \
	rsync -a $(VPS):/home/paperclip/backups/ "$$dest/company-export/"; \
	echo "backup: $$dest"; ls -lh "$$dest/var-backups" "$$dest/company-export"

# make reasoning: force ACPX Claude sessions to emit thinking text (see vps/acpx-thinking-patch.sh).
reasoning: install-backup
	@ssh $(VPS) 'su - paperclip -c /home/paperclip/acpx-thinking-patch.sh'

# Paperclip runs this fork's CI builds (grappus/stable). Updates are started from the app only: sidebar
# build badge -> Check for updates -> Update now. Nothing is built or deployed from a workstation.
# make install-updater installs/refreshes the host side of that (vps/paperclip-overlay + the root path unit
# that runs it); status/rollback are emergency tools.
install-updater:
	@scp -q vps/paperclip-overlay vps/paperclip-update.path vps/paperclip-update.service $(VPS):/tmp/
	@ssh $(VPS) 'set -e; install -m 755 -o root -g root /tmp/paperclip-overlay /usr/local/bin/paperclip-overlay; \
	  install -m 644 /tmp/paperclip-update.path /tmp/paperclip-update.service /etc/systemd/system/; \
	  install -d -m 700 -o paperclip -g paperclip /home/paperclip/.paperclip/grappus-updates; \
	  systemctl daemon-reload; systemctl enable --now paperclip-update.path; \
	  systemctl is-active paperclip-update.path; rm -f /tmp/paperclip-overlay /tmp/paperclip-update.path /tmp/paperclip-update.service'

# make install-providers: host side of the in-app Providers panel (paperclip-providers + its root path
# unit) and the managed-settings guard drop-in (deny list from vps/clarifier-settings.json), which reaches
# every agent run whatever its working directory.
install-providers:
	@scp -q vps/paperclip-providers vps/paperclip-providers.path vps/paperclip-providers.service vps/clarifier-settings.json $(VPS):/tmp/
	@ssh $(VPS) 'set -e; install -m 755 -o root -g root /tmp/paperclip-providers /usr/local/bin/paperclip-providers; \
	  install -m 644 /tmp/paperclip-providers.path /tmp/paperclip-providers.service /etc/systemd/system/; \
	  install -d -m 700 -o paperclip -g paperclip /home/paperclip/.paperclip/grappus-providers; \
	  paperclip-providers install-guards /tmp/clarifier-settings.json; \
	  systemctl daemon-reload; systemctl enable --now paperclip-providers.path; systemctl is-active paperclip-providers.path; \
	  rm -f /tmp/paperclip-providers /tmp/paperclip-providers.path /tmp/paperclip-providers.service /tmp/clarifier-settings.json'

# Per-person git identities (vault-rules projects such as identity-gated Bitbucket repos): credential helper that
# reads ~/.git-identities/<host>/<identity> ("username:token", chosen by $GIT_IDENTITY, else the "default" link),
# gitconfig wiring for bitbucket.org, and the managed-settings drop-in that stops Claude Code from adding
# Co-Authored-By trailers host-wide (45-paperclip-git.json). Token files are written by the agent, never by make.
install-identities:
	@scp -q vps/git-credential-identity vps/managed-git.json $(VPS):/tmp/
	@ssh $(VPS) 'set -e; install -m 755 -o paperclip -g paperclip /tmp/git-credential-identity /home/paperclip/.local/bin/git-credential-identity; \
	  install -d -m 700 -o paperclip -g paperclip /home/paperclip/.git-identities /home/paperclip/.git-identities/bitbucket.org; \
	  su - paperclip -c "git config --global credential.https://bitbucket.org.helper /home/paperclip/.local/bin/git-credential-identity; git config --global credential.https://bitbucket.org.useHttpPath false"; \
	  install -m 644 -o root -g root /tmp/managed-git.json /etc/claude-code/managed-settings.d/45-paperclip-git.json; \
	  rm -f /tmp/git-credential-identity /tmp/managed-git.json; echo installed'

# Daily Hostinger VPS snapshot (one per VM, expires after 24 h, so daily is mandatory). Needs /root/.hostinger_token.
install-snapshot:
	@scp -q vps/hostinger-snapshot $(VPS):/tmp/
	@ssh $(VPS) 'set -e; install -m 755 -o root -g root /tmp/hostinger-snapshot /usr/local/bin/hostinger-snapshot; rm -f /tmp/hostinger-snapshot; \
	  test -s /root/.hostinger_token || echo "WARN: /root/.hostinger_token missing"; \
	  printf "SHELL=/bin/sh\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n30 3 * * * root /usr/local/bin/hostinger-snapshot\n" > /etc/cron.d/hostinger-snapshot; chmod 644 /etc/cron.d/hostinger-snapshot; cat /etc/cron.d/hostinger-snapshot'

# make install-mac: the `mac` tool (Xcode/iOS builds on registered Macs over Tailscale ssh). Registry
# /home/paperclip/macs.json and key ~/.ssh/mac_builder stay on the host; Macs are added with `mac add` there.
install-mac:
	@scp -q vps/mac $(VPS):/tmp/mac
	@ssh $(VPS) 'set -e; install -m 755 -o root -g root /tmp/mac /usr/local/bin/mac; rm -f /tmp/mac; su - paperclip -c "mac pubkey >/dev/null; mac list"'

paperclip-rollback:
	@ssh $(VPS) 'paperclip-overlay rollback'

paperclip-status:
	@ssh $(VPS) 'paperclip-overlay status'

.PHONY: deploy install-mac install-backup install-heal install-preview install-providers install-skills-sync backup reasoning install-updater paperclip-rollback paperclip-status
