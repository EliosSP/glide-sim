# Glide – simulazione 3D del parcheggio in parallelo

Simulazione nel browser del concept **Glide** (specchietti luminosi, display centrale, pulsante P) per pitch e test con utenti.
Progetto Politecnico di Milano × Italdesign.

## Avvio

```bash
npm install
npm run dev
```

Apri l'indirizzo mostrato (di solito http://localhost:5173) in Chrome.

## Pubblicazione

Il simulatore è pubblicato su GitHub Pages: **https://eliossp.github.io/glide-sim/** (da aprire in Chrome).

- Ogni push su `main` pubblica la nuova versione in 1–2 minuti (workflow `.github/workflows/deploy.yml`).
- Gli errori di pubblicazione si vedono nella scheda **Actions** del repository.
- **Attenzione:** un errore TypeScript blocca la pubblicazione. Prima di fare push esegui `npm run build` in locale e controlla che finisca senza errori.
- Il repository è privato, ma il sito è visibile a chiunque abbia il link.
- In locale non cambia nulla: `npm run dev` usa il percorso `/`; la pubblicazione usa `/glide-sim/` (dalla variabile `VITE_BASE`, impostata dal workflow con il nome del repository).

## Comandi

| Tasto | Azione |
|---|---|
| ↑ / ↓ | acceleratore / freno |
| ← / → | volante (continuo; in marcia avanti torna lentamente al centro, da fermo e in retro resta dove lo lasci) |
| R / D | retromarcia / marcia (solo da fermo) |
| Spazio | freno forte |
| Z / X (tieni premuto) | guarda lo specchietto sinistro / destro (la testa si gira e la vista si stringe) |
| W (tieni premuto) | guarda il retrovisore interno |
| Q / E | freccia sinistra / destra (a destra valuta lo spazio evidenziato) |
| P | pulsante Park Assist (di nuovo: annulla; in autonomo frena e restituisce il controllo) |
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
| G (o F1) | pannello parametri (su Mac F1 senza fn regola la luminosità) |
| F | schermo intero |
| 0 | avvia / ferma la demo per il pitch |
| I | modalità test: mostra / nasconde l'indicatore partecipante · prova |
| L | esporta i due CSV del log |
| Esc / Backspace | reset scenario (in schermo intero Esc esce solo dal fullscreen) |

## Cosa simula

- **Collisioni:** carrozzeria contro auto parcheggiate, pneumatici contro il cordolo. Al contatto l'auto si ferma e il contatto viene contato (HUD, poi log CSV).
- **Specchietti:** riflesso reale calcolato dall'occhio del guidatore (cambia se giri la testa). Destro convesso (campo più ampio, come sulle auto europee), sinistro quasi piano. Retrovisore interno piatto, senza barra luminosa (si vede attraverso abitacolo e lunotto; in qualità bassa si aggiorna a frame alterni).
- **Ambiente:** asfalto, marciapiede a lastre, cordolo in pietra e intonaco delle facciate con texture PBR CC0; auto parcheggiate in quattro sagome (utilitaria, berlina, SUV, monovolume) con targhe; alberi, cestini sui lampioni, cartello P e strisce pedonali. Nessun oggetto sta in carreggiata o nella fila di parcheggio, quindi pianificatore e collisioni non cambiano.

- **Parcheggio assistito:** il pianificatore calcola punto di inizio sterzata, angolo, punto di controsterzo, angolo di controsterzo e punto di raddrizzamento. Durante la manovra ricalcola dalla posizione reale: se sterzi un po' di più o di meno, il punto di controsterzo si sposta di conseguenza. Con la UI di debug visibile la traiettoria pianificata è disegnata sulla strada.
- **Barre luminose:** tutti gli stati del capitolo 2 (pronto, in corso, in obiettivo, oltre, countdown, punto raggiunto, preannuncio, scatto, spento). Lo zero è sempre sul lato verso l'auto. La barra è sul bordo inferiore del guscio, visibile da dentro e da fuori.
- **Fine manovra:** "P inserita" quando l'auto è ferma nello spazio con le ruote dritte da 1 s.

- **Flusso sul display:** sotto i 15 km/h compare la ricostruzione 3D con gli spazi (blu = ci sta) e quello più vicino evidenziato; la freccia a destra lo valuta ("ci sta / non ci sta" e con che margine); P mostra la modalità consigliata con il motivo e, per ogni modalità, cosa fa Glide e cosa fai tu. Durante la manovra il display mostra solo l'essenziale (telecamera posteriore con gli stessi obiettivi se attivata nel pannello). Dentro lo spazio: sensori e telecamera. Alla fine: rinforzo fattuale.

- **Modalità autonoma:** l'auto segue esattamente la traiettoria della preview, quindi i punti critici annunciati (distanza minima, tratto più rapido, punto dove i sensori vedono male) sono quelli della manovra. Negli specchietti la barra (senza tacca) arriva all'angolo che il volante avrà 1 s dopo; in movimento i segmenti contano fino al prossimo cambio di comportamento. Profilo velocità Fluido (default) o Brusco.
- **Interruzioni:** I1 presa di controllo con freno o volante, con tre scelte (riprendi, assistito da qui, a mano); I2 "cordolo poco visibile": Glide si ferma dove l'aveva annunciato e propone l'assistito; I3 "ostacolo imprevisto" (pulsante nel pannello): l'auto si ferma, mostra la nuova traiettoria per 3,5 s (tenendo il freno: sterzo o freno in quel momento valgono come presa di controllo) e riparte. Se non esiste una manovra sicura lo dice e propone assistito o guida a mano.

- **Scenari:** *Vuoto* (default: solo auto parcheggiate) e *Animato* (pedoni, auto che aspetta dietro, ciclista, traffico nella corsia opposta). Si cambia con N o dal pannello; ogni attore si può anche accendere e spegnere da solo.
- **Auto che aspetta dietro:** arriva quando premi P e si ferma dietro di te alla distanza impostata (default 6 m). È un ostacolo reale: conta nelle collisioni e nei sensori, e in autonomo, quando si ferma, Glide ricontrolla il resto della traiettoria. Con "Si infila troppo vicina" (60 cm) Glide si ferma e dice "L'auto dietro è troppo vicina". Dopo essersi fermata non avanza più mentre fai manovra; quando sei dentro lo spazio riparte.
- **Auto dietro in assistito:** se si ferma prima della retro e la manovra non è più libera, Glide la ricalcola; se non ci sta più, mostra "La manovra non ci sta · L'auto dietro è troppo vicina" e si ferma. Se è vicina (meno di 60 cm dalla traiettoria), quando inizi la retro compare da sola la telecamera posteriore. Se continuando a quel modo la toccheresti, nello specchietto il countdown finisce prima ("Fermati qui: dietro non c'è spazio") e Glide prosegue col controsterzo da lì. Vale per qualunque ostacolo sul percorso.
- **Ciclista:** arriva da dietro a sinistra e ti passa accanto durante il controsterzo (assistito: quando inizia il controsterzo; autonomo: 2,5 s prima). Si sposta a sinistra per non toccare né te né l'auto dietro, e aspetta se dalla corsia opposta arriva qualcuno.
- **Pedoni** sui due marciapiedi e **traffico** nella corsia opposta (si ferma se invadi la sua corsia). Sul display gli attori compaiono nella ricostruzione 3D (pedoni e ciclista in giallo).
- **Pericolo (pedone/ciclista improvviso):** comportamento non ancora definito dal gruppo. Con il toggle acceso, quando ciclista o pedone passano a meno di 1 m dall'auto viene chiamato l'hook vuoto `onHazard` in `src/modes/flow.ts` (e scritto in console).
- **Suoni** (sintetizzati, Web Audio): conferma breve (in obiettivo / punto raggiunto) dal lato dello specchietto attivo, attivazione P, avvio autonomo, fine. Sensori di parcheggio solo sotto i 30 cm, a bip brevi sempre più fitti, mai continui. L'audio parte dopo il primo tasto premuto (regola del browser).

### Lunghezza degli spazi

Con quest'auto (passo 2,6 m, sterzata 35°) una sola manovra richiede uno spazio di almeno **auto + 2,0 m**. Decisione del gruppo: lo spazio "stretto" è auto + 2,2 m; nella fila c'è anche uno spazio da auto + 1,0 m, che Glide segnala come "non ci sta in una manovra", e uno ampio (7,2 m) dove consiglia l'autonomo.

## Parametri (G o F1)

- **Telecamera in movimento**: display con telecamera posteriore durante la retro (default spento)
- **Profilo velocità** (autonomo): Fluido / Brusco
- **Anticipo barra** (autonomo): 0,5–1,5 s, default 1 s
- **Cordolo poco visibile (I2)**, **Ostacolo imprevisto (I3)**
- **Scenario e attori**: Vuoto / Animato, pedoni, auto che aspetta dietro, distanza auto dietro (1,5–8 m), si infila troppo vicina, ciclista, traffico corsia opposta, pericolo (hook `onHazard`, spento)
- **Barra luminosa** (dal vivo): tolleranza tacca (± 5–10% dell'escursione, default 7%), anticipo del preannuncio (1,0–2,5 s, default 1,75), segmenti del countdown (4–12, default 8), lampeggi di conferma (numero, durata acceso/spento), colore (default bianco freddo `#e3f1ff`; le tinte arancioni vengono rifiutate), luminosità, "Turchese in autonomo", **Scala di grigi** (filtro sull'immagine, per verificare che gli stati si capiscano senza colore)
- **Spazio target**: lunghezza in metri, applicata ricaricando la pagina (`?space=`)
- **Preset**: "Salva preset" scarica un JSON con tutti i valori del pannello (esclusi partecipante, prova e demo); "Carica preset" li riapplica, così ogni sessione parte identica
- **Suoni**: volume
- **Ora**: giorno / sera
- **Qualità grafica**: alta / bassa (passa a bassa da sola se gli FPS restano sotto 40 per 3 s)
- **Debug → Mostra traiettoria**: la traiettoria pianificata disegnata sulla strada (default spento). Si vede solo nelle viste esterna e dall'alto, mai dal posto guida, negli specchietti o nella telecamera.

## Demo per il pitch

`?demo=1` (o tasto 0, o pannello → Demo) avvia una sequenza scriptata senza input: avvicinamento → assistito completo → reset → autonomo con preview, nello scenario Animato. Il pilota automatico genera gli stessi comandi della tastiera dentro il loop di fisica, quindi la demo usa esattamente la logica dei test. Camera coreografata (posto guida, primi piani del display e degli specchietti, vista esterna, dall'alto), formato 16:9 con bande nere, UI di debug nascosta, sottotitoli brevi in inglese. Dura circa 2 minuti.

- **Pannello → Demo**: sottotitoli on/off, "Presa di controllo" (spenta): a metà manovra autonoma il pilota frena, compare "Hai preso il controllo", poi Glide riprende e finisce.
- Esc o 0 fermano la demo e resettano. Per registrare: schermo intero (F), poi un registratore di schermo.

## Modalità test

`?test=1` (o pannello → Sessione di test → Modalità test): HUD, aiuto, traiettoria e pannello nascosti, vista posto guida. In basso a sinistra un indicatore discreto con ID partecipante e numero di prova (tasto I per nasconderlo). L'ID si inserisce nel pannello (G); la prova aumenta a ogni reset (Esc, Backspace, N). Lo schermo intero va attivato con F, perché il browser non lo permette senza un gesto dell'utente.

## Log per i test

Il log è sempre attivo (pannello → Sessione di test → Log attivo), tranne durante la demo. Resta in memoria e in `localStorage`: un reload non perde i dati e la numerazione delle prove continua. "Esporta CSV" (o L) scarica due file, `glide_<partecipante>_<data>_events.csv` e `..._summary.csv`. "Nuova sessione…" (con conferma) svuota il log.

**events.csv**, una riga per evento: `session_id, participant_id, trial, t_ms` (dall'inizio della prova, orologio di simulazione), `event, phase, side, value, extra_json`. Eventi: `trial_start, approach, space_evaluated, park_button, park_active, mode_chosen, phase, confirm, point_reached, over, steer_error` (value = errore in frazione dell'escursione), `contact, preview_shown, auto_start, takeover, low_confidence, trajectory_change, switch_to_assisted, manual, cancel, done, auto_done, glance` (Z/X/W: start/end con durata, proxy dello sguardo), `reset`.

**summary.csv**, una riga per prova: esito (`done` / `cancel` / `reset` / `in_corso`), modalità, tempo totale e per fase dell'assistito, durata dell'autonomo, numero di "oltre", errori di sterzo (%) e media, contatti, distanze finali da cordolo, auto davanti e dietro (cm), prese di controllo, passaggi all'assistito, annullamenti, sguardi, tutti i parametri attivi (`params_json`).

## Parametri URL

- `?demo=1`: avvia la demo. `?test=1`: modalità test. Si combinano (es. `?demo=1&fixedStep=1`).
- `?fixedStep=1`: ogni frame fa avanzare la simulazione di 1/60 s esatti, indipendentemente dagli FPS reali (browser headless, registrazioni, test). Tutta la simulazione usa un unico orologio.

## Stato

- [x] 1. Scena, strada, auto con cinematica e tastiera, viste
- [x] 2. Specchietti con riflesso reale
- [x] 3. Pianificatore + barra luminosa (assistita)
- [x] 4. Display centrale (passi 1–5 e 11–12)
- [x] 5. Modalità autonoma (preview, avvio, interruzioni I1–I3)
- [x] 6. Attori e suoni

### Fase 2 (vedi `system-prompt-glide-sviluppo-v2.md`)

Prima del pitch (4 novembre 2026):
- [x] 9. Bug B1–B6 (traiettoria solo da fuori, P annulla l'autonomo, auto ferma durante la ripianificazione, tasti Mac, barra sul bordo inferiore dello specchietto) + orologio unico e `?fixedStep=1`
- [x] 10. Retrovisore interno + ambiente (fase A)
- [x] 11. Modalità demo + modalità test
- [x] 12. Log CSV + pannello parametri completo

Dopo il pitch:
- [ ] 13. Test automatici (`__glide`, vitest, Playwright)
- [ ] 14. Ambiente (fase B)
- [ ] 15. Gamepad e volante (proposta)
- [ ] 16. Prove gestite dal facilitatore (proposta)
- [ ] 17. README completo

## Crediti

Tutti gli asset sono CC0 da [Poly Haven](https://polyhaven.com):
- HDRI: *Kloofendal 48d Partly Cloudy (Pure Sky)* (giorno), *Qwantani Dusk 2 (Pure Sky)* (sera).
- Texture 1K (`public/textures/`): *Clean Asphalt* (strada), *Concrete Pavement 02* (marciapiede), *Concrete* (cordolo), *Beige Wall 001* (rilievo e rugosità dell'intonaco).

Auto, persone, bici, alberi e arredo urbano sono procedurali (nessuna licenza).
