# TRANS

[![ci](https://github.com/dantonioluigi/trans-card-game/actions/workflows/ci.yml/badge.svg)](https://github.com/dantonioluigi/trans-card-game/actions/workflows/ci.yml)
[![release](https://github.com/dantonioluigi/trans-card-game/actions/workflows/release.yml/badge.svg)](https://github.com/dantonioluigi/trans-card-game/actions/workflows/release.yml)

Gioco di carte a **prese e dichiarazioni**: una via di mezzo fra briscola e tresette,
dove il punto non è prendere tanto, ma prendere **esattamente quanto avevi detto**.

Multiplayer online (basta un link) oppure da soli contro i bot. Niente account,
niente installazioni per chi gioca: si apre il browser e si entra con un codice a 4 lettere.

![tavolo](docs/screenshot.png)

---

## Le regole

**Il mazzo.** 52 carte francesi, niente jolly.
Valori: `2 < 3 < … < 10 < J < Q < K < A`. La **briscola è sempre cuori ♥**.

**La presa.** Chi esce sceglie il seme. Sei **obbligato a rispondere a quel seme** se
ce l'hai in mano; se non ce l'hai giochi quello che vuoi, briscola compresa.
Vince la briscola più alta, altrimenti la carta più alta del seme di uscita.
Chi prende esce nella presa successiva.

**La dichiarazione.** Prima di giocare ognuno dichiara quante prese farà,
partendo da sinistra del mazziere — che quindi parla per ultimo.

**Il mazziere non può pareggiare il conto:** la somma delle dichiarazioni non
può fare esattamente il numero di prese in palio. In cinque, in un round da 5
carte, se i primi quattro dicono 1 a testa il mazziere non può dire 1: dovrà
dire 0, oppure 2 o più. Così almeno un giocatore sbaglia per forza, e chiudere
il giro diventa la posizione più scomoda del tavolo.

| Esito | Punti |
|---|---|
| Dichiari **0** e fai **0** | **10** |
| Dichiari **1** e fai **1** | **15** |
| Dichiari **2** e fai **2** | **20** |
| … e così via, +5 per ogni presa dichiarata | `10 + 5 × dichiarate` |
| **Sbagli** la dichiarazione | **1 punto per ogni presa fatta** |

Dichiarare tanto paga, ma sbagliare di una sola presa azzera quasi tutto: dire 4 e
farne 4 vale 30, dire 4 e farne 3 ne vale 3.

![la dichiarazione](docs/dichiarazione.png)

Si dichiara guardando le proprie carte — tranne nel round BUIO, dove restano coperte.

**I round.** Si scende di mano in mano — 7 carte a testa, poi 6, 5, 4, 3, 2, 1 —
e poi arrivano i tre round speciali, tutti da 7 carte:

| Round | Cosa cambia |
|---|---|
| **NO BRISCOLA** | Non c'è briscola. Vince sempre la carta più alta del seme di uscita. |
| **BUIO** | Dichiari **senza guardare le tue carte**. Le vedi solo dopo che hanno parlato tutti. |
| **A PERDERE** | Non si dichiara: ogni presa che incassi vale **−5 punti**. |

**Durata.**

- **Partita veloce — 10 round:** `7, 6, 5, 4, 3, 2, 1` + NO BRISCOLA, BUIO, A PERDERE.
- **Partita lunga — 20 round:** la veloce, poi la risalita `1, 2, 3, 4, 5, 6, 7`
  e di nuovo i tre speciali.

Vince chi ha più punti alla fine. Si gioca da **2 a 6 giocatori**, umani o bot mescolati.

---

## Come si avvia

```bash
git clone https://github.com/<utente>/trans-card-game.git
cd trans-card-game
pip install -r requirements.txt
python -m server.main
```

Apri <http://localhost:8000>, scegli un nome e **Crea tavolo**: ti ritrovi un codice
a 4 lettere. Passalo agli altri (o usa *copia il link d'invito*), riempi i posti
vuoti con i bot e parti.

Variabili d'ambiente utili:

| Variabile | Default | A cosa serve |
|---|---|---|
| `TRANS_HOST` | `0.0.0.0` | interfaccia di ascolto |
| `TRANS_PORT` | `8000` | porta |
| `TRANS_RELOAD` | *(vuoto)* | se valorizzata, ricarica a caldo durante lo sviluppo |

Con Docker:

```bash
docker build -t trans .
docker run --rm -p 8000:8000 trans
```

---

## I bot

Tre livelli, si scelgono uno per uno quando si aggiungono al tavolo.

| Livello | Come dichiara | Come gioca |
|---|---|---|
| `facile` | tira a indovinare intorno alla quota equa | carta legale a caso |
| `normale` | stima le prese con playout Monte Carlo sulle mani possibili | prende con la carta più economica che basta, altrimenti scarica |
| `esperto` | più simulazioni | tiene il conto delle carte già uscite e sa quando una carta è imbattibile |

Un umano che si disconnette non blocca il tavolo: il computer gioca al posto suo
finché non torna, e riprende il suo posto riaprendo il link.

Per vedere quanto valgono davvero:

```bash
python -m trans.simulate --games 200 --levels esperto normale normale facile
```

```
200 partite · Partita veloce (10 round) · 4 giocatori

giocatore       vittorie   punti medi   scommesse ok
esperto-0             71         69.7          56.4%
normale-2             60         67.0          51.3%
normale-1             63         66.5          53.0%
facile-3              10         38.8          33.7%
```

`facile` sta trenta punti sotto agli altri, mentre fra `normale` ed `esperto` il
divario resta piccolo: su dieci round il caso delle carte pesa ancora parecchio.

Quel 56% va letto ricordando che il mazziere non può pareggiare il conto: **almeno
un giocatore per round sbaglia sempre**, quindi in quattro il tetto teorico è 75%.

---

## Com'è fatto

```
trans/          engine puro, senza rete e senza UI
  cards.py      mazzo, valori, chi vince la presa
  rules.py      calendario dei round e punteggio
  engine.py     macchina a stati della partita
  bots.py       i tre livelli di bot
  simulate.py   auto-partite per tarare i bot
server/         FastAPI: pagina + WebSocket
  room.py       tavoli, lobby, riconnessioni, turni dei bot
  main.py       endpoint HTTP e WebSocket
web/            client, HTML/CSS/JS senza build step
tests/          74 test su regole, engine e server
helm/           chart Kubernetes
.github/        ci (test, chart, client) e release su tag
```

Tre scelte che vale la pena conoscere:

- **L'engine non sa che esiste la rete.** `trans/` è deterministico a parità di seed,
  quindi le regole si testano senza server e i bot ci girano contro a velocità piena.
- **Il server è l'unico arbitro.** Il client non decide mai cosa è legale: manda
  l'intenzione (`bid`, `play`) e riceve uno stato già filtrato. La mano di un giocatore
  non passa mai sul socket di un altro — nemmeno nel round BUIO, dove resta coperta
  anche per il proprietario finché non ha dichiarato.
- **Lo stato dei tavoli vive in memoria.** Un riavvio azzera le partite in corso: è
  voluto, tiene il deploy a un solo processo senza database.

### Test

```bash
pip install -r requirements-dev.txt
python -m pytest
```

Coprono le regole (chi vince una presa, i punteggi, il calendario dei round),
l'engine (turni, obbligo di seme, mosse illegali, partite complete da 2 a 6 giocatori)
e il server via WebSocket (lobby, permessi dell'host, privatezza delle mani,
riconnessione, una partita intera contro i bot).

---

## Rilasci

Il rilascio parte da un tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

Da lì [`release.yml`](.github/workflows/release.yml) manda avanti **due job in
parallelo** — nessuno dei due aspetta l'altro:

| Job | Cosa fa |
|---|---|
| `image` | build multi-arch (`amd64` + `arm64`) e push su `ghcr.io/dantonioluigi/trans-card-game`, taggata `1.0.0`, `1.0` e `latest` |
| `chart` | riscrive `version` e `appVersion` del chart col numero del tag, fa lint, impacchetta e pubblica su `oci://ghcr.io/dantonioluigi/charts` |

Quando entrambi hanno finito, un terzo job crea la GitHub Release con le note
generate dai commit e il `.tgz` del chart allegato. Un tag tipo `v1.0.0-rc1`
produce una pre-release e non muove `latest`.

Su ogni push e ogni PR gira invece [`ci.yml`](.github/workflows/ci.yml), sempre
in parallelo: i test su Python 3.10 e 3.12, il lint del chart e il controllo di
sintassi del client.

---

## Su Kubernetes

```bash
helm install trans oci://ghcr.io/dantonioluigi/charts/trans-card-game --version 1.0.0
```

Oppure dal repo, senza registry:

```bash
helm install trans ./helm/trans-card-game \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=trans.casa.it
```

Le voci di [`values.yaml`](helm/trans-card-game/values.yaml) che contano davvero:

| Valore | Default | Nota |
|---|---|---|
| `replicaCount` | `1` | **lascialo a 1.** I tavoli stanno nella memoria del processo: con due repliche due giocatori che digitano lo stesso codice finiscono su pod diversi e non si vedono. Il chart te lo dice anche a installazione fatta. |
| `ingress.annotations` | timeout a 3600s | i WebSocket restano aperti per tutta la partita; con i timeout di default l'ingress taglia la connessione a metà mano |
| `image.tag` | `""` | vuoto significa "usa `appVersion` del chart", cioè la versione rilasciata |
| `resources` | 50m / 96Mi | il processo è piccolo; il picco è quando i bot simulano le mani per dichiarare |

Il Deployment usa strategia `Recreate` e non `RollingUpdate`, per lo stesso
motivo: due pod attivi insieme sarebbero due partite diverse. Un aggiornamento
interrompe le partite in corso — è il prezzo di non avere un database.

---

## Licenza

MIT — vedi [LICENSE](LICENSE).
