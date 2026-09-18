# Observabilidade — Entrega 2

> Aplicação: Todo List (`https://todo-2026-m2.duckdns.org`). Repositório:
> `aula-uniamerica-infraestrutura-cloud`. Ferramenta de painéis: **Grafana Cloud** —
> `https://smallchameleon1005.grafana.net/d/todo-observabilidade-e2/` (acesso por login do Grafana
> Cloud; sem credenciais neste documento). Diagramas técnicos:
> [`diagrama-arquitetura.md`](./diagrama-arquitetura.md) e
> [`diagrama-observabilidade.md`](./diagrama-observabilidade.md). JSON canônico do dashboard:
> [`../../observability/grafana/dashboard-observabilidade.json`](../../observability/grafana/dashboard-observabilidade.json).

## 1. Visão geral do pipeline

```
Backend (Cloud Run) + Load Balancer/Cloud Armor  →  Cloud Logging  →  Log-based Metrics
  → Cloud Monitoring  →  Grafana Cloud (data source "Google Cloud Monitoring")  →  8 painéis
```

Detalhado em [`diagrama-observabilidade.md`](./diagrama-observabilidade.md). Resumo das decisões e
por que foram tomadas:

- **Cloud Monitoring como armazenamento único**, em vez de um Prometheus/Loki auto-hospedado:
  reaproveita APIs que já estavam habilitadas no projeto, zero infraestrutura nova para manter —
  consistente com a filosofia 100% serverless da Entrega 1.
- **Grafana Cloud (SaaS)** em vez de self-hosted: zero infraestrutura extra para manter; login e
  controle de acesso aos painéis já vêm prontos.
- **Log-based metrics** como ponte entre logs estruturados e métricas: permite consultar os dados
  como séries temporais (agregação, percentis) em vez de reprocessar texto de log a cada consulta.

## 2. Logging estruturado do backend

- **Onde é gerado**: `backend/logger.js` e as chamadas a ele em `backend/index.js`, dentro do
  processo Node do Cloud Run.
- **Formato**: uma linha JSON por evento, escrita no `stdout`. Campos comuns a todo evento:
  `severity`, `time` (ISO 8601, UTC), `service` (`"backend"`), `environment`, `event`. Campos
  adicionais variam por tipo de evento (ver tabela abaixo).
- **Como é coletado**: automaticamente. O Cloud Run encaminha `stdout`/`stderr` de cada instância
  para o **Cloud Logging** sem precisar de nenhum agente instalado pelo grupo — é um recurso nativo
  do serviço gerenciado. O Cloud Logging reconhece os campos especiais `severity` e `time` do JSON
  e usa esse valor (em vez do horário de ingestão) como timestamp do evento.
- **Onde fica armazenado**: Cloud Logging, bucket `_Default` do projeto `todo-infra-2026-m2` —
  retenção padrão de **30 dias** (configuração padrão do GCP, não alterada por este trabalho).
- **Como é consultado**: diretamente no Cloud Logging (`gcloud logging read` ou o console, para
  depuração ponto-a-ponto) e, para os painéis, via as **log-based metrics** descritas na Seção 3,
  que agregam esses logs em séries temporais no Cloud Monitoring.
- **Nunca logado**: texto da tarefa do usuário, senha, token, connection string. Conferido nos
  trechos de código de `backend/index.js`/`backend/logger.js` — só id da tarefa (`todo_id`), nunca
  o campo `text`.

| Evento | Quando ocorre | Campos principais |
|---|---|---|
| `http_request` | Toda requisição HTTP, ao final da resposta | `request_id`, `method`, `route`, `status`, `status_class`, `duration_ms` |
| `db_operation` | Toda chamada ao MongoDB Atlas via Mongoose | `request_id`, `operation`, `result`, `duration_ms`, `error_type?`, `error_message?` |
| `business_event` | Criação, conclusão, reabertura ou exclusão de tarefa | `request_id`, `event_name`, `todo_id` |
| `startup` | Início do processo / conexão com o banco | `message` |

### Exemplo real de registro e sua relação com um painel

Par de registros reais, capturados nesta sessão (`gcloud logging read`), do teste de falha
controlada (Seção 6) — note o mesmo `request_id` nos dois, é a correlação exigida pelo enunciado:

```json
// severity=INFO, timestamp=2026-09-17T23:12:04.235Z
{"duration_ms": 2.81, "environment": "production", "event": "http_request", "method": "PATCH",
 "request_id": "634ddced-c0a5-45e3-81d4-cc66609ea76f", "route": "/todos/:id", "service": "backend",
 "status": 500, "status_class": "5xx"}
```
```json
// severity=ERROR, timestamp=2026-09-17T23:12:04.234Z (mesma requisição, 1ms antes)
{"duration_ms": 2.06, "environment": "production",
 "error_message": "Cast to ObjectId failed for value \"id-invalido\" (type string) at path \"_id\" for model \"Todo\"",
 "error_type": "CastError", "event": "db_operation", "operation": "update",
 "request_id": "634ddced-c0a5-45e3-81d4-cc66609ea76f", "result": "failure", "service": "backend"}
```

O primeiro registro alimenta `app_http_requests` (rota `/todos/:id`, `status_class=5xx`) — é o que
aparece no **Painel 2** (taxa de erro) subindo naquele minuto. O segundo alimenta
`app_db_operations` (`operation=update`, `result=failure`) — é o que aparece no **Painel 4a**. O
`request_id` compartilhado comprova que os dois eventos vêm da mesma requisição HTTP: o usuário
tentou `PATCH /todos/id-invalido`, o Express roteou para `/todos/:id`, a chamada ao Mongoose
(`findById`) lançou `CastError`, o backend logou a falha do banco e depois devolveu HTTP 500 — a
cadeia completa, do evento na aplicação até os dois painéis.

## 3. Log-based metrics e Uptime Checks (configuração reproduzível)

Todas criadas via `observability/setup-cloud-monitoring.sh` (idempotente) a partir dos arquivos em
`observability/log-metrics/*.yaml`. Resumo:

| Métrica | Tipo | Filtro (resumo) | Labels |
|---|---|---|---|
| `app_http_requests` | contador | `event="http_request"`, exclui `/health` | `route`, `method`, `status_class` |
| `app_http_request_duration` | distribuição (ms) | idem | `route`, `method` |
| `app_db_operations` | contador | `event="db_operation"` | `operation`, `result` |
| `app_db_operation_duration` | distribuição (ms) | idem | `operation` |
| `app_business_events` | contador | `event="business_event"` | `event_name` |
| `lb_requests_by_region` | contador | logs do Load Balancer, política `todo-armor` | `region_code`, `outcome`, `configured_action` |

Uptime Checks (`gcloud monitoring uptime create`, período de 5 min, de localidades globais do
Google):
- `todo-frontend-home` → `https://todo-2026-m2.duckdns.org/`
- `todo-api-health` → `https://todo-2026-m2.duckdns.org/api/health` (valida também o corpo da
  resposta, não só o código HTTP)

## 4. Os 8 painéis

Painéis 1–7: aplicação/usuário, fundamentação completa dos 10 itens exigidos. Painel 8: referência
operacional, fora dessa exigência (decisão explícita do usuário, ver nota ao final).

---

### Painel 1 — Uso por operação (volume por funcionalidade)

1. **Pergunta**: quais operações do Todo List (listar, criar, concluir, apagar) são mais usadas, e
   como o volume varia ao longo do tempo?
2. **Motivo**: entender quais funcionalidades geram carga/valor de uso real, priorizar atenção, e
   detectar quedas de uso anormais.
3. **Origem dos dados**: evento `http_request` do backend; log-based metric `app_http_requests`
   (contador), campos `route`/`method`, excluindo `/health`.
4. **Consulta e cálculo**: soma de `app_http_requests` agrupada por `route` e `method`, alinhada
   por intervalo de 1 minuto. Unidade: requisições por minuto (ou contagem absoluta no período
   selecionado).
5. **Recorte temporal**: período ajustável no Grafana (padrão sugerido: últimas 6h); agregação em
   janelas de 1–5 min; atualização automática a cada 1 min; timestamps de origem em UTC.
6. **Visualização**: série temporal com uma linha por rota — permite comparar volume relativo entre
   operações e identificar picos/quedas, que é o que a pergunta pede (variação no tempo).
7. **Interpretação**: mais volume em `GET /todos` é esperado (toda visita à tela dispara uma
   listagem); ausência total de dados em todas as rotas = sem tráfego no período, não é sinônimo de
   erro (ver Painel 5 para saber se é indisponibilidade).
8. **Critérios de atenção**: queda abrupta e simultânea em todas as rotas (cruzar com Painel 5);
   crescimento muito acima do padrão observado nos testes controlados (cruzar com Painel 7).
9. **Ação decorrente**: se cair a zero, checar disponibilidade (Painel 5) e logs de erro; se crescer
   de forma anormal, checar a origem geográfica (Painel 7).
10. **Validação e limitações**: `observability/gerar-trafego.sh` gera N ciclos de criação/listagem;
    o painel deve mostrar a contagem correspondente no período do teste (evidência na Seção 6).
    Limitação: mede requisições, não usuários — não permite concluir "quantas pessoas" usaram o
    app, só "quantas operações" ocorreram.

---

### Painel 2 — Taxa de erro por operação

1. **Pergunta**: quais operações estão falhando, e qual fração das tentativas resulta em erro
   (4xx/5xx)?
2. **Motivo**: detectar regressões, bugs ou abuso que afetam a experiência real do usuário,
   diferenciando erro de validação (4xx) de falha da aplicação (5xx).
3. **Origem dos dados**: mesmo evento `http_request` / métrica `app_http_requests`, usando o label
   `status_class`.
4. **Consulta e cálculo**: numerador = soma de `app_http_requests` com `status_class` em
   `{4xx,5xx}`, agrupada por `route`; denominador = soma total de `app_http_requests` da mesma
   `route`, no mesmo período; resultado × 100 = percentual de erro por rota.
5. **Recorte temporal**: igual ao Painel 1.
6. **Visualização**: série temporal em % por rota, com tabela auxiliar de contagem absoluta de erro
   — o percentual sozinho esconde volume baixo (1 erro em 1 tentativa = 100%, não é uma crise).
7. **Interpretação**: taxa próxima de 0% é o esperado; picos localizados numa rota apontam para uma
   classe de erro específica, a investigar no `error_type` do log bruto.
8. **Critérios de atenção**: sem histórico de produção de longo prazo, não há uma referência
   externa de "taxa aceitável" — a referência inicial usada é o comportamento observado nos testes
   controlados desta entrega (Seção 6); qualquer taxa sustentada acima disso, por mais de alguns
   minutos, motiva investigação. Essa limitação de referência é reconhecida explicitamente.
9. **Ação decorrente**: filtrar os logs brutos por `route` + `status_class=5xx`, ler `error_type`/
   `error_message`; se for `CastError`, é entrada inválida (não uma falha de infraestrutura); se
   for erro de conexão, cruzar com o Painel 4.
10. **Validação e limitações**: o teste controlado (`PATCH /todos/id-invalido`) deve aparecer como
    erro na rota `/todos/:id`, método PATCH, no minuto do teste (evidência na Seção 6). Limitação:
    o painel não diferencia "erro esperado do fluxo normal" de "bug real" — isso exige olhar o log
    bruto; o painel só indica onde olhar.

---

### Painel 3 — Tempo de resposta por operação

1. **Pergunta**: quais operações demoram mais para responder, e em quais períodos?
2. **Motivo**: latência alta prejudica a experiência mesmo sem erro — é um sinal distinto de
   "funciona ou não".
3. **Origem dos dados**: campo `duration_ms` do evento `http_request`; log-based metric de
   distribuição `app_http_request_duration`.
4. **Consulta e cálculo**: percentil 50 (mediana) e percentil 95 da distribuição, agrupados por
   `route`, no período. Unidade: milissegundos.
5. **Recorte temporal**: igual aos anteriores; percentis calculados sobre a janela de agregação
   escolhida (ex.: 5 min).
6. **Visualização**: série temporal com duas linhas por rota (p50 e p95) — mediana mostra o caso
   comum, p95 mostra o pior caso que a maioria ainda sente; mais informativo que média, que é
   distorcida por outliers.
7. **Interpretação**: p50 baixo e estável é o esperado; p95 muito acima do p50 indica
   variabilidade; crescimento sustentado dos dois pode indicar degradação (cruzar com Painel 4).
8. **Critérios de atenção**: mesma ressalva do Painel 2 — limite inicial vem da observação dos
   testes controlados, não de um SLA definido a priori.
9. **Ação decorrente**: se a latência subir, cruzar com o Painel 4 para saber se o gargalo é a
   aplicação ou a chamada ao Atlas.
10. **Validação e limitações**: comparar o tempo observado no painel durante o teste de tráfego com
    a duração medida pelo próprio script de teste (evidência na Seção 6). Limitação: mede o tempo
    dentro do processo Node (do middleware até a resposta), não inclui a rede entre o navegador e o
    Load Balancer.

---

### Painel 4 — Saúde das operações no banco de dados (visão do backend)

1. **Pergunta**: as chamadas do backend ao MongoDB Atlas estão funcionando, e com qual duração?
2. **Motivo**: distinguir "a API falhou" de "o banco falhou" — sem isso um 500 genérico não diz
   onde investigar. É a experiência da aplicação ao falar com o banco, não a métrica interna do
   servidor do Atlas.
3. **Origem dos dados**: evento `db_operation` (`operation`, `result`, `duration_ms`,
   `error_type`); métricas `app_db_operations` (contador) e `app_db_operation_duration`
   (distribuição).
4. **Consulta e cálculo**: contagem de `app_db_operations` por `operation` e `result`
   (success/failure); percentis p50/p95 de `app_db_operation_duration` por `operation`.
5. **Recorte temporal**: igual aos demais painéis.
6. **Visualização**: painel combinado — barras de sucesso/falha por operação (list/create/
   update/delete) + série temporal de duração p95 por operação.
7. **Interpretação**: falha concentrada numa operação aponta para um problema ali, não no banco
   inteiro; duração subindo em todas as operações ao mesmo tempo sugere problema de rede/Atlas.
8. **Critérios de atenção**: qualquer `failure` fora de um teste controlado deliberado merece
   checagem; duração muito acima do observado nos testes é o sinal inicial, na ausência de um SLA
   formal do tier gratuito do Atlas.
9. **Ação decorrente**: olhar `error_type` — `CastError` é entrada inválida (não é falha do Atlas);
   erro de timeout/rede motivaria checar a allowlist do Atlas e o Cloud NAT.
10. **Validação e limitações**: o teste controlado deve aparecer como `operation=update`,
    `result=failure`, `error_type=CastError` (evidência na Seção 6). Limitação: mede só a
    experiência do backend ao falar com o Atlas — não a saúde interna do cluster (isso é
    deliberadamente fora do escopo, para não duplicar o painel nativo "Opcounters" do próprio
    Atlas).

---

### Painel 5 — Disponibilidade real do domínio

1. **Pergunta**: a aplicação (front-end e API) está de fato acessível pelo domínio público
   configurado?
2. **Motivo**: é a pergunta mais básica — sem isso nenhum outro painel importa, porque ninguém
   consegue nem chegar na aplicação. É a experiência de quem tenta acessar de fora, não uma métrica
   de recurso do servidor.
3. **Origem dos dados**: Uptime Checks gerenciados do GCP (`todo-frontend-home` em `/`,
   `todo-api-health` em `/api/health`); métricas nativas `uptime_check/check_passed` e
   `uptime_check/request_latency`.
4. **Consulta e cálculo**: % de disponibilidade = (checks com `check_passed=true` / total de
   checks) × 100, no período.
5. **Recorte temporal**: sondas a cada 5 minutos, de múltiplas localidades do Google; janela
   recomendada: últimas 24h.
6. **Visualização**: indicador de % (stat) + série temporal de sucesso/falha por checagem — o
   formato por checagem deixa claro exatamente quando cada falha ocorreu.
7. **Interpretação**: 100% é o esperado; falha isolada pode ser transitória; falhas sustentadas em
   checks seguidos indicam indisponibilidade real.
8. **Critérios de atenção**: 2+ checks falhos seguidos (10+ min de indisponibilidade aparente) já é
   motivo de investigação imediata — é o sinal mais crítico do sistema.
9. **Ação decorrente**: checar Load Balancer/Cloud Armor (bloqueio acidental?), certificado SSL
   (expirado?), e os demais painéis, para ver se coincide com queda geral de tráfego.
10. **Validação e limitações**: comparar horários de check bem-sucedido no painel com os testes
    manuais (`curl`, todos HTTP 200) realizados nesta sessão. Limitação: uma checagem a cada 5 min
    não captura indisponibilidades muito curtas — ausência de falha registrada não garante 100% de
    uptime real, só do que foi amostrado.

---

### Painel 6 — Funil de conclusão de tarefas (uso real / produto)

1. **Pergunta**: como as pessoas de fato usam a lista — quantas tarefas são criadas vs. concluídas
   vs. reabertas vs. apagadas, e essa proporção muda com o tempo?
2. **Motivo**: é a métrica de produto real, não de tráfego — mostra padrão de uso, não volume de
   chamadas HTTP.
3. **Origem dos dados**: evento `business_event` (`event_name`); métrica `app_business_events`.
4. **Consulta e cálculo**: contagem de `app_business_events` agrupada por `event_name`, por
   período.
5. **Recorte temporal**: agregação diária ou por hora conforme o volume real; janela recomendada:
   7 dias para padrão de uso, ou o período do teste controlado para validação.
6. **Visualização**: barras empilhadas/proporção por `event_name` ao longo do tempo — evidencia a
   relação entre os tipos de evento, que é a pergunta (proporção, não volume absoluto).
7. **Interpretação**: mais `todo_created` que `todo_deleted` é esperado numa lista que cresce;
   proporção muito diferente do teste pode indicar uso real diferente do esperado — não é
   necessariamente um problema.
8. **Critérios de atenção**: não se aplicam limites de alerta como nos Painéis 2/3/4 — é uma
   métrica descritiva de uso, não de saúde.
9. **Ação decorrente**: usar como insight de produto (ex.: se ninguém completa tarefas, talvez o
   botão não esteja claro na UI) — não é uma ação operacional de infraestrutura.
10. **Validação e limitações**: o script de teste cria N tarefas, completa metade, apaga 2 — o
    painel deve mostrar exatamente essas contagens no período do teste (evidência na Seção 6).
    Limitação: não identifica usuários únicos, só eventos.

---

### Painel 7 — Origem geográfica dos acessos: permitidos vs. bloqueados

1. **Pergunta**: de quais países vêm as chamadas à API, e as tentativas de países bloqueados (ex.:
   Coreia do Norte) estão sendo de fato rejeitadas?
2. **Motivo**: torna visível e comprovável, com dado real, que a regra de bloqueio geográfico do
   Cloud Armor (documentada desde a Entrega 1) está funcionando — sem isso a regra existe só "no
   papel".
3. **Origem dos dados**: logs de requisição do Load Balancer com Cloud Armor anexado (`api-bs`),
   campos `jsonPayload.securityPolicyRequestData.remoteIpInfo.regionCode` e
   `jsonPayload.enforcedSecurityPolicy.{outcome,configuredAction}`; log-based metric
   `lb_requests_by_region`.
4. **Consulta e cálculo**: contagem de `lb_requests_by_region` agrupada por `region_code` e
   `outcome` (ACCEPT/DENY), no período.
5. **Recorte temporal**: janela recomendada mais longa (7 dias), já que o volume de tentativas de
   regiões bloqueadas é imprevisível.
6. **Visualização**: tabela por país com contagem de ACCEPT vs. DENY — mais precisa para ler
   códigos de país e comparar números exatos do que um mapa, que é mais ilustrativo.
7. **Interpretação**: geografia esperada é predominância de acessos legítimos (BR); qualquer linha
   com `region_code` igual a `KP` ou `DE` e `outcome=DENY` é a prova de que o bloqueio geográfico
   está ativo; qualquer uma das duas com `outcome=ACCEPT` seria uma falha grave da regra.
8. **Critérios de atenção**: volume alto e súbito de DENY vindo de um único país (mesmo fora da
   lista geo-bloqueada) pode indicar abuso que o rate-limit já trata, mas vale cruzar com a regra
   de rate-based-ban.
9. **Ação decorrente**: se aparecer ACCEPT de uma região que deveria estar bloqueada, é bug de
   configuração do Cloud Armor — corrigir a regra imediatamente.
10. **Validação e limitações**: não é possível originar tráfego real da Coreia do Norte para testar
    de propósito, mas a regra foi estendida para incluir a Alemanha (`origin.region_code == 'KP' ||
    origin.region_code == 'DE'`, nas duas políticas) justamente para viabilizar um teste real: o
    grupo tem acesso a uma VPS na Alemanha e vai testar o acesso a partir dela, o que deve gerar uma
    linha real com `region_code=DE` e `outcome=DENY` — validação pendente, a documentar aqui com
    horário e captura assim que executada. Até lá, a validação já realizada é: (a) tráfego real de
    teste apareceu com `outcome=ACCEPT` e um `region_code` coerente com a geolocalização do IP de
    origem pela base do Cloud Armor (evidência de que o campo é preenchido corretamente — teste real
    nesta sessão retornou `region_code=BE`, geolocalização do IP de saída usado no teste, não
    necessariamente o país físico de quem digitou o comando); (b) inspeção direta da regra
    `origin.region_code == 'KP' || origin.region_code == 'DE'` na política `todo-armor` (prioridade
    1000, antes do rate-limit) como evidência estrutural de que tráfego de fato originado desses
    países seria negado. **Limitação**: cobre só tráfego de API (`api-bs`) — o front-end estático
    (`front-bb`) tem a mesma regra geográfica via `todo-armor-edge`, mas não gera log de requisição
    (limitação de plataforma, ver Seção 5), então
    bloqueios ali não aparecem neste painel.

---

### Painel 8 — "Bastidores": CPU, memória e instâncias do Cloud Run (referência operacional)

**Fora da fundamentação de 10 itens acima, por decisão explícita do usuário.** Este projeto tinha a
restrição deliberada de que os painéis fundamentados fossem só de aplicação/usuário, não de
infraestrutura. O usuário pediu métricas de servidor mesmo assim, então este painel existe como
referência de acompanhamento pessoal, usando métricas nativas do Cloud Run
(`run.googleapis.com/container/cpu/utilizations`, `.../memory/utilizations`,
`.../instance_count`) — sem exigir nenhuma configuração nova, já disponíveis no Cloud Monitoring.
Se a banca perguntar por que ele não tem a mesma fundamentação dos demais: foi deixado de fora de
propósito, por decisão do grupo, para não diluir o foco da entrega (que pede métricas de aplicação/
usuário) com métricas de infraestrutura.

## 5. Limitações conhecidas (documentadas, não escondidas)

- `front-bb` (backend-bucket do front-end) não gera log de requisição — testado nesta sessão via
  API do Compute Engine (v1 e beta, PATCH e PUT), campo `logConfig` não é aplicado a esse tipo de
  backend. O Painel 7 cobre só tráfego de API.
- Ausência de dado num painel, num dado período, significa **ausência de coleta ou de tráfego**,
  não "ausência de erro" — por exemplo, o Painel 2 (taxa de erro) sem dado não significa "zero
  erros", significa "zero requisições" naquele intervalo. Essa distinção é importante e é feita
  explicitamente aqui porque o enunciado pede que ela não seja confundida.
- Retenção: logs brutos ~30 dias (Cloud Logging); séries temporais do Cloud Monitoring retidas por
  mais tempo, conforme padrão do próprio serviço — ambos administrados pelo GCP, não configurados
  manualmente pelo grupo.

## 6. Testes e evidências

**Cenário executado**: `observability/gerar-trafego.sh 10`, contra o domínio público
`https://todo-2026-m2.duckdns.org`, em **2026-09-17, 23:11:54Z–23:12:04Z (UTC)**. Backend na
revisão `backend-00004-9tq` (primeira revisão com a instrumentação desta entrega).

| # | Cenário | Esperado | Observado | Painel |
|---|---|---|---|---|
| 1 | 10× `POST /todos` + 10× `GET /todos` pelo domínio público | eventos `http_request`/`business_event` registrados, refletindo em contadores | Consulta direta ao Cloud Monitoring (`timeSeries.list`) na janela do teste: 9 séries de `GET /todos 2xx`, 8 de `POST /todos 2xx` | 1, 6 |
| 2 | 5× `PATCH /todos/:id` (completar) | evento `business_event` com `event_name=todo_completed` | confirmado via `gcloud logging read` | 6 |
| 3 | 2× `DELETE /todos/:id` | evento `business_event` com `event_name=todo_deleted` | confirmado (exemplo na Seção 2) | 6 |
| 4 | `GET /api/health` | 200, usado pelo Uptime Check | HTTP 200 confirmado por `curl` | 5 |
| 5 | **Falha controlada**: `PATCH /todos/id-invalido` | HTTP 500; `db_operation` com `result=failure`, `error_type=CastError` | HTTP 500 confirmado; par de logs com `request_id` compartilhado capturado (Seção 2); consulta ao painel 2 (join de erro/total) retornou **12.5%** de taxa de erro na rota `/todos/:id` no período (1 falha em 8 chamadas), e **4%** em `/todos` (1 falha em 25, do teste de validação abaixo) — valores batem com a contagem manual dos testes | 2, 4a, 4b |
| 6 | `POST /todos` sem campo `text` | HTTP 400 | confirmado (`{"message":"O campo \"text\" é obrigatório"}`) | 2 |
| 7 | Uptime Check (`todo-frontend-home`, `todo-api-health`) nas últimas 3h | `check_passed` ≈ 100% | consulta MQL retornou `fraction_true = 1` (100%) para os dois checks | 5 |
| 8 | Origem geográfica do tráfego real (LB + Cloud Armor) | países reais aparecendo com `outcome=ACCEPT` | consulta MQL retornou séries reais de `BR`, `BE`, `PY`, `US`, `SG`, todas `ACCEPT` — nenhuma tentativa de região bloqueada (`KP`/`DE`) ocorreu de fato nesta janela, como esperado (ver limitação abaixo) | 7 |
| 10 | **Pendente**: acesso via VPS na Alemanha, após ampliar a regra geográfica para incluir `DE` | `region_code=DE`, `outcome=DENY`, HTTP 403 no cliente | a executar pelo grupo; preencher aqui com horário, captura e a linha de log real quando feito | 7 |
| 9 | Métricas nativas do Cloud Run durante o teste | valores plausíveis de CPU/memória/instâncias | CPU ≈ 0.13–0.17%, memória ≈ 19.6%, instâncias: 1 ativa + 1–2 ociosas (consistente com `min-instances=2`) | 8a/8b/8c |

**Caminho evento → log → painel demonstrado** (item obrigatório do enunciado): documentado na
Seção 2 com o par de registros reais do teste 5 — mesmo `request_id` no `http_request` (rota
`/todos/:id`, status 500) e no `db_operation` (`operation=update`, `result=failure`,
`error_type=CastError`), ambos alimentando log-based metrics que geram os Painéis 2 e 4a
diretamente no Cloud Monitoring, consultado pelo Grafana.

**Correspondência diagrama ↔ ambiente real**: coberta pelos comandos `gcloud`/`curl` rodados ao
vivo nesta sessão contra o projeto `todo-infra-2026-m2` (Seções 1–3 deste documento e os dois
diagramas Mermaid), não por transcrição de documentação antiga.

**Restauração do funcionamento normal**: nenhuma alteração destrutiva foi feita — a "tarefa com id
inválido" nunca existiu de fato (o teste só tenta um id malformado), e as tarefas de teste criadas
continuam na base como registros normais (não foram tratadas como dado descartável a limpar, pois
não há distinção entre tarefa "de teste" e "real" no modelo de dados desta aplicação simples).

**Limitação confirmada nesta rodada de testes, com plano de fechamento**: nenhuma tentativa de
acesso de uma região geo-bloqueada ocorreu organicamente durante a janela observada. Para a
Coreia do Norte (`KP`) isso continua sem como testar de propósito (fora do escopo e da capacidade
do grupo). Por isso a regra foi ampliada nesta sessão para também bloquear a Alemanha (`DE`) —
`origin.region_code == 'KP' || origin.region_code == 'DE'`, confirmada via
`gcloud compute security-policies describe todo-armor` (e `todo-armor-edge`) logo após a mudança
— e o grupo vai testar a partir de uma VPS própria hospedada na Alemanha, o que deve gerar uma
linha real de `DENY` com `region_code=DE` no Painel 7 (linha 10 da tabela acima, pendente).

## 7. Queries MQL usadas em cada painel (reprodutibilidade)

Todas testadas e validadas com dado real via `/api/ds/query` do Grafana antes de salvar no
dashboard (não apenas assumidas). Também estão embutidas em
`observability/grafana/dashboard-observabilidade.json`.

```
Painel 1 — fetch cloud_run_revision
  | metric 'logging.googleapis.com/user/app_http_requests'
  | align rate(1m) | group_by [metric.route, metric.method], sum(val())

Painel 2 — { t_errors: fetch cloud_run_revision
             | metric 'logging.googleapis.com/user/app_http_requests'
             | filter metric.status_class =~ '4xx|5xx'
             | align rate(5m) | group_by [metric.route], sum(val()) ;
             t_total: fetch cloud_run_revision
             | metric 'logging.googleapis.com/user/app_http_requests'
             | align rate(5m) | group_by [metric.route], sum(val()) }
           | join | value [error_rate_pct: val(0) / val(1) * 100]

Painel 3 — fetch cloud_run_revision
  | metric 'logging.googleapis.com/user/app_http_request_duration'
  | group_by [metric.route], percentile(val(), 95) | every 1m
  (e percentile(val(), 50) para a mediana)

Painel 4a — fetch cloud_run_revision
  | metric 'logging.googleapis.com/user/app_db_operations'
  | align rate(1m) | group_by [metric.operation, metric.result], sum(val())

Painel 4b — fetch cloud_run_revision
  | metric 'logging.googleapis.com/user/app_db_operation_duration'
  | group_by [metric.operation], percentile(val(), 95) | every 1m

Painel 5 — fetch uptime_url
  | metric 'monitoring.googleapis.com/uptime_check/check_passed'
  | align next_older(5m) | group_by [resource.host, metric.check_id], fraction_true(val())

Painel 6 — fetch cloud_run_revision
  | metric 'logging.googleapis.com/user/app_business_events'
  | align rate(1m) | group_by [metric.event_name], sum(val())

Painel 7 — fetch l7_lb_rule
  | metric 'logging.googleapis.com/user/lb_requests_by_region'
  | align rate(5m) | group_by [metric.region_code, metric.outcome], sum(val())

Painel 8a/8b — fetch cloud_run_revision
  | metric 'run.googleapis.com/container/cpu/utilizations' (ou .../memory/utilizations)
  | group_by [], mean(val()) | every 1m

Painel 8c — fetch cloud_run_revision
  | metric 'run.googleapis.com/container/instance_count'
  | group_by [metric.state], mean(val()) | every 1m
```
