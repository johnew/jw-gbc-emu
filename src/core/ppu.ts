import { IF_LCD, IF_VBLANK, SCREEN_HEIGHT, SCREEN_WIDTH } from "./types";
import type { DmgPaletteId } from "./types";
import { base64ToUint8, uint8ToBase64 } from "./encoding";

/** RGBA little-endian for ImageData */
const DMG_PALETTES: Record<DmgPaletteId, readonly [number, number, number, number]> = {
  green: [0xff0fbc9b, 0xff0fac8b, 0xff306230, 0xff0f380f],
  gray: [0xffffffff, 0xffaaaaaa, 0xff555555, 0xff000000],
  pocket: [0xff6fbfa4, 0xff4f8f74, 0xff2f5f44, 0xff0f2f14],
  brown: [0xff8cbcf8, 0xff548ce0, 0xff304890, 0xff101820],
};

export class Ppu {
  lcdc = 0x91;
  stat = 0x85;
  scy = 0;
  scx = 0;
  ly = 0;
  lyc = 0;
  bgp = 0xfc;
  obp0 = 0xff;
  obp1 = 0xff;
  wy = 0;
  wx = 0;

  // CGB
  vbk = 0;
  bgpi = 0;
  bgpd = new Uint8Array(64);
  obpi = 0;
  obpd = new Uint8Array(64);
  opri = 0;

  vram = new Uint8Array(0x4000); // 2 banks * 8KB
  oam = new Uint8Array(0xa0);

  readonly frameBuffer = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  frameReady = false;

  private mode = 2; // OAM
  private modeClock = 0;
  private windowLine = 0;
  private cgbMode = false;
  private dmgColors: [number, number, number, number] = [...DMG_PALETTES.green];
  private dmgPaletteId: DmgPaletteId = "green";
  private requestInterrupt: ((bit: number) => void) | null = null;
  private onHBlank: (() => void) | null = null;

  getMode(): number {
    return this.mode;
  }

  setHblankCallback(cb: () => void): void {
    this.onHBlank = cb;
  }

  getDmgPalette(): DmgPaletteId {
    return this.dmgPaletteId;
  }

  setDmgPalette(id: DmgPaletteId): void {
    if (!(id in DMG_PALETTES)) id = "green";
    this.dmgPaletteId = id;
    this.dmgColors = [...DMG_PALETTES[id]];
  }

  setCgbMode(enabled: boolean): void {
    this.cgbMode = enabled;
  }

  setInterruptCallback(cb: (bit: number) => void): void {
    this.requestInterrupt = cb;
  }

  reset(cgb: boolean): void {
    this.cgbMode = cgb;
    this.lcdc = 0x91;
    this.stat = 0x85;
    this.scy = 0;
    this.scx = 0;
    this.ly = 0;
    this.lyc = 0;
    this.bgp = 0xfc;
    this.obp0 = 0xff;
    this.obp1 = 0xff;
    this.wy = 0;
    this.wx = 0;
    this.vbk = 0;
    this.bgpi = 0;
    this.obpi = 0;
    this.bgpd.fill(0xff);
    this.obpd.fill(0xff);
    this.vram.fill(0);
    this.oam.fill(0);
    this.mode = 2;
    this.modeClock = 0;
    this.windowLine = 0;
    this.frameReady = false;
    this.frameBuffer.fill(0xffffffff);
  }

  exportState(): Record<string, number | boolean | string> {
    return {
      lcdc: this.lcdc,
      stat: this.stat,
      scy: this.scy,
      scx: this.scx,
      ly: this.ly,
      lyc: this.lyc,
      bgp: this.bgp,
      obp0: this.obp0,
      obp1: this.obp1,
      wy: this.wy,
      wx: this.wx,
      vbk: this.vbk,
      bgpi: this.bgpi,
      obpi: this.obpi,
      opri: this.opri,
      mode: this.mode,
      modeClock: this.modeClock,
      windowLine: this.windowLine,
      cgbMode: this.cgbMode,
      dmgPaletteId: this.dmgPaletteId,
      vram: uint8ToBase64(this.vram),
      oam: uint8ToBase64(this.oam),
      bgpd: uint8ToBase64(this.bgpd),
      obpd: uint8ToBase64(this.obpd),
      frameBuffer: uint8ToBase64(new Uint8Array(this.frameBuffer.buffer)),
    };
  }

  importState(state: Record<string, number | boolean | string>): void {
    this.lcdc = Number(state.lcdc) & 0xff;
    this.stat = Number(state.stat) & 0xff;
    this.scy = Number(state.scy) & 0xff;
    this.scx = Number(state.scx) & 0xff;
    this.ly = Number(state.ly) & 0xff;
    this.lyc = Number(state.lyc) & 0xff;
    this.bgp = Number(state.bgp) & 0xff;
    this.obp0 = Number(state.obp0) & 0xff;
    this.obp1 = Number(state.obp1) & 0xff;
    this.wy = Number(state.wy) & 0xff;
    this.wx = Number(state.wx) & 0xff;
    this.vbk = Number(state.vbk) & 1;
    this.bgpi = Number(state.bgpi) & 0xff;
    this.obpi = Number(state.obpi) & 0xff;
    this.opri = Number(state.opri) & 0xff;
    this.mode = Number(state.mode) & 3;
    this.modeClock = Number(state.modeClock);
    this.windowLine = Number(state.windowLine);
    this.cgbMode = Boolean(state.cgbMode);
    if (typeof state.dmgPaletteId === "string") {
      this.setDmgPalette(state.dmgPaletteId as DmgPaletteId);
    }
    if (typeof state.vram === "string") this.vram.set(base64ToUint8(state.vram));
    if (typeof state.oam === "string") this.oam.set(base64ToUint8(state.oam));
    if (typeof state.bgpd === "string") this.bgpd.set(base64ToUint8(state.bgpd));
    if (typeof state.obpd === "string") this.obpd.set(base64ToUint8(state.obpd));
    if (typeof state.frameBuffer === "string") {
      const bytes = base64ToUint8(state.frameBuffer);
      this.frameBuffer.set(new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2));
    }
    this.frameReady = true;
  }

  readVram(addr: number): number {
    const bank = this.vbk & 1;
    return this.vram[bank * 0x2000 + (addr - 0x8000)] ?? 0xff;
  }

  writeVram(addr: number, value: number): void {
    const bank = this.vbk & 1;
    this.vram[bank * 0x2000 + (addr - 0x8000)] = value & 0xff;
  }

  readStat(): number {
    return (this.stat & 0xf8) | (this.ly === this.lyc ? 0x04 : 0) | (this.mode & 0x03);
  }

  writeBgpd(value: number): void {
    const idx = this.bgpi & 0x3f;
    this.bgpd[idx] = value & 0xff;
    if (this.bgpi & 0x80) this.bgpi = 0x80 | ((idx + 1) & 0x3f);
  }

  writeObpd(value: number): void {
    const idx = this.obpi & 0x3f;
    this.obpd[idx] = value & 0xff;
    if (this.obpi & 0x80) this.obpi = 0x80 | ((idx + 1) & 0x3f);
  }

  step(cycles: number): void {
    if ((this.lcdc & 0x80) === 0) {
      this.modeClock = 0;
      this.ly = 0;
      this.mode = 0;
      return;
    }

    this.modeClock += cycles;

    switch (this.mode) {
      case 2: // OAM search
        if (this.modeClock >= 80) {
          this.modeClock -= 80;
          this.setMode(3);
        }
        break;
      case 3: // Pixel transfer
        if (this.modeClock >= 172) {
          this.modeClock -= 172;
          this.renderScanline();
          this.setMode(0);
        }
        break;
      case 0: // HBlank
        if (this.modeClock >= 204) {
          this.modeClock -= 204;
          this.ly++;
          this.checkLyc();
          if (this.ly === 144) {
            this.setMode(1);
            this.frameReady = true;
            this.requestInterrupt?.(IF_VBLANK);
          } else {
            this.setMode(2);
          }
        }
        break;
      case 1: // VBlank
        if (this.modeClock >= 456) {
          this.modeClock -= 456;
          this.ly++;
          this.checkLyc();
          if (this.ly > 153) {
            this.ly = 0;
            this.windowLine = 0;
            this.setMode(2);
          }
        }
        break;
    }
  }

  private setMode(mode: number): void {
    this.mode = mode;
    const stat = this.stat;
    if (mode === 0) {
      this.onHBlank?.();
      if (stat & 0x08) this.requestInterrupt?.(IF_LCD);
    }
    if (mode === 1 && (stat & 0x10)) this.requestInterrupt?.(IF_LCD);
    if (mode === 2 && (stat & 0x20)) this.requestInterrupt?.(IF_LCD);
  }

  private checkLyc(): void {
    if (this.ly === this.lyc && (this.stat & 0x40)) {
      this.requestInterrupt?.(IF_LCD);
    }
  }

  private renderScanline(): void {
    if (this.ly >= SCREEN_HEIGHT) return;
    const line = new Uint8Array(SCREEN_WIDTH);
    // low8 = BG attr (CGB) or shade; bits8-9 = BG color; bit12 = sprite drawn
    const bgPri = new Uint16Array(SCREEN_WIDTH);

    // CGB: LCDC.0 does not disable BG — it only controls master priority vs sprites.
    // DMG: LCDC.0 disables background (and window).
    const drawBg = this.cgbMode || (this.lcdc & 0x01) !== 0;
    if (drawBg) this.renderBackground(line, bgPri);
    else line.fill(0);

    if (this.lcdc & 0x20) this.renderWindow(line, bgPri);
    if (this.lcdc & 0x02) this.renderSprites(line, bgPri);

    const row = this.ly * SCREEN_WIDTH;
    for (let x = 0; x < SCREEN_WIDTH; x++) {
      this.frameBuffer[row + x] = this.paletteColor(line[x]!, bgPri[x]!, false);
    }
  }

  private renderBackground(line: Uint8Array, bgPri: Uint16Array): void {
    const mapBase = (this.lcdc & 0x08) ? 0x1c00 : 0x1800;
    const signed = (this.lcdc & 0x10) === 0;
    const y = (this.scy + this.ly) & 0xff;
    const tileRow = (y >> 3) & 31;

    for (let x = 0; x < SCREEN_WIDTH; x++) {
      const lx = (this.scx + x) & 0xff;
      this.plotBgTilePixel(line, bgPri, x, lx, y, tileRow, mapBase, signed);
    }
  }

  private renderWindow(line: Uint8Array, bgPri: Uint16Array): void {
    if (this.ly < this.wy) return;
    const wx = this.wx - 7;
    if (wx >= SCREEN_WIDTH) return;

    const mapBase = (this.lcdc & 0x40) ? 0x1c00 : 0x1800;
    const signed = (this.lcdc & 0x10) === 0;
    const y = this.windowLine;
    this.windowLine++;
    const tileRow = (y >> 3) & 31;

    for (let x = Math.max(0, wx); x < SCREEN_WIDTH; x++) {
      const lx = x - wx;
      this.plotBgTilePixel(line, bgPri, x, lx, y, tileRow, mapBase, signed);
    }
  }

  private plotBgTilePixel(
    line: Uint8Array,
    bgPri: Uint16Array,
    screenX: number,
    lx: number,
    y: number,
    tileRow: number,
    mapBase: number,
    signed: boolean,
  ): void {
    const tileCol = (lx >> 3) & 31;
    const mapIndex = mapBase + tileRow * 32 + tileCol;
    const tileId = this.vram[mapIndex]!;
    const attr = this.cgbMode ? this.vram[0x2000 + mapIndex]! : 0;

    let tileAddr: number;
    if (signed) {
      const tid = tileId > 127 ? tileId - 256 : tileId;
      tileAddr = 0x1000 + tid * 16;
    } else {
      tileAddr = tileId * 16;
    }

    const bank = this.cgbMode ? ((attr >> 3) & 1) : 0;
    const flipY = (attr & 0x40) !== 0;
    const flipX = (attr & 0x20) !== 0;
    const rowInTile = flipY ? 7 - (y & 7) : y & 7;
    const base = bank * 0x2000 + tileAddr + rowInTile * 2;
    const lo = this.vram[base]!;
    const hi = this.vram[base + 1]!;
    const bit = flipX ? lx & 7 : 7 - (lx & 7);
    const colorId = ((hi >> bit) & 1) << 1 | ((lo >> bit) & 1);
    line[screenX] = colorId;
    bgPri[screenX] = this.cgbMode ? (attr | (colorId << 8)) : colorId;
  }

  private renderSprites(line: Uint8Array, bgPri: Uint16Array): void {
    const tall = (this.lcdc & 0x04) !== 0;
    const height = tall ? 16 : 8;
    const sprites: { x: number; y: number; tile: number; attr: number; index: number }[] = [];

    for (let i = 0; i < 40; i++) {
      const oy = this.oam[i * 4]! - 16;
      const ox = this.oam[i * 4 + 1]! - 8;
      const tile = this.oam[i * 4 + 2]!;
      const attr = this.oam[i * 4 + 3]!;
      if (this.ly >= oy && this.ly < oy + height) {
        sprites.push({ x: ox, y: oy, tile, attr, index: i });
      }
    }

    // DMG: priority by X then OAM index. CGB: OAM index only. Cap 10/line.
    if (this.cgbMode) sprites.sort((a, b) => a.index - b.index);
    else sprites.sort((a, b) => (a.x - b.x) || (a.index - b.index));
    const visible = sprites.slice(0, 10);

    // Draw back-to-front so earlier entries win
    for (let s = visible.length - 1; s >= 0; s--) {
      const sp = visible[s]!;
      let row = this.ly - sp.y;
      const flipY = (sp.attr & 0x40) !== 0;
      const flipX = (sp.attr & 0x20) !== 0;
      if (flipY) row = height - 1 - row;

      const rowInTile = row & 7;
      const bank = this.cgbMode ? ((sp.attr >> 3) & 1) : 0;
      const tileNum = tall ? ((sp.tile & 0xfe) + (row >= 8 ? 1 : 0)) : sp.tile;
      const addr = bank * 0x2000 + tileNum * 16 + rowInTile * 2;
      const lo = this.vram[addr]!;
      const hi = this.vram[addr + 1]!;

      // CGB LCDC.0 clear => sprites always above BG (ignore BG priority bit)
      const masterBgPriority = this.cgbMode && (this.lcdc & 0x01) !== 0;

      for (let px = 0; px < 8; px++) {
        const x = sp.x + px;
        if (x < 0 || x >= SCREEN_WIDTH) continue;
        const bit = flipX ? px : 7 - px;
        const colorId = ((hi >> bit) & 1) << 1 | ((lo >> bit) & 1);
        if (colorId === 0) continue;

        // Don't overwrite a sprite pixel already drawn by a higher-priority sprite
        if (this.cgbMode && (bgPri[x]! & 0x1000)) continue;

        const bgColor = (bgPri[x]! >> 8) & 0x03;
        const bgAttr = bgPri[x]! & 0xff;
        const bgPriority = this.cgbMode && masterBgPriority && (bgAttr & 0x80) !== 0;
        const spriteBehind = (sp.attr & 0x80) !== 0;

        if (this.cgbMode) {
          if (bgPriority && bgColor !== 0) continue;
          if (spriteBehind && bgColor !== 0) continue;
        } else {
          const dmgBg = line[x]! & 0x03;
          if (spriteBehind && dmgBg !== 0) continue;
        }

        if (this.cgbMode) {
          line[x] = colorId;
          bgPri[x] = 0x1000 | ((sp.attr & 7) << 2) | colorId;
        } else {
          const pal = (sp.attr & 0x10) ? this.obp1 : this.obp0;
          line[x] = (pal >> (colorId * 2)) & 0x03;
          bgPri[x] = 0x1000;
        }
      }
    }
  }

  private paletteColor(colorId: number, meta: number, _sprite: boolean): number {
    if (this.cgbMode) {
      if (meta & 0x1000) {
        const pal = (meta >> 2) & 7;
        const cid = meta & 3;
        return this.cgbColor(this.obpd, pal, cid);
      }
      const attr = meta & 0xff;
      const pal = attr & 7;
      return this.cgbColor(this.bgpd, pal, colorId);
    }
    // DMG
    if (meta & 0x1000) {
      return this.dmgColors[colorId & 3]!;
    }
    const shade = (this.bgp >> ((colorId & 3) * 2)) & 3;
    return this.dmgColors[shade]!;
  }

  private cgbColor(palRam: Uint8Array, palette: number, colorId: number): number {
    const idx = palette * 8 + colorId * 2;
    const lo = palRam[idx]!;
    const hi = palRam[idx + 1]!;
    const raw = lo | (hi << 8);
    const r = raw & 0x1f;
    const g = (raw >> 5) & 0x1f;
    const b = (raw >> 10) & 0x1f;
    // Scale 5-bit to 8-bit
    const R = (r * 255 / 31) | 0;
    const G = (g * 255 / 31) | 0;
    const B = (b * 255 / 31) | 0;
    return 0xff000000 | (B << 16) | (G << 8) | R;
  }
}
