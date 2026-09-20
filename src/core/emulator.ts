import { Apu } from "./apu";
import { createCartridge, type Cartridge } from "./cartridge";
import { Cpu } from "./cpu";
import { Joypad } from "./joypad";
import { Mmu } from "./mmu";
import { Ppu } from "./ppu";
import { LinkCable } from "./serial";
import { Timer } from "./timer";
import type { Button, DmgPaletteId, EmulatorSavestate, SaveState } from "./types";
import { CYCLES_PER_FRAME, DMG_PALETTE_IDS, IF_JOYPAD, IF_TIMER } from "./types";
import { loadSave, loadSavestate, listSavestateSlots, saveSave, saveSavestate } from "./saves";

const AUTOSAVE_EVERY_FRAMES = 120;
const SPEED_STEPS = [1, 2, 4, 6] as const;
const MAX_SPEED = SPEED_STEPS[SPEED_STEPS.length - 1]!;

/** Shared cable for the two on-page sessions. */
let sharedCable: LinkCable | null = null;

function sharedLinkCable(): LinkCable {
  if (!sharedCable) sharedCable = new LinkCable();
  return sharedCable;
}

export class Emulator {
  readonly mmu = new Mmu();
  readonly cpu = new Cpu(this.mmu);
  readonly ppu = new Ppu();
  readonly apu = new Apu();
  readonly timer = new Timer();
  readonly joypad = new Joypad();

  private cart: Cartridge | null = null;
  private running = false;
  private speed = 1;
  private muted = false;
  private cyclesThisFrame = 0;
  private saveTimer = 0;

  constructor() {
    this.joypad.setInterruptCallback(() => this.mmu.requestInterrupt(IF_JOYPAD));
    this.timer.setInterruptCallback(() => this.mmu.requestInterrupt(IF_TIMER));
    this.ppu.setInterruptCallback((bit) => this.mmu.requestInterrupt(bit));
  }

  get title(): string {
    return this.cart?.header.title ?? "";
  }

  get isCgb(): boolean {
    return this.cart?.isCgb ?? false;
  }

  get frameBuffer(): Uint32Array {
    return this.ppu.frameBuffer;
  }

  getSpeed(): number {
    return this.speed;
  }

  setDmgPalette(id: DmgPaletteId): void {
    this.ppu.setDmgPalette(id);
  }

  getDmgPalette(): DmgPaletteId {
    return this.ppu.getDmgPalette();
  }

  cycleDmgPalette(): DmgPaletteId {
    const cur = this.ppu.getDmgPalette();
    const idx = DMG_PALETTE_IDS.indexOf(cur);
    const next = DMG_PALETTE_IDS[(idx + 1) % DMG_PALETTE_IDS.length]!;
    this.ppu.setDmgPalette(next);
    return next;
  }

  /** Drain pending APU samples (call after runFrame). */
  takeAudioSamples(): Float32Array {
    return this.apu.takeSamples();
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(1, Math.min(MAX_SPEED, speed));
  }

  cycleSpeed(): number {
    const idx = SPEED_STEPS.findIndex((s) => s === this.speed);
    const next = SPEED_STEPS[(idx + 1) % SPEED_STEPS.length]!;
    this.setSpeed(next);
    return this.speed;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.apu.setMuted(muted);
  }

  isMuted(): boolean {
    return this.muted;
  }

  setButton(button: Button, pressed: boolean): void {
    this.joypad.setButton(button, pressed);
  }

  loadRom(rom: Uint8Array): void {
    this.flushSave();
    this.cart = createCartridge(rom);
    this.mmu.attach({
      cart: this.cart,
      ppu: this.ppu,
      apu: this.apu,
      timer: this.timer,
      joypad: this.joypad,
    });
    this.mmu.reset();
    this.mmu.cgbMode = this.cart.isCgb;
    this.ppu.reset(this.cart.isCgb);
    this.apu.reset();
    this.timer.reset();
    this.cpu.reset(this.cart.isCgb);

    // Post-boot I/O defaults (DMG + CGB)
    this.mmu.write(0xff05, 0x00);
    this.mmu.write(0xff06, 0x00);
    this.mmu.write(0xff07, 0x00);
    this.mmu.write(0xff40, 0x91);
    this.mmu.write(0xff42, 0x00);
    this.mmu.write(0xff43, 0x00);
    this.mmu.write(0xff45, 0x00);
    this.mmu.write(0xff47, 0xfc);
    this.mmu.write(0xff48, 0xff);
    this.mmu.write(0xff49, 0xff);
    this.mmu.write(0xff4a, 0x00);
    this.mmu.write(0xff4b, 0x00);
    if (this.cart.isCgb) {
      this.mmu.key1 = 0;
      this.mmu.doubleSpeed = false;
      this.ppu.vbk = 0;
      this.mmu.svbk = 1;
      this.mmu.hdma5 = 0xff;
      for (let i = 0; i < 8; i++) {
        const shades = [0x7fff, 0x56b5, 0x294a, 0x0000];
        for (let c = 0; c < 4; c++) {
          const col = shades[c]!;
          this.ppu.bgpd[i * 8 + c * 2] = col & 0xff;
          this.ppu.bgpd[i * 8 + c * 2 + 1] = (col >> 8) & 0xff;
          this.ppu.obpd[i * 8 + c * 2] = col & 0xff;
          this.ppu.obpd[i * 8 + c * 2 + 1] = (col >> 8) & 0xff;
        }
      }
    }
    this.mmu.ie = 0x00;

    const saved = loadSave(this.cart.header);
    if (saved) this.cart.loadSaveData(saved);

    this.running = true;
    this.cyclesThisFrame = 0;
  }

  createSavestate(): EmulatorSavestate {
    if (!this.cart) throw new Error("No ROM loaded");
    return {
      version: 1,
      title: this.cart.header.title,
      checksum: this.cart.header.checksum,
      createdAt: Date.now(),
      cpu: this.cpu.exportState(),
      mmu: this.mmu.exportState(),
      ppu: this.ppu.exportState(),
      apu: this.apu.exportState(),
      timer: this.timer.exportState(),
      joypad: this.joypad.exportState(),
      cart: this.cart.exportState(),
    };
  }

  applySavestate(state: EmulatorSavestate): void {
    if (!this.cart) throw new Error("No ROM loaded");
    if (state.checksum !== this.cart.header.checksum) {
      throw new Error("Savestate does not match the loaded ROM");
    }
    this.cpu.importState(state.cpu);
    this.mmu.importState(state.mmu);
    this.ppu.importState(state.ppu);
    this.apu.importState(state.apu);
    this.timer.importState(state.timer);
    this.joypad.importState(state.joypad);
    this.cart.importState(state.cart);
    this.apu.setMuted(this.muted);
    this.cyclesThisFrame = 0;
  }

  saveStateToSlot(slot: number): void {
    if (!this.cart) throw new Error("No ROM loaded");
    saveSavestate(this.cart.header, slot, this.createSavestate());
    this.flushSave();
  }

  loadStateFromSlot(slot: number): boolean {
    if (!this.cart) throw new Error("No ROM loaded");
    const state = loadSavestate(this.cart.header, slot);
    if (!state) return false;
    this.applySavestate(state);
    return true;
  }

  occupiedSlots(): number[] {
    if (!this.cart) return [];
    return listSavestateSlots(this.cart.header);
  }

  getHeader() {
    return this.cart?.header ?? null;
  }

  /** Raw SRAM bytes for .sav download (no RTC metadata). */
  exportBatterySavBytes(): Uint8Array | null {
    if (!this.cart) return null;
    this.flushSave();
    const data = this.cart.getSaveData();
    return data ? new Uint8Array(data.sram) : null;
  }

  /** Full battery payload including RTC when present. */
  exportBatterySave(): SaveState | null {
    if (!this.cart) return null;
    this.flushSave();
    return this.cart.getSaveData();
  }

  importBatterySave(data: SaveState): void {
    if (!this.cart) throw new Error("No ROM loaded");
    this.cart.loadSaveData(data);
    this.flushSave();
  }

  importBatterySavBytes(bytes: Uint8Array): void {
    if (!this.cart) throw new Error("No ROM loaded");
    this.cart.loadSaveData({ sram: bytes });
    this.flushSave();
  }

  getSavestateFromSlot(slot: number): EmulatorSavestate | null {
    if (!this.cart) return null;
    return loadSavestate(this.cart.header, slot);
  }

  importSavestateToSlot(slot: number, state: EmulatorSavestate): void {
    if (!this.cart) throw new Error("No ROM loaded");
    if (state.checksum !== this.cart.header.checksum) {
      throw new Error("Savestate does not match the loaded ROM");
    }
    saveSavestate(this.cart.header, slot, state);
  }

  isLinked(): boolean {
    return this.mmu.serial.isLinked();
  }

  /** Attach this emulator and `other` to the shared link cable (pins both to 1×). */
  linkWith(other: Emulator): void {
    this.unlink();
    other.unlink();
    sharedLinkCable().connect(this.mmu.serial, other.mmu.serial);
    this.setSpeed(1);
    other.setSpeed(1);
  }

  unlink(): void {
    if (sharedCable?.connected) sharedCable.disconnect();
  }

  /** Run until one video frame completes. Returns true if a frame was produced. */
  runFrame(): boolean {
    if (!this.running || !this.cart) return false;

    this.ppu.frameReady = false;
    let safety = CYCLES_PER_FRAME * (this.mmu.doubleSpeed ? 4 : 2);
    while (!this.ppu.frameReady && safety > 0) {
      const cycles = this.cpu.step();
      // Wall-clock T-cycles: PPU/APU/serial are NOT sped up in CGB double-speed.
      const wallCycles = this.mmu.doubleSpeed ? Math.floor(cycles / 2) : cycles;
      this.timer.step(cycles);
      this.mmu.serial.step(wallCycles);
      this.ppu.step(wallCycles);
      this.apu.step(wallCycles);
      this.cyclesThisFrame += cycles;
      safety -= cycles;
    }

    this.saveTimer += this.cyclesThisFrame;
    this.cyclesThisFrame = 0;
    if (this.saveTimer >= CYCLES_PER_FRAME * AUTOSAVE_EVERY_FRAMES) {
      this.saveTimer = 0;
      this.flushSave();
    }

    return this.ppu.frameReady;
  }

  flushSave(): void {
    if (!this.cart) return;
    const data = this.cart.getSaveData();
    if (data) saveSave(this.cart.header, data);
  }

  unload(): void {
    this.flushSave();
    this.running = false;
    this.cart = null;
  }
}

export type { Button, DmgPaletteId };
