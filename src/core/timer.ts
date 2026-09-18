export class Timer {
  div = 0;
  tima = 0;
  tma = 0;
  tac = 0;
  private divCounter = 0;
  private timaCounter = 0;
  private requestInterrupt: (() => void) | null = null;

  setInterruptCallback(cb: () => void): void {
    this.requestInterrupt = cb;
  }

  reset(): void {
    this.div = 0;
    this.tima = 0;
    this.tma = 0;
    this.tac = 0;
    this.divCounter = 0;
    this.timaCounter = 0;
  }

  exportState(): Record<string, number> {
    return {
      div: this.div,
      tima: this.tima,
      tma: this.tma,
      tac: this.tac,
      divCounter: this.divCounter,
      timaCounter: this.timaCounter,
    };
  }

  importState(state: Record<string, number>): void {
    this.div = state.div & 0xff;
    this.tima = state.tima & 0xff;
    this.tma = state.tma & 0xff;
    this.tac = state.tac & 0x07;
    this.divCounter = state.divCounter;
    this.timaCounter = state.timaCounter;
  }

  writeDiv(_value: number): void {
    this.div = 0;
    this.divCounter = 0;
  }

  step(cycles: number): void {
    this.divCounter += cycles;
    while (this.divCounter >= 256) {
      this.divCounter -= 256;
      this.div = (this.div + 1) & 0xff;
    }

    if ((this.tac & 0x04) === 0) return;

    const freq = tacFrequency(this.tac);
    this.timaCounter += cycles;
    while (this.timaCounter >= freq) {
      this.timaCounter -= freq;
      this.tima = (this.tima + 1) & 0xff;
      if (this.tima === 0) {
        this.tima = this.tma;
        this.requestInterrupt?.();
      }
    }
  }
}

function tacFrequency(tac: number): number {
  switch (tac & 0x03) {
    case 0: return 1024;
    case 1: return 16;
    case 2: return 64;
    default: return 256;
  }
}
