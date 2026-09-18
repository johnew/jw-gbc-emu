import type { Button } from "./types";

export class Joypad {
  private buttons = 0xff; // 1 = released
  private selectButtons = false;
  private selectDpad = false;
  private requestInterrupt: (() => void) | null = null;

  setInterruptCallback(cb: () => void): void {
    this.requestInterrupt = cb;
  }

  setButton(button: Button, pressed: boolean): void {
    const bit = buttonBit(button);
    const prev = this.buttons;
    if (pressed) this.buttons &= ~bit;
    else this.buttons |= bit;
    if (pressed && (prev & bit) !== 0) this.requestInterrupt?.();
  }

  writeP1(value: number): void {
    this.selectButtons = (value & 0x20) === 0;
    this.selectDpad = (value & 0x10) === 0;
  }

  readP1(): number {
    let result = 0xc0;
    if (this.selectButtons) result &= ~0x20;
    else result |= 0x20;
    if (this.selectDpad) result &= ~0x10;
    else result |= 0x10;

    let low = 0x0f;
    if (this.selectDpad) low &= this.buttons & 0x0f;
    if (this.selectButtons) low &= (this.buttons >> 4) & 0x0f;
    return result | low;
  }

  exportState(): Record<string, number | boolean> {
    return {
      selectButtons: this.selectButtons,
      selectDpad: this.selectDpad,
    };
  }

  importState(state: Record<string, number | boolean>): void {
    this.selectButtons = Boolean(state.selectButtons);
    this.selectDpad = Boolean(state.selectDpad);
    // Keep live keyboard state; don't restore held buttons from the snapshot
  }
}

function buttonBit(button: Button): number {
  switch (button) {
    case "right": return 0x01;
    case "left": return 0x02;
    case "up": return 0x04;
    case "down": return 0x08;
    case "a": return 0x10;
    case "b": return 0x20;
    case "select": return 0x40;
    case "start": return 0x80;
  }
}
