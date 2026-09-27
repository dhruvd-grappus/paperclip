# Grappus ops for the Paperclip VPS. Scripts live here in the fork (grappus/); the pipeline's markdown
# (skills/*/SKILL.md, agents/clarifier.md) stays in the dev-pipe repo, found via PIPELINE_DIR.
# dev-pipe's Makefile forwards every target here, so `make deploy` still works from dev-pipe.
VPS=root@187.126.114.172
PIPELINE_DIR?=$(HOME)/Desktop/dev-pipe/paperclip
# Backups land outside any repo so secrets (ssh keys, PATs, master.key, .env) never sit next to a git
# working tree. Override with BACKUP_DIR.
BACKUP_DIR?=$(HOME)/dev-pipe-backups

# make deploy: ship skills + AGENTS.md (dev-pipe) and host helpers (here) to the VPS, run the native deploy
# as paperclip. deploy-native.py expects skills/, agents/clarifier.md and vps/ side by side, so the tarball
# is assembled from both trees.
deploy:
	@test -f $(PIPELINE_DIR)/agents/clarifier.md || { echo "PIPELINE_DIR=$(PIPELINE_DIR) has no agents/clarifier.md"; exit 1; }
	@COPYFILE_DISABLE=1 tar cf - -C $(PIPELINE_DIR) skills agents/clarifier.md -C $(CURDIR) vps deploy-native.py 2>/dev/null | ssh $(VPS) 'rm -rf /home/paperclip/deploy.new && mkdir -p /home/paperclip/deploy.new && tar xf - -C /home/paperclip/deploy.new 2>/dev/null && rm -rf /home/paperclip/deploy && mv /home/paperclip/deploy.new /home/paperclip/deploy && chown -R paperclip:paperclip /home/paperclip/deploy && cp /home/paperclip/deploy/vps/build-start /usr/local/bin/build-start && chmod 755 /usr/local/bin/build-start && su - paperclip -c "cd ~/deploy && python3 deploy-native.py $(ARGS)"'

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

paperclip-rollback:
	@ssh $(VPS) 'paperclip-overlay rollback'

paperclip-status:
	@ssh $(VPS) 'paperclip-overlay status'

.PHONY: deploy install-backup install-heal backup reasoning install-updater paperclip-rollback paperclip-status
