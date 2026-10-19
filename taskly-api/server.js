// ============================================
// 1. IMPORTAÇÕES
// ============================================
const express = require("express");
const crypto = require("crypto");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { createClient } = require("@libsql/client");
const path = require("path");
require("dotenv").config();

// ============================================
// 2. CONFIGURAÇÕES
// ============================================
const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || "segredo-padrao";

// ✅ Libera o CORS para o GitHub Pages poder acessar
app.use(cors({
  origin: "*", // Em produção, você pode trocar "*" pela URL do seu GitHub Pages
  credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ============================================
// 3. BANCO DE DADOS (Turso Nuvem ou SQLite Local)
// ============================================
// Se a variável TURSO_DATABASE_URL existir (no Render), usa a nuvem.
// Se não existir (no seu PC rodando o .exe), usa um arquivo local.
const isCloud = !!process.env.TURSO_DATABASE_URL;

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || "file:taskly.db",
  authToken: process.env.TURSO_AUTH_TOKEN
});

async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'usuario',
      reset_token TEXT,
      reset_token_expires TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      priority TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Garante que o primeiro usuário seja admin
  const { rows } = await db.execute("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'");
  if (rows[0].c === 0) {
    const primeiro = await db.execute("SELECT id FROM users ORDER BY id ASC LIMIT 1");
    if (primeiro.rows.length > 0) {
      await db.execute({ sql: "UPDATE users SET role = 'admin' WHERE id = ?", args: [primeiro.rows[0].id] });
      console.log(`👑 Usuário #${primeiro.rows[0].id} promovido a admin.`);
    }
  }
  console.log(`✅ Banco de dados pronto (${isCloud ? "Turso Nuvem" : "SQLite Local"}).`);
}

initDb();

// ============================================
// 4. FUNÇÕES AUXILIARES
// ============================================
function gerarToken(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, SECRET, { expiresIn: "1d" });
}

function autenticar(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return res.status(401).json({ error: "Token não fornecido." });
  try {
    const payload = jwt.verify(header.split(" ")[1], SECRET);
    req.user = { id: payload.id, username: payload.username, role: payload.role };
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido ou expirado." });
  }
}

function taskToJson(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    priority: row.priority,
    start: row.start_date,
    end: row.end_date,
    color: row.color,
  };
}

// ============================================
// 5. ROTAS DE AUTENTICAÇÃO
// ============================================
app.get("/", (_req, res) => res.json({ ok: true, mensagem: "API Taskly funcionando!" }));

app.post("/api/register", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Usuário e senha são obrigatórios." });
  if (username.length < 3) return res.status(400).json({ error: "Usuário deve ter ao menos 3 caracteres." });
  if (password.length < 6) return res.status(400).json({ error: "Senha deve ter ao menos 6 caracteres." });

  const existe = await db.execute({ sql: "SELECT id FROM users WHERE username = ?", args: [username] });
  if (existe.rows.length > 0) return res.status(409).json({ error: "Usuário já existe." });

  const total = await db.execute("SELECT COUNT(*) AS c FROM users");
  const role = total.rows[0].c === 0 ? "admin" : "usuario";

  const passwordHash = await bcrypt.hash(password, 10);
  const info = await db.execute({
    sql: "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
    args: [username, passwordHash, role]
  });

  const user = { id: Number(info.lastInsertRowid), username, role };
  const token = gerarToken(user);
  res.status(201).json({ token, user });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Usuário e senha são obrigatórios." });

  const { rows } = await db.execute({ sql: "SELECT * FROM users WHERE username = ?", args: [username] });
  const user = rows[0];
  if (!user) return res.status(401).json({ error: "Usuário ou senha inválidos." });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Usuário ou senha inválidos." });

  const token = gerarToken(user);
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

app.post("/api/forgot-password", async (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: "Informe o nome de usuário." });

  const { rows } = await db.execute({ sql: "SELECT * FROM users WHERE username = ?", args: [username] });
  const user = rows[0];
  if (!user) return res.json({ message: "Se o usuário existir, um token de redefinição foi gerado." });

  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  
  await db.execute({ 
    sql: "UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?", 
    args: [token, expires, user.id] 
  });

  console.log("\n🔑  RESET DE SENHA SOLICITADO");
  console.log(`    Usuário: ${user.username}`);
  console.log(`    Token:   ${token}\n`);

  res.json({ message: "Token gerado. Verifique o console do servidor.", token });
});

app.post("/api/reset-password", async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) return res.status(400).json({ error: "Token e nova senha são obrigatórios." });
  if (newPassword.length < 6) return res.status(400).json({ error: "Nova senha deve ter ao menos 6 caracteres." });

  const { rows } = await db.execute({ sql: "SELECT * FROM users WHERE reset_token = ?", args: [token] });
  const user = rows[0];
  
  if (!user) return res.status(400).json({ error: "Token inválido." });
  if (!user.reset_token_expires || new Date(user.reset_token_expires) < new Date()) {
    return res.status(400).json({ error: "Token expirado. Solicite um novo." });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.execute({ 
    sql: "UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?", 
    args: [passwordHash, user.id] 
  });

  res.json({ message: "Senha redefinida com sucesso. Faça login novamente." });
});

app.post("/api/change-password", autenticar, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: "Senha atual e nova senha são obrigatórias." });
  if (newPassword.length < 6) return res.status(400).json({ error: "Nova senha deve ter ao menos 6 caracteres." });
  if (currentPassword === newPassword) return res.status(400).json({ error: "A nova senha deve ser diferente da atual." });

  const { rows } = await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [req.user.id] });
  const user = rows[0];
  if (!user) return res.status(404).json({ error: "Usuário não encontrado." });

  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Senha atual incorreta." });

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.execute({ sql: "UPDATE users SET password_hash = ? WHERE id = ?", args: [passwordHash, user.id] });

  res.json({ message: "Senha alterada com sucesso." });
});

app.get("/api/me", autenticar, (req, res) => res.json({ user: req.user }));

// ============================================
// 6. CRUD DE TAREFAS
// ============================================
app.get("/api/tasks", autenticar, async (req, res) => {
  let rows;
  if (req.user.role === "admin" || req.user.role === "gerente") {
    const result = await db.execute(`
      SELECT tasks.*, users.username AS owner_name
      FROM tasks JOIN users ON users.id = tasks.user_id
      ORDER BY tasks.start_date ASC, tasks.id ASC
    `);
    rows = result.rows;
  } else {
    const result = await db.execute({ sql: "SELECT * FROM tasks WHERE user_id = ? ORDER BY start_date ASC, id ASC", args: [req.user.id] });
    rows = result.rows;
  }
  res.json(rows.map((r) => ({ ...taskToJson(r), owner: r.owner_name || req.user.username })));
});

app.post("/api/tasks", autenticar, async (req, res) => {
  const { name, type, priority, start, end, color } = req.body || {};
  if (!name || !type || !priority || !start || !end) return res.status(400).json({ error: "Preencha todos os campos." });
  if (end < start) return res.status(400).json({ error: "A data de término deve ser posterior à de início." });

  const info = await db.execute({
    sql: `INSERT INTO tasks (user_id, name, type, priority, start_date, end_date, color) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [req.user.id, String(name).trim(), type, priority, start, end, color || "#6c63dc"]
  });

  const { rows } = await db.execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [info.lastInsertRowid] });
  res.status(201).json({ ...taskToJson(rows[0]), owner: req.user.username });
});

app.put("/api/tasks/:id", autenticar, async (req, res) => {
  const id = Number(req.params.id);
  const { name, type, priority, start, end, color } = req.body || {};

  const { rows } = await db.execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  const tarefa = rows[0];
  if (!tarefa) return res.status(404).json({ error: "Tarefa não encontrada." });
  if (req.user.role !== "admin" && tarefa.user_id !== req.user.id) return res.status(403).json({ error: "Sem permissão." });

  if (!name || !type || !priority || !start || !end) return res.status(400).json({ error: "Preencha todos os campos." });
  if (end < start) return res.status(400).json({ error: "A data de término deve ser posterior à de início." });

  await db.execute({
    sql: `UPDATE tasks SET name = ?, type = ?, priority = ?, start_date = ?, end_date = ?, color = ? WHERE id = ?`,
    args: [String(name).trim(), type, priority, start, end, color || tarefa.color, id]
  });

  const updated = await db.execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  res.json(taskToJson(updated.rows[0]));
});

app.delete("/api/tasks/:id", autenticar, async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await db.execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  const tarefa = rows[0];
  if (!tarefa) return res.status(404).json({ error: "Tarefa não encontrada." });
  if (req.user.role !== "admin" && tarefa.user_id !== req.user.id) return res.status(403).json({ error: "Sem permissão." });

  await db.execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [id] });
  res.json({ ok: true });
});

// ============================================
// 7. ROTAS DE USUÁRIOS (só admin)
// ============================================
app.get("/api/users", autenticar, async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Acesso negado." });
  const { rows } = await db.execute("SELECT id, username, role, created_at FROM users ORDER BY id ASC");
  res.json(rows);
});

app.put("/api/users/:id/role", autenticar, async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Acesso negado." });

  const id = Number(req.params.id);
  const { role } = req.body || {};
  if (!["admin", "gerente", "usuario"].includes(role)) return res.status(400).json({ error: "Papel inválido." });
  if (id === req.user.id) return res.status(400).json({ error: "Você não pode mudar seu próprio papel." });

  await db.execute({ sql: "UPDATE users SET role = ? WHERE id = ?", args: [role, id] });
  res.json({ ok: true });
});

// ============================================
// 8. INICIA O SERVIDOR
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});