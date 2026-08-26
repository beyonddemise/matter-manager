#!/bin/zsh
# dev-down.sh — graceful teardown of the dev session

SESSION="mattermanager"

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' not running."
  exit 0
fi

# Panes 0-2: backend, frontend, admin — send q + Enter
for PANE in 0 1 2; do
  tmux send-keys -t "$SESSION.$PANE" 'q' Enter
done

# Give processes a moment to shut down cleanly
sleep 5

# Kill the session (harmless if panes already closed it)
tmux kill-session -t "$SESSION"

echo "mattermanager environment stopped."