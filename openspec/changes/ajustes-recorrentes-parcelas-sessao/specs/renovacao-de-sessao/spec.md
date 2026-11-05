## ADDED Requirements

### Requirement: Renovação em qualquer 401 fora de /api/auth
O cliente HTTP SHALL tratar qualquer resposta 401 de uma rota fora de `/api/auth/` como possível sessão vencida, qualquer que seja o código do erro (`unauthorized`, `token_expired` ou outro). Ele SHALL tentar renovar a sessão uma única vez por requisição e SHALL repetir a requisição original uma única vez. Respostas 401 de rotas `/api/auth/` SHALL NOT disparar renovação.

#### Scenario: Cookie de acesso já apagado pelo navegador
- **WHEN** a pessoa volta à aba depois de 20 minutos, o navegador já apagou `ff_access`, e o `ff_refresh` ainda é válido
- **THEN** a primeira chamada recebe 401 `unauthorized`, o cliente chama `/api/auth/refresh` e repete a chamada, e a pessoa vê os dados sem passar pelo login

#### Scenario: Token expirado com cookie ainda presente
- **WHEN** uma chamada recebe 401 `token_expired`
- **THEN** o cliente renova a sessão e repete a chamada uma vez

#### Scenario: Login com senha errada
- **WHEN** `/api/auth/login` responde 401 `invalid_credentials`
- **THEN** o cliente não tenta renovar e devolve o erro para a tela

### Requirement: Uma renovação por vez
Chamadas simultâneas que recebem 401 SHALL compartilhar uma única chamada a `/api/auth/refresh` dentro da aba. Quando o navegador oferecer a Web Locks API, a renovação SHALL também ser serializada entre as abas da mesma origem.

#### Scenario: Cinco chamadas ao mesmo tempo
- **WHEN** a tela do mês dispara cinco consultas e todas recebem 401
- **THEN** o cliente faz uma única chamada a `/api/auth/refresh` e repete as cinco consultas depois dela

#### Scenario: Duas abas renovando ao mesmo tempo com Web Locks
- **WHEN** duas abas recebem 401 quase ao mesmo tempo
- **THEN** a segunda aba só chama `/api/auth/refresh` depois que a resposta da primeira gravou os cookies novos, e as duas continuam logadas

### Requirement: Repetir mesmo quando a renovação falha
Quando a renovação falhar, o cliente SHALL repetir a requisição original uma vez antes de considerar a sessão perdida, porque outra aba pode já ter renovado os cookies. Quando a falha tiver o código `refresh_superseded`, o cliente SHALL esperar um instante curto (até 1 s) antes de repetir. O cliente SHALL chamar o tratador de sessão perdida (ir para `/entrar` lembrando de onde veio) somente se a repetição também receber 401.

#### Scenario: Aba que perdeu a corrida
- **WHEN** a renovação de uma aba responde 401 `refresh_superseded` porque outra aba acabou de rotacionar o token
- **THEN** o cliente espera um instante, repete a requisição original com os cookies que a outra aba recebeu, e a pessoa continua logada

#### Scenario: Sessão revogada de verdade
- **WHEN** a pessoa usou "Sair de todos os aparelhos" em outro lugar, a renovação responde 401 e a repetição também responde 401
- **THEN** o cliente vai para `/entrar` lembrando a página atual

#### Scenario: Sem conexão durante a repetição
- **WHEN** a renovação ou a repetição falham por falta de rede
- **THEN** o cliente mostra o erro de conexão (`offline`) e não manda para o login

### Requirement: Corrida de rotação não apaga os cookies
O `/api/auth/refresh` SHALL responder 401 com código `refresh_superseded` quando receber um refresh token já rotacionado há no máximo 30 s, ou quando perder a atualização concorrente da mesma linha. Essa resposta SHALL NOT apagar os cookies `ff_access` e `ff_refresh` nem revogar a família. As demais falhas de renovação (token ausente, desconhecido, revogado, vencido, ou reuso depois de 30 s) SHALL continuar respondendo 401 `unauthorized` e apagando os cookies. Reuso depois de 30 s SHALL continuar revogando a família. A validade do cookie `ff_access` SHALL continuar igual à do JWT (15 minutos).

#### Scenario: Duas renovações com o mesmo token
- **WHEN** duas chamadas a `/api/auth/refresh` chegam com o mesmo refresh token e uma delas rotaciona primeiro
- **THEN** a vencedora responde 200 com cookies novos, a outra responde 401 `refresh_superseded` sem `Set-Cookie` que apague cookies, e uma chamada a `/api/me` com os cookies da vencedora responde 200

#### Scenario: Reuso depois da janela
- **WHEN** um refresh token rotacionado há mais de 30 s é usado de novo
- **THEN** a resposta é 401 `unauthorized`, os cookies são apagados e a família inteira é revogada, como hoje

#### Scenario: Sem cookie de acesso e com refresh válido
- **WHEN** uma rota protegida recebe uma requisição sem `ff_access` e depois `/api/auth/refresh` recebe o `ff_refresh` válido
- **THEN** a rota responde 401 `unauthorized`, a renovação responde 200 com cookies novos, e a mesma rota repetida responde 200
