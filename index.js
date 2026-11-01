const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;

// Utilizadores simulados
const USERS = [
    { user: 'admin', pass: 'bydsul2026', role: 'Administrador' },
    { user: 'operador', pass: 'yardsync2026', role: 'Operador de Pátio' }
];

// Rota de Login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const foundUser = USERS.find(u => u.user === username && u.pass === password);

    if (foundUser) {
        const token = Buffer.from(`${username}:${Date.now()}`).toString('base64');
        return res.json({ success: true, token, role: foundUser.role, username });
    } else {
        return res.status(401).json({ success: false, message: 'Credenciais inválidas.' });
    }
});

// Middleware de segurança
function verificarAutenticacao(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Acesso negado. Token em falta.' });
    }
    next();
}

// Rota protegida de agendamentos
app.get('/api/agendamentos', verificarAutenticacao, (req, res) => {
    return res.json([
        { id: 1, placa: "ABC-1234", chassi: "9BWZZZ370...", cliente: "João Silva", dataEntrega: "2026-11-10", localizacao: "Pátio Loja" },
        { id: 2, placa: "XYZ-9876", chassi: "8AJXXX581...", cliente: "Maria Souza", dataEntrega: "2026-11-12", localizacao: "CD" }
    ]);
});

// Catch-all para o front-end
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`YardSync rodando na porta ${PORT}`);
});