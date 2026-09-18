/** Minimal 4-channel Game Boy APU producing stereo PCM samples. */
import { base64ToUint8, uint8ToBase64 } from "./saves";

export class Apu {
  nr10 = 0;
  nr11 = 0;
  nr12 = 0;
  nr13 = 0;
  nr14 = 0;
  nr21 = 0;
  nr22 = 0;
  nr23 = 0;
  nr24 = 0;
  nr30 = 0;
  nr31 = 0;
  nr32 = 0;
  nr33 = 0;
  nr34 = 0;
  nr41 = 0;
  nr42 = 0;
  nr43 = 0;
  nr44 = 0;
  nr50 = 0;
  nr51 = 0;
  nr52 = 0x80;
  waveRam = new Uint8Array(16);

  private frameSeq = 0;
  private frameSeqTimer = 0;
  private sampleTimer = 0;
  private readonly samplePeriod: number;
  private muted = false;

  // Channel state
  private ch1Enabled = false;
  private ch1Timer = 0;
  private ch1DutyPos = 0;
  private ch1Length = 0;
  private ch1EnvVol = 0;
  private ch1EnvTimer = 0;
  private ch1SweepTimer = 0;
  private ch1Shadow = 0;
  private ch1SweepEnabled = false;

  private ch2Enabled = false;
  private ch2Timer = 0;
  private ch2DutyPos = 0;
  private ch2Length = 0;
  private ch2EnvVol = 0;
  private ch2EnvTimer = 0;

  private ch3Enabled = false;
  private ch3Timer = 0;
  private ch3Pos = 0;
  private ch3Length = 0;

  private ch4Enabled = false;
  private ch4Timer = 0;
  private ch4Length = 0;
  private ch4EnvVol = 0;
  private ch4EnvTimer = 0;
  private ch4Lfsr = 0x7fff;

  readonly sampleBuffer: number[] = [];
  private readonly maxBuffer: number;

  constructor(sampleRate = 44100) {
    this.samplePeriod = 4194304 / sampleRate;
    this.maxBuffer = sampleRate; // ~1s cap
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  reset(): void {
    this.nr52 = 0x80;
    this.sampleBuffer.length = 0;
    this.ch1Enabled = this.ch2Enabled = this.ch3Enabled = this.ch4Enabled = false;
  }

  exportState(): Record<string, number | boolean | string> {
    return {
      nr10: this.nr10, nr11: this.nr11, nr12: this.nr12, nr13: this.nr13, nr14: this.nr14,
      nr21: this.nr21, nr22: this.nr22, nr23: this.nr23, nr24: this.nr24,
      nr30: this.nr30, nr31: this.nr31, nr32: this.nr32, nr33: this.nr33, nr34: this.nr34,
      nr41: this.nr41, nr42: this.nr42, nr43: this.nr43, nr44: this.nr44,
      nr50: this.nr50, nr51: this.nr51, nr52: this.nr52,
      waveRam: uint8ToBase64(this.waveRam),
      frameSeq: this.frameSeq,
      frameSeqTimer: this.frameSeqTimer,
      sampleTimer: this.sampleTimer,
      ch1Enabled: this.ch1Enabled, ch1Timer: this.ch1Timer, ch1DutyPos: this.ch1DutyPos,
      ch1Length: this.ch1Length, ch1EnvVol: this.ch1EnvVol, ch1EnvTimer: this.ch1EnvTimer,
      ch1SweepTimer: this.ch1SweepTimer, ch1Shadow: this.ch1Shadow, ch1SweepEnabled: this.ch1SweepEnabled,
      ch2Enabled: this.ch2Enabled, ch2Timer: this.ch2Timer, ch2DutyPos: this.ch2DutyPos,
      ch2Length: this.ch2Length, ch2EnvVol: this.ch2EnvVol, ch2EnvTimer: this.ch2EnvTimer,
      ch3Enabled: this.ch3Enabled, ch3Timer: this.ch3Timer, ch3Pos: this.ch3Pos, ch3Length: this.ch3Length,
      ch4Enabled: this.ch4Enabled, ch4Timer: this.ch4Timer, ch4Length: this.ch4Length,
      ch4EnvVol: this.ch4EnvVol, ch4EnvTimer: this.ch4EnvTimer, ch4Lfsr: this.ch4Lfsr,
    };
  }

  importState(state: Record<string, number | boolean | string>): void {
    this.nr10 = Number(state.nr10) & 0xff;
    this.nr11 = Number(state.nr11) & 0xff;
    this.nr12 = Number(state.nr12) & 0xff;
    this.nr13 = Number(state.nr13) & 0xff;
    this.nr14 = Number(state.nr14) & 0xff;
    this.nr21 = Number(state.nr21) & 0xff;
    this.nr22 = Number(state.nr22) & 0xff;
    this.nr23 = Number(state.nr23) & 0xff;
    this.nr24 = Number(state.nr24) & 0xff;
    this.nr30 = Number(state.nr30) & 0xff;
    this.nr31 = Number(state.nr31) & 0xff;
    this.nr32 = Number(state.nr32) & 0xff;
    this.nr33 = Number(state.nr33) & 0xff;
    this.nr34 = Number(state.nr34) & 0xff;
    this.nr41 = Number(state.nr41) & 0xff;
    this.nr42 = Number(state.nr42) & 0xff;
    this.nr43 = Number(state.nr43) & 0xff;
    this.nr44 = Number(state.nr44) & 0xff;
    this.nr50 = Number(state.nr50) & 0xff;
    this.nr51 = Number(state.nr51) & 0xff;
    this.nr52 = Number(state.nr52) & 0xff;
    if (typeof state.waveRam === "string") this.waveRam.set(base64ToUint8(state.waveRam));
    this.frameSeq = Number(state.frameSeq) & 7;
    this.frameSeqTimer = Number(state.frameSeqTimer);
    this.sampleTimer = Number(state.sampleTimer);
    this.ch1Enabled = Boolean(state.ch1Enabled);
    this.ch1Timer = Number(state.ch1Timer);
    this.ch1DutyPos = Number(state.ch1DutyPos) & 7;
    this.ch1Length = Number(state.ch1Length);
    this.ch1EnvVol = Number(state.ch1EnvVol);
    this.ch1EnvTimer = Number(state.ch1EnvTimer);
    this.ch1SweepTimer = Number(state.ch1SweepTimer);
    this.ch1Shadow = Number(state.ch1Shadow);
    this.ch1SweepEnabled = Boolean(state.ch1SweepEnabled);
    this.ch2Enabled = Boolean(state.ch2Enabled);
    this.ch2Timer = Number(state.ch2Timer);
    this.ch2DutyPos = Number(state.ch2DutyPos) & 7;
    this.ch2Length = Number(state.ch2Length);
    this.ch2EnvVol = Number(state.ch2EnvVol);
    this.ch2EnvTimer = Number(state.ch2EnvTimer);
    this.ch3Enabled = Boolean(state.ch3Enabled);
    this.ch3Timer = Number(state.ch3Timer);
    this.ch3Pos = Number(state.ch3Pos) & 31;
    this.ch3Length = Number(state.ch3Length);
    this.ch4Enabled = Boolean(state.ch4Enabled);
    this.ch4Timer = Number(state.ch4Timer);
    this.ch4Length = Number(state.ch4Length);
    this.ch4EnvVol = Number(state.ch4EnvVol);
    this.ch4EnvTimer = Number(state.ch4EnvTimer);
    this.ch4Lfsr = Number(state.ch4Lfsr);
    this.sampleBuffer.length = 0;
  }

  read(addr: number): number {
    switch (addr) {
      case 0xff10: return this.nr10 | 0x80;
      case 0xff11: return this.nr11 | 0x3f;
      case 0xff12: return this.nr12;
      case 0xff13: return 0xff;
      case 0xff14: return this.nr14 | 0xbf;
      case 0xff16: return this.nr21 | 0x3f;
      case 0xff17: return this.nr22;
      case 0xff18: return 0xff;
      case 0xff19: return this.nr24 | 0xbf;
      case 0xff1a: return this.nr30 | 0x7f;
      case 0xff1b: return 0xff;
      case 0xff1c: return this.nr32 | 0x9f;
      case 0xff1d: return 0xff;
      case 0xff1e: return this.nr34 | 0xbf;
      case 0xff20: return 0xff;
      case 0xff21: return this.nr42;
      case 0xff22: return this.nr43;
      case 0xff23: return this.nr44 | 0xbf;
      case 0xff24: return this.nr50;
      case 0xff25: return this.nr51;
      case 0xff26: {
        let v = this.nr52 & 0x80;
        if (this.ch1Enabled) v |= 1;
        if (this.ch2Enabled) v |= 2;
        if (this.ch3Enabled) v |= 4;
        if (this.ch4Enabled) v |= 8;
        return v | 0x70;
      }
      default:
        if (addr >= 0xff30 && addr <= 0xff3f) return this.waveRam[addr - 0xff30]!;
        return 0xff;
    }
  }

  write(addr: number, value: number): void {
    value &= 0xff;
    if (addr === 0xff26) {
      this.nr52 = value & 0x80;
      if ((value & 0x80) === 0) {
        this.ch1Enabled = this.ch2Enabled = this.ch3Enabled = this.ch4Enabled = false;
      }
      return;
    }
    if ((this.nr52 & 0x80) === 0 && addr < 0xff30) return;

    switch (addr) {
      case 0xff10: this.nr10 = value; break;
      case 0xff11:
        this.nr11 = value;
        this.ch1Length = 64 - (value & 0x3f);
        break;
      case 0xff12: this.nr12 = value; break;
      case 0xff13: this.nr13 = value; break;
      case 0xff14:
        this.nr14 = value;
        if (value & 0x80) this.triggerCh1();
        break;
      case 0xff16:
        this.nr21 = value;
        this.ch2Length = 64 - (value & 0x3f);
        break;
      case 0xff17: this.nr22 = value; break;
      case 0xff18: this.nr23 = value; break;
      case 0xff19:
        this.nr24 = value;
        if (value & 0x80) this.triggerCh2();
        break;
      case 0xff1a: this.nr30 = value; if ((value & 0x80) === 0) this.ch3Enabled = false; break;
      case 0xff1b: this.nr31 = value; this.ch3Length = 256 - value; break;
      case 0xff1c: this.nr32 = value; break;
      case 0xff1d: this.nr33 = value; break;
      case 0xff1e:
        this.nr34 = value;
        if (value & 0x80) this.triggerCh3();
        break;
      case 0xff20: this.nr41 = value; this.ch4Length = 64 - (value & 0x3f); break;
      case 0xff21: this.nr42 = value; break;
      case 0xff22: this.nr43 = value; break;
      case 0xff23:
        this.nr44 = value;
        if (value & 0x80) this.triggerCh4();
        break;
      case 0xff24: this.nr50 = value; break;
      case 0xff25: this.nr51 = value; break;
      default:
        if (addr >= 0xff30 && addr <= 0xff3f) this.waveRam[addr - 0xff30] = value;
    }
  }

  step(cycles: number): void {
    if ((this.nr52 & 0x80) === 0) return;

    this.frameSeqTimer += cycles;
    while (this.frameSeqTimer >= 8192) {
      this.frameSeqTimer -= 8192;
      this.clockFrameSequencer();
    }

    this.clockChannelTimers(cycles);

    this.sampleTimer += cycles;
    while (this.sampleTimer >= this.samplePeriod) {
      this.sampleTimer -= this.samplePeriod;
      this.generateSample();
    }
  }

  takeSamples(): Float32Array {
    const out = new Float32Array(this.sampleBuffer.length);
    for (let i = 0; i < this.sampleBuffer.length; i++) out[i] = this.sampleBuffer[i]!;
    this.sampleBuffer.length = 0;
    return out;
  }

  private clockFrameSequencer(): void {
    // length @ 256Hz: steps 0,2,4,6
    if ((this.frameSeq & 1) === 0) this.clockLength();
    // sweep @ 128Hz: steps 2,6
    if (this.frameSeq === 2 || this.frameSeq === 6) this.clockSweep();
    // envelope @ 64Hz: step 7
    if (this.frameSeq === 7) this.clockEnvelope();
    this.frameSeq = (this.frameSeq + 1) & 7;
  }

  private clockLength(): void {
    if ((this.nr14 & 0x40) && this.ch1Length > 0) {
      this.ch1Length--;
      if (this.ch1Length === 0) this.ch1Enabled = false;
    }
    if ((this.nr24 & 0x40) && this.ch2Length > 0) {
      this.ch2Length--;
      if (this.ch2Length === 0) this.ch2Enabled = false;
    }
    if ((this.nr34 & 0x40) && this.ch3Length > 0) {
      this.ch3Length--;
      if (this.ch3Length === 0) this.ch3Enabled = false;
    }
    if ((this.nr44 & 0x40) && this.ch4Length > 0) {
      this.ch4Length--;
      if (this.ch4Length === 0) this.ch4Enabled = false;
    }
  }

  private clockEnvelope(): void {
    if (this.ch1EnvTimer > 0) {
      this.ch1EnvTimer--;
      if (this.ch1EnvTimer === 0) {
        this.ch1EnvTimer = this.nr12 & 7;
        if (this.ch1EnvTimer === 0) this.ch1EnvTimer = 8;
        const up = (this.nr12 & 0x08) !== 0;
        if (up && this.ch1EnvVol < 15) this.ch1EnvVol++;
        else if (!up && this.ch1EnvVol > 0) this.ch1EnvVol--;
      }
    }
    if (this.ch2EnvTimer > 0) {
      this.ch2EnvTimer--;
      if (this.ch2EnvTimer === 0) {
        this.ch2EnvTimer = this.nr22 & 7;
        if (this.ch2EnvTimer === 0) this.ch2EnvTimer = 8;
        const up = (this.nr22 & 0x08) !== 0;
        if (up && this.ch2EnvVol < 15) this.ch2EnvVol++;
        else if (!up && this.ch2EnvVol > 0) this.ch2EnvVol--;
      }
    }
    if (this.ch4EnvTimer > 0) {
      this.ch4EnvTimer--;
      if (this.ch4EnvTimer === 0) {
        this.ch4EnvTimer = this.nr42 & 7;
        if (this.ch4EnvTimer === 0) this.ch4EnvTimer = 8;
        const up = (this.nr42 & 0x08) !== 0;
        if (up && this.ch4EnvVol < 15) this.ch4EnvVol++;
        else if (!up && this.ch4EnvVol > 0) this.ch4EnvVol--;
      }
    }
  }

  private clockSweep(): void {
    if (!this.ch1SweepEnabled) return;
    if (this.ch1SweepTimer > 0) this.ch1SweepTimer--;
    if (this.ch1SweepTimer === 0) {
      this.ch1SweepTimer = (this.nr10 >> 4) & 7;
      if (this.ch1SweepTimer === 0) this.ch1SweepTimer = 8;
      const shift = this.nr10 & 7;
      if (shift > 0 || ((this.nr10 >> 4) & 7) > 0) {
        const neg = (this.nr10 & 0x08) !== 0;
        let newFreq = this.ch1Shadow >> shift;
        newFreq = neg ? this.ch1Shadow - newFreq : this.ch1Shadow + newFreq;
        if (newFreq > 2047) this.ch1Enabled = false;
        else if (shift > 0) {
          this.ch1Shadow = newFreq;
          this.nr13 = newFreq & 0xff;
          this.nr14 = (this.nr14 & 0xf8) | ((newFreq >> 8) & 7);
        }
      }
    }
  }

  private clockChannelTimers(cycles: number): void {
    if (this.ch1Enabled) {
      this.ch1Timer -= cycles;
      while (this.ch1Timer <= 0) {
        this.ch1Timer += (2048 - this.ch1Freq()) * 4;
        this.ch1DutyPos = (this.ch1DutyPos + 1) & 7;
      }
    }
    if (this.ch2Enabled) {
      this.ch2Timer -= cycles;
      while (this.ch2Timer <= 0) {
        this.ch2Timer += (2048 - this.ch2Freq()) * 4;
        this.ch2DutyPos = (this.ch2DutyPos + 1) & 7;
      }
    }
    if (this.ch3Enabled) {
      this.ch3Timer -= cycles;
      while (this.ch3Timer <= 0) {
        this.ch3Timer += (2048 - this.ch3Freq()) * 2;
        this.ch3Pos = (this.ch3Pos + 1) & 31;
      }
    }
    if (this.ch4Enabled) {
      this.ch4Timer -= cycles;
      while (this.ch4Timer <= 0) {
        this.ch4Timer += this.ch4Period();
        const xor = (this.ch4Lfsr & 1) ^ ((this.ch4Lfsr >> 1) & 1);
        this.ch4Lfsr = (this.ch4Lfsr >> 1) | (xor << 14);
        if (this.nr43 & 0x08) {
          this.ch4Lfsr = (this.ch4Lfsr & ~0x40) | (xor << 6);
        }
      }
    }
  }

  private generateSample(): void {
    if (this.sampleBuffer.length >= this.maxBuffer) return;
    if (this.muted) {
      this.sampleBuffer.push(0, 0);
      return;
    }

    let left = 0;
    let right = 0;
    const dutyTables = [
      [0, 0, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 1, 1, 1],
      [0, 1, 1, 1, 1, 1, 1, 0],
    ];

    if (this.ch1Enabled) {
      const duty = dutyTables[(this.nr11 >> 6) & 3]!;
      const amp = duty[this.ch1DutyPos]! * this.ch1EnvVol;
      if (this.nr51 & 0x10) left += amp;
      if (this.nr51 & 0x01) right += amp;
    }
    if (this.ch2Enabled) {
      const duty = dutyTables[(this.nr21 >> 6) & 3]!;
      const amp = duty[this.ch2DutyPos]! * this.ch2EnvVol;
      if (this.nr51 & 0x20) left += amp;
      if (this.nr51 & 0x02) right += amp;
    }
    if (this.ch3Enabled && (this.nr30 & 0x80)) {
      const byte = this.waveRam[this.ch3Pos >> 1]!;
      let sample = (this.ch3Pos & 1) === 0 ? byte >> 4 : byte & 0x0f;
      const shift = [4, 0, 1, 2][(this.nr32 >> 5) & 3]!;
      sample = shift === 4 ? 0 : sample >> shift;
      if (this.nr51 & 0x40) left += sample;
      if (this.nr51 & 0x04) right += sample;
    }
    if (this.ch4Enabled) {
      const amp = (~this.ch4Lfsr & 1) * this.ch4EnvVol;
      if (this.nr51 & 0x80) left += amp;
      if (this.nr51 & 0x08) right += amp;
    }

    const leftVol = ((this.nr50 >> 4) & 7) + 1;
    const rightVol = (this.nr50 & 7) + 1;
    this.sampleBuffer.push((left * leftVol) / (15 * 8 * 4), (right * rightVol) / (15 * 8 * 4));
  }

  private ch1Freq(): number {
    return this.nr13 | ((this.nr14 & 7) << 8);
  }
  private ch2Freq(): number {
    return this.nr23 | ((this.nr24 & 7) << 8);
  }
  private ch3Freq(): number {
    return this.nr33 | ((this.nr34 & 7) << 8);
  }
  private ch4Period(): number {
    const divisorCode = this.nr43 & 7;
    const divisor = divisorCode === 0 ? 8 : divisorCode * 16;
    const shift = this.nr43 >> 4;
    return divisor << shift;
  }

  private triggerCh1(): void {
    this.ch1Enabled = true;
    if (this.ch1Length === 0) this.ch1Length = 64;
    this.ch1Timer = (2048 - this.ch1Freq()) * 4;
    this.ch1EnvVol = this.nr12 >> 4;
    this.ch1EnvTimer = this.nr12 & 7;
    this.ch1Shadow = this.ch1Freq();
    this.ch1SweepTimer = (this.nr10 >> 4) & 7;
    if (this.ch1SweepTimer === 0) this.ch1SweepTimer = 8;
    this.ch1SweepEnabled = ((this.nr10 >> 4) & 7) !== 0 || (this.nr10 & 7) !== 0;
    if ((this.nr12 & 0xf8) === 0) this.ch1Enabled = false;
  }

  private triggerCh2(): void {
    this.ch2Enabled = true;
    if (this.ch2Length === 0) this.ch2Length = 64;
    this.ch2Timer = (2048 - this.ch2Freq()) * 4;
    this.ch2EnvVol = this.nr22 >> 4;
    this.ch2EnvTimer = this.nr22 & 7;
    if ((this.nr22 & 0xf8) === 0) this.ch2Enabled = false;
  }

  private triggerCh3(): void {
    this.ch3Enabled = (this.nr30 & 0x80) !== 0;
    if (this.ch3Length === 0) this.ch3Length = 256;
    this.ch3Timer = (2048 - this.ch3Freq()) * 2;
    this.ch3Pos = 0;
  }

  private triggerCh4(): void {
    this.ch4Enabled = true;
    if (this.ch4Length === 0) this.ch4Length = 64;
    this.ch4Timer = this.ch4Period();
    this.ch4EnvVol = this.nr42 >> 4;
    this.ch4EnvTimer = this.nr42 & 7;
    this.ch4Lfsr = 0x7fff;
    if ((this.nr42 & 0xf8) === 0) this.ch4Enabled = false;
  }
}
