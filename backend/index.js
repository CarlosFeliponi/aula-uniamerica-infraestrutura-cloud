const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const { logger, withDb } = require('./logger');

const app = express();

// Cloud Run injeta a variável PORT automaticamente (normalmente 8080).
// O fallback 5000 é só pra você rodar localmente com docker-compose.
const port = process.env.PORT || 5000;

// A string de conexão agora vem de fora do código.
const mongoURI = process.env.MONGO_URI || 'mongodb://root:rootpassword@mongo-todo:27017/todo-app?authSource=admin';

mongoose.connect(mongoURI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => logger.info('startup', { message: 'Conectado ao MongoDB' }))
  .catch((err) => logger.error('startup', {
    message: 'Erro ao conectar ao MongoDB',
    error_type: err.name,
    error_message: err.message,
  }));

// CORS restrito à origem do front-end (definida via env var).
// '*' só é usado como fallback pra você testar localmente.
const allowedOrigins = process.env.FRONTEND_ORIGIN
  ? process.env.FRONTEND_ORIGIN.split(',')
  : ['*'];

app.use(cors({
  origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
}));
app.use(bodyParser.json());

// Correlação + duração por requisição (evento "db_operation" abaixo reaproveita o mesmo
// request_id quando a rota faz alguma chamada ao banco). É a fonte de dado dos painéis de
// "uso por operação", "taxa de erro" e "tempo de resposta".
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  const start = process.hrtime.bigint();
  res.setHeader('X-Request-Id', req.id);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const status = res.statusCode;
    // req.route só existe depois que o Express casou a rota; route.path é relativo ao router
    // (ex.: "/todos/:id"), então chamadas em "/todos" e "/api/todos" caem na MESMA operação.
    const route = (req.route && req.route.path) || req.path;

    logger.info('http_request', {
      request_id: req.id,
      method: req.method,
      route,
      status,
      status_class: `${Math.floor(status / 100)}xx`,
      duration_ms: Math.round(durationMs * 100) / 100,
    });
  });

  next();
});

const router = express.Router();

// Health check — usado pelo Load Balancer pra saber se essa instância está saudável, e também
// pelo Uptime Check do Cloud Monitoring (painel de disponibilidade).
router.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

// Definindo o modelo de Tarefa (To-do)
const TodoSchema = new mongoose.Schema({
  text: { type: String, required: true },
  completed: { type: Boolean, default: false },
});

const Todo = mongoose.model('Todo', TodoSchema);

// Rota para obter todas as tarefas (GET)
router.get('/todos', async (req, res) => {
  try {
    const todos = await withDb('list', req.id, () => Todo.find()); // Retorna todas as tarefas do banco
    res.json(todos);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Rota para adicionar uma nova tarefa (POST)
router.post('/todos', async (req, res) => {
  const { text } = req.body; // Obtém o texto da tarefa do corpo da requisição

  // Verifica se o campo "text" está presente
  if (!text) {
    return res.status(400).json({ message: 'O campo "text" é obrigatório' });
  }

  const todo = new Todo({
    text,
    completed: false,
  });

  try {
    const newTodo = await withDb('create', req.id, () => todo.save()); // Salva a tarefa no banco

    // Evento de negócio (não é tráfego HTTP bruto) — fonte do painel de funil de conclusão.
    // Nunca inclui o texto da tarefa, só o id.
    logger.info('business_event', {
      request_id: req.id,
      event_name: 'todo_created',
      todo_id: newTodo._id.toString(),
    });

    res.status(201).json(newTodo); // Retorna a tarefa criada
  } catch (err) {
    res.status(400).json({ message: err.message }); // Retorna erro se houver falha no banco de dados
  }
});

// Rota para marcar uma tarefa como concluída (PATCH)
router.patch('/todos/:id', async (req, res) => {
  try {
    const todo = await withDb('update', req.id, async () => {
      const found = await Todo.findById(req.params.id); // Encontra a tarefa pelo ID
      if (!found) return null;

      // Alterna o status de "completed" da tarefa
      found.completed = !found.completed;
      await found.save(); // Salva a tarefa modificada
      return found;
    });

    if (!todo) {
      return res.status(404).json({ message: 'Tarefa não encontrada' });
    }

    logger.info('business_event', {
      request_id: req.id,
      event_name: todo.completed ? 'todo_completed' : 'todo_reopened',
      todo_id: todo._id.toString(),
    });

    res.json(todo); // Retorna a tarefa atualizada
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Rota para excluir uma tarefa (DELETE)
router.delete('/todos/:id', async (req, res) => {
  try {
    const todo = await withDb('delete', req.id, () => Todo.findByIdAndDelete(req.params.id)); // Deleta a tarefa pelo ID

    if (!todo) {
      return res.status(404).json({ message: 'Tarefa não encontrada' });
    }

    logger.info('business_event', {
      request_id: req.id,
      event_name: 'todo_deleted',
      todo_id: todo._id.toString(),
    });

    res.json({ message: 'Tarefa excluída com sucesso' }); // Retorna uma mensagem de sucesso
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Monta as MESMAS rotas em dois lugares:
// sem prefixo (pra você continuar testando local/via proxy como já fazia)
// e sob /api (que é o caminho que o Load Balancer vai usar em produção)
app.use('/', router);
app.use('/api', router);

app.listen(port, '0.0.0.0', () => {
  logger.info('startup', { message: `Servidor rodando na porta ${port}` });
});
