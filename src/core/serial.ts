import { IF_SERIAL } from "./types";

/** Cycles per bit at 8192 Hz internal clock (normal speed). */
const CYCLES_PER_BIT_NORMAL = 512;
/** CGB fast serial clock (SC bit1) ≈ 262144 Hz. */
const CYCLES_PER_BIT_FAST = 16;
const BITS_PER_TRANSFER = 8;

export class LinkCable {
  private left: SerialPort | null = null;
  private right: SerialPort | null = null;

  get connected(): boolean {
    return this.left !== null && this.right !== null;
  }

  connect(a: SerialPort, b: SerialPort): void {
    this.disconnect();
    this.left = a;
    this.right = b;
    a.attachLink(this);
    b.attachLink(this);
  }

  disconnect(): void {
    this.left?.attachLink(null);
    this.right?.attachLink(null);
    this.left = null;
    this.right = null;
  }

  peerOf(port: SerialPort): SerialPort | null {
    if (port === this.left) return this.right;
    if (port === this.right) return this.left;
    return null;
  }
}

/**
 * Game Boy serial port (SB/SC). When linked, the master's clock
 * exchanges a byte with the peer — enough for Pokémon Gen 1/2 trades.
 */
export class SerialPort {
  sb = 0xff;
  /** Raw SC; bit7 = transfer, bit0 = internal clock, bit1 = CGB fast. */
  sc = 0x7e;

  private transferring = false;
  private cyclesLeft = 0;
  private link: LinkCable | null = null;
  private requestInterrupt: (() => void) | null = null;
  /** When linked, master waits until peer also has a transfer pending (helps Pokémon). */
  syncWithPeer = true;

  setInterruptCallback(cb: () => void): void {
    this.requestInterrupt = cb;
  }

  attachLink(cable: LinkCable | null): void {
    this.link = cable;
    // Cancel in-flight transfer on unplug
    if (!cable && this.transferring) {
      this.transferring = false;
      this.cyclesLeft = 0;
      this.sc &= 0x7f;
    }
  }

  isLinked(): boolean {
    return this.link?.connected === true;
  }

  reset(): void {
    this.sb = 0xff;
    this.sc = 0x7e;
    this.transferring = false;
    this.cyclesLeft = 0;
  }

  readSb(): number {
    return this.sb;
  }

  readSc(): number {
    // Preserve bit0 (clock), bit1 (CGB speed), bit7 (transfer); unused bits read high
    return (this.sc & 0x83) | 0x7c;
  }

  writeSb(value: number): void {
    this.sb = value & 0xff;
  }

  writeSc(value: number): void {
    this.sc = value & 0xff;
    if (value & 0x80) {
      if (value & 0x01) {
        // Internal clock — this side is master
        this.beginMasterTransfer();
      } else {
        // External clock — wait for peer master to clock us
        this.transferring = true;
        this.cyclesLeft = 0;
      }
    } else {
      this.transferring = false;
      this.cyclesLeft = 0;
    }
  }

  private beginMasterTransfer(): void {
    this.transferring = true;
    const fast = (this.sc & 0x02) !== 0;
    const perBit = fast ? CYCLES_PER_BIT_FAST : CYCLES_PER_BIT_NORMAL;
    this.cyclesLeft = perBit * BITS_PER_TRANSFER;
  }

  /** Advance by CPU T-cycles. Only the master counts down. */
  step(cycles: number): void {
    if (!this.transferring) return;
    if ((this.sc & 0x01) === 0) return; // slave: wait for peer

    if (this.syncWithPeer && this.link?.connected) {
      const peer = this.link.peerOf(this);
      // Wait until peer has also requested a transfer (Pokémon handshake)
      if (peer && (peer.sc & 0x80) === 0) return;
    }

    this.cyclesLeft -= cycles;
    if (this.cyclesLeft <= 0) this.completeMasterTransfer();
  }

  private completeMasterTransfer(): void {
    const peer = this.link?.peerOf(this) ?? null;
    const sent = this.sb;
    let received = 0xff;

    if (peer) {
      received = peer.sb;
      // Clock the peer if it is waiting on an external transfer
      if ((peer.sc & 0x80) !== 0 && (peer.sc & 0x01) === 0) {
        peer.sb = sent;
        peer.finishTransfer();
      } else if ((peer.sc & 0x80) !== 0 && (peer.sc & 0x01) !== 0) {
        // Both think they're master — still exchange (rare)
        peer.sb = sent;
        peer.finishTransfer();
      }
    }

    this.sb = received;
    this.finishTransfer();
  }

  private finishTransfer(): void {
    this.transferring = false;
    this.cyclesLeft = 0;
    this.sc &= 0x7f;
    this.requestInterrupt?.();
  }

  exportState(): Record<string, number | boolean> {
    return {
      sb: this.sb,
      sc: this.sc,
      transferring: this.transferring,
      cyclesLeft: this.cyclesLeft,
    };
  }

  importState(state: Record<string, number | boolean>): void {
    this.sb = Number(state.sb) & 0xff;
    this.sc = Number(state.sc) & 0xff;
    this.transferring = Boolean(state.transferring);
    this.cyclesLeft = Number(state.cyclesLeft) || 0;
  }
}

export { IF_SERIAL };
