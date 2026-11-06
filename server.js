const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool, types } = require('pg');

// O pg converte DATE/TIMESTAMP em objetos Date e isso "anda" um dia por causa do
// fuso horário. Mantemos como texto (YYYY-MM-DD / YYYY-MM-DD HH:MM:SS).
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1114, (v) => v);

/* ------------------------------------------------------------------ */
/* Configuração                                                        */
/* ------------------------------------------------------------------ */
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const APP_TZ = process.env.APP_TZ || 'America/Sao_Paulo';
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('ERRO: defina a variável DATABASE_URL (veja o arquivo .env.example).');
  process.exit(1);
}

let AUTH_SECRET = process.env.AUTH_SECRET;
if (!AUTH_SECRET) {
  if (IS_PROD) {
    console.error('ERRO: defina AUTH_SECRET em produção.');
    process.exit(1);
  }
  AUTH_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('AVISO: AUTH_SECRET não definido. Usando um segredo temporário (logins caem ao reiniciar).');
}

const LOCALIZACOES = ['Pátio Loja', 'CD', 'Em Trânsito', 'Solicitado do CD'];
const STATUS = ['Pendente de Agendamento', 'Cliente Contactado', 'Agendado', 'Em Preparação', 'Entregue'];
const ROLES = ['operador', 'administrador', 'ti'];

const PLACA_RE = /^[A-Z]{3}\d[A-Z0-9]\d{2}$/;
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATAHORA_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

const local = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: local || process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

/* ------------------------------------------------------------------ */
/* Utilitários                                                         */
/* ------------------------------------------------------------------ */
const normalizarPlaca = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function somarDias(iso, dias) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function hojeISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ }).format(new Date());
}

class HttpError extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

async function comTransacao(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const paraApi = (r) => ({
  id: r.id,
  placa: r.placa,
  chassi: r.chassi,
  cliente: r.cliente,
  dataFaturamento: r.data_faturamento,
  previsaoEntrega: r.previsao_entrega,
  dataEntrega: r.previsao_entrega, // mantido por compatibilidade com a primeira versão
  dataAgendada: r.data_agendada,
  localizacao: r.localizacao,
  statusProcesso: r.status_processo,
  obs: r.obs,
  atualizadoEm: r.atualizado_em,
});

/* ------------------------------------------------------------------ */
/* Senhas e tokens (sem dependências extras, só o módulo crypto)       */
/* ------------------------------------------------------------------ */
function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(senha), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verificarSenha(senha, guardado) {
  const [tipo, salt, hash] = String(guardado || '').split('$');
  if (tipo !== 'scrypt' || !salt || !hash) return false;
  const calc = crypto.scryptSync(String(senha || ''), salt, 64);
  const orig = Buffer.from(hash, 'hex');
  return calc.length === orig.length && crypto.timingSafeEqual(calc, orig);
}

const b64 = (s) => Buffer.from(s).toString('base64url');
const assinar = (dados) => crypto.createHmac('sha256', AUTH_SECRET).update(dados).digest('base64url');

function gerarToken(usuario) {
  const payload = b64(JSON.stringify({ id: usuario.id, exp: Date.now() + 12 * 60 * 60 * 1000 }));
  return `${payload}.${assinar(payload)}`;
}

function lerToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const esperado = assinar(payload);
  if (sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
  try {
    const dados = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return dados.exp > Date.now() ? dados : null;
  } catch {
    return null;
  }
}

// Exige login e (opcionalmente) um dos perfis informados.
// Consulta o usuário no banco a cada chamada: assim, revogar um usuário
// ou mudar o perfil dele vale imediatamente.
function auth(...perfis) {
  return async (req, res, next) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const dados = m && lerToken(m[1]);
    if (!dados) throw new HttpError(401, 'Faça login para continuar.');
    const r = await pool.query('SELECT id, username, role FROM usuarios WHERE id = $1', [dados.id]);
    if (!r.rowCount) throw new HttpError(401, 'Usuário não existe mais. Faça login novamente.');
    if (perfis.length && !perfis.includes(r.rows[0].role)) {
      throw new HttpError(403, 'Seu perfil não tem permissão para esta ação.');
    }
    req.usuario = r.rows[0];
    next();
  };
}

/* ------------------------------------------------------------------ */
/* Banco de dados                                                      */
/* ------------------------------------------------------------------ */
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS config (
      chave TEXT PRIMARY KEY,
      valor TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'operador',
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS agendamentos (
      id SERIAL PRIMARY KEY,
      placa TEXT UNIQUE NOT NULL,
      chassi TEXT,
      cliente TEXT,
      data_faturamento DATE,
      previsao_entrega DATE,
      data_agendada TIMESTAMP,
      localizacao TEXT NOT NULL DEFAULT 'CD',
      status_processo TEXT NOT NULL DEFAULT 'Pendente de Agendamento',
      obs TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS movimentacoes (
      id SERIAL PRIMARY KEY,
      placa TEXT NOT NULL,
      de TEXT,
      para TEXT NOT NULL,
      usuario TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_mov_placa ON movimentacoes (placa, criado_em DESC);
  `);

  await pool.query(
    `INSERT INTO config (chave, valor) VALUES ('dias_apos_faturamento', '7') ON CONFLICT (chave) DO NOTHING`
  );

  // Primeiro acesso: cria o usuário "admin" com perfil TI.
  const u = await pool.query('SELECT 1 FROM usuarios LIMIT 1');
  if (!u.rowCount) {
    const senha = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    await pool.query(`INSERT INTO usuarios (username, password_hash, role) VALUES ('admin', $1, 'ti')`, [hashSenha(senha)]);
    console.log('============================================================');
    console.log(' Usuário inicial criado -> login: admin | perfil: ti');
    if (!process.env.ADMIN_PASSWORD) console.log(` Senha gerada (aparece só agora): ${senha}`);
    console.log(' Troque a senha depois do primeiro acesso.');
    console.log('============================================================');
  }

  // Dados de exemplo (nunca em produção, a menos que SEED_DEMO=true)
  const querDemo = process.env.SEED_DEMO === 'true' || (!IS_PROD && process.env.SEED_DEMO !== 'false');
  const v = await pool.query('SELECT 1 FROM agendamentos LIMIT 1');
  if (querDemo && !v.rowCount) {
    const hoje = hojeISO();
    const exemplos = [
      ['ABC1234', '9BWZZZ370...', 'João Silva', -3, 'Pátio Loja', 'Agendado'],
      ['XYZ9876', '8AJXXX581...', 'Maria Souza', -1, 'CD', 'Pendente de Agendamento'],
    ];
    for (const [placa, chassi, cliente, dif, loc, st] of exemplos) {
      const fat = somarDias(hoje, dif);
      await pool.query(
        `INSERT INTO agendamentos (placa, chassi, cliente, data_faturamento, previsao_entrega, localizacao, status_processo)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [placa, chassi, cliente, fat, somarDias(fat, 7), loc, st]
      );
    }
  }
}

async function getSla(db = pool) {
  const r = await db.query(`SELECT valor FROM config WHERE chave = 'dias_apos_faturamento'`);
  const n = parseInt(r.rows[0] && r.rows[0].valor, 10);
  return Number.isFinite(n) ? n : 7;
}

/* ------------------------------------------------------------------ */
/* Validação                                                           */
/* ------------------------------------------------------------------ */
function validarVeiculo(b) {
  const v = {};
  const erros = [];
  const texto = (k, col, max) => {
    if (!(k in b)) return;
    const s = String(b[k] == null ? '' : b[k]).trim();
    if (s.length > max) erros.push(`${k} deve ter no máximo ${max} caracteres`);
    else v[col] = s || null;
  };
  const data = (k, col) => {
    if (!(k in b)) return;
    const s = String(b[k] == null ? '' : b[k]).trim();
    if (!s) v[col] = null;
    else if (!DATA_RE.test(s)) erros.push(`${k} deve estar no formato AAAA-MM-DD`);
    else v[col] = s;
  };
  texto('chassi', 'chassi', 40);
  texto('cliente', 'cliente', 120);
  texto('obs', 'obs', 500);
  data('dataFaturamento', 'data_faturamento');
  data('previsaoEntrega', 'previsao_entrega');
  if ('dataAgendada' in b) {
    const s = String(b.dataAgendada == null ? '' : b.dataAgendada).trim();
    if (!s) v.data_agendada = null;
    else if (!DATAHORA_RE.test(s)) erros.push('dataAgendada deve estar no formato AAAA-MM-DD HH:MM');
    else v.data_agendada = s.replace('T', ' ');
  }
  if ('localizacao' in b) {
    if (!LOCALIZACOES.includes(b.localizacao)) erros.push('localização inválida');
    else v.localizacao = b.localizacao;
  }
  if ('statusProcesso' in b) {
    if (!STATUS.includes(b.statusProcesso)) erros.push('status inválido');
    else v.status_processo = b.statusProcesso;
  }
  return { v, erro: erros.join('; ') };
}

// Atualiza a localização e registra no histórico (dentro de uma transação).
async function registrarMovimentacao(client, placa, de, para, usuario) {
  if (de === para) return;
  await client.query('INSERT INTO movimentacoes (placa, de, para, usuario) VALUES ($1,$2,$3,$4)', [placa, de, para, usuario]);
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */
const app = express();
app.set('trust proxy', 1); // Railway fica atrás de um proxy HTTPS
app.disable('x-powered-by');

app.get('/health', (req, res) => res.json({ ok: true }));

if (IS_PROD) {
  app.use((req, res, next) => (req.secure ? next() : res.redirect(301, `https://${req.headers.host}${req.originalUrl}`)));
}

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self)',
  });
  next();
});
app.use(express.json({ limit: '100kb' }));

// Servimos APENAS o index.html. (Servir a pasta inteira exporia server.js e .env.)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ---- Login ---- */
const falhas = new Map(); // ip -> { n, ate }
app.post('/api/login', async (req, res) => {
  const agora = Date.now();
  const f = falhas.get(req.ip);
  if (f && f.ate > agora && f.n >= 8) {
    throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
  }
  const b = req.body || {};
  const r = await pool.query('SELECT * FROM usuarios WHERE username = $1', [String(b.username || '').trim().toLowerCase()]);
  const u = r.rows[0];
  if (!u || !verificarSenha(b.password, u.password_hash)) {
    falhas.set(req.ip, { n: (f && f.ate > agora ? f.n : 0) + 1, ate: agora + 15 * 60 * 1000 });
    throw new HttpError(401, 'Usuário ou senha incorretos.');
  }
  falhas.delete(req.ip);
  res.json({ sucesso: true, token: gerarToken(u), usuario: { username: u.username, role: u.role } });
});

app.get('/api/me', auth(), (req, res) => res.json({ usuario: req.usuario, localizacoes: LOCALIZACOES, status: STATUS }));

app.post('/api/me/senha', auth(), async (req, res) => {
  const { atual, nova } = req.body || {};
  if (!nova || String(nova).length < 8) throw new HttpError(400, 'A nova senha precisa ter pelo menos 8 caracteres.');
  const r = await pool.query('SELECT password_hash FROM usuarios WHERE id = $1', [req.usuario.id]);
  if (!verificarSenha(atual, r.rows[0].password_hash)) throw new HttpError(400, 'Senha atual incorreta.');
  await pool.query('UPDATE usuarios SET password_hash = $1 WHERE id = $2', [hashSenha(nova), req.usuario.id]);
  res.json({ sucesso: true, mensagem: 'Senha alterada.' });
});

/* ---- Painel resumo ---- */
app.get('/api/resumo', auth(), async (req, res) => {
  const hoje = hojeISO();
  const [loc, abertos] = await Promise.all([
    pool.query(`SELECT localizacao, COUNT(*)::int AS n FROM agendamentos WHERE status_processo <> 'Entregue' GROUP BY 1`),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE COALESCE(data_agendada::date, previsao_entrega) = $1)::int AS hoje,
         COUNT(*) FILTER (WHERE previsao_entrega < $1 AND data_agendada IS NULL)::int AS atrasados
       FROM agendamentos WHERE status_processo <> 'Entregue'`,
      [hoje]
    ),
  ]);
  const porLocalizacao = Object.fromEntries(LOCALIZACOES.map((l) => [l, 0]));
  loc.rows.forEach((r) => (porLocalizacao[r.localizacao] = r.n));
  res.json({ porLocalizacao, entregasHoje: abertos.rows[0].hoje, atrasados: abertos.rows[0].atrasados });
});

/* ---- Veículos / agendamentos ---- */
// Usado pelo app e pelo Excel. Filtros opcionais: ?busca=&localizacao=&status=&dia=hoje
app.get('/api/agendamentos', auth(), async (req, res) => {
  const cond = [];
  const args = [];
  const { busca, localizacao, status, dia } = req.query;
  if (busca) {
    args.push(`%${String(busca).trim()}%`);
    const i = args.length;
    args.push(`%${normalizarPlaca(busca)}%`);
    cond.push(`(cliente ILIKE $${i} OR chassi ILIKE $${i} OR placa ILIKE $${i} OR placa ILIKE $${i + 1})`);
  }
  if (localizacao) { args.push(String(localizacao)); cond.push(`localizacao = $${args.length}`); }
  if (status) { args.push(String(status)); cond.push(`status_processo = $${args.length}`); }
  if (dia === 'hoje') { args.push(hojeISO()); cond.push(`COALESCE(data_agendada::date, previsao_entrega) = $${args.length}`); }
  const r = await pool.query(
    `SELECT * FROM agendamentos ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
     ORDER BY (status_processo = 'Entregue'), COALESCE(data_agendada::date, previsao_entrega) NULLS LAST, placa`,
    args
  );
  res.json(r.rows.map(paraApi));
});

app.get('/api/agendamentos/:placa', auth(), async (req, res) => {
  const placa = normalizarPlaca(req.params.placa);
  const r = await pool.query('SELECT * FROM agendamentos WHERE placa = $1', [placa]);
  if (!r.rowCount) throw new HttpError(404, 'Veículo não encontrado.');
  const h = await pool.query(
    'SELECT de, para, usuario, criado_em FROM movimentacoes WHERE placa = $1 ORDER BY criado_em DESC LIMIT 20',
    [placa]
  );
  res.json({ ...paraApi(r.rows[0]), historico: h.rows });
});

app.post('/api/agendamentos', auth('administrador', 'ti'), async (req, res) => {
  const b = req.body || {};
  const placa = normalizarPlaca(b.placa);
  if (!PLACA_RE.test(placa)) throw new HttpError(400, 'Placa inválida. Exemplos: ABC1234 ou ABC1D23.');
  const { v, erro } = validarVeiculo(b);
  if (erro) throw new HttpError(400, erro);
  if (!v.cliente) throw new HttpError(400, 'Informe o nome do cliente.');
  // Motor de SLA: previsão = faturamento + dias configurados (a menos que informem a previsão)
  if (v.data_faturamento && !v.previsao_entrega) v.previsao_entrega = somarDias(v.data_faturamento, await getSla());
  v.localizacao = v.localizacao || 'CD';
  v.status_processo = v.status_processo || STATUS[0];

  const cols = ['placa', ...Object.keys(v)];
  const vals = [placa, ...Object.values(v)];
  const r = await pool.query(
    `INSERT INTO agendamentos (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`,
    vals
  );
  res.status(201).json({ sucesso: true, mensagem: `Veículo ${placa} cadastrado.`, veiculo: paraApi(r.rows[0]) });
});

app.put('/api/agendamentos/:placa', auth('administrador', 'ti'), async (req, res) => {
  const placa = normalizarPlaca(req.params.placa);
  const { v, erro } = validarVeiculo(req.body || {});
  if (erro) throw new HttpError(400, erro);

  const veiculo = await comTransacao(async (client) => {
    const atual = await client.query('SELECT * FROM agendamentos WHERE placa = $1 FOR UPDATE', [placa]);
    if (!atual.rowCount) throw new HttpError(404, 'Veículo não encontrado.');
    if (v.data_faturamento && !('previsao_entrega' in v)) v.previsao_entrega = somarDias(v.data_faturamento, await getSla(client));
    const cols = Object.keys(v);
    if (!cols.length) return atual.rows[0];
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).concat('atualizado_em = now()');
    const r = await client.query(`UPDATE agendamentos SET ${sets.join(', ')} WHERE placa = $${cols.length + 1} RETURNING *`, [
      ...Object.values(v),
      placa,
    ]);
    if (v.localizacao) await registrarMovimentacao(client, placa, atual.rows[0].localizacao, v.localizacao, req.usuario.username);
    return r.rows[0];
  });
  res.json({ sucesso: true, mensagem: `Veículo ${placa} atualizado.`, veiculo: paraApi(veiculo) });
});

app.delete('/api/agendamentos/:placa', auth('ti'), async (req, res) => {
  const placa = normalizarPlaca(req.params.placa);
  const r = await pool.query('DELETE FROM agendamentos WHERE placa = $1', [placa]);
  if (!r.rowCount) throw new HttpError(404, 'Veículo não encontrado.');
  res.json({ sucesso: true, mensagem: `Veículo ${placa} removido.` });
});

// Rota do leitor de QR Code: qualquer perfil logado pode mudar a localização.
app.post('/api/veiculos/scan', auth(), async (req, res) => {
  const placa = normalizarPlaca((req.body || {}).placa);
  const nova = (req.body || {}).novaLocalizacao;
  if (!LOCALIZACOES.includes(nova)) throw new HttpError(400, 'Localização inválida.');

  const veiculo = await comTransacao(async (client) => {
    const atual = await client.query('SELECT * FROM agendamentos WHERE placa = $1 FOR UPDATE', [placa]);
    if (!atual.rowCount) throw new HttpError(404, 'Veículo não encontrado.');
    const r = await client.query('UPDATE agendamentos SET localizacao = $1, atualizado_em = now() WHERE placa = $2 RETURNING *', [nova, placa]);
    await registrarMovimentacao(client, placa, atual.rows[0].localizacao, nova, req.usuario.username);
    return r.rows[0];
  });
  res.json({ sucesso: true, mensagem: `Veículo ${placa} atualizado para: ${nova}`, veiculo: paraApi(veiculo) });
});

/* ---- Exportação para o Excel (CSV) ---- */
const cabecalhoCsv = ['Placa', 'Chassi', 'Cliente', 'Data de Faturamento', 'Previsão de Entrega', 'Data Agendada', 'Localização', 'Status', 'Observações', 'Atualizado em'];
const brData = (s) => (s ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : '');
const brDataHora = (s) => (s ? brData(s) + ' ' + s.slice(11, 16) : '');
const celulaCsv = (x) => {
  let s = x == null ? '' : String(x);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // evita que o Excel trate texto como fórmula
  return '"' + s.replace(/"/g, '""') + '"';
};

function chaveExcelValida(req) {
  const chave = process.env.EXCEL_API_KEY;
  const enviada = req.headers['x-api-key'];
  if (!chave || !enviada) return false;
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(chave), h(enviada));
}

app.get(
  '/api/exportar.csv',
  (req, res, next) => (chaveExcelValida(req) ? next() : auth()(req, res, next)),
  async (req, res) => {
    const r = await pool.query(`SELECT * FROM agendamentos ORDER BY placa`);
    const linhas = r.rows.map((x) =>
      [x.placa, x.chassi, x.cliente, brData(x.data_faturamento), brData(x.previsao_entrega), brDataHora(x.data_agendada),
       x.localizacao, x.status_processo, x.obs, new Date(x.atualizado_em).toLocaleString('pt-BR', { timeZone: APP_TZ })]
        .map(celulaCsv).join(';')
    );
    res.type('text/csv; charset=utf-8').send('\uFEFF' + [cabecalhoCsv.map(celulaCsv).join(';'), ...linhas].join('\r\n'));
  }
);

/* ---- Painel de TI ---- */
app.get('/api/config', auth('ti'), async (req, res) => res.json({ diasAposFaturamento: await getSla() }));

app.put('/api/config', auth('ti'), async (req, res) => {
  const dias = parseInt((req.body || {}).diasAposFaturamento, 10);
  if (!Number.isInteger(dias) || dias < 0 || dias > 365) throw new HttpError(400, 'Informe um número de dias entre 0 e 365.');
  await pool.query(`INSERT INTO config (chave, valor) VALUES ('dias_apos_faturamento', $1) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`, [String(dias)]);
  res.json({ sucesso: true, mensagem: `SLA atualizado para ${dias} dia(s). Vale para os próximos cadastros.` });
});

app.get('/api/usuarios', auth('ti'), async (req, res) => {
  const r = await pool.query('SELECT id, username, role, criado_em FROM usuarios ORDER BY username');
  res.json(r.rows);
});

app.post('/api/usuarios', auth('ti'), async (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new HttpError(400, 'Usuário: 3 a 30 caracteres (letras, números, ponto, hífen ou _).');
  if (!ROLES.includes(b.role)) throw new HttpError(400, 'Perfil inválido.');
  if (!b.password || String(b.password).length < 8) throw new HttpError(400, 'A senha precisa ter pelo menos 8 caracteres.');
  await pool.query('INSERT INTO usuarios (username, password_hash, role) VALUES ($1,$2,$3)', [username, hashSenha(b.password), b.role]);
  res.status(201).json({ sucesso: true, mensagem: `Usuário ${username} criado.` });
});

app.delete('/api/usuarios/:id', auth('ti'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.usuario.id) throw new HttpError(400, 'Você não pode remover o seu próprio usuário.');
  const r = await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
  if (!r.rowCount) throw new HttpError(404, 'Usuário não encontrado.');
  res.json({ sucesso: true, mensagem: 'Usuário removido. O acesso dele foi revogado.' });
});

/* ---- Erros ---- */
app.use('/api', (req, res) => res.status(404).json({ sucesso: false, mensagem: 'Rota não encontrada.' }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  let status = err.status || 500;
  let mensagem = err.message;
  if (err.type === 'entity.parse.failed') { status = 400; mensagem = 'JSON inválido.'; }
  else if (err.code === '23505') { status = 409; mensagem = 'Já existe um registro com esses dados (placa ou usuário repetido).'; }
  else if (['22007', '22008', '22P02'].includes(err.code)) { status = 400; mensagem = 'Data ou valor inválido.'; }
  else if (status >= 500) { console.error(err); mensagem = 'Erro interno do servidor.'; }
  res.status(status).json({ sucesso: false, mensagem });
});

initDB()
  .then(() => app.listen(PORT, '0.0.0.0', () => console.log(`Servidor YardSync rodando na porta ${PORT}`)))
  .catch((e) => {
    console.error('Falha ao iniciar o banco de dados:', e.message);
    process.exit(1);
  });
