#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
source_dir="$PWD"
target="$HOME/.local/share/minecraft-panel"
unit_dir="$HOME/.config/systemd/user"

for command in node npm python3 tmux systemctl; do
  command -v "$command" >/dev/null || { echo "缺少依赖：$command" >&2; exit 1; }
done

mkdir -p -- "$target/public" "$unit_dir"
if [[ "$source_dir" != "$target" ]]; then
  install -m 644 package.json package-lock.json server.mjs discover.py terminal.py tmux.conf "$target/"
  install -m 644 public/index.html public/style.css public/app.js public/favicon.svg "$target/public/"
fi
cd -- "$target"
npm ci --omit=dev
node_exe="$(command -v node)"

cat > "$unit_dir/minecraft-panel.service" <<EOF
[Unit]
Description=Minecraft server management panel
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/.local/share/minecraft-panel
ExecStart="$node_exe" server.mjs
EnvironmentFile=-%h/.config/minecraft-panel/environment
KillMode=process
Restart=on-failure
RestartSec=2
UMask=0077

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable minecraft-panel.service
systemctl --user restart minecraft-panel.service
systemctl --user --no-pager status minecraft-panel.service
