/** Streams emulator PCM into Web Audio. Call resume() from a user gesture. */
export class AudioOutput {
  private ctx: AudioContext | null = null;
  private nextTime = 0;
  private muted = false;
  private volume = 0.35;

  async resume(): Promise<void> {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: 44100 });
      this.nextTime = this.ctx.currentTime;
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /**
   * Push interleaved stereo float samples [-1, 1].
   * `playbackSpeed` compresses the buffer in wall-clock time so turbo stays in sync
   * (pitch rises with speed, same as classic emulators).
   */
  pushSamples(interleaved: Float32Array, playbackSpeed = 1): void {
    if (!this.ctx || this.muted || interleaved.length < 2) return;
    const frames = interleaved.length >> 1;
    if (frames === 0) return;

    const rate = Math.max(1, playbackSpeed);
    const buffer = this.ctx.createBuffer(2, frames, this.ctx.sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < frames; i++) {
      left[i] = interleaved[i * 2]! * this.volume;
      right[i] = interleaved[i * 2 + 1]! * this.volume;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(this.ctx.destination);

    const now = this.ctx.currentTime;
    // Keep a small lead, but don't let the queue balloon
    if (this.nextTime < now + 0.05) this.nextTime = now + 0.05;
    if (this.nextTime > now + 0.25) {
      // Drop backlog so turbo changes feel immediate
      this.nextTime = now + 0.05;
    }
    src.start(this.nextTime);
    this.nextTime += buffer.duration / rate;
  }

  async close(): Promise<void> {
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
    }
  }
}
