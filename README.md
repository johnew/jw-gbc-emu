# Game Boy Color Emulator

Browser-based Game Boy / Game Boy Color emulator written in TypeScript. Aimed at Pokémon Red, Blue, and Crystal.

The emulator is available here: https://johnew.github.io/jw-gbc-emu/ 

## Run

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`) in **Firefox** or another modern browser.

## Features

- Load `.gb` / `.gbc` ROMs from disk (nothing is bundled)
- Display scale (2× / 3× / 4× / fit) and **fullscreen**
- **Mobile-friendly** layout with on-screen D-pad / A / B / Start / Select
- **Sound** via Web Audio (starts after a click/key)
- **Speed** 1× / 2× / 4× / 6× (button or `Tab`)
- DMG **shades** toggle (green / gray / pocket / brown)
- Battery saves (+ RTC for Crystal) in `localStorage`
- **Options** panel — download / import battery saves (`.sav`) and savestates
- **Second game** — desktop: two panels side by side; **mobile: in-page Game 1 / Game 2 tabs** to switch quickly
- **Link cable** — connect both sessions to trade in Pokémon Red/Blue (Cable Club)

## Trading

### Red / Blue (same generation)

1. Click **Add second game** and load Red or Blue in both (on mobile, switch with the Game 1 / Game 2 tabs)  
2. Click **Connect link cable** (both run lockstep at 1×)  
3. Pokémon Center → **Cable Club** → trade center  
4. Focus the game you need (panel click on desktop, tab on mobile); complete prompts on both sides  

### Time Capsule (Red/Blue ↔ Gold/Silver/Crystal)

Same link cable button. On the Gen 2 game use **Cable Club → Time Capsule**; on Gen 1 use the normal trade room. Serial timing follows wall-clock speed (important when Crystal is in CGB double-speed). Still experimental — soft-reset (`A+B+Start+Select`) if a side softlocks, then disconnect the cable.

Disconnect the cable before closing the second game.

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

## GitHub Pages

This repo includes a workflow that builds and publishes `dist/` on every push to `master`/`main`.

1. Create a GitHub repo and push this project (keep the default branch `master` or `main`).
2. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. After the **Deploy to GitHub Pages** workflow succeeds, open  
   `https://<you>.github.io/<repo-name>/`  
   (example: `https://johnew.github.io/jw-gbc-emu/`).

Local check with the same asset prefix GitHub uses:

```bash
# PowerShell
$env:BASE_PATH="/jw-gbc-emu/"; npm run build; npm run preview
```

Do not commit ROM files. Users load their own `.gb` / `.gbc` in the browser.
