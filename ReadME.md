# 🚘 YardSync | Gestão Inteligente de Pátio

O **YardSync** é um painel corporativo moderno e responsivo voltado para a logística automotiva e controlo de pátio. Ele combina uma interface elegante (*mobile-first*), autenticação segura de operadores, leitor de QR Code em tempo real e sincronização de agendamentos via API Node.js.

---

## 🚀 Tecnologias Utilizadas

* **Back-End:** Node.js, Express, CORS
* **Front-End:** HTML5, CSS3 (Design System com fonte *Inter*), JavaScript (Vanilla)
* **Segurança:** Autenticação baseada em tokens (Bearer Token) e proteção de rotas no servidor
* **Ferramentas:** HTML5-QRCode (Leitura de códigos via câmara)
* **Hospedagem / Deploy:** Railway

---

## 🛠️ Estrutura de Ficheiros

```text
yardsync/
├── package.json      # Dependências e script de inicialização
├── index.js          # Servidor Express, rotas da API e segurança
└── index.html        # Front-end completo (Dashboard, Login e Scanner)