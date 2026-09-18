import type { Apu } from "./apu";
import type { Cartridge } from "./cartridge";
import type { Joypad } from "./joypad";
import type { Ppu } from "./ppu";
import type { Timer } from "./timer";
import { SerialPort } from "./serial";
import { base64ToUint8, uint8ToBase64 } from "./saves";
import { IF_JOYPAD, IF_LCD, IF_SERIAL, IF_TIMER, IF_VBLANK } from "./types";

export class Mmu {
  cart!: Cartridge;
  ppu!: Ppu;
  apu!: Apu;
  timer!: Timer;
  joypad!: Joypad;
  serial = new SerialPort();

  wram = new Uint8Array(0x8000); // 8 banks * 4KB for CGB
  hram = new Uint8Array(0x7f);
  ie = 0;
  if = 0xe1;
  svbk = 1;
  key1 = 0;
  hdma1 = 0;
  hdma2 = 0;
  hdma3 = 0;
  hdma4 = 0;
  hdma5 = 0xff;
  cgbMode = false;
  doubleSpeed = false;

  /** HBlank DMA: remaining 16-byte blocks (0 when idle). */
  private hdmaActive = false;
  private hdmaBlocksLeft = 0;
  private hdmaSrc = 0;
  private hdmaDst = 0;

  constructor() {
    this.serial.setInterruptCallback(() => this.requestInterrupt(IF_SERIAL));
  }

  attach(parts: {
    cart: Cartridge;
    ppu: Ppu;
    apu: Apu;
    timer: Timer;
    joypad: Joypad;
  }): void {
    this.cart = parts.cart;
    this.ppu = parts.ppu;
    this.apu = parts.apu;
    this.timer = parts.timer;
    this.joypad = parts.joypad;
    this.cgbMode = parts.cart.isCgb;
    this.ppu.setHblankCallback(() => this.onHBlank());
  }

  reset(): void {
    this.wram.fill(0);
    this.hram.fill(0);
    this.ie = 0;
    this.if = 0xe1;
    this.svbk = 1;
    this.key1 = 0;
    this.hdma1 = 0;
    this.hdma2 = 0;
    this.hdma3 = 0;
    this.hdma4 = 0;
    this.hdma5 = 0xff;
    this.hdmaActive = false;
    this.hdmaBlocksLeft = 0;
    this.doubleSpeed = false;
    this.serial.reset();
  }

  exportState(): Record<string, number | boolean | string> {
    return {
      wram: uint8ToBase64(this.wram),
      hram: uint8ToBase64(this.hram),
      ie: this.ie,
      if: this.if,
      svbk: this.svbk,
      key1: this.key1,
      hdma1: this.hdma1,
      hdma2: this.hdma2,
      hdma3: this.hdma3,
      hdma4: this.hdma4,
      hdma5: this.hdma5,
      hdmaActive: this.hdmaActive,
      hdmaBlocksLeft: this.hdmaBlocksLeft,
      hdmaSrc: this.hdmaSrc,
      hdmaDst: this.hdmaDst,
      cgbMode: this.cgbMode,
      doubleSpeed: this.doubleSpeed,
      serial: JSON.stringify(this.serial.exportState()),
    };
  }

  importState(state: Record<string, number | boolean | string>): void {
    if (typeof state.wram === "string") this.wram.set(base64ToUint8(state.wram));
    if (typeof state.hram === "string") this.hram.set(base64ToUint8(state.hram));
    this.ie = Number(state.ie) & 0xff;
    this.if = Number(state.if) & 0x1f;
    this.svbk = Number(state.svbk) & 0x07;
    this.key1 = Number(state.key1) & 0x01;
    this.hdma1 = Number(state.hdma1) & 0xff;
    this.hdma2 = Number(state.hdma2) & 0xff;
    this.hdma3 = Number(state.hdma3) & 0xff;
    this.hdma4 = Number(state.hdma4) & 0xff;
    this.hdma5 = Number(state.hdma5) & 0xff;
    this.hdmaActive = Boolean(state.hdmaActive);
    this.hdmaBlocksLeft = Number(state.hdmaBlocksLeft) || 0;
    this.hdmaSrc = Number(state.hdmaSrc) || 0;
    this.hdmaDst = Number(state.hdmaDst) || 0;
    this.cgbMode = Boolean(state.cgbMode);
    this.doubleSpeed = Boolean(state.doubleSpeed);
    if (typeof state.serial === "string") {
      try {
        this.serial.importState(JSON.parse(state.serial) as Record<string, number | boolean>);
      } catch {
        this.serial.reset();
      }
    } else if (typeof state.serialData === "number") {
      // Older savestates
      this.serial.sb = Number(state.serialData) & 0xff;
      this.serial.sc = Number(state.serialControl) & 0xff;
    }
  }

  requestInterrupt(bit: number): void {
    this.if |= bit;
  }

  read(addr: number): number {
    addr &= 0xffff;
    if (addr < 0x8000) return this.cart.read(addr);
    if (addr < 0xa000) return this.ppu.readVram(addr);
    if (addr < 0xc000) return this.cart.read(addr);
    if (addr < 0xd000) return this.wram[addr - 0xc000]!;
    if (addr < 0xe000) {
      const bank = this.cgbMode ? Math.max(1, this.svbk & 7) : 1;
      return this.wram[bank * 0x1000 + (addr - 0xd000)]!;
    }
    if (addr < 0xfe00) return this.read(addr - 0x2000); // echo
    if (addr < 0xfea0) return this.ppu.oam[addr - 0xfe00]!;
    if (addr < 0xff00) return 0xff;
    return this.readIo(addr);
  }

  write(addr: number, value: number): void {
    addr &= 0xffff;
    value &= 0xff;
    if (addr < 0x8000) {
      this.cart.write(addr, value);
      return;
    }
    if (addr < 0xa000) {
      this.ppu.writeVram(addr, value);
      return;
    }
    if (addr < 0xc000) {
      this.cart.write(addr, value);
      return;
    }
    if (addr < 0xd000) {
      this.wram[addr - 0xc000] = value;
      return;
    }
    if (addr < 0xe000) {
      const bank = this.cgbMode ? Math.max(1, this.svbk & 7) : 1;
      this.wram[bank * 0x1000 + (addr - 0xd000)] = value;
      return;
    }
    if (addr < 0xfe00) {
      this.write(addr - 0x2000, value);
      return;
    }
    if (addr < 0xfea0) {
      this.ppu.oam[addr - 0xfe00] = value;
      return;
    }
    if (addr < 0xff00) return;
    this.writeIo(addr, value);
  }

  private readIo(addr: number): number {
    switch (addr) {
      case 0xff00: return this.joypad.readP1();
      case 0xff01: return this.serial.readSb();
      case 0xff02: return this.serial.readSc();
      case 0xff04: return this.timer.div;
      case 0xff05: return this.timer.tima;
      case 0xff06: return this.timer.tma;
      case 0xff07: return this.timer.tac | 0xf8;
      case 0xff0f: return this.if | 0xe0;
      case 0xff40: return this.ppu.lcdc;
      case 0xff41: return this.ppu.readStat();
      case 0xff42: return this.ppu.scy;
      case 0xff43: return this.ppu.scx;
      case 0xff44: return this.ppu.ly;
      case 0xff45: return this.ppu.lyc;
      case 0xff47: return this.ppu.bgp;
      case 0xff48: return this.ppu.obp0;
      case 0xff49: return this.ppu.obp1;
      case 0xff4a: return this.ppu.wy;
      case 0xff4b: return this.ppu.wx;
      case 0xff4d: return (this.key1 & 0x7f) | (this.doubleSpeed ? 0x80 : 0);
      case 0xff4f: return this.ppu.vbk | 0xfe;
      case 0xff50: return 0xff;
      case 0xff51: return this.hdma1;
      case 0xff52: return this.hdma2;
      case 0xff53: return this.hdma3;
      case 0xff54: return this.hdma4;
      case 0xff55: return this.hdma5;
      case 0xff68: return this.ppu.bgpi;
      case 0xff69: return this.ppu.bgpd[this.ppu.bgpi & 0x3f]!;
      case 0xff6a: return this.ppu.obpi;
      case 0xff6b: return this.ppu.obpd[this.ppu.obpi & 0x3f]!;
      case 0xff6c: return this.ppu.opri | 0xfe;
      case 0xff70: return this.svbk | 0xf8;
      case 0xffff: return this.ie;
      default:
        if (addr >= 0xff10 && addr <= 0xff3f) return this.apu.read(addr);
        if (addr >= 0xff80 && addr <= 0xfffe) return this.hram[addr - 0xff80]!;
        return 0xff;
    }
  }

  private writeIo(addr: number, value: number): void {
    switch (addr) {
      case 0xff00: this.joypad.writeP1(value); break;
      case 0xff01: this.serial.writeSb(value); break;
      case 0xff02: this.serial.writeSc(value); break;
      case 0xff04: this.timer.writeDiv(value); break;
      case 0xff05: this.timer.tima = value; break;
      case 0xff06: this.timer.tma = value; break;
      case 0xff07: this.timer.tac = value & 0x07; break;
      case 0xff0f: this.if = value & 0x1f; break;
      case 0xff40: {
        const wasOn = (this.ppu.lcdc & 0x80) !== 0;
        this.ppu.lcdc = value;
        if (wasOn && (value & 0x80) === 0) {
          // LCD off: hardware treats this as continuous HBlank for HDMA
          while (this.hdmaActive) this.transferHdmaBlock();
        }
        break;
      }
      case 0xff41: this.ppu.stat = (value & 0x78) | (this.ppu.stat & 0x07); break;
      case 0xff42: this.ppu.scy = value; break;
      case 0xff43: this.ppu.scx = value; break;
      case 0xff44: break;
      case 0xff45: this.ppu.lyc = value; break;
      case 0xff46: this.dma(value); break;
      case 0xff47: this.ppu.bgp = value; break;
      case 0xff48: this.ppu.obp0 = value; break;
      case 0xff49: this.ppu.obp1 = value; break;
      case 0xff4a: this.ppu.wy = value; break;
      case 0xff4b: this.ppu.wx = value; break;
      case 0xff4d: this.key1 = value & 0x01; break;
      case 0xff4f: this.ppu.vbk = value & 1; break;
      case 0xff50: break;
      case 0xff51: this.hdma1 = value; break;
      case 0xff52: this.hdma2 = value & 0xf0; break;
      case 0xff53: this.hdma3 = value & 0x1f; break;
      case 0xff54: this.hdma4 = value & 0xf0; break;
      case 0xff55: this.startHdma(value); break;
      case 0xff68: this.ppu.bgpi = value; break;
      case 0xff69: this.ppu.writeBgpd(value); break;
      case 0xff6a: this.ppu.obpi = value; break;
      case 0xff6b: this.ppu.writeObpd(value); break;
      case 0xff6c: this.ppu.opri = value & 0x01; break;
      case 0xff70:
        this.svbk = value & 0x07;
        break;
      case 0xffff: this.ie = value; break;
      default:
        if (addr >= 0xff10 && addr <= 0xff3f) this.apu.write(addr, value);
        else if (addr >= 0xff80 && addr <= 0xfffe) this.hram[addr - 0xff80] = value;
    }
  }

  private dma(page: number): void {
    const src = page << 8;
    for (let i = 0; i < 0xa0; i++) {
      this.ppu.oam[i] = this.read(src + i);
    }
  }

  /**
   * FF55 write: bit7=0 GDMA (all at once), bit7=1 HDMA (16 bytes each HBlank).
   * Writing bit7=0 while HDMA is active cancels it.
   */
  private startHdma(value: number): void {
    if (!this.cgbMode) return;

    if (this.hdmaActive) {
      // Cancel HBlank DMA
      this.hdmaActive = false;
      this.hdma5 = 0x80 | ((this.hdmaBlocksLeft - 1) & 0x7f);
      this.hdmaBlocksLeft = 0;
      return;
    }

    this.hdmaSrc = ((this.hdma1 << 8) | this.hdma2) & 0xfff0;
    this.hdmaDst = 0x8000 | (((this.hdma3 << 8) | this.hdma4) & 0x1ff0);
    const blocks = (value & 0x7f) + 1;

    if (value & 0x80) {
      // HBlank DMA
      this.hdmaActive = true;
      this.hdmaBlocksLeft = blocks;
      this.hdma5 = (blocks - 1) & 0x7f; // bit7 clear = transfer in progress
      // If already in HBlank / VBlank, transfer one block immediately
      const mode = this.ppu.getMode();
      if (mode === 0 || mode === 1) this.transferHdmaBlock();
    } else {
      // General-purpose DMA
      for (let i = 0; i < blocks; i++) this.copyHdmaBlock();
      this.syncHdmaRegs();
      this.hdmaActive = false;
      this.hdmaBlocksLeft = 0;
      this.hdma5 = 0xff;
    }
  }

  /** Called by PPU when entering HBlank (mode 0). */
  onHBlank(): void {
    if (!this.hdmaActive) return;
    this.transferHdmaBlock();
  }

  private transferHdmaBlock(): void {
    if (!this.hdmaActive || this.hdmaBlocksLeft <= 0) return;
    this.copyHdmaBlock();
    this.hdmaBlocksLeft--;
    this.syncHdmaRegs();
    if (this.hdmaBlocksLeft <= 0) {
      this.hdmaActive = false;
      this.hdma5 = 0xff;
    } else {
      this.hdma5 = (this.hdmaBlocksLeft - 1) & 0x7f;
    }
  }

  private copyHdmaBlock(): void {
    for (let i = 0; i < 16; i++) {
      const byte = this.readHdmaSource(this.hdmaSrc);
      // Destination is always VRAM; use current VBK
      this.ppu.writeVram(this.hdmaDst, byte);
      this.hdmaSrc = (this.hdmaSrc + 1) & 0xffff;
      this.hdmaDst = 0x8000 | ((this.hdmaDst + 1) & 0x1fff);
    }
  }

  private readHdmaSource(addr: number): number {
    addr &= 0xffff;
    // Valid HDMA sources: ROM / SRAM / WRAM (not VRAM/OAM)
    if (addr >= 0x8000 && addr < 0xa000) return 0xff;
    if (addr >= 0xfe00) return 0xff;
    return this.read(addr);
  }

  private syncHdmaRegs(): void {
    this.hdma1 = (this.hdmaSrc >> 8) & 0xff;
    this.hdma2 = this.hdmaSrc & 0xf0;
    this.hdma3 = (this.hdmaDst >> 8) & 0x1f;
    this.hdma4 = this.hdmaDst & 0xf0;
  }
}

export { IF_VBLANK, IF_LCD, IF_TIMER, IF_SERIAL, IF_JOYPAD };
