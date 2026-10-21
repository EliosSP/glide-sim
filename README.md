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
| 1 | avvia il parcheggio assistito sullo spazio obiettivo (in attesa del flusso display della milestone 4) |
| C | cambia vista: posto guida → esterna → dall'alto |
| V | split-screen posto guida + esterna |
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

### Nota sulla lunghezza dello spazio

Con quest'auto (passo 2,6 m, sterzata 35°) una sola manovra (sterzata → retro → controsterzo → retro finale) richiede uno spazio di almeno **auto + 2,0 m**. Lo spazio di default della specifica (auto + 1,0 m) si fa solo in più manovre. Per ora lo spazio obiettivo è auto + 2,2 m (`TARGET_SPACE_LENGTH` in `src/config.ts`), in attesa di una decisione del gruppo.

## Parametri (F1)

- **Ora**: giorno / sera
- **Qualità grafica**: alta / bassa (passa a bassa da sola se gli FPS restano sotto 40 per 3 s)

## Stato

- [x] 1. Scena, strada, auto con cinematica e tastiera, viste
- [x] 2. Specchietti con riflesso reale
- [x] 3. Pianificatore + barra luminosa (assistita)
- [ ] 4. Display centrale
- [ ] 5. Modalità autonoma
- [ ] 6. Attori e suoni
- [ ] 7. Modalità demo
- [ ] 8. Pannello parametri e log CSV

## Crediti

HDRI CC0 da [Poly Haven](https://polyhaven.com): *Kloofendal 48d Partly Cloudy (Pure Sky)* (giorno), *Qwantani Dusk 2 (Pure Sky)* (sera).
