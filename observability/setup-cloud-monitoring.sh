#!/usr/bin/env bash
# Cria (ou atualiza, se já existirem) os recursos de observabilidade da Entrega 2 no projeto
# GCP todo-infra-2026-m2: as log-based metrics derivadas dos logs estruturados do backend,
# os Uptime Checks usados pelo painel de disponibilidade, e a service account de leitura que
# o Grafana usa para consultar o Cloud Monitoring.
#
# Idempotente: pode ser rodado de novo com segurança (usa "describe" antes de decidir entre
# create/update). Não cria nem imprime nenhuma credencial — a chave da service account do
# Grafana é um passo manual, documentado no final deste arquivo e em
# ../docs/entrega2/observabilidade.md, porque exige uma decisão humana (liberar
# temporariamente uma política de organização) que não deve ser automatizada.
set -euo pipefail

PROJECT_ID="todo-infra-2026-m2"
REGION="southamerica-east1"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== Log de requisições do Load Balancer (necessário para a métrica de origem geográfica) =="
# api-bs (backend-service da API) suporta logConfig via gcloud estável.
gcloud compute backend-services update api-bs --global --enable-logging --logging-sample-rate=1.0 --project="$PROJECT_ID"
# front-bb (backend-bucket, GCS estático) NÃO aceita logConfig nesta API (testado com PATCH/PUT
# em v1 e beta — a plataforma não aplica o campo para backends do tipo bucket). O painel de
# origem geográfica cobre só o tráfego de API (api-bs), não os arquivos estáticos do front-end.
# Isso está documentado em docs/entrega2/observabilidade.md como limitação conhecida.

echo ""
echo "== Log-based metrics =="
for name in app_http_requests app_http_request_duration app_db_operations app_db_operation_duration app_business_events lb_requests_by_region; do
  file="${DIR}/log-metrics/${name}.yaml"
  if gcloud logging metrics describe "$name" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "-> $name já existe, atualizando a partir de ${file}"
    gcloud logging metrics update "$name" --project="$PROJECT_ID" --config-from-file="$file"
  else
    echo "-> criando $name a partir de ${file}"
    gcloud logging metrics create "$name" --project="$PROJECT_ID" --config-from-file="$file"
  fi
done

echo ""
echo "== Uptime Checks (painel de disponibilidade) =="
# gcloud monitoring uptime não tem "update a partir de nome" simples, então só cria se a
# configuração com esse display name ainda não existir.
if ! gcloud monitoring uptime list-configs --project="$PROJECT_ID" --format="value(displayName)" | grep -qx "todo-frontend-home"; then
  gcloud monitoring uptime create "todo-frontend-home" \
    --project="$PROJECT_ID" \
    --resource-type=uptime-url \
    --resource-labels=host=todo-2026-m2.duckdns.org,project_id="$PROJECT_ID" \
    --protocol=https --path=/ --port=443 --period=5 --timeout=10
else
  echo "-> todo-frontend-home já existe, pulando"
fi

if ! gcloud monitoring uptime list-configs --project="$PROJECT_ID" --format="value(displayName)" | grep -qx "todo-api-health"; then
  gcloud monitoring uptime create "todo-api-health" \
    --project="$PROJECT_ID" \
    --resource-type=uptime-url \
    --resource-labels=host=todo-2026-m2.duckdns.org,project_id="$PROJECT_ID" \
    --protocol=https --path=/api/health --port=443 --period=5 --timeout=10 \
    --matcher-content='"status":"ok"' --matcher-type=contains-string
else
  echo "-> todo-api-health já existe, pulando"
fi

echo ""
echo "== Service account de leitura para o Grafana =="
if ! gcloud iam service-accounts describe "grafana-viewer-sa@${PROJECT_ID}.iam.gserviceaccount.com" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create grafana-viewer-sa \
    --project="$PROJECT_ID" \
    --display-name="Grafana Cloud Monitoring viewer (Entrega 2)" \
    --description="Usada apenas pelo data source do Grafana Cloud para consultar metricas do Cloud Monitoring, somente leitura."
else
  echo "-> grafana-viewer-sa já existe, pulando criação"
fi

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:grafana-viewer-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/monitoring.viewer" \
  --condition=None >/dev/null

echo ""
echo "== Concluído =="
cat <<'EOF'
Passo manual restante (não automatizado de propósito): gerar a chave JSON da
grafana-viewer-sa para configurar no data source do Grafana Cloud.

Este projeto tem a política de organização `iam.disableServiceAccountKeyCreation`
aplicada por padrão. Para criar a chave:

  1. gcloud org-policies describe constraints/iam.disableServiceAccountKeyCreation \
       --project=todo-infra-2026-m2 --effective
     (confirme que está "enforce: true" antes de mexer)

  2. gcloud resource-manager org-policies disable-enforce \
       constraints/iam.disableServiceAccountKeyCreation --project=todo-infra-2026-m2

  3. gcloud iam service-accounts keys create SEU_ARQUIVO_LOCAL.json \
       --iam-account=grafana-viewer-sa@todo-infra-2026-m2.iam.gserviceaccount.com \
       --project=todo-infra-2026-m2

  4. gcloud resource-manager org-policies enable-enforce \
       constraints/iam.disableServiceAccountKeyCreation --project=todo-infra-2026-m2
     (religar a política — a chave já criada continua funcionando)

  5. Usar o conteúdo de SEU_ARQUIVO_LOCAL.json só na configuração do data source
     "Google Cloud Monitoring" no Grafana Cloud. NUNCA commitar esse arquivo.

Isso exige permissão `roles/orgpolicy.policyAdmin` (concedida no nível da
organização, não do projeto) — só quem administra a organização do GCP pode
fazer os passos 2 e 4. Ver docs/entrega2/observabilidade.md para o racional
completo dessa decisão.
EOF
