import type { Mmu } from "./mmu";
import { IF_JOYPAD, IF_LCD, IF_SERIAL, IF_TIMER, IF_VBLANK } from "./types";

const FLAG_Z = 0x80;
const FLAG_N = 0x40;
const FLAG_H = 0x20;
const FLAG_C = 0x10;

export class Cpu {
  a = 0;
  f = 0;
  b = 0;
  c = 0;
  d = 0;
  e = 0;
  h = 0;
  l = 0;
  sp = 0;
  pc = 0;
  ime = false;
  halted = false;
  private imeScheduled = false;
  private mmu: Mmu;

  constructor(mmu: Mmu) {
    this.mmu = mmu;
  }

  reset(cgb: boolean): void {
    // Post-boot state
    if (cgb) {
      this.a = 0x11;
      this.f = 0x80;
      this.b = 0x00;
      this.c = 0x00;
      this.d = 0xff;
      this.e = 0x56;
      this.h = 0x00;
      this.l = 0x0d;
    } else {
      this.a = 0x01;
      this.f = 0xb0;
      this.b = 0x00;
      this.c = 0x13;
      this.d = 0x00;
      this.e = 0xd8;
      this.h = 0x01;
      this.l = 0x4d;
    }
    this.sp = 0xfffe;
    this.pc = 0x0100;
    this.ime = false;
    this.halted = false;
    this.imeScheduled = false;
  }

  exportState(): Record<string, number | boolean> {
    return {
      a: this.a,
      f: this.f,
      b: this.b,
      c: this.c,
      d: this.d,
      e: this.e,
      h: this.h,
      l: this.l,
      sp: this.sp,
      pc: this.pc,
      ime: this.ime,
      halted: this.halted,
      imeScheduled: this.imeScheduled,
    };
  }

  importState(state: Record<string, number | boolean>): void {
    this.a = Number(state.a) & 0xff;
    this.f = Number(state.f) & 0xf0;
    this.b = Number(state.b) & 0xff;
    this.c = Number(state.c) & 0xff;
    this.d = Number(state.d) & 0xff;
    this.e = Number(state.e) & 0xff;
    this.h = Number(state.h) & 0xff;
    this.l = Number(state.l) & 0xff;
    this.sp = Number(state.sp) & 0xffff;
    this.pc = Number(state.pc) & 0xffff;
    this.ime = Boolean(state.ime);
    this.halted = Boolean(state.halted);
    this.imeScheduled = Boolean(state.imeScheduled);
  }

  get af(): number {
    return ((this.a & 0xff) << 8) | (this.f & 0xf0);
  }
  set af(v: number) {
    this.a = (v >> 8) & 0xff;
    this.f = v & 0xf0;
  }
  get bc(): number {
    return ((this.b & 0xff) << 8) | (this.c & 0xff);
  }
  set bc(v: number) {
    this.b = (v >> 8) & 0xff;
    this.c = v & 0xff;
  }
  get de(): number {
    return ((this.d & 0xff) << 8) | (this.e & 0xff);
  }
  set de(v: number) {
    this.d = (v >> 8) & 0xff;
    this.e = v & 0xff;
  }
  get hl(): number {
    return ((this.h & 0xff) << 8) | (this.l & 0xff);
  }
  set hl(v: number) {
    this.h = (v >> 8) & 0xff;
    this.l = v & 0xff;
  }

  /** Execute one instruction (or HALT idle). Returns T-cycles. */
  step(): number {
    if (this.imeScheduled) {
      this.ime = true;
      this.imeScheduled = false;
    }

    const interruptCycles = this.serviceInterrupts();
    if (interruptCycles > 0) return interruptCycles;

    if (this.halted) {
      // Still tick 4 cycles while halted
      if ((this.mmu.ie & this.mmu.if & 0x1f) !== 0) this.halted = false;
      return 4;
    }

    const op = this.fetch8();
    return this.execute(op);
  }

  private serviceInterrupts(): number {
    const pending = this.mmu.ie & this.mmu.if & 0x1f;
    if (!pending) return 0;
    this.halted = false;
    if (!this.ime) return 0;

    this.ime = false;
    const vectors = [
      [IF_VBLANK, 0x40],
      [IF_LCD, 0x48],
      [IF_TIMER, 0x50],
      [IF_SERIAL, 0x58],
      [IF_JOYPAD, 0x60],
    ] as const;
    for (const [bit, vec] of vectors) {
      if (pending & bit) {
        this.mmu.if &= ~bit;
        this.push16(this.pc);
        this.pc = vec;
        return 20;
      }
    }
    return 0;
  }

  private fetch8(): number {
    const v = this.mmu.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  private fetch16(): number {
    const lo = this.fetch8();
    const hi = this.fetch8();
    return lo | (hi << 8);
  }

  private push16(v: number): void {
    this.sp = (this.sp - 1) & 0xffff;
    this.mmu.write(this.sp, (v >> 8) & 0xff);
    this.sp = (this.sp - 1) & 0xffff;
    this.mmu.write(this.sp, v & 0xff);
  }

  private pop16(): number {
    const lo = this.mmu.read(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    const hi = this.mmu.read(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    return lo | (hi << 8);
  }

  private setZNHC(z: boolean, n: boolean, h: boolean, c: boolean): void {
    this.f =
      (z ? FLAG_Z : 0) |
      (n ? FLAG_N : 0) |
      (h ? FLAG_H : 0) |
      (c ? FLAG_C : 0);
  }

  private execute(op: number): number {
    switch (op) {
      case 0x00: return 4; // NOP
      case 0x01: this.bc = this.fetch16(); return 12;
      case 0x02: this.mmu.write(this.bc, this.a); return 8;
      case 0x03: this.bc = (this.bc + 1) & 0xffff; return 8;
      case 0x04: this.b = this.inc8(this.b); return 4;
      case 0x05: this.b = this.dec8(this.b); return 4;
      case 0x06: this.b = this.fetch8(); return 8;
      case 0x07: this.rlca(); return 4;
      case 0x08: {
        const a = this.fetch16();
        this.mmu.write(a, this.sp & 0xff);
        this.mmu.write(a + 1, (this.sp >> 8) & 0xff);
        return 20;
      }
      case 0x09: this.addHl(this.bc); return 8;
      case 0x0a: this.a = this.mmu.read(this.bc); return 8;
      case 0x0b: this.bc = (this.bc - 1) & 0xffff; return 8;
      case 0x0c: this.c = this.inc8(this.c); return 4;
      case 0x0d: this.c = this.dec8(this.c); return 4;
      case 0x0e: this.c = this.fetch8(); return 8;
      case 0x0f: this.rrca(); return 4;

      case 0x10: {
        // STOP — CGB speed switch
        this.fetch8();
        if (this.mmu.cgbMode && (this.mmu.key1 & 0x01)) {
          this.mmu.doubleSpeed = !this.mmu.doubleSpeed;
          this.mmu.key1 = 0;
          this.mmu.timer.writeDiv(0); // DIV resets on speed switch
        }
        return 4;
      }
      case 0x11: this.de = this.fetch16(); return 12;
      case 0x12: this.mmu.write(this.de, this.a); return 8;
      case 0x13: this.de = (this.de + 1) & 0xffff; return 8;
      case 0x14: this.d = this.inc8(this.d); return 4;
      case 0x15: this.d = this.dec8(this.d); return 4;
      case 0x16: this.d = this.fetch8(); return 8;
      case 0x17: this.rla(); return 4;
      case 0x18: return this.jr(true);
      case 0x19: this.addHl(this.de); return 8;
      case 0x1a: this.a = this.mmu.read(this.de); return 8;
      case 0x1b: this.de = (this.de - 1) & 0xffff; return 8;
      case 0x1c: this.e = this.inc8(this.e); return 4;
      case 0x1d: this.e = this.dec8(this.e); return 4;
      case 0x1e: this.e = this.fetch8(); return 8;
      case 0x1f: this.rra(); return 4;

      case 0x20: return this.jr((this.f & FLAG_Z) === 0);
      case 0x21: this.hl = this.fetch16(); return 12;
      case 0x22: this.mmu.write(this.hl, this.a); this.hl = (this.hl + 1) & 0xffff; return 8;
      case 0x23: this.hl = (this.hl + 1) & 0xffff; return 8;
      case 0x24: this.h = this.inc8(this.h); return 4;
      case 0x25: this.h = this.dec8(this.h); return 4;
      case 0x26: this.h = this.fetch8(); return 8;
      case 0x27: this.daa(); return 4;
      case 0x28: return this.jr((this.f & FLAG_Z) !== 0);
      case 0x29: this.addHl(this.hl); return 8;
      case 0x2a: this.a = this.mmu.read(this.hl); this.hl = (this.hl + 1) & 0xffff; return 8;
      case 0x2b: this.hl = (this.hl - 1) & 0xffff; return 8;
      case 0x2c: this.l = this.inc8(this.l); return 4;
      case 0x2d: this.l = this.dec8(this.l); return 4;
      case 0x2e: this.l = this.fetch8(); return 8;
      case 0x2f: this.a ^= 0xff; this.f = (this.f & FLAG_Z) | FLAG_N | FLAG_H | (this.f & FLAG_C); return 4;

      case 0x30: return this.jr((this.f & FLAG_C) === 0);
      case 0x31: this.sp = this.fetch16(); return 12;
      case 0x32: this.mmu.write(this.hl, this.a); this.hl = (this.hl - 1) & 0xffff; return 8;
      case 0x33: this.sp = (this.sp + 1) & 0xffff; return 8;
      case 0x34: {
        const v = this.inc8(this.mmu.read(this.hl));
        this.mmu.write(this.hl, v);
        return 12;
      }
      case 0x35: {
        const v = this.dec8(this.mmu.read(this.hl));
        this.mmu.write(this.hl, v);
        return 12;
      }
      case 0x36: this.mmu.write(this.hl, this.fetch8()); return 12;
      case 0x37: this.f = (this.f & FLAG_Z) | FLAG_C; return 4;
      case 0x38: return this.jr((this.f & FLAG_C) !== 0);
      case 0x39: this.addHl(this.sp); return 8;
      case 0x3a: this.a = this.mmu.read(this.hl); this.hl = (this.hl - 1) & 0xffff; return 8;
      case 0x3b: this.sp = (this.sp - 1) & 0xffff; return 8;
      case 0x3c: this.a = this.inc8(this.a); return 4;
      case 0x3d: this.a = this.dec8(this.a); return 4;
      case 0x3e: this.a = this.fetch8(); return 8;
      case 0x3f: this.f = (this.f & FLAG_Z) | ((this.f & FLAG_C) ? 0 : FLAG_C); return 4;

      // LD r,r'
      case 0x40: this.b = this.b; return 4;
      case 0x41: this.b = this.c; return 4;
      case 0x42: this.b = this.d; return 4;
      case 0x43: this.b = this.e; return 4;
      case 0x44: this.b = this.h; return 4;
      case 0x45: this.b = this.l; return 4;
      case 0x46: this.b = this.mmu.read(this.hl); return 8;
      case 0x47: this.b = this.a; return 4;
      case 0x48: this.c = this.b; return 4;
      case 0x49: this.c = this.c; return 4;
      case 0x4a: this.c = this.d; return 4;
      case 0x4b: this.c = this.e; return 4;
      case 0x4c: this.c = this.h; return 4;
      case 0x4d: this.c = this.l; return 4;
      case 0x4e: this.c = this.mmu.read(this.hl); return 8;
      case 0x4f: this.c = this.a; return 4;
      case 0x50: this.d = this.b; return 4;
      case 0x51: this.d = this.c; return 4;
      case 0x52: this.d = this.d; return 4;
      case 0x53: this.d = this.e; return 4;
      case 0x54: this.d = this.h; return 4;
      case 0x55: this.d = this.l; return 4;
      case 0x56: this.d = this.mmu.read(this.hl); return 8;
      case 0x57: this.d = this.a; return 4;
      case 0x58: this.e = this.b; return 4;
      case 0x59: this.e = this.c; return 4;
      case 0x5a: this.e = this.d; return 4;
      case 0x5b: this.e = this.e; return 4;
      case 0x5c: this.e = this.h; return 4;
      case 0x5d: this.e = this.l; return 4;
      case 0x5e: this.e = this.mmu.read(this.hl); return 8;
      case 0x5f: this.e = this.a; return 4;
      case 0x60: this.h = this.b; return 4;
      case 0x61: this.h = this.c; return 4;
      case 0x62: this.h = this.d; return 4;
      case 0x63: this.h = this.e; return 4;
      case 0x64: this.h = this.h; return 4;
      case 0x65: this.h = this.l; return 4;
      case 0x66: this.h = this.mmu.read(this.hl); return 8;
      case 0x67: this.h = this.a; return 4;
      case 0x68: this.l = this.b; return 4;
      case 0x69: this.l = this.c; return 4;
      case 0x6a: this.l = this.d; return 4;
      case 0x6b: this.l = this.e; return 4;
      case 0x6c: this.l = this.h; return 4;
      case 0x6d: this.l = this.l; return 4;
      case 0x6e: this.l = this.mmu.read(this.hl); return 8;
      case 0x6f: this.l = this.a; return 4;
      case 0x70: this.mmu.write(this.hl, this.b); return 8;
      case 0x71: this.mmu.write(this.hl, this.c); return 8;
      case 0x72: this.mmu.write(this.hl, this.d); return 8;
      case 0x73: this.mmu.write(this.hl, this.e); return 8;
      case 0x74: this.mmu.write(this.hl, this.h); return 8;
      case 0x75: this.mmu.write(this.hl, this.l); return 8;
      case 0x76: this.halted = true; return 4;
      case 0x77: this.mmu.write(this.hl, this.a); return 8;
      case 0x78: this.a = this.b; return 4;
      case 0x79: this.a = this.c; return 4;
      case 0x7a: this.a = this.d; return 4;
      case 0x7b: this.a = this.e; return 4;
      case 0x7c: this.a = this.h; return 4;
      case 0x7d: this.a = this.l; return 4;
      case 0x7e: this.a = this.mmu.read(this.hl); return 8;
      case 0x7f: this.a = this.a; return 4;

      case 0x80: this.add(this.b); return 4;
      case 0x81: this.add(this.c); return 4;
      case 0x82: this.add(this.d); return 4;
      case 0x83: this.add(this.e); return 4;
      case 0x84: this.add(this.h); return 4;
      case 0x85: this.add(this.l); return 4;
      case 0x86: this.add(this.mmu.read(this.hl)); return 8;
      case 0x87: this.add(this.a); return 4;
      case 0x88: this.adc(this.b); return 4;
      case 0x89: this.adc(this.c); return 4;
      case 0x8a: this.adc(this.d); return 4;
      case 0x8b: this.adc(this.e); return 4;
      case 0x8c: this.adc(this.h); return 4;
      case 0x8d: this.adc(this.l); return 4;
      case 0x8e: this.adc(this.mmu.read(this.hl)); return 8;
      case 0x8f: this.adc(this.a); return 4;
      case 0x90: this.sub(this.b); return 4;
      case 0x91: this.sub(this.c); return 4;
      case 0x92: this.sub(this.d); return 4;
      case 0x93: this.sub(this.e); return 4;
      case 0x94: this.sub(this.h); return 4;
      case 0x95: this.sub(this.l); return 4;
      case 0x96: this.sub(this.mmu.read(this.hl)); return 8;
      case 0x97: this.sub(this.a); return 4;
      case 0x98: this.sbc(this.b); return 4;
      case 0x99: this.sbc(this.c); return 4;
      case 0x9a: this.sbc(this.d); return 4;
      case 0x9b: this.sbc(this.e); return 4;
      case 0x9c: this.sbc(this.h); return 4;
      case 0x9d: this.sbc(this.l); return 4;
      case 0x9e: this.sbc(this.mmu.read(this.hl)); return 8;
      case 0x9f: this.sbc(this.a); return 4;
      case 0xa0: this.and(this.b); return 4;
      case 0xa1: this.and(this.c); return 4;
      case 0xa2: this.and(this.d); return 4;
      case 0xa3: this.and(this.e); return 4;
      case 0xa4: this.and(this.h); return 4;
      case 0xa5: this.and(this.l); return 4;
      case 0xa6: this.and(this.mmu.read(this.hl)); return 8;
      case 0xa7: this.and(this.a); return 4;
      case 0xa8: this.xor(this.b); return 4;
      case 0xa9: this.xor(this.c); return 4;
      case 0xaa: this.xor(this.d); return 4;
      case 0xab: this.xor(this.e); return 4;
      case 0xac: this.xor(this.h); return 4;
      case 0xad: this.xor(this.l); return 4;
      case 0xae: this.xor(this.mmu.read(this.hl)); return 8;
      case 0xaf: this.xor(this.a); return 4;
      case 0xb0: this.or(this.b); return 4;
      case 0xb1: this.or(this.c); return 4;
      case 0xb2: this.or(this.d); return 4;
      case 0xb3: this.or(this.e); return 4;
      case 0xb4: this.or(this.h); return 4;
      case 0xb5: this.or(this.l); return 4;
      case 0xb6: this.or(this.mmu.read(this.hl)); return 8;
      case 0xb7: this.or(this.a); return 4;
      case 0xb8: this.cp(this.b); return 4;
      case 0xb9: this.cp(this.c); return 4;
      case 0xba: this.cp(this.d); return 4;
      case 0xbb: this.cp(this.e); return 4;
      case 0xbc: this.cp(this.h); return 4;
      case 0xbd: this.cp(this.l); return 4;
      case 0xbe: this.cp(this.mmu.read(this.hl)); return 8;
      case 0xbf: this.cp(this.a); return 4;

      case 0xc0: return this.ret((this.f & FLAG_Z) === 0);
      case 0xc1: this.bc = this.pop16(); return 12;
      case 0xc2: return this.jp((this.f & FLAG_Z) === 0);
      case 0xc3: return this.jp(true);
      case 0xc4: return this.call((this.f & FLAG_Z) === 0);
      case 0xc5: this.push16(this.bc); return 16;
      case 0xc6: this.add(this.fetch8()); return 8;
      case 0xc7: return this.rst(0x00);
      case 0xc8: return this.ret((this.f & FLAG_Z) !== 0);
      case 0xc9: this.pc = this.pop16(); return 16;
      case 0xca: return this.jp((this.f & FLAG_Z) !== 0);
      case 0xcb: return this.cb(this.fetch8());
      case 0xcc: return this.call((this.f & FLAG_Z) !== 0);
      case 0xcd: return this.call(true);
      case 0xce: this.adc(this.fetch8()); return 8;
      case 0xcf: return this.rst(0x08);
      case 0xd0: return this.ret((this.f & FLAG_C) === 0);
      case 0xd1: this.de = this.pop16(); return 12;
      case 0xd2: return this.jp((this.f & FLAG_C) === 0);
      case 0xd4: return this.call((this.f & FLAG_C) === 0);
      case 0xd5: this.push16(this.de); return 16;
      case 0xd6: this.sub(this.fetch8()); return 8;
      case 0xd7: return this.rst(0x10);
      case 0xd8: return this.ret((this.f & FLAG_C) !== 0);
      case 0xd9: this.pc = this.pop16(); this.ime = true; return 16;
      case 0xda: return this.jp((this.f & FLAG_C) !== 0);
      case 0xdc: return this.call((this.f & FLAG_C) !== 0);
      case 0xde: this.sbc(this.fetch8()); return 8;
      case 0xdf: return this.rst(0x18);
      case 0xe0: this.mmu.write(0xff00 + this.fetch8(), this.a); return 12;
      case 0xe1: this.hl = this.pop16(); return 12;
      case 0xe2: this.mmu.write(0xff00 + this.c, this.a); return 8;
      case 0xe5: this.push16(this.hl); return 16;
      case 0xe6: this.and(this.fetch8()); return 8;
      case 0xe7: return this.rst(0x20);
      case 0xe8: this.addSp(this.fetch8()); return 16;
      case 0xe9: this.pc = this.hl; return 4;
      case 0xea: this.mmu.write(this.fetch16(), this.a); return 16;
      case 0xee: this.xor(this.fetch8()); return 8;
      case 0xef: return this.rst(0x28);
      case 0xf0: this.a = this.mmu.read(0xff00 + this.fetch8()); return 12;
      case 0xf1: this.af = this.pop16(); return 12;
      case 0xf2: this.a = this.mmu.read(0xff00 + this.c); return 8;
      case 0xf3: this.ime = false; this.imeScheduled = false; return 4;
      case 0xf5: this.push16(this.af); return 16;
      case 0xf6: this.or(this.fetch8()); return 8;
      case 0xf7: return this.rst(0x30);
      case 0xf8: this.ldHlSp(this.fetch8()); return 12;
      case 0xf9: this.sp = this.hl; return 8;
      case 0xfa: this.a = this.mmu.read(this.fetch16()); return 16;
      case 0xfb: this.imeScheduled = true; return 4;
      case 0xfe: this.cp(this.fetch8()); return 8;
      case 0xff: return this.rst(0x38);

      default:
        // Illegal DMG opcodes
        return 4;
    }
  }

  private jr(cond: boolean): number {
    const off = this.fetch8();
    if (!cond) return 8;
    const signed = off > 127 ? off - 256 : off;
    this.pc = (this.pc + signed) & 0xffff;
    return 12;
  }

  private jp(cond: boolean): number {
    const addr = this.fetch16();
    if (!cond) return 12;
    this.pc = addr;
    return 16;
  }

  private call(cond: boolean): number {
    const addr = this.fetch16();
    if (!cond) return 12;
    this.push16(this.pc);
    this.pc = addr;
    return 24;
  }

  private ret(cond: boolean): number {
    if (!cond) return 8;
    this.pc = this.pop16();
    return 20;
  }

  private rst(vec: number): number {
    this.push16(this.pc);
    this.pc = vec;
    return 16;
  }

  private inc8(v: number): number {
    const r = (v + 1) & 0xff;
    this.setZNHC(r === 0, false, (v & 0x0f) === 0x0f, (this.f & FLAG_C) !== 0);
    return r;
  }

  private dec8(v: number): number {
    const r = (v - 1) & 0xff;
    this.setZNHC(r === 0, true, (v & 0x0f) === 0, (this.f & FLAG_C) !== 0);
    return r;
  }

  private addHl(v: number): void {
    const hl = this.hl;
    const r = hl + v;
    this.hl = r & 0xffff;
    this.f =
      (this.f & FLAG_Z) |
      (((hl ^ v ^ r) & 0x1000) ? FLAG_H : 0) |
      (r > 0xffff ? FLAG_C : 0);
  }

  private add(v: number): void {
    const r = this.a + v;
    this.setZNHC((r & 0xff) === 0, false, ((this.a ^ v ^ r) & 0x10) !== 0, r > 0xff);
    this.a = r & 0xff;
  }

  private adc(v: number): void {
    const c = (this.f & FLAG_C) ? 1 : 0;
    const r = this.a + v + c;
    this.setZNHC((r & 0xff) === 0, false, ((this.a ^ v ^ r) & 0x10) !== 0, r > 0xff);
    this.a = r & 0xff;
  }

  private sub(v: number): void {
    const r = this.a - v;
    this.setZNHC((r & 0xff) === 0, true, ((this.a ^ v ^ r) & 0x10) !== 0, r < 0);
    this.a = r & 0xff;
  }

  private sbc(v: number): void {
    const c = (this.f & FLAG_C) ? 1 : 0;
    const r = this.a - v - c;
    this.setZNHC((r & 0xff) === 0, true, ((this.a ^ v ^ r) & 0x10) !== 0, r < 0);
    this.a = r & 0xff;
  }

  private and(v: number): void {
    this.a &= v;
    this.setZNHC(this.a === 0, false, true, false);
  }

  private xor(v: number): void {
    this.a ^= v;
    this.setZNHC(this.a === 0, false, false, false);
  }

  private or(v: number): void {
    this.a |= v;
    this.setZNHC(this.a === 0, false, false, false);
  }

  private cp(v: number): void {
    const r = this.a - v;
    this.setZNHC((r & 0xff) === 0, true, ((this.a ^ v ^ r) & 0x10) !== 0, r < 0);
  }

  private rlca(): void {
    const c = (this.a >> 7) & 1;
    this.a = ((this.a << 1) | c) & 0xff;
    this.setZNHC(false, false, false, c !== 0);
  }

  private rrca(): void {
    const c = this.a & 1;
    this.a = ((this.a >> 1) | (c << 7)) & 0xff;
    this.setZNHC(false, false, false, c !== 0);
  }

  private rla(): void {
    const c = (this.f & FLAG_C) ? 1 : 0;
    const newC = (this.a >> 7) & 1;
    this.a = ((this.a << 1) | c) & 0xff;
    this.setZNHC(false, false, false, newC !== 0);
  }

  private rra(): void {
    const c = (this.f & FLAG_C) ? 1 : 0;
    const newC = this.a & 1;
    this.a = ((this.a >> 1) | (c << 7)) & 0xff;
    this.setZNHC(false, false, false, newC !== 0);
  }

  private daa(): void {
    let a = this.a;
    let adjust = 0;
    let c = (this.f & FLAG_C) !== 0;
    if ((this.f & FLAG_N) === 0) {
      if ((this.f & FLAG_H) || (a & 0x0f) > 9) adjust |= 0x06;
      if (c || a > 0x99) {
        adjust |= 0x60;
        c = true;
      }
      a = (a + adjust) & 0xff;
    } else {
      if (this.f & FLAG_H) adjust |= 0x06;
      if (c) adjust |= 0x60;
      a = (a - adjust) & 0xff;
    }
    this.a = a;
    this.setZNHC(a === 0, (this.f & FLAG_N) !== 0, false, c);
  }

  private addSp(off: number): void {
    const signed = off > 127 ? off - 256 : off;
    const sp = this.sp;
    const r = (sp + signed) & 0xffff;
    const tmp = sp ^ signed ^ (sp + signed);
    this.sp = r;
    this.setZNHC(false, false, (tmp & 0x10) !== 0, (tmp & 0x100) !== 0);
  }

  private ldHlSp(off: number): void {
    const signed = off > 127 ? off - 256 : off;
    const sp = this.sp;
    const r = (sp + signed) & 0xffff;
    const tmp = sp ^ signed ^ (sp + signed);
    this.hl = r;
    this.setZNHC(false, false, (tmp & 0x10) !== 0, (tmp & 0x100) !== 0);
  }

  private cb(op: number): number {
    const reg = op & 7;
    const get = (): number => {
      switch (reg) {
        case 0: return this.b;
        case 1: return this.c;
        case 2: return this.d;
        case 3: return this.e;
        case 4: return this.h;
        case 5: return this.l;
        case 6: return this.mmu.read(this.hl);
        default: return this.a;
      }
    };
    const set = (v: number): void => {
      switch (reg) {
        case 0: this.b = v; break;
        case 1: this.c = v; break;
        case 2: this.d = v; break;
        case 3: this.e = v; break;
        case 4: this.h = v; break;
        case 5: this.l = v; break;
        case 6: this.mmu.write(this.hl, v); break;
        default: this.a = v; break;
      }
    };
    const cycles = reg === 6 ? 16 : 8;
    const group = op >> 6;
    const bit = (op >> 3) & 7;

    if (group === 0) {
      let v = get();
      switch (bit) {
        case 0: { // RLC
          const c = (v >> 7) & 1;
          v = ((v << 1) | c) & 0xff;
          this.setZNHC(v === 0, false, false, c !== 0);
          break;
        }
        case 1: { // RRC
          const c = v & 1;
          v = ((v >> 1) | (c << 7)) & 0xff;
          this.setZNHC(v === 0, false, false, c !== 0);
          break;
        }
        case 2: { // RL
          const cIn = (this.f & FLAG_C) ? 1 : 0;
          const c = (v >> 7) & 1;
          v = ((v << 1) | cIn) & 0xff;
          this.setZNHC(v === 0, false, false, c !== 0);
          break;
        }
        case 3: { // RR
          const cIn = (this.f & FLAG_C) ? 1 : 0;
          const c = v & 1;
          v = ((v >> 1) | (cIn << 7)) & 0xff;
          this.setZNHC(v === 0, false, false, c !== 0);
          break;
        }
        case 4: { // SLA
          const c = (v >> 7) & 1;
          v = (v << 1) & 0xff;
          this.setZNHC(v === 0, false, false, c !== 0);
          break;
        }
        case 5: { // SRA
          const c = v & 1;
          v = ((v >> 1) | (v & 0x80)) & 0xff;
          this.setZNHC(v === 0, false, false, c !== 0);
          break;
        }
        case 6: { // SWAP
          v = ((v << 4) | (v >> 4)) & 0xff;
          this.setZNHC(v === 0, false, false, false);
          break;
        }
        case 7: { // SRL
          const c = v & 1;
          v = (v >> 1) & 0xff;
          this.setZNHC(v === 0, false, false, c !== 0);
          break;
        }
      }
      set(v);
      return cycles;
    }

    if (group === 1) {
      // BIT
      const v = get();
      const z = (v & (1 << bit)) === 0;
      this.f = (z ? FLAG_Z : 0) | FLAG_H | (this.f & FLAG_C);
      return reg === 6 ? 12 : 8;
    }

    if (group === 2) {
      set(get() & ~(1 << bit));
      return cycles;
    }

    // SET
    set(get() | (1 << bit));
    return cycles;
  }
}
