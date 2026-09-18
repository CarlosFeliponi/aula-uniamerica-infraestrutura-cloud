// Logging estruturado (uma linha JSON por evento) escrito no stdout.
// O Cloud Run encaminha automaticamente stdout/stderr pro Cloud Logging e já reconhece
// os campos especiais "severity" e "time" sem precisar de nenhum agente extra.
// Isso é a fonte de dado de onde as log-based metrics do Cloud Monitoring são extraídas
// (ver observability/setup-cloud-monitoring.sh), que por sua vez alimentam o Grafana.
const SERVICE = 'backend';
const ENVIRONMENT = process.env.ENVIRONMENT || 'production';

function emit(severity, event, fields = {}) {
  const entry = {
    severity,
    time: new Date().toISOString(),
    service: SERVICE,
    environment: ENVIRONMENT,
    event,
    ...fields,
  };
  // Nunca incluir aqui: senhas, tokens, connection strings ou o texto da tarefa do usuário.
  console.log(JSON.stringify(entry));
}

const logger = {
  info: (event, fields) => emit('INFO', event, fields),
  warn: (event, fields) => emit('WARNING', event, fields),
  error: (event, fields) => emit('ERROR', event, fields),
};

// Mede e loga uma operação contra o MongoDB (evento "db_operation"), separando sucesso/falha
// e duração — é a fonte de dado do painel "saúde das operações no banco" (visão do backend,
// não a métrica interna do servidor Atlas).
async function withDb(operation, requestId, fn) {
  const start = process.hrtime.bigint();
  try {
    const result = await fn();
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    logger.info('db_operation', {
      request_id: requestId,
      operation,
      result: 'success',
      duration_ms: Math.round(durationMs * 100) / 100,
    });
    return result;
  } catch (err) {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    logger.error('db_operation', {
      request_id: requestId,
      operation,
      result: 'failure',
      duration_ms: Math.round(durationMs * 100) / 100,
      error_type: err.name,
      error_message: err.message,
    });
    throw err;
  }
}

module.exports = { logger, withDb };
