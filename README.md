# 🚘 YardSync | Gestão Inteligente e Rastreio de Pátio para Concessionárias

> **Conecte a operação de pátio às suas planilhas.** O YardSync permite que portarias e equipes de campo escaneiem os QR Codes dos veículos com o celular para atualizar posições em tempo real, sincronizando tudo diretamente com o Microsoft Excel via VBA.

---

## 🎯 Apresentação Executiva

No setor automotivo, a agilidade na movimentação de veículos entre o Centro de Distribuição (CD) e o showroom define a eficiência operacional de uma concessionária. O **YardSync** elimina os gargalos e a digitação manual de planilhas ao unir tecnologia mobile e automação de escritório. 

A partir do QR Code já presente no veículo, o operador realiza o escaneamento na portaria ou no pátio, atualiza o status instantaneamente e mantém a gerência informada sem alterar a rotina de controle em Excel.

---

## 🚀 Principais Benefícios para Concessionárias

* **Agilidade na Portaria e Pátio:** Escaneamento rápido do QR Code do veículo usando a câmera de qualquer smartphone (sem instalação de aplicativos complexos).
* **Mapeamento de Status em Tempo Real:**
  * 🏬 **Pátio Loja:** Veículo disponível no showroom ou pátio de exposição.
  * 🏭 **CD (Centro de Distribuição):** Estocado no armazém ou pátio central.
  * 🚚 **Em Trânsito:** Em deslocamento entre unidades ou em transporte.
  * 📦 **Solicitado do CD:** Requisitado pela equipe comercial para preparação.
* **Sincronização Nativa com Excel/VBA:** Atualize o banco de dados interno da gerência com apenas um clique na planilha.
* **Conformidade com a LGPD:** Tratamento seguro e minimizado de dados confidenciais de clientes e veículos.

---

## 📱 Funcionalidades do Sistema

### 1. Web App Mobile (Operação de Campo)
* **Scanner por Câmera:** Leitura direta do QR Code afixado no veículo pelo navegador do celular.
* **Ficha Completa do Veículo:** Exibição instantânea de **Placa, Chassi, Cliente, Data de Entrega e Localização Atual**.
* **Atualização de Status:** Permite alternar o status logístico do veículo com confirmação imediata no servidor.
* **Painel do Pátio:** contadores por localização, entregas do dia, atrasados, busca e filtros.
* **Cadastro e edição (Administrador/TI):** status comercial, data de entrega agendada, observações e previsão calculada automaticamente (faturamento + SLA).
* **Painel de TI:** ajuste do SLA e gestão de usuários.

### 2. Módulo de Integração Excel / VBA (Gerência)
* **Sincronização Automatizada:** macro (`excel/YardSyncModulo.bas`) via requisição HTTP (`MSXML2.ServerXMLHTTP`) que baixa um CSV do servidor e preenche a planilha com um clique, usando uma chave somente leitura.

---

## 🔒 Segurança e LGPD

Desenvolvido sob padrões de proteção de dados:
* **Minimização:** armazenamento restrito aos dados essenciais para o fluxo logístico (Placa, Chassi, Cliente, Datas, Localização e Status).
* **Criptografia em trânsito:** em produção o servidor redireciona HTTP para `HTTPS` (o certificado é fornecido pela hospedagem, como o Railway).
* **Autenticação e perfis:** login com token assinado (12 h), senhas com hash `scrypt` e três perfis — *Operador de pátio*, *Administrador* e *TI / Gestor*. Remover um usuário revoga o acesso na hora.
* **Rastreabilidade:** cada mudança de localização grava quem fez, de onde para onde e quando.
* **Proteção contra tentativas de invasão:** limite de tentativas de login por IP.

---

## ▶️ Como rodar

```bash
npm install
cp .env.example .env      # preencha DATABASE_URL e AUTH_SECRET
npm start
```

No primeiro start o servidor cria as tabelas e o usuário `admin` (perfil TI). Se `ADMIN_PASSWORD` não estiver definida, a senha gerada aparece **uma única vez** no log.

**Excel:** importe `excel/YardSyncModulo.bas` (instruções no topo do arquivo) e defina `EXCEL_API_KEY` no servidor.

---

## 🛠️ Stack Tecnológica

| Camada | Tecnologia |
| :--- | :--- |
| **Frontend Mobile** | HTML5, CSS3, JavaScript (PWA / Responsivo) |
| **Leitor de QR Code** | Biblioteca `html5-qrcode` integrada à câmera |
| **Backend / API** | Node.js com Express 5 (hospedado na nuvem via HTTPS) |
| **Banco de dados** | PostgreSQL (`pg`) |
| **Módulo Corporativo** | Microsoft Excel com macros VBA |

---

<p align="center">
  <b>YardSync</b> — Inteligência e agilidade para o fluxo de veículos da sua concessionária.
</p>
