/**
 * Game Boy serial port (SB/SC) and same-page link cable.
 *
 * Bit periods use *wall-clock* T-cycles (≈4.19 MHz), not CGB double-speed CPU
 * cycles — serial keeps running at normal speed in double-speed mode (Pan Docs).
 */

const CYCLES_PER_BIT_NORMAL = 512; // 8192 Hz
const CYCLES_PER_BIT_FAST = 16; // CGB SC.1 → ≈262144 Hz
const BITS_PER_TRANSFER = 8;

/** Connects two SerialPorts on the same page for trading. */
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

  private peerOf(port: SerialPort): SerialPort | null {
    if (port === this.left) return this.right;
    if (port === this.right) return this.left;
    return null;
  }

  peerReady(port: SerialPort): boolean {
    const peer = this.peerOf(port);
    return peer !== null && (peer.sc & 0x80) !== 0;
  }

  /** Master finished shifting: swap `sent` for peer's SB and clock the peer if ready. */
  exchange(port: SerialPort, sent: number): number {
    const peer = this.peerOf(port);
    if (!peer) return 0xff;
    const received = peer.sb;
    if ((peer.sc & 0x80) !== 0) {
      peer.acceptRemoteByte(sent);
    }
    return received;
  }
}

export class SerialPort {
  sb = 0xff;
  /** Raw SC; bit7 = transfer, bit0 = internal clock, bit1 = CGB fast. */
  sc = 0x7e;

  private transferring = false;
  private cyclesLeft = 0;
  private link: LinkCable | null = null;
  private requestInterrupt: (() => void) | null = null;

  setInterruptCallback(cb: () => void): void {
    this.requestInterrupt = cb;
  }

  attachLink(cable: LinkCable | null): void {
    this.link = cable;
    if (this.transferring) {
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
    return (this.sc & 0x83) | 0x7c;
  }

  writeSb(value: number): void {
    this.sb = value & 0xff;
  }

  writeSc(value: number): void {
    this.sc = value & 0xff;
    if (value & 0x80) {
      if (value & 0x01) this.beginMasterTransfer();
      else {
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

  step(wallCycles: number): void {
    if (!this.transferring || wallCycles <= 0) return;
    if ((this.sc & 0x01) === 0) return;

    if (this.link?.connected && !this.link.peerReady(this)) return;

    this.cyclesLeft -= wallCycles;
    if (this.cyclesLeft <= 0) this.completeMasterTransfer();
  }

  private completeMasterTransfer(): void {
    if (!this.link) {
      this.sb = 0xff;
    } else {
      this.sb = this.link.exchange(this, this.sb);
    }
    this.finishTransfer();
  }

  /** Peer clocks us as slave. */
  acceptRemoteByte(byte: number): void {
    this.sb = byte & 0xff;
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
