# Diagrama técnico — Arquitetura da aplicação (Entrega 2)

Este arquivo é ao mesmo tempo a **versão legível** (renderiza como diagrama em qualquer visualizador
Mermaid — GitHub, VS Code, `mermaid.live`) e o **arquivo-fonte editável** do diagrama: é só texto.

Todos os nomes de recurso abaixo são reais, verificados ao vivo contra o projeto GCP
`todo-infra-2026-m2` nesta sessão (não copiados de documentação antiga sem checar). O diagrama do
pipeline de observabilidade (fontes de log/métrica → coleta → armazenamento → painel, e quem pode
consultar) está em [`diagrama-observabilidade.md`](./diagrama-observabilidade.md) — os nós
`CloudRun` (backend) e `Armor` (Cloud Armor) aparecem nos dois diagramas com o mesmo nome, para
deixar a relação entre os dois explícita.

```mermaid
flowchart TB
    User(["Usuário (navegador)"])
    DNS[["DuckDNS<br/>todo-2026-m2.duckdns.org<br/>Registro A → 34.36.229.144"]]

    subgraph GCP["GCP — projeto todo-infra-2026-m2 (região southamerica-east1)"]
        LB["HTTPS Load Balancer global<br/>IP público fixo 34.36.229.144 · TLS 443<br/>certificado gerenciado todo-cert (ACTIVE)<br/>redireciona HTTP 80 → HTTPS 301 (todo-redirect)"]
        Armor["Cloud Armor<br/>todo-armor (anexado à API) e todo-armor-edge (anexado ao front-end)<br/>regra 1: bloqueio geográfico (origin.region_code == KP ou DE) → deny 403<br/>regra 2: rate-based-ban 100 req/min por IP → ban 10 min"]

        subgraph Public["Front-end — ponto de atendimento público, redundante"]
            Bucket["Cloud Storage, multi-região (US)<br/>bucket todo-frontend-todo-infra-2026-m2<br/>+ Cloud CDN (cache em POPs globais)<br/>backend-bucket: front-bb<br/>leitura pública: allUsers → roles/storage.objectViewer"]
        end

        subgraph Restricted["Back-end — sem IP/domínio público próprio"]
            CloudRun["Cloud Run: backend<br/>ingress = internal-and-cloud-load-balancing<br/>min-instances=2 / max=10 (redundância)<br/>service account: backend-sa (privilégio mínimo)"]
        end

        subgraph VPCbox["VPC todo-vpc — subnet todo-subnet, 10.10.0.0/24, sem regras de firewall próprias"]
            NAT["Cloud Router todo-router + Cloud NAT todo-nat<br/>IP de saída fixo: 34.95.244.244"]
        end
    end

    subgraph AtlasBox["MongoDB Atlas — serviço externo gerenciado (fora do projeto GCP)"]
        Mongo[("Cluster0, tier M0<br/>db todo-app / coleção todos<br/>porta 27017, TLS (mongodb+srv)<br/>Network Access allowlist: só 34.95.244.244/32<br/>usuário backend_app: readWrite restrito a todo-app")]
    end

    User -->|"1: consulta DNS"| DNS
    User ==>|"2: HTTPS 443"| LB
    LB --> Armor
    Armor -->|"caminho / e /static/*"| Bucket
    Armor -->|"caminho /api/* — chamado pelo navegador via axios, não pelo bucket"| CloudRun
    CloudRun -->|"egress via VPC (all-traffic)"| NAT
    NAT ==>|"27017/TLS"| Mongo

    BlockedRun["Tentativa: acessar *.run.app direto"] -.->|"bloqueado pelo ingress → HTTP 404"| CloudRun
    BlockedAtlas["Tentativa: IP fora da allowlist"] -.->|"bloqueado no Atlas → timeout de conexão"| Mongo
    BlockedGeo["Tentativa de país bloqueado (Coreia do Norte ou Alemanha)"] -.->|"bloqueado pelo Cloud Armor → HTTP 403"| Armor

    classDef blocked fill:#fde8e8,stroke:#c0392b,color:#7a1f1f;
    class BlockedRun,BlockedAtlas,BlockedGeo blocked;
```

## Legenda

| Estilo | Significado |
|---|---|
| Seta fina `-->` | Consulta DNS (troca de metadado, não é tráfego HTTP) |
| Seta grossa `==>` | Tráfego de aplicação permitido (HTTPS/TLS) |
| Seta tracejada vermelha `-.->`, caixa vermelha | Tentativa de acesso bloqueada, com o ponto exato onde o bloqueio ocorre |
| Retângulo | Recurso do GCP administrado pelo grupo |
| Cilindro | Banco de dados |
| Subgraph "VPC" | Rede privada — nenhum componente ali aceita conexão de entrada da internet |

## Notas de fidelidade (o que foi corrigido nesta entrega em relação à Entrega 1)

- **IAM do Cloud Run (`backend`)**: `roles/run.invoker` está concedido a `allUsers`, não só ao Load
  Balancer. Isso foi investigado nesta sessão com a documentação oficial do Google Cloud: um Load
  Balancer HTTPS **externo** usando Serverless NEG **sem Identity-Aware Proxy (IAP)** não anexa
  nenhum token de identidade às requisições que repassa — não existe uma "identidade do LB" para
  restringir com IAM sem adicionar IAP (fora do escopo aqui). Por isso `allUsers` é **exigido**
  para o tráfego do Load Balancer funcionar, e não é uma falha de configuração. O controle real
  contra acesso direto é só o `ingress = internal-and-cloud-load-balancing`, confirmado ao vivo
  (`curl` direto na URL `*.run.app` → HTTP 404). A documentação da Entrega 1 afirmava o contrário;
  esta é a versão corrigida.
- **Firewall da VPC `todo-vpc`**: não existe nenhuma regra de firewall própria nessa rede (só as
  regras padrão da rede `default`, que é outra rede, não utilizada). Isso é intencional e correto:
  como nada dentro da VPC aceita conexões de entrada (o Cloud Run usa Direct VPC Egress só para
  *sair* através do NAT), o padrão implícito de "negar tudo que não foi liberado" de uma VPC em
  modo customizado já é suficiente — não há necessidade de regra explícita.
- **Log do Load Balancer**: habilitado no `api-bs` (backend-service da API) nesta entrega, para
  alimentar o painel de origem geográfica (ver `diagrama-observabilidade.md`). **Não foi possível
  habilitar no `front-bb`** (backend-bucket do front-end, que serve arquivos estáticos do Cloud
  Storage) — testado via API do Compute Engine (v1 e beta, PATCH e PUT) e o campo `logConfig`
  simplesmente não é aplicado nesse tipo de backend. Isso é uma limitação da plataforma, não uma
  escolha do grupo — é o tipo de coisa que o enunciado pede para sinalizar explicitamente quando
  algo é administrado pelo provedor e não está disponível.
