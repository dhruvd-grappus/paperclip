# grappus/ — ops for our Paperclip VPS

Everything executable that runs the Grappus pipeline on the VPS. The pipeline's instructions (skills,
AGENTS.md) and the operating manual (CLAUDE.md) live in the dev-pipe repo; `make` targets here read the
markdown from `PIPELINE_DIR` (default `~/Desktop/dev-pipe/paperclip`). dev-pipe's own Makefile forwards
every target here.

| Path | What |
| --- | --- |
| `Makefile` | `deploy` (skills + AGENTS.md + helpers), `install-backup`, `install-heal`, `install-updater`, `backup`, `reasoning`, `paperclip-status`, `paperclip-rollback` |
| `deploy-native.py` | runs on the VPS as `paperclip` during `make deploy` |
| `vps/` | host helpers and systemd units; each file's header says where it is installed |
| `slack-bridge/` | `bridge.py`, `slack_check.py` (the host's `.env` and `state.json` are never committed) |
| `hygiene-agent/` | static hygiene page generator |
| `historical/` | multi-agent-era admin scripts; kept for reference, do not re-run |

The VPS is the source of truth: diff a live helper against its copy here before editing, and copy host-side
changes back. This folder is not part of the Paperclip build; `.github/workflows/grappus-overlay.yml`
ignores changes under `grappus/`.
