# Glide – simulazione 3D del parcheggio in parallelo

Simulazione nel browser del concept **Glide** (specchietti luminosi, display centrale, pulsante P) per pitch e test con utenti.
Progetto Politecnico di Milano × Italdesign.

## Avvio

```bash
npm install
npm run dev
```

Apri l'indirizzo mostrato (di solito http://localhost:5173) in Chrome.

## Comandi

| Tasto | Azione |
|---|---|
| ↑ / ↓ | acceleratore / freno |
| ← / → | volante (continuo; in marcia avanti torna lentamente al centro, da fermo e in retro resta dove lo lasci) |
| R / D | retromarcia / marcia (solo da fermo) |
| Spazio | freno forte |
| Z / X (tieni premuto) | guarda lo specchietto sinistro / destro (la testa si gira e la vista si stringe) |
| Q / E | freccia sinistra / destra (a destra valuta lo spazio evidenziato) |
| P | pulsante Park Assist (di nuovo: annulla) |
| 1 / 2 | sul display: Assistito / Autonomo |
| Invio | "Avvia" (dopo la preview) · "Riprendi in autonomo" (dopo una presa di controllo) |
| A | "Passa all'assistito" (dalla preview o dal punto in cui l'auto si è fermata) |
| M | "Finisco io a mano" |
| ↓ / Spazio / ← / → in autonomo | presa di controllo: l'auto si ferma subito |
| C | cambia vista: posto guida → esterna → dall'alto |
| V | split-screen posto guida + esterna |
| N | scenario Vuoto ↔ Animato (resetta la scena) |
| trascina il mouse | gira la testa al posto guida (doppio clic: centra) |
| H | nasconde la UI di debug |
| F1 | pannello parametri |
| Esc | reset scenario |

## Cosa simula

- **Collisioni:** carrozzeria contro auto parcheggiate, pneumatici contro il cordolo. Al contatto l'auto si ferma e il contatto viene contato (HUD, poi log CSV).
- **Specchietti:** riflesso reale calcolato dall'occhio del guidatore (cambia se giri la testa). Destro convesso (campo più ampio, come sulle auto europee), sinistro quasi piano.

- **Parcheggio assistito:** il pianificatore calcola punto di inizio sterzata, angolo, punto di controsterzo, angolo di controsterzo e punto di raddrizzamento. Durante la manovra ricalcola dalla posizione reale: se sterzi un po' di più o di meno, il punto di controsterzo si sposta di conseguenza. Con la UI di debug visibile la traiettoria pianificata è disegnata sulla strada.
- **Barre luminose:** tutti gli stati del capitolo 2 (pronto, in corso, in obiettivo, oltre, countdown, punto raggiunto, preannuncio, scatto, spento). Lo zero è sempre sul lato verso l'auto.
- **Fine manovra:** "P inserita" quando l'auto è ferma nello spazio con le ruote dritte da 1 s.

- **Flusso sul display:** sotto i 15 km/h compare la ricostruzione 3D con gli spazi (blu = ci sta) e quello più vicino evidenziato; la freccia a destra lo valuta ("ci sta / non ci sta" e con che margine); P mostra la modalità consigliata con il motivo e, per ogni modalità, cosa fa Glide e cosa fai tu. Durante la manovra il display mostra solo l'essenziale (telecamera posteriore con gli stessi obiettivi se attivata nel pannello). Dentro lo spazio: sensori e telecamera. Alla fine: rinforzo fattuale.

- **Modalità autonoma:** l'auto segue esattamente la traiettoria della preview, quindi i punti critici annunciati (distanza minima, tratto più rapido, punto dove i sensori vedono male) sono quelli della manovra. Negli specchietti la barra (senza tacca) arriva all'angolo che il volante avrà 1 s dopo; in movimento i segmenti contano fino al prossimo cambio di comportamento. Profilo velocità Fluido (default) o Brusco.
- **Interruzioni:** I1 presa di controllo con freno o volante, con tre scelte (riprendi, assistito da qui, a mano); I2 "cordolo poco visibile": Glide si ferma dove l'aveva annunciato e propone l'assistito; I3 "ostacolo imprevisto" (pulsante nel pannello): l'auto si ferma, mostra la nuova traiettoria per 3,5 s e riparte. Se non esiste una manovra sicura lo dice e propone assistito o guida a mano.

- **Scenari:** *Vuoto* (default: solo auto parcheggiate) e *Animato* (pedoni, auto che aspetta dietro, ciclista, traffico nella corsia opposta). Si cambia con N o dal pannello; ogni attore si può anche accendere e spegnere da solo.
- **Auto che aspetta dietro:** arriva quando premi P e si ferma dietro di te alla distanza impostata (default 6 m). È un ostacolo reale: conta nelle collisioni e nei sensori, e in autonomo, quando si ferma, Glide ricontrolla il resto della traiettoria. Con "Si infila troppo vicina" (60 cm) Glide si ferma e dice "L'auto dietro è troppo vicina". Dopo essersi fermata non avanza più mentre fai manovra; quando sei dentro lo spazio riparte.
- **Auto dietro in assistito:** se si ferma prima della retro e la manovra non è più libera, Glide la ricalcola; se non ci sta più, mostra "La manovra non ci sta · L'auto dietro è troppo vicina" e si ferma. Se è vicina (meno di 60 cm dalla traiettoria), quando inizi la retro compare da sola la telecamera posteriore. Se continuando a quel modo la toccheresti, nello specchietto il countdown finisce prima ("Fermati qui: dietro non c'è spazio") e Glide prosegue col controsterzo da lì. Vale per qualunque ostacolo sul percorso.
- **Ciclista:** arriva da dietro a sinistra e ti passa accanto durante il controsterzo (assistito: quando inizia il controsterzo; autonomo: 2,5 s prima). Si sposta a sinistra per non toccare né te né l'auto dietro, e aspetta se dalla corsia opposta arriva qualcuno.
- **Pedoni** sui due marciapiedi e **traffico** nella corsia opposta (si ferma se invadi la sua corsia). Sul display gli attori compaiono nella ricostruzione 3D (pedoni e ciclista in giallo).
- **Pericolo (pedone/ciclista improvviso):** comportamento non ancora definito dal gruppo. Con il toggle acceso, quando ciclista o pedone passano a meno di 1 m dall'auto viene chiamato l'hook vuoto `onHazard` in `src/modes/flow.ts` (e scritto in console).
- **Suoni** (sintetizzati, Web Audio): conferma breve (in obiettivo / punto raggiunto) dal lato dello specchietto attivo, attivazione P, avvio autonomo, fine. Sensori di parcheggio solo sotto i 30 cm, a bip brevi sempre più fitti, mai continui. L'audio parte dopo il primo tasto premuto (regola del browser).

### Lunghezza degli spazi

Con quest'auto (passo 2,6 m, sterzata 35°) una sola manovra richiede uno spazio di almeno **auto + 2,0 m**. Decisione del gruppo: lo spazio "stretto" è auto + 2,2 m; nella fila c'è anche uno spazio da auto + 1,0 m, che Glide segnala come "non ci sta in una manovra", e uno ampio (7,2 m) dove consiglia l'autonomo.

## Parametri (F1)

- **Telecamera in movimento**: display con telecamera posteriore durante la retro (default spento)
- **Profilo velocità** (autonomo): Fluido / Brusco
- **Anticipo barra** (autonomo): 0,5–1,5 s, default 1 s
- **Cordolo poco visibile (I2)**, **Ostacolo imprevisto (I3)**
- **Scenario e attori**: Vuoto / Animato, pedoni, auto che aspetta dietro, distanza auto dietro (1,5–8 m), si infila troppo vicina, ciclista, traffico corsia opposta, pericolo (hook `onHazard`, spento)
- **Suoni**: volume
- **Ora**: giorno / sera
- **Qualità grafica**: alta / bassa (passa a bassa da sola se gli FPS restano sotto 40 per 3 s)

## Stato

- [x] 1. Scena, strada, auto con cinematica e tastiera, viste
- [x] 2. Specchietti con riflesso reale
- [x] 3. Pianificatore + barra luminosa (assistita)
- [x] 4. Display centrale (passi 1–5 e 11–12)
- [x] 5. Modalità autonoma (preview, avvio, interruzioni I1–I3)
- [x] 6. Attori e suoni
- [ ] 7. Modalità demo
- [ ] 8. Pannello parametri e log CSV

## Crediti

HDRI CC0 da [Poly Haven](https://polyhaven.com): *Kloofendal 48d Partly Cloudy (Pure Sky)* (giorno), *Qwantani Dusk 2 (Pure Sky)* (sera).
