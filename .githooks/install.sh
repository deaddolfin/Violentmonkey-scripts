#!/bin/sh
# Кладёт обёртку в .git/hooks/pre-commit; core.hooksPath не трогаем — он отключил бы чужие хуки.
set -e
root=$(git rev-parse --show-toplevel)
hook="$root/.git/hooks/pre-commit"
if [ -e "$hook" ] && ! grep -q 'githooks/pre-commit' "$hook"; then
  echo "В $hook уже есть чужой хук — добавьте вызов .githooks/pre-commit вручную" >&2
  exit 1
fi
cat > "$hook" <<'HOOK'
#!/bin/sh
exec "$(git rev-parse --show-toplevel)/.githooks/pre-commit" "$@"
HOOK
chmod +x "$hook"
echo "Хук установлен: $hook"
