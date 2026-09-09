const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');

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
  .then(() => console.log('Conectado ao MongoDB'))
  .catch((err) => console.error('Erro ao conectar ao MongoDB:', err));

// CORS restrito à origem do front-end (definida via env var).
// '*' só é usado como fallback pra você testar localmente.
const allowedOrigins = process.env.FRONTEND_ORIGIN
  ? process.env.FRONTEND_ORIGIN.split(',')
  : ['*'];

app.use(cors({
  origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
}));
app.use(bodyParser.json());

const router = express.Router();

// Health check — usado pelo Load Balancer pra saber se essa instância está saudável.
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
    const todos = await Todo.find(); // Retorna todas as tarefas do banco
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
    const newTodo = await todo.save(); // Salva a tarefa no banco
    res.status(201).json(newTodo); // Retorna a tarefa criada
  } catch (err) {
    res.status(400).json({ message: err.message }); // Retorna erro se houver falha no banco de dados
  }
});

// Rota para marcar uma tarefa como concluída (PATCH)
router.patch('/todos/:id', async (req, res) => {
  try {
    const todo = await Todo.findById(req.params.id); // Encontra a tarefa pelo ID

    if (!todo) {
      return res.status(404).json({ message: 'Tarefa não encontrada' });
    }

    // Alterna o status de "completed" da tarefa
    todo.completed = !todo.completed;
    await todo.save(); // Salva a tarefa modificada
    res.json(todo); // Retorna a tarefa atualizada
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Rota para excluir uma tarefa (DELETE)
router.delete('/todos/:id', async (req, res) => {
  try {
    const todo = await Todo.findByIdAndDelete(req.params.id); // Deleta a tarefa pelo ID

    if (!todo) {
      return res.status(404).json({ message: 'Tarefa não encontrada' });
    }

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
  console.log(`Servidor rodando na porta ${port}`);
});