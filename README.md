# TRANS

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
partendo da sinistra del mazziere.

| Esito | Punti |
|---|---|
| Dichiari **0** e fai **0** | **10** |
| Dichiari **1** e fai **1** | **15** |
| Dichiari **2** e fai **2** | **20** |
| … e così via, +5 per ogni presa dichiarata | `10 + 5 × dichiarate` |
| **Sbagli** la dichiarazione | **1 punto per ogni presa fatta** |

Dichiarare tanto paga, ma sbagliare di una sola presa azzera quasi tutto: dire 4 e
farne 4 vale 30, dire 4 e farne 3 ne vale 3.

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
normale-2             67         72.9          56.8%
esperto-0             70         72.3          58.3%
normale-1             59         69.8          55.7%
facile-3              11         35.9          31.2%
```

`facile` sta sotto di quaranta punti a partita, mentre fra `normale` ed `esperto`
il divario è piccolo: l'esperto centra la dichiarazione un paio di punti percentuali
più spesso, ma su dieci round il caso delle carte pesa ancora parecchio.

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

## Licenza

MIT — vedi [LICENSE](LICENSE).
