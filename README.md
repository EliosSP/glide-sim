# Glide – simulazione 3D del parcheggio in parallelo

Simulazione nel browser del concept **Glide** (specchietti luminosi, display centrale, pulsante P) per pitch e test con utenti.
Progetto Politecnico di Milano × Italdesign.

## Avvio

```bash
npm install
npm run dev
```

Apri l'indirizzo mostrato (di solito http://localhost:5173) in Chrome.

## Comandi (milestone 1)

| Tasto | Azione |
|---|---|
| ↑ / ↓ | acceleratore / freno |
| ← / → | volante (continuo; in marcia avanti torna lentamente al centro, da fermo e in retro resta dove lo lasci) |
| R / D | retromarcia / marcia (solo da fermo) |
| Spazio | freno forte |
| C | cambia vista: posto guida → esterna → dall'alto |
| V | split-screen posto guida + esterna |
| trascina il mouse | gira la testa al posto guida (doppio clic: centra) |
| H | nasconde la UI di debug |
| F1 | pannello parametri |
| Esc | reset scenario |

## Parametri (F1)

- **Ora**: giorno / sera
- **Qualità grafica**: alta / bassa (passa a bassa da sola se gli FPS restano sotto 40 per 3 s)

## Stato

- [x] 1. Scena, strada, auto con cinematica e tastiera, viste
- [ ] 2. Specchietti con riflesso reale
- [ ] 3. Pianificatore + barra luminosa (assistita)
- [ ] 4. Display centrale
- [ ] 5. Modalità autonoma
- [ ] 6. Attori e suoni
- [ ] 7. Modalità demo
- [ ] 8. Pannello parametri e log CSV

## Crediti

HDRI CC0 da [Poly Haven](https://polyhaven.com): *Kloofendal 48d Partly Cloudy (Pure Sky)* (giorno), *Qwantani Dusk 2 (Pure Sky)* (sera).
