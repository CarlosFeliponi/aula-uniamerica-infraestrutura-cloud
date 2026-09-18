#!/usr/bin/env bash
# Gera tráfego real contra a aplicação em produção (pelo domínio público) para popular os
# painéis 1, 3, 4 e 6, e dispara uma falha controlada e não-destrutiva para os painéis 2 e 4
# (PATCH numa tarefa com id inválido → Mongoose CastError → HTTP 500).
#
# Não usa dado fictício "direto no painel": tudo passa pela aplicação de verdade, pelo domínio
# público, exatamente como um usuário real. Uso: ./gerar-trafego.sh [quantidade de ciclos]
set -euo pipefail

BASE="https://todo-2026-m2.duckdns.org/api"
CICLOS="${1:-8}"

echo "== $(date -u +%FT%TZ) — iniciando $CICLOS ciclos de uso normal =="

ids=()
for i in $(seq 1 "$CICLOS"); do
  # criar (POST /todos) — evento de negócio todo_created
  resp=$(curl -s -X POST "$BASE/todos" -H "Content-Type: application/json" \
    -d "{\"text\":\"tarefa de teste $(date +%s)-$i\"}")
  id=$(echo "$resp" | jq -r '._id // empty')
  if [ -n "$id" ]; then
    ids+=("$id")
  fi

  # listar (GET /todos)
  curl -s -o /dev/null "$BASE/todos"

  sleep 0.3
done

echo "== concluindo parte das tarefas (PATCH → todo_completed) =="
for id in "${ids[@]:0:$((CICLOS/2))}"; do
  curl -s -o /dev/null -X PATCH "$BASE/todos/$id"
  sleep 0.2
done

echo "== apagando algumas tarefas (DELETE → todo_deleted) =="
for id in "${ids[@]: -2}"; do
  curl -s -o /dev/null -X DELETE "$BASE/todos/$id"
  sleep 0.2
done

echo "== validação da rota /health (usada pelo Uptime Check) =="
curl -s -o /dev/null -w "  /api/health -> HTTP %{http_code}\n" "$BASE/health"

echo ""
echo "== falha controlada (não-destrutiva): PATCH em id inválido =="
echo "   Esperado: HTTP 500, evento db_operation com result=failure e error_type=CastError,"
echo "   visível no painel 2 (taxa de erro, rota /todos/:id) e no painel 4 (saúde do banco)."
curl -s -w "   status: %{http_code}\n" -X PATCH "$BASE/todos/id-invalido"

echo ""
echo "== falha controlada adicional: POST sem campo 'text' (HTTP 400) =="
curl -s -w "   status: %{http_code}\n" -X POST "$BASE/todos" -H "Content-Type: application/json" -d '{}'

echo ""
echo "== $(date -u +%FT%TZ) — concluído. ${#ids[@]} tarefas criadas neste ciclo. =="
echo "   Anote este horário (UTC) para localizar a janela no Grafana durante a validação."
