# Game Boy Color Emulator

Browser-based Game Boy / Game Boy Color emulator written in TypeScript. Aimed at Pokémon Red, Blue, and Crystal.

## Run

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`) in **Firefox** or another modern browser.

## Features

- Load `.gb` / `.gbc` ROMs from disk (nothing is bundled)
- Display scale (2× / 3× / 4× / fit) and **fullscreen**
- **Sound** via Web Audio (starts after a click/key)
- **Speed** 1× / 2× / 4× (button or `Tab`)
- DMG **shades** toggle (green / gray / pocket / brown)
- Battery saves (+ RTC for Crystal) in `localStorage`
- **Options** panel — download / import battery saves (`.sav`) and savestates
- **Second game** — run two ROMs side by side (click a panel to focus controls)
- **Link cable** — connect both sessions to trade in Pokémon Red/Blue (Cable Club)

## Trading (Red / Blue)

1. Open a second game and load Red or Blue in both panels  
2. Click **Connect link cable** (both run lockstep at 1×)  
3. In each game, go to a Pokémon Center → **Cable Club** → trade center  
4. Click a panel to control that game; complete the in-game trade prompts on both sides  

Disconnect the cable before closing the second game. Gen 1 ↔ Gen 1 works; Crystal↔Crystal may work similarly but is less tested.

## Controls

| Action | Keys |
|--------|------|
| Focus game | Click its panel |
| D-pad | Arrow keys or WASD |
| A | Z or K |
| B | X or J |
| Start | Enter |
| Select | Shift |
| Save state | F5 |
| Load state | F7 |
| Select slot | 1–9 |
| Speed | Tab |
| Shades | P |
| Fullscreen | F |
| Mute | M |

## Pokémon Crystal notes

Crystal is a Game Boy Color title and needs CGB features this emulator implements:

- Color palettes, VRAM/WRAM banks
- **HBlank HDMA** (used heavily for map graphics)
- Double-speed mode
- MBC3 + real-time clock (day/night)

If Crystal still misbehaves (white screen, freeze, wrong tiles), say what you see after loading — bring-up is iterative.

## Legal

Provide your own legally obtained ROM dumps. Commercial game ROMs are not included and must not be redistributed with this project.

## Build

```bash
npm run build
npm run preview
```
