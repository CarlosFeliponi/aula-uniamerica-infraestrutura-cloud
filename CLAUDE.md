# CLAUDE.md

Guia de contexto para sessões futuras do Claude Code trabalhando neste repositório.

## O que é este projeto

Todo List (fork de `LaercioMLB/aula-uniamerica-infraestrutura-cloud`) usado como aplicação de
exemplo para uma disciplina de Infraestrutura Cloud. O código da aplicação em si (React + Node/
Express + MongoDB) é propositalmente simples — o valor da disciplina está na infraestrutura ao
redor dela (GCP + MongoDB Atlas) e, na segunda entrega, na observabilidade.

- **Front-end**: `frontend/` — Create React App, chama a API via `REACT_APP_API_URL` (variável de
  build-time; em produção é `/api`, caminho relativo, porque o Load Balancer serve front-end e API
  no mesmo domínio).
- **Back-end**: `backend/` — Express + Mongoose. `index.js` monta as mesmas rotas em `/` e em
  `/api` (`app.use('/', router); app.use('/api', router);`) para não precisar de rewrite de URL no
  Load Balancer. `logger.js` é o módulo de logging estruturado (ver seção abaixo).
- **Banco local**: `banco-de-dados/` — imagem Docker de um MongoDB só para `docker-compose`. Em
  produção o banco é MongoDB Atlas (Cluster0, tier M0), não este container.
- **`docker-compose.yaml`**: sobe front-end + back-end + Mongo local para desenvolvimento.

## Como rodar localmente

```bash
docker-compose up --build
```

Front-end em `http://localhost` (porta 80), back-end em `http://localhost:5000`, Mongo em
`localhost:27017`. Sem isso, `backend/index.js` também roda direto com `node index.js` (variável
`MONGO_URI` tem fallback pro Mongo do compose; sem Mongo nenhum, o servidor HTTP sobe mesmo assim,
só as rotas que tocam o banco falham).

## Infraestrutura em produção (resumo — sem credenciais)

- App ao vivo em `https://todo-2026-m2.duckdns.org`.
- Projeto GCP: `todo-infra-2026-m2`, região `southamerica-east1`.
- Front-end: bucket GCS multi-região `todo-frontend-todo-infra-2026-m2` + Cloud CDN
  (backend-bucket `front-bb`). Back-end: Cloud Run `backend` (min 2 / max 10 instâncias, ingress
  restrito ao Load Balancer). Banco: MongoDB Atlas `Cluster0` (M0), allowlist de IP só com o IP
  fixo de saída do Cloud NAT.
- Segurança segue "bloquear tudo, liberar só o necessário" em todas as camadas, exceto na borda
  pública (Load Balancer/Cloud Armor), que segue "permitir por padrão, bloquear abuso identificado"
  (rate limiting + bloqueio geográfico).
- Documentação completa e diagramas técnicos (Mermaid, diagrama-como-código) estão em
  `docs/entrega2/`. **Não existe pasta `docs/entrega1/` dentro deste repositório** — os
  entregáveis da primeira entrega (PNG antigo, .docx) ficam num diretório irmão fora do git, só
  como referência histórica; não recrie nem copie esses arquivos para dentro deste repo.

## Observabilidade (Entrega 2)

- Ferramenta de painéis: **Grafana Cloud**. Fonte de dados: **Cloud Monitoring**, alimentado por
  **log-based metrics** extraídas dos logs estruturados do backend e dos logs de requisição do
  Load Balancer/Cloud Armor, mais **Uptime Checks** gerenciados do GCP.
- `observability/` — script `setup-cloud-monitoring.sh` (idempotente) e as configs YAML das
  log-based metrics. Reproduz tudo que foi criado no GCP para a observabilidade, exceto a chave da
  service account do Grafana (passo manual documentado no próprio script — nunca automatizar
  criação de chave, e nunca commitar uma).
- `docs/entrega2/` — diagramas Mermaid e a fundamentação completa dos painéis.
- **Logging estruturado do backend** (`backend/logger.js`): uma linha JSON por evento no stdout,
  campos padrão `severity`, `time`, `service`, `environment`, `event`. Eventos: `http_request`
  (toda requisição, com `route`, `status`, `duration_ms`), `db_operation` (toda chamada Mongoose,
  com sucesso/falha e duração), `business_event` (criação/conclusão/reabertura/exclusão de
  tarefa). **Nunca** logar o texto da tarefa do usuário, senha, token ou connection string.

## Coisas para nunca fazer

- **Nunca modifique o diretório irmão `demonstracao_sse`** (fora deste repositório, em
  `../demonstracao_sse` relativo à raiz deste repo). É o repositório de um professor, usado só
  como referência de uma técnica de teste (disparar um erro conhecido e observar a reação num
  painel) — não faz parte desta infraestrutura e não deve aparecer em commits, diagramas ou
  documentação deste projeto como se fizesse.
- Não recriar chave de service account sem necessidade explícita — este projeto tem a política de
  organização `iam.disableServiceAccountKeyCreation` ativa por padrão; criar uma chave exige
  liberar essa política temporariamente (permissão `roles/orgpolicy.policyAdmin`, concedida no
  nível da organização) e religá-la logo depois. Ver `observability/setup-cloud-monitoring.sh` e
  `docs/entrega2/observabilidade.md` para o procedimento e o racional de segurança.
- Não alterar o IAM do Cloud Run (`backend`) para restringir `run.invoker` de `allUsers` — isso
  quebraria o site em produção. Ver a nota de fidelidade em `docs/entrega2/diagrama-arquitetura.md`
  para o porquê (Load Balancer externo sem IAP não autentica o tráfego que repassa).
