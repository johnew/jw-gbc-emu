import type { CartridgeHeader, SaveState } from "../types";
import { base64ToUint8, uint8ToBase64 } from "../encoding";

function readTitle(rom: Uint8Array): string {
  let title = "";
  for (let i = 0x134; i <= 0x143; i++) {
    const c = rom[i]!;
    if (c === 0) break;
    if (c >= 32 && c < 127) title += String.fromCharCode(c);
  }
  return title.trim() || "Unknown";
}

export function parseHeader(rom: Uint8Array): CartridgeHeader {
  const romSizeCode = rom[0x148] ?? 0;
  const ramSizeCode = rom[0x149] ?? 0;
  const romBanks = 2 << romSizeCode;
  const ramSizes = [0, 2 * 1024, 8 * 1024, 32 * 1024, 128 * 1024, 64 * 1024];
  let checksum = 0;
  for (let i = 0; i < Math.min(rom.length, 0x14f); i++) checksum = (checksum + rom[i]!) & 0xffff;
  return {
    title: readTitle(rom),
    cartridgeType: rom[0x147] ?? 0,
    romSize: romBanks * 0x4000,
    ramSize: ramSizes[ramSizeCode] ?? 0,
    cgbFlag: rom[0x143] ?? 0,
    checksum,
  };
}

export interface Cartridge {
  readonly header: CartridgeHeader;
  readonly isCgb: boolean;
  read(addr: number): number;
  write(addr: number, value: number): void;
  getSaveData(): SaveState | null;
  loadSaveData(data: SaveState): void;
  exportState(): Record<string, number | boolean | string | null>;
  importState(state: Record<string, number | boolean | string | null>): void;
}

class NoMbcCartridge implements Cartridge {
  readonly header: CartridgeHeader;
  readonly isCgb: boolean;
  private rom: Uint8Array;
  private sram: Uint8Array;

  constructor(rom: Uint8Array, header: CartridgeHeader) {
    this.rom = rom;
    this.header = header;
    this.isCgb = (header.cgbFlag & 0x80) !== 0;
    this.sram = new Uint8Array(header.ramSize || 0);
  }

  read(addr: number): number {
    if (addr < 0x8000) return this.rom[addr] ?? 0xff;
    if (addr >= 0xa000 && addr < 0xc000) {
      const offset = addr - 0xa000;
      return this.sram[offset] ?? 0xff;
    }
    return 0xff;
  }

  write(addr: number, _value: number): void {
    if (addr >= 0xa000 && addr < 0xc000 && this.sram.length > 0) {
      this.sram[addr - 0xa000] = _value & 0xff;
    }
  }

  getSaveData(): SaveState | null {
    if (this.sram.length === 0) return null;
    return { sram: new Uint8Array(this.sram) };
  }

  loadSaveData(data: SaveState): void {
    if (data.sram.length === this.sram.length) this.sram.set(data.sram);
  }

  exportState(): Record<string, number | boolean | string | null> {
    return {
      kind: "none",
      sram: this.sram.length ? uint8ToBase64(this.sram) : null,
    };
  }

  importState(state: Record<string, number | boolean | string | null>): void {
    if (typeof state.sram === "string") {
      const bytes = base64ToUint8(state.sram);
      this.sram.fill(0);
      this.sram.set(bytes.subarray(0, Math.min(bytes.length, this.sram.length)));
    }
  }
}

/** MBC1 / MBC3-compatible banking used by Pokémon Red/Blue/Crystal. */
class Mbc3Cartridge implements Cartridge {
  readonly header: CartridgeHeader;
  readonly isCgb: boolean;
  private rom: Uint8Array;
  private sram: Uint8Array;
  private romBank = 1;
  private ramBank = 0;
  private ramEnabled = false;
  private romBankMask: number;
  private hasRtc: boolean;

  // RTC
  private rtcS = 0;
  private rtcM = 0;
  private rtcH = 0;
  private rtcDl = 0;
  private rtcDh = 0;
  private latchedS = 0;
  private latchedM = 0;
  private latchedH = 0;
  private latchedDl = 0;
  private latchedDh = 0;
  private latchClockReg = 0xff;
  private lastUnix = Date.now();

  constructor(rom: Uint8Array, header: CartridgeHeader) {
    this.rom = rom;
    this.header = header;
    this.isCgb = (header.cgbFlag & 0x80) !== 0;
    const type = header.cartridgeType;
    this.hasRtc = type === 0x0f || type === 0x10;
    const banks = Math.max(2, Math.ceil(rom.length / 0x4000));
    this.romBankMask = banks - 1;
    // Round mask up to next power-of-two-minus-one style
    let mask = 1;
    while (mask < banks) mask <<= 1;
    this.romBankMask = mask - 1;
    this.sram = new Uint8Array(Math.max(header.ramSize, this.hasRtc ? 0 : 0) || (header.ramSize > 0 ? header.ramSize : 32 * 1024));
    if (header.ramSize === 0 && (type === 0x13 || type === 0x10 || type === 0x0f || type === 0x03)) {
      this.sram = new Uint8Array(32 * 1024);
    }
  }

  private tickRtc(): void {
    if ((this.rtcDh & 0x40) !== 0) return; // halted
    const now = Date.now();
    let elapsed = Math.floor((now - this.lastUnix) / 1000);
    if (elapsed <= 0) return;
    this.lastUnix = now;
    this.rtcS += elapsed;
    this.rtcM += Math.floor(this.rtcS / 60);
    this.rtcS %= 60;
    this.rtcH += Math.floor(this.rtcM / 60);
    this.rtcM %= 60;
    let days = this.rtcDl | ((this.rtcDh & 1) << 8);
    days += Math.floor(this.rtcH / 24);
    this.rtcH %= 24;
    if (days > 511) {
      days &= 511;
      this.rtcDh |= 0x80; // day carry
    }
    this.rtcDl = days & 0xff;
    this.rtcDh = (this.rtcDh & 0xfe) | ((days >> 8) & 1);
  }

  read(addr: number): number {
    if (addr < 0x4000) return this.rom[addr] ?? 0xff;
    if (addr < 0x8000) {
      const bank = this.romBank & this.romBankMask;
      const offset = bank * 0x4000 + (addr - 0x4000);
      return this.rom[offset] ?? 0xff;
    }
    if (addr >= 0xa000 && addr < 0xc000) {
      if (!this.ramEnabled) return 0xff;
      if (this.ramBank <= 0x03) {
        const offset = this.ramBank * 0x2000 + (addr - 0xa000);
        return this.sram[offset] ?? 0xff;
      }
      if (this.hasRtc && this.ramBank >= 0x08 && this.ramBank <= 0x0c) {
        this.tickRtc();
        switch (this.ramBank) {
          case 0x08: return this.latchedS;
          case 0x09: return this.latchedM;
          case 0x0a: return this.latchedH;
          case 0x0b: return this.latchedDl;
          case 0x0c: return this.latchedDh;
        }
      }
      return 0xff;
    }
    return 0xff;
  }

  write(addr: number, value: number): void {
    value &= 0xff;
    if (addr < 0x2000) {
      this.ramEnabled = (value & 0x0f) === 0x0a;
      return;
    }
    if (addr < 0x4000) {
      let bank = value & 0x7f;
      if (bank === 0) bank = 1;
      this.romBank = bank;
      return;
    }
    if (addr < 0x6000) {
      this.ramBank = value & 0x0f;
      return;
    }
    if (addr < 0x8000) {
      if (this.hasRtc) {
        if (this.latchClockReg === 0 && value === 1) {
          this.tickRtc();
          this.latchedS = this.rtcS;
          this.latchedM = this.rtcM;
          this.latchedH = this.rtcH;
          this.latchedDl = this.rtcDl;
          this.latchedDh = this.rtcDh;
        }
        this.latchClockReg = value;
      }
      return;
    }
    if (addr >= 0xa000 && addr < 0xc000) {
      if (!this.ramEnabled) return;
      if (this.ramBank <= 0x03) {
        const offset = this.ramBank * 0x2000 + (addr - 0xa000);
        if (offset < this.sram.length) this.sram[offset] = value;
        return;
      }
      if (this.hasRtc && this.ramBank >= 0x08 && this.ramBank <= 0x0c) {
        this.tickRtc();
        switch (this.ramBank) {
          case 0x08: this.rtcS = value % 60; break;
          case 0x09: this.rtcM = value % 60; break;
          case 0x0a: this.rtcH = value % 24; break;
          case 0x0b: this.rtcDl = value; break;
          case 0x0c: this.rtcDh = value; break;
        }
      }
    }
  }

  getSaveData(): SaveState | null {
    if (this.sram.length === 0 && !this.hasRtc) return null;
    this.tickRtc();
    const state: SaveState = { sram: new Uint8Array(this.sram) };
    if (this.hasRtc) {
      state.rtc = {
        seconds: this.rtcS,
        minutes: this.rtcM,
        hours: this.rtcH,
        days: this.rtcDl | ((this.rtcDh & 1) << 8),
        halt: (this.rtcDh & 0x40) !== 0,
        dayCarry: (this.rtcDh & 0x80) !== 0,
        latch: this.latchClockReg,
        baseTimestamp: this.lastUnix,
      };
    }
    return state;
  }

  loadSaveData(data: SaveState): void {
    if (data.sram.length <= this.sram.length) {
      this.sram.fill(0);
      this.sram.set(data.sram);
    }
    if (data.rtc && this.hasRtc) {
      this.rtcS = data.rtc.seconds;
      this.rtcM = data.rtc.minutes;
      this.rtcH = data.rtc.hours;
      this.rtcDl = data.rtc.days & 0xff;
      this.rtcDh =
        ((data.rtc.days >> 8) & 1) |
        (data.rtc.halt ? 0x40 : 0) |
        (data.rtc.dayCarry ? 0x80 : 0);
      this.latchClockReg = data.rtc.latch;
      this.lastUnix = data.rtc.baseTimestamp;
      this.tickRtc();
    }
  }

  exportState(): Record<string, number | boolean | string | null> {
    this.tickRtc();
    return {
      kind: "mbc3",
      romBank: this.romBank,
      ramBank: this.ramBank,
      ramEnabled: this.ramEnabled,
      sram: uint8ToBase64(this.sram),
      rtcS: this.rtcS,
      rtcM: this.rtcM,
      rtcH: this.rtcH,
      rtcDl: this.rtcDl,
      rtcDh: this.rtcDh,
      latchedS: this.latchedS,
      latchedM: this.latchedM,
      latchedH: this.latchedH,
      latchedDl: this.latchedDl,
      latchedDh: this.latchedDh,
      latchClockReg: this.latchClockReg,
      lastUnix: this.lastUnix,
    };
  }

  importState(state: Record<string, number | boolean | string | null>): void {
    if (typeof state.romBank === "number") this.romBank = state.romBank;
    if (typeof state.ramBank === "number") this.ramBank = state.ramBank;
    if (typeof state.ramEnabled === "boolean") this.ramEnabled = state.ramEnabled;
    if (typeof state.sram === "string") {
      const bytes = base64ToUint8(state.sram);
      this.sram.fill(0);
      this.sram.set(bytes.subarray(0, Math.min(bytes.length, this.sram.length)));
    }
    if (typeof state.rtcS === "number") this.rtcS = state.rtcS;
    if (typeof state.rtcM === "number") this.rtcM = state.rtcM;
    if (typeof state.rtcH === "number") this.rtcH = state.rtcH;
    if (typeof state.rtcDl === "number") this.rtcDl = state.rtcDl;
    if (typeof state.rtcDh === "number") this.rtcDh = state.rtcDh;
    if (typeof state.latchedS === "number") this.latchedS = state.latchedS;
    if (typeof state.latchedM === "number") this.latchedM = state.latchedM;
    if (typeof state.latchedH === "number") this.latchedH = state.latchedH;
    if (typeof state.latchedDl === "number") this.latchedDl = state.latchedDl;
    if (typeof state.latchedDh === "number") this.latchedDh = state.latchedDh;
    if (typeof state.latchClockReg === "number") this.latchClockReg = state.latchClockReg;
    if (typeof state.lastUnix === "number") this.lastUnix = state.lastUnix;
  }
}

export function createCartridge(rom: Uint8Array): Cartridge {
  const header = parseHeader(rom);
  const type = header.cartridgeType;
  // ROM only
  if (type === 0x00) return new NoMbcCartridge(rom, header);
  // MBC1, MBC3, MBC5 (treat banking like MBC3 for Pokémon; MBC5 ROM bank uses more bits)
  if (
    type === 0x01 || type === 0x02 || type === 0x03 ||
    type === 0x0f || type === 0x10 || type === 0x11 || type === 0x12 || type === 0x13 ||
    type === 0x19 || type === 0x1a || type === 0x1b || type === 0x1c || type === 0x1d || type === 0x1e
  ) {
    return new Mbc3Cartridge(rom, header);
  }
  // Fallback: try MBC3-style banking
  console.warn(`Unknown cartridge type 0x${type.toString(16)}; using MBC3 mapper`);
  return new Mbc3Cartridge(rom, header);
}
