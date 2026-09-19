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

O primeiro registro alimenta `app_http_requests` — essa métrica continua sendo coletada, mas desde
a reestruturação de escopo (ver nota na Seção 3) não alimenta mais nenhum painel fundamentado;
fica aqui só como o lado "requisição HTTP" da correlação. O segundo alimenta `app_db_operations`
(`operation=update`, `result=failure`) — é o que aparece no **Painel 4a**. O `request_id`
compartilhado comprova que os dois eventos vêm da mesma requisição HTTP: o usuário tentou
`PATCH /todos/id-invalido`, o Express roteou para `/todos/:id`, a chamada ao Mongoose (`findById`)
lançou `CastError`, o backend logou a falha do banco e depois devolveu HTTP 500 — a cadeia
completa, do evento na aplicação até o Painel 4a.

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

**Nota de honestidade sobre escopo**: após uma reestruturação de prioridades (ver Seção 4), os
painéis que consumiam `app_http_requests`, `app_http_request_duration` e `app_business_events`
foram removidos do dashboard. As três métricas continuam sendo coletadas normalmente (o
`logger.js` do backend não mudou, e remover a coleta não foi pedido) — só não são mais
visualizadas em nenhum painel fundamentado nem de referência. Isso é declarado aqui para não dar a
entender, silenciosamente, que elas ainda alimentam algo.

## 4. Os painéis

Depois de uma reestruturação de escopo, o dashboard tem **4 painéis fundamentados com os 10 itens
completos — Painéis 4, 5, 7 e 9 — atendendo ao mínimo de 4 exigido pelo enunciado**, mais **1
painel de referência operacional (Painel 8), fora dessa exigência**, decisão explícita do usuário,
implementado em 3 sub-painéis (8a/8b/8c). No Grafana isso totaliza **8 painéis** (4a, 4b, 5, 7, 9,
8a, 8b, 8c) — a numeração dos painéis removidos (1, 2, 3, 6) não foi reaproveitada, para não gerar
confusão com referências antigas a eles.

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

### Painel 9 — Bloqueios por abuso (rate-limit)

1. **Pergunta**: a regra de rate-based-ban do Cloud Armor (100 requisições/min por IP → ban de 10
   minutos) está de fato acionando, e com que frequência — independente do bloqueio geográfico do
   Painel 7?
2. **Motivo**: o Painel 7 responde "de onde vêm os acessos e se região bloqueada é rejeitada"; este
   painel responde uma pergunta diferente — "alguém está abusando da API por volume (não por
   origem), e a defesa contra isso está funcionando?". Sem ele, a regra de rate-limit (documentada
   desde a Entrega 1) fica tão "no papel" quanto o bloqueio geográfico estava antes do Painel 7.
3. **Origem dos dados**: mesmos logs de requisição do Load Balancer com Cloud Armor anexado
   (`api-bs`) do Painel 7, campo `jsonPayload.enforcedSecurityPolicy.{configuredAction,outcome}`;
   mesma log-based metric `lb_requests_by_region` (nenhuma métrica nova foi criada), agrupada por
   `configured_action` em vez de `region_code` — é isso que separa este painel do bloqueio
   geográfico: `configured_action=RATE_BASED_BAN` identifica avaliações pela regra de taxa,
   diferente de `configured_action=DENY` da regra geográfica.
4. **Consulta e cálculo**: contagem de `lb_requests_by_region` agrupada por `configured_action` e
   `outcome`, no período. `outcome=ACCEPT` numa linha `RATE_BASED_BAN` significa "avaliado pela
   regra, dentro do limite" (`RATE_LIMIT_THRESHOLD_CONFORM`); `outcome=DENY` significaria a banda
   realmente acionando.
5. **Recorte temporal**: janela recomendada de 6h (padrão do dashboard) a 7 dias — abuso por volume
   pode ser um evento raro e pontual, então uma janela mais longa aumenta a chance de capturar algo.
6. **Visualização**: série temporal simples de contagem por `configured_action`/`outcome` — mesmo
   padrão dos demais painéis fundamentados, sem necessidade de nada mais elaborado.
7. **Interpretação**: no uso normal, esperado é 100% `outcome=ACCEPT` (tráfego dentro do limite);
   qualquer linha com `outcome=DENY` é a prova de que alguém excedeu 100 req/min de um único IP e
   foi banido por 10 minutos.
8. **Critérios de atenção**: qualquer ocorrência de `outcome=DENY` já é digna de atenção — em
   condições normais de uso da turma, não se espera que ninguém bata o limite; se acontecer de
   forma repetida vinda do mesmo período, vale cruzar com o Painel 7 para ver se também é uma
   região que deveria estar geo-bloqueada.
9. **Ação decorrente**: se `outcome=DENY` aparecer sem explicação (não foi um teste do grupo),
   investigar o IP de origem via log bruto do Load Balancer e decidir se merece bloqueio permanente
   (regra geográfica ou de IP) além do ban temporário automático.
10. **Validação e limitações**: consultado nesta sessão via `/api/ds/query` do Grafana — **só
    existem entradas com `configured_action=RATE_BASED_BAN` e `outcome=ACCEPT`** (confirmado
    agrupando por `configured_action` e `outcome` juntos); nenhuma requisição desta sessão excedeu
    de fato o limite de 100/min de um único IP. **Validação pendente**: o grupo não gerou tráfego
    suficiente para acionar o ban de verdade — isso exigiria disparar 100+ requisições em menos de
    um minuto do mesmo IP, o que não foi feito para não sobrecarregar desnecessariamente a aplicação
    em produção durante os testes desta sessão. Documentado aqui como limitação honesta, no mesmo
    padrão já usado para o teste geográfico pendente do Painel 7 (linha 5 da tabela da Seção 6).

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

**Forma de visualização (atualizada)**: seguindo uma referência visual anexada pelo usuário
(`docs/imagem apenas de referencias.jpeg`, na pasta irmã fora do repo — um card "Servidor (Host)"
com gauges em arco verde/amarelo/vermelho e um stat simples), os três sub-painéis deixaram de ser
série temporal e viraram indicadores do **valor atual**:
- **8a (CPU) e 8b (Memória)**: painéis do tipo `gauge`, unidade `percentunit` (confirmado com
  valor real antes de fixar: CPU retornou `0.00121` = 0,12%, memória `0.1937` = 19,37% — as
  métricas nativas de utilização do Cloud Run vêm mesmo como fração 0–1, não como 0–100).
  Limiares de cor (decisão do grupo, não é um SLA formal do GCP): verde até 50%, amarelo até 80%,
  vermelho acima disso. Consultam só os últimos 10 minutos (`timeFrom: 10m`) e reduzem para o
  último valor não-nulo (`lastNotNull`) — sem eixo de tempo.
- **8c (Instâncias)**: painel do tipo `stat`, unidade simples (contagem), mostrando o valor atual
  de instâncias `active` e `idle` lado a lado, mesma janela de 10 minutos e mesma redução para o
  último valor.

## 5. Limitações conhecidas (documentadas, não escondidas)

- `front-bb` (backend-bucket do front-end) não gera log de requisição — testado nesta sessão via
  API do Compute Engine (v1 e beta, PATCH e PUT), campo `logConfig` não é aplicado a esse tipo de
  backend. O Painel 7 cobre só tráfego de API.
- Ausência de dado num painel, num dado período, significa **ausência de coleta ou de tráfego**,
  não "ausência de erro" — por exemplo, o Painel 9 (rate-limit) sem nenhuma linha `outcome=DENY`
  não significa que a proteção parou de funcionar, significa que ninguém excedeu o limite naquele
  intervalo. Essa distinção é importante e é feita explicitamente aqui porque o enunciado pede que
  ela não seja confundida.
- `app_http_requests`, `app_http_request_duration` e `app_business_events` continuam sendo
  coletadas (o logger do backend não mudou), mas não alimentam mais nenhum painel do dashboard
  desde a reestruturação de escopo — ver nota na Seção 3.
- Retenção: logs brutos ~30 dias (Cloud Logging); séries temporais do Cloud Monitoring retidas por
  mais tempo, conforme padrão do próprio serviço — ambos administrados pelo GCP, não configurados
  manualmente pelo grupo.

## 6. Testes e evidências

**Cenário executado**: `observability/gerar-trafego.sh 10`, contra o domínio público
`https://todo-2026-m2.duckdns.org`, em **2026-09-17, 23:11:54Z–23:12:04Z (UTC)**. Backend na
revisão `backend-00004-9tq` (primeira revisão com a instrumentação desta entrega).

> Nota sobre esta tabela: linhas de evidência que só validavam os Painéis 1, 2, 3 ou 6 (removidos
> na reestruturação de escopo) foram retiradas daqui. A linha da falha controlada, que originalmente
> citava o Painel 2 além do 4a/4b, foi mantida e editada para referenciar só os painéis que
> continuam existindo — conforme pedido explicitamente ao reestruturar o escopo.

| # | Cenário | Esperado | Observado | Painel |
|---|---|---|---|---|
| 1 | `GET /api/health` | 200, usado pelo Uptime Check | HTTP 200 confirmado por `curl` | 5 |
| 2 | **Falha controlada**: `PATCH /todos/id-invalido` | HTTP 500; `db_operation` com `result=failure`, `error_type=CastError` | HTTP 500 confirmado; par de logs com `request_id` compartilhado capturado (Seção 2); no Painel 4a, a operação `update` aparece com `result=failure` no minuto do teste, e no Painel 4b a duração dessa chamada (2,06 ms) entra na distribuição de `update` | 4a, 4b |
| 3 | Uptime Check (`todo-frontend-home`, `todo-api-health`) nas últimas 3h | `check_passed` ≈ 100% | consulta MQL retornou `fraction_true = 1` (100%) para os dois checks | 5 |
| 4 | Origem geográfica do tráfego real (LB + Cloud Armor) | países reais aparecendo com `outcome=ACCEPT` | consulta MQL retornou séries reais de `BR`, `BE`, `PY`, `US`, `SG`, todas `ACCEPT` — nenhuma tentativa de região bloqueada (`KP`/`DE`) ocorreu de fato nesta janela, como esperado (ver limitação abaixo) | 7 |
| 5 | **Pendente**: acesso via VPS na Alemanha, após ampliar a regra geográfica para incluir `DE` | `region_code=DE`, `outcome=DENY`, HTTP 403 no cliente | a executar pelo grupo; preencher aqui com horário, captura e a linha de log real quando feito | 7 |
| 6 | Métricas nativas do Cloud Run, valor pontual (gauge, últimos 10 min) | valores plausíveis de CPU/memória/instâncias | CPU = 0,12%, memória = 19,37%, instâncias: 1 ativa + 1 ociosa (consistente com `min-instances=2`) — confirmado via `/api/ds/query` com a query final (sem `every`, `timeFrom: 10m`) | 8a/8b/8c |
| 7 | Regra de rate-based-ban (`configured_action=RATE_BASED_BAN`) nas últimas 6h | mistura de `outcome=ACCEPT` (normal) e, idealmente, algum `DENY` (banimento real) | consulta MQL retornou **só `outcome=ACCEPT`** (`RATE_LIMIT_THRESHOLD_CONFORM`) — nenhuma requisição desta sessão excedeu 100/min de um único IP. **Validação pendente**: falta gerar tráfego acima do limite de propósito (não feito nesta sessão para não sobrecarregar a produção) | 9 |

**Caminho evento → log → painel demonstrado** (item obrigatório do enunciado): documentado na
Seção 2 com o par de registros reais do teste 2 — mesmo `request_id` no `http_request` (rota
`/todos/:id`, status 500, que não alimenta mais nenhum painel fundamentado após a reestruturação)
e no `db_operation` (`operation=update`, `result=failure`, `error_type=CastError`), que alimenta a
log-based metric consultada pelo Painel 4a diretamente no Cloud Monitoring, consultado pelo
Grafana.

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

Queries dos Painéis 1, 2, 3 e 6 foram removidas desta lista junto com os painéis (histórico
disponível no controle de versão do git, se precisar consultar).

```
Painel 4a — fetch cloud_run_revision
  | metric 'logging.googleapis.com/user/app_db_operations'
  | align rate(1m) | group_by [metric.operation, metric.result], sum(val())

Painel 4b — fetch cloud_run_revision
  | metric 'logging.googleapis.com/user/app_db_operation_duration'
  | group_by [metric.operation], percentile(val(), 95) | every 1m

Painel 5 — fetch uptime_url
  | metric 'monitoring.googleapis.com/uptime_check/check_passed'
  | align next_older(5m) | group_by [resource.host, metric.check_id], fraction_true(val())

Painel 7 — fetch l7_lb_rule
  | metric 'logging.googleapis.com/user/lb_requests_by_region'
  | align rate(5m) | group_by [metric.region_code, metric.outcome], sum(val())

Painel 9 — fetch l7_lb_rule
  | metric 'logging.googleapis.com/user/lb_requests_by_region'
  | align rate(5m) | group_by [metric.configured_action, metric.outcome], sum(val())

Painel 8a/8b — fetch cloud_run_revision
  | metric 'run.googleapis.com/container/cpu/utilizations' (ou .../memory/utilizations)
  | group_by [], mean(val())
  (painel tipo gauge, sem "every" — instantâneo, timeFrom: 10m, reduzido para lastNotNull)

Painel 8c — fetch cloud_run_revision
  | metric 'run.googleapis.com/container/instance_count'
  | group_by [metric.state], mean(val())
  (painel tipo stat, sem "every" — instantâneo, timeFrom: 10m, reduzido para lastNotNull)
```
