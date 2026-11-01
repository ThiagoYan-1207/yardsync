const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;

// Configurações globais de regras de negócio (Editáveis pela TI)
let configSistema = {
    diasAposFaturamento: 10 // Padrão: 10 dias após o faturamento
};

// Base de dados de utilizadores (Gerida pela TI)
let USERS = [
    { id: 1, user: 'admin', pass: 'bydsul2026', role: 'Administrador' },
    { id: 2, user: 'operador', pass: 'yardsync2026', role: 'Operador de Pátio' },
    { id: 3, user: 'ti', pass: 'yardsync_ti2026', role: 'TI / Gestor' }
];

// Base de dados de veículos
let AGENDAMENTOS = [
    { 
        id: 1, 
        placa: "ABC-1234", 
        chassi: "9BWZZZ370...", 
        cliente: "João Silva", 
        dataFaturamento: "2026-11-01",
        previsaoEntrega: "2026-11-11", // Calculado automaticamente (10 dias)
        dataAgendada: "2026-11-12T14:00",
        localizacao: "Pátio Loja",
        statusProcesso: "Agendado",
        obs: "Instalar insulfilm e lavagem especial."
    }
];

// Login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const foundUser = USERS.find(u => u.user === username && u.pass === password);

    if (foundUser) {
        const token = Buffer.from(`${username}:${Date.now()}`).toString('base64');
        return res.json({ success: true, token, role: foundUser.role, username });
    }
    return res.status(401).json({ success: false, message: 'Credenciais inválidas.' });
});

function verificarAutenticacao(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Acesso negado.' });
    }
    next();
}

// Listar agendamentos
app.get('/api/agendamentos', verificarAutenticacao, (req, res) => {
    res.json(AGENDAMENTOS);
});

// Atualizar veículo
app.put('/api/agendamentos/:id', verificarAutenticacao, (req, res) => {
    const { id } = req.params;
    const { localizacao, statusProcesso, dataFaturamento, dataAgendada, obs } = req.body;

    const idx = AGENDAMENTOS.findIndex(item => item.id === parseInt(id));
    if (idx !== -1) {
        let novaPrevisao = AGENDAMENTOS[idx].previsaoEntrega;
        
        // Se a data de faturamento mudou, recalcula a previsão automaticamente com base no SLA configurado pela TI
        if (dataFaturamento && dataFaturamento !== AGENDAMENTOS[idx].dataFaturamento) {
            const fatDate = new Date(dataFaturamento);
            fatDate.setDate(fatDate.getDate() + configSistema.diasAposFaturamento);
            novaPrevisao = fatDate.toISOString().split('T')[0];
        }

        AGENDAMENTOS[idx] = {
            ...AGENDAMENTOS[idx],
            localizacao: localizacao || AGENDAMENTOS[idx].localizacao,
            statusProcesso: statusProcesso || AGENDAMENTOS[idx].statusProcesso,
            dataFaturamento: dataFaturamento || AGENDAMENTOS[idx].dataFaturamento,
            previsaoEntrega: novaPrevisao,
            dataAgendada: dataAgendada !== undefined ? dataAgendada : AGENDAMENTOS[idx].dataAgendada,
            obs: obs !== undefined ? obs : AGENDAMENTOS[idx].obs
        };
        return res.json({ success: true, item: AGENDAMENTOS[idx] });
    }
    res.status(404).json({ message: 'Veículo não encontrado.' });
});

// --- ROTAS DA DASHBOARD DA TI ---

// Obter configurações e utilizadores
app.get('/api/ti/config', verificarAutenticacao, (req, res) => {
    res.json({ config: configSistema, users: USERS });
});

// Atualizar regras de prazo (SLA)
app.put('/api/ti/config', verificarAutenticacao, (req, res) => {
    const { diasAposFaturamento } = req.body;
    if (diasAposFaturamento) {
        configSistema.diasAposFaturamento = parseInt(diasAposFaturamento);
    }
    res.json({ success: true, config: configSistema });
});

// Criar novo utilizador (Acesso)
app.post('/api/ti/users', verificarAutenticacao, (req, res) => {
    const { newUser, newPass, newRole } = req.body;
    if (!newUser || !newPass || !newRole) {
        return res.status(400).json({ success: false, message: 'Preencha todos os campos.' });
    }
    const id = USERS.length + 1;
    USERS.push({ id, user: newUser, pass: newPass, role: newRole });
    res.json({ success: true, users: USERS });
});

// Remover utilizador
app.delete('/api/ti/users/:id', verificarAutenticacao, (req, res) => {
    const id = parseInt(req.params.id);
    USERS = USERS.filter(u => u.id !== id);
    res.json({ success: true, users: USERS });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`YardSync rodando na porta ${PORT}`);
});