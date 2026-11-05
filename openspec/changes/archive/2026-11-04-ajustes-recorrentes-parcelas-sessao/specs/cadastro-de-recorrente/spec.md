## ADDED Requirements

### Requirement: Recorrente se cadastra com mês de início e dia
O cadastro de um lançamento recorrente SHALL pedir "Mês de início" (obrigatório) e um dia de 1 a 31, cujo rótulo e obrigatoriedade dependem do tipo e do método:

| Tipo e método | Rótulo do dia | Obrigatório |
| --- | --- | --- |
| Despesa fora do crédito | "Dia para o pagamento" | Não |
| Entrada | "Dia do recebimento" | Sim |
| Despesa no crédito | "Dia da cobrança" | Sim |

A recorrente SHALL NOT exibir o campo "Data" nem o rótulo "Vencimento". A API SHALL receber `startMonth` (`YYYY-MM`) e `day` (inteiro ou nulo) para `form: "recurring"` e SHALL recusar `date`/`dueDate` nesse caso. A obrigatoriedade do dia SHALL ser verificada no servidor, com erro de validação no campo `day`.

#### Scenario: Despesa fora do crédito sem dia
- **WHEN** a pessoa cadastra "Academia", recorrente, pix, mês de início 2026-11, sem dia
- **THEN** o item é gravado com `start_month = 2026-11` e `due_day` nulo, as ocorrências não têm data p/ pagamento e não há lembrete por email

#### Scenario: Despesa fora do crédito com dia 31
- **WHEN** a pessoa cadastra uma recorrente com mês de início 2027-01 e dia para o pagamento 31
- **THEN** a ocorrência de fevereiro de 2027 tem data p/ pagamento 2027-02-28 e a de março, 2027-03-31

#### Scenario: Entrada sem dia
- **WHEN** a pessoa tenta cadastrar uma entrada recorrente sem "Dia do recebimento"
- **THEN** o servidor responde 400 `validation` com a mensagem "Informe o dia do recebimento." no campo `day`

#### Scenario: Crédito sem dia
- **WHEN** a pessoa tenta cadastrar uma recorrente no crédito sem "Dia da cobrança"
- **THEN** o servidor responde 400 `validation` com a mensagem "Informe o dia da cobrança." no campo `day`

#### Scenario: Crédito com dia da cobrança
- **WHEN** a pessoa cadastra uma assinatura no crédito com mês de início 2026-11 e dia da cobrança 20, num cartão que fecha no dia 10
- **THEN** a cobrança de cada mês cai no dia 20 e vai para a fatura definida pela regra compra × fechamento (ADR-0005)

#### Scenario: Contrato antigo
- **WHEN** um cliente envia `form: "recurring"` com `date` e sem `startMonth`
- **THEN** o servidor responde 400 `validation` no campo `startMonth`

### Requirement: Seletor de mês compatível com todos os navegadores
O "Mês de início" SHALL usar um controle de mês e ano feito com elementos `<select>` estilizados com `ff-select`, sem `<input type="month">` e sem cores literais. Ele SHALL ter rótulo acessível para mês e ano. O padrão no cadastro SHALL ser o mês que está aberto na tela.

#### Scenario: Safari no computador
- **WHEN** a pessoa abre o cadastro de recorrente no Safari para macOS
- **THEN** ela escolhe mês e ano em duas listas e o valor enviado é `YYYY-MM`

#### Scenario: Cadastro aberto em mês futuro
- **WHEN** a pessoa está vendo janeiro de 2027 e clica em "+ Adicionar"
- **THEN** o "Mês de início" já vem com janeiro de 2027

### Requirement: Edição do dia vale daqui em diante
Na edição de uma recorrente fora do crédito, mudar o dia SHALL ser uma mudança simples. A regra (`due_day`) passa a valer, e o mês aberto e os meses seguintes já gravados, pendentes e sem pagamento SHALL receber a data p/ pagamento no dia novo. Os meses anteriores ao aberto SHALL ficar como estão. Tirar o dia SHALL deixar esses meses sem data p/ pagamento. No crédito, mudar o "Dia da cobrança" SHALL continuar estrutural, porque muda a fatura de cada mês.

#### Scenario: Mudar o dia a partir de dezembro
- **WHEN** uma recorrente de dia 10 tem novembro pago e dezembro gravado pendente, e a pessoa abre dezembro e muda o dia para 15
- **THEN** dezembro e os meses previstos seguintes passam a vencer no dia 15, novembro continua no dia 10 e o pagamento de novembro é preservado

#### Scenario: Mudar o dia da cobrança no crédito com mês pago
- **WHEN** a pessoa muda o dia da cobrança de uma recorrente no crédito que tem parte numa fatura já paga
- **THEN** a interface avisa antes de salvar que a mudança recalcula os meses e o servidor responde 409, como nas demais mudanças estruturais

### Requirement: Mudar o mês de início é estrutural
Mudar o "Mês de início" na edição SHALL recriar os meses como num cadastro novo (mesmo id), seguindo a regra estrutural do ADR-0004. A mudança SHALL ser recusada com 409 se houver qualquer pagamento ou parte numa fatura já paga. Meses marcados como "Só este mês" (cancelados) SHALL continuar cancelados depois da recriação, quando o mês ainda existir na sequência nova.

#### Scenario: Antecipar o início sem pagamentos
- **WHEN** uma recorrente começa em 2026-11, não tem pagamentos, e a pessoa muda o mês de início para 2026-09
- **THEN** os meses de 2026-09 até o mês atual são gravados e o item continua com o mesmo id

#### Scenario: Mudar o início com mês pago
- **WHEN** a recorrente já tem um mês pago e a pessoa muda o mês de início
- **THEN** a interface avisa antes de salvar e o servidor responde 409 com a orientação de encerrar e cadastrar de novo
