const express = require('express');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;

// Configuração da Conexão PostgreSQL
// Usa a variável de ambiente DATABASE_URL (fornecida pelo Railway, Supabase ou Neon)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://usuario:senha@localhost:5432/yardsync',
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Inicialização e Criação Automática das Tabelas no Banco na Nuvem
async function initDB() {
    try {
        // Tabela de Configurações / SLA
        await pool.query(`
            CREATE TABLE IF NOT EXISTS config (
                id SERIAL PRIMARY KEY,
                dias_apos_faturamento INT DEFAULT 10
            );
        `);

        // Garante 1 registro inicial de config se estiver vazio
        const resConfig = await pool.query('SELECT * FROM config WHERE id = 1');
        if (resConfig.rows.length === 0) {
            await pool.query('INSERT INTO config (id, dias_apos_faturamento) VALUES (1, 10)');
        }

        // Tabela de Utilizadores
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(100) NOT NULL,
                role VARCHAR(50) NOT NULL
            );
        `);

        // Criar utilizadores padrão se a tabela estiver vazia
        const resUsers = await pool.query('SELECT * FROM usuarios');
        if (resUsers.rows.length === 0) {
            await pool.query(`
                INSERT INTO usuarios (username, password, role) VALUES 
                ('admin', 'bydsul2026', 'Administrador'),
                ('operador', 'yardsync2026', 'Operador de Pátio'),
                ('ti', 'yardsync_ti2026', 'TI / Gestor')
            `);
        }

        // Tabela de Veículos / Agendamentos
        await pool.query(`
            CREATE TABLE IF NOT EXISTS agendamentos (
                id SERIAL PRIMARY KEY,
                placa VARCHAR(10) NOT NULL,
                chassi VARCHAR(50),
                cliente VARCHAR(100) NOT NULL,
                data_faturamento DATE,
                previsao_entrega DATE,
                data_agendada VARCHAR(50),
                localizacao VARCHAR(50) DEFAULT 'CD',
                status_processo VARCHAR(50) DEFAULT 'Pendente de Agendamento',
                obs TEXT
            );
        `);

        console.log('✅ PostgreSQL conectado e tabelas sincronizadas!');
    } catch (err) {
        console.error('❌ Erro ao inicializar PostgreSQL:', err);
    }
}

initDB();

// --- ROTAS DE AUTENTICAÇÃO ---
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM usuarios WHERE username = $1 AND password = $2', [username, password]);
        if (result.rows.length > 0) {
            const user = result.rows[0];
            const token = Buffer.from(`${user.username}:${Date.now()}`).toString('base64');
            return res.json({ success: true, token, role: user.role, username: user.username });
        }
        return res.status(401).json({ success: false, message: 'Credenciais inválidas.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function verificarAutenticacao(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Acesso negado.' });
    }
    next();
}

// --- ROTAS DE VEÍCULOS ---

// Listar todos os veículos
app.get('/api/agendamentos', verificarAutenticacao, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM agendamentos ORDER BY id DESC');
        // Mapeia os nomes das colunas do banco para o padrão usado no front-end
        const items = result.rows.map(row => ({
            id: row.id,
            placa: row.placa,
            chassi: row.chassi,
            cliente: row.cliente,
            dataFaturamento: row.data_faturamento ? row.data_faturamento.toISOString().split('T')[0] : '',
            previsaoEntrega: row.previsao_entrega ? row.previsao_entrega.toISOString().split('T')[0] : '',
            dataAgendada: row.data_agendada || '',
            localizacao: row.localizacao,
            statusProcesso: row.status_processo,
            obs: row.obs
        }));
        res.json(items);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cadastrar veículo manualmente
app.post('/api/agendamentos', verificarAutenticacao, async (req, res) => {
    const { placa, chassi, cliente, dataFaturamento, localizacao } = req.body;
    
    if (!placa || !cliente || !dataFaturamento) {
        return res.status(400).json({ success: false, message: 'Preencha os campos obrigatórios.' });
    }

    try {
        // Obter SLA configurado pela TI
        const cfgRes = await pool.query('SELECT dias_apos_faturamento FROM config WHERE id = 1');
        const diasSLA = cfgRes.rows[0]?.dias_apos_faturamento || 10;

        // Calcular Previsão de Entrega
        const fatDate = new Date(dataFaturamento);
        fatDate.setDate(fatDate.getDate() + diasSLA);
        const previsaoEntrega = fatDate.toISOString().split('T')[0];

        const insertQuery = `
            INSERT INTO agendamentos (placa, chassi, cliente, data_faturamento, previsao_entrega, localizacao, status_processo, obs)
            VALUES ($1, $2, $3, $4, $5, $6, 'Pendente de Agendamento', 'Cadastrado via PostgreSQL Cloud')
            RETURNING *;
        `;
        const values = [placa.toUpperCase(), chassi || 'N/D', cliente, dataFaturamento, previsaoEntrega, localizacao || 'CD'];
        const result = await pool.query(insertQuery, values);

        res.json({ success: true, item: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Atualizar dados de um veículo
app.put('/api/agendamentos/:id', verificarAutenticacao, async (req, res) => {
    const { id } = req.params;
    const { localizacao, statusProcesso, dataFaturamento, dataAgendada, obs } = req.body;

    try {
        let novaPrevisao = null;
        if (dataFaturamento) {
            const cfgRes = await pool.query('SELECT dias_apos_faturamento FROM config WHERE id = 1');
            const diasSLA = cfgRes.rows[0]?.dias_apos_faturamento || 10;
            const fatDate = new Date(dataFaturamento);
            fatDate.setDate(fatDate.getDate() + diasSLA);
            novaPrevisao = fatDate.toISOString().split('T')[0];
        }

        const updateQuery = `
            UPDATE agendamentos 
            SET localizacao = COALESCE($1, localizacao),
                status_processo = COALESCE($2, status_processo),
                data_faturamento = COALESCE($3, data_faturamento),
                previsao_entrega = COALESCE($4, previsao_entrega),
                data_agendada = COALESCE($5, data_agendada),
                obs = COALESCE($6, obs)
            WHERE id = $7
            RETURNING *;
        `;
        const values = [localizacao, statusProcesso, dataFaturamento || null, novaPrevisao, dataAgendada, obs, id];
        const result = await pool.query(updateQuery, values);

        res.json({ success: true, item: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ROTAS DA DASHBOARD DA TI ---

app.get('/api/ti/config', verificarAutenticacao, async (req, res) => {
    try {
        const configRes = await pool.query('SELECT dias_apos_faturamento FROM config WHERE id = 1');
        const usersRes = await pool.query('SELECT id, username as user, role FROM usuarios ORDER BY id ASC');
        res.json({ config: { diasAposFaturamento: configRes.rows[0]?.dias_apos_faturamento || 10 }, users: usersRes.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/ti/config', verificarAutenticacao, async (req, res) => {
    const { diasAposFaturamento } = req.body;
    try {
        await pool.query('UPDATE config SET dias_apos_faturamento = $1 WHERE id = 1', [parseInt(diasAposFaturamento)]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/ti/users', verificarAutenticacao, async (req, res) => {
    const { newUser, newPass, newRole } = req.body;
    try {
        await pool.query('INSERT INTO usuarios (username, password, role) VALUES ($1, $2, $3)', [newUser, newPass, newRole]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/ti/users/:id', verificarAutenticacao, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`YardSync a rodar na porta ${PORT}`);
});