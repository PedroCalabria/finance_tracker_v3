## ADDED Requirements

### Requirement: Entrada pelo menu
O menu SHALL ter o item "Importar" (rota `/importar`), entre "Visão do mês" e os cadastros, com o mesmo comportamento dos outros itens (`aria-current`, gaveta no celular).

#### Scenario: Abrir a importação
- **WHEN** a pessoa clica em "Importar" no menu
- **THEN** abre a tela "Importar extrato ou fatura" no passo de envio do arquivo

### Requirement: Envio do arquivo
O passo de envio SHALL:
- aceitar arrastar e soltar ou escolher o arquivo (`accept` de PDF e OFX, sem `capture`);
- mostrar o que é aceito ("Extrato ou fatura do Banco do Brasil em PDF, ou OFX de qualquer banco · até 10 MB");
- mostrar o progresso;
- quando a API pedir senha, mostrar o campo "Senha do PDF" (tipo senha, sem autocompletar) e reenviar.

A senha e o conteúdo SHALL ficar só na memória da página, sem `localStorage`.

#### Scenario: PDF com senha
- **WHEN** a API responde `pdf_password_required`
- **THEN** a tela mostra "Este PDF tem senha" com o campo "Senha do PDF" e o botão "Abrir"

### Requirement: Destino
Depois da leitura, a tela SHALL mostrar:
- a origem detectada (ex.: "Extrato do Banco do Brasil · 01 a 31/10/2026" ou "Fatura Ourocard final ••12 · vence 10/12/2026");
- o seletor de destino, só com contas para extrato e só com cartões para fatura, pré-selecionado;
- os avisos de leitura.

Trocar o destino SHALL recalcular as sugestões. Sem destino compatível, a tela SHALL explicar e oferecer "+ Nova conta" ou "+ Novo cartão".

#### Scenario: Sem cartão cadastrado
- **WHEN** a pessoa importa uma fatura e não tem cartão
- **THEN** a tela diz "Cadastre o cartão para importar a fatura" com "+ Novo cartão"

### Requirement: Conciliação agrupada com totais
A conciliação SHALL agrupar as linhas por sugestão atual: "Casar com lançamento", "Criar lançamento", "Pagamento de fatura", "Ignorar" e "Já conciliadas" (recolhido). Na fatura, entra também o grupo "Créditos e estornos". No topo, SHALL haver totais de quantas linhas e quanto dinheiro serão importados, ignorados e já estavam conciliados.

Cada linha SHALL mostrar:
- data, descrição do banco e valor com sentido;
- a sugestão, com o lançamento casado (nome, mês, previsto e status) e o selo "Já pago no app" quando for o caso;
- um controle para trocar a ação e o alvo;
- quando necessário, as perguntas da linha ("Só este mês" / "Daqui em diante", "Desconto" / "Parcial") e, no `create`, descrição e categoria editáveis.

Linhas com pergunta sem resposta SHALL ser destacadas, e "Confirmar importação" SHALL ficar desabilitado até todas estarem respondidas.

#### Scenario: Trocar a sugestão
- **WHEN** a pessoa muda uma linha de "Criar lançamento" para "Ignorar"
- **THEN** a linha vai para o grupo "Ignorar" e os totais são atualizados

#### Scenario: Pergunta pendente
- **WHEN** uma linha casa com recorrente fixa de valor diferente e ainda não foi escolhido "Só este mês" ou "Daqui em diante"
- **THEN** a linha fica destacada e "Confirmar importação" fica desabilitado, com a dica "Responda 1 linha"

### Requirement: Seções de conferência
Abaixo das linhas, a tela SHALL mostrar "No app, mas não no extrato" (pagamentos) ou "No app, mas não na fatura" (itens). Na fatura, SHALL mostrar também o resumo "Total do banco · Itens no app · Diferença (vai para o ajuste)" e a opção "Usar as datas do banco".

#### Scenario: Resumo da fatura
- **WHEN** a pessoa concilia uma fatura
- **THEN** ela vê o total do banco, a soma dos itens depois da importação e a diferença

### Requirement: Confirmação e resultado
"Confirmar importação" SHALL enviar as decisões numa chamada. Durante o envio, o botão SHALL mostrar "Aguarde…". Em caso de sucesso, a tela SHALL mostrar o resumo ("12 pagamentos registrados, 5 lançamentos criados, 1 fatura paga, 8 ignoradas"), o link "Ver o mês" e invalidar os dados financeiros (`invalidateFinance`). Em caso de erro numa linha, a tela SHALL rolar até ela e mostrar a mensagem, e nada terá sido gravado.

#### Scenario: Sucesso
- **WHEN** a confirmação termina
- **THEN** aparece o resumo com "Ver o mês de outubro", e a tela do mês já mostra os pagamentos

### Requirement: Celular e design system
Abaixo de 1024px, a conciliação SHALL virar lista de cards (descrição, valor, data, sugestão e controle), sem rolagem horizontal da página. A tela SHALL usar só classes `ff-*`, tokens e `app.css` (ADR-0009), nos temas claro e escuro, com rótulos visíveis e controles acessíveis por teclado.

#### Scenario: Celular
- **WHEN** a pessoa concilia num celular de 390px
- **THEN** cada linha é um card com o controle de ação, e a página não rola de lado
