#!/bin/zsh
# dev-up.sh — 3 panels in one tmux session

SESSION="mattermanager"
APP_DIR="$HOME/Code/matter-manager"
WEB_DIR="$HOME/Code/matter-manager-web"

# Re-attach if already running
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Existing session found"
  tmux attach -t "$SESSION"
  exit 0
fi

tmux new-session -d -s "$SESSION" -c "$APP_DIR" \
  -x "$(tput cols)" -y "$(tput lines)" 

tmux split-window -t "$SESSION" -c "$APP_DIR"
tmux split-window -t "$SESSION" -c "$WEB_DIR"

# selct tile layout then attach
tmux select-layout -t "$SESSION" even-vertical
tmux attach -t "$SESSION"