/** APU always emits PCM at this rate (see `Apu` constructor). */
const APU_SAMPLE_RATE = 44100;

/**
 * Streams emulator PCM into Web Audio.
 *
 * Normal turbo: playbackRate = emu speed (classic chipmunk).
 *
 * Keep-pitch (experimental hack): play queued PCM at 1× so turbo doesn't
 * pitch-shift the music. Lag is expected. Soft-snaps to live on a timer,
 * and optionally when the stream goes quiet (experimental quiet catch-up).
 */
export class AudioOutput {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private nextTime = 0;
  private userMuted = false;
  private focusMuted = false;
  private volume = 0.35;

  /** Interleaved stereo chunks at APU rate (oldest chunk first). */
  private chunks: Float32Array[] = [];
  private chunkOffset = 0;
  /** Total interleaved samples waiting (L+R counts as 2). */
  private pendingSamples = 0;
  /** True = discard inbound audio until we drain below PENDING_RESUME. */
  private rejecting = false;

  private keepPitchActive = false;
  private keepPitchNext = 0;
  private keepPitchSources: AudioBufferSourceNode[] = [];
  private keepPitchGain: GainNode | null = null;
  /** performance.now() when we last snapped to live (or entered the mode). */
  private lastCatchUpWall = 0;
  private catchUpArmed = false;
  private catchUpAt = 0;
  private quietCatchUp = false;
  /** performance.now() when the inbound stream went quiet, or 0. */
  private quietSince = 0;

  private turboSources: AudioBufferSourceNode[] = [];

  private static readonly MIN_LEAD = 0.03;
  private static readonly TURBO_MAX_LEAD = 0.25;
  private static readonly KEEP_LEAD = 0.12;
  /** Soft safety cap while waiting for the periodic catch-up. */
  private static readonly PENDING_MAX = Math.floor(APU_SAMPLE_RATE * 45) * 2;
  private static readonly PENDING_RESUME = Math.floor(APU_SAMPLE_RATE * 8) * 2;
  /** Wall-clock interval between snap-to-live catch-ups. */
  private static readonly CATCH_UP_EVERY_MS = 60_000;
  private static readonly QUIET_RMS = 0.012;
  private static readonly QUIET_HOLD_MS = 180;
  private static readonly QUIET_MIN_LAG = Math.floor(APU_SAMPLE_RATE * 0.5) * 2;
  private static readonly FADE_OUT = 0.05;
  private static readonly FADE_IN = 0.06;
  private static readonly CHUNK_FRAMES = 2048;

  async resume(): Promise<void> {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: APU_SAMPLE_RATE });
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.volume;
      this.masterGain.connect(this.ctx.destination);
      this.nextTime = this.ctx.currentTime + AudioOutput.MIN_LEAD;
      this.keepPitchNext = this.ctx.currentTime + AudioOutput.MIN_LEAD;
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  async suspend(): Promise<void> {
    this.catchUpArmed = false;
    this.quietSince = 0;
    this.stopKeepPitch(true);
    this.stopTurboSources();
    this.clearPending();
    if (this.ctx?.state === "running") await this.ctx.suspend();
  }

  setMuted(muted: boolean): void {
    this.userMuted = muted;
  }

  /** Silence when another game tab is focused (mobile dual-session). */
  setFocusMuted(muted: boolean): void {
    this.focusMuted = muted;
  }

  private get muted(): boolean {
    return this.userMuted || this.focusMuted;
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.masterGain) {
      this.masterGain.gain.value = this.volume;
    }
  }

  getVolume(): number {
    return this.volume;
  }

  setQuietCatchUp(enabled: boolean): void {
    this.quietCatchUp = enabled;
    if (!enabled) this.quietSince = 0;
  }

  resetKeepPitchQueue(): void {
    this.clearPending();
    this.stopKeepPitch(false);
    this.resetCatchUpTimer();
    this.resetKeepGain();
    this.quietSince = 0;
  }

  pushSamples(
    interleaved: Float32Array,
    playbackSpeed = 1,
    keepPitch = false,
  ): void {
    if (!this.ctx || this.muted || interleaved.length < 2) return;

    if (keepPitch) {
      this.enterKeepPitch();
      this.trackQuiet(interleaved);
      this.maybeArmQuietCatchUp();
      this.maybeArmTimedCatchUp();
      this.finishCatchUpIfDue();
      this.enqueueKeepPitch(interleaved);
      this.flushKeepPitch();
      return;
    }

    this.leaveKeepPitch();
    this.scheduleTurbo(interleaved, Math.max(1, playbackSpeed));
  }

  private ensureMaster(): GainNode {
    if (!this.ctx) throw new Error("AudioContext missing");
    if (!this.masterGain) {
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.volume;
      this.masterGain.connect(this.ctx.destination);
    }
    return this.masterGain;
  }

  private enterKeepPitch(): void {
    if (!this.ctx || this.keepPitchActive) return;
    this.stopTurboSources();
    this.clearPending();
    this.resetCatchUpTimer();
    this.quietSince = 0;
    const master = this.ensureMaster();
    if (!this.keepPitchGain) {
      this.keepPitchGain = this.ctx.createGain();
      this.keepPitchGain.gain.value = 1;
      this.keepPitchGain.connect(master);
    }
    this.keepPitchNext = this.ctx.currentTime + AudioOutput.MIN_LEAD;
    this.keepPitchActive = true;
  }

  private leaveKeepPitch(): void {
    if (!this.keepPitchActive) return;
    this.keepPitchActive = false;
    this.catchUpArmed = false;
    this.quietSince = 0;
    this.clearPending();
    this.stopKeepPitch(true);
    if (this.ctx) this.nextTime = this.ctx.currentTime + AudioOutput.MIN_LEAD;
  }

  private resetCatchUpTimer(): void {
    this.lastCatchUpWall = performance.now();
    this.catchUpArmed = false;
    this.catchUpAt = 0;
  }

  private resetKeepGain(): void {
    if (!this.ctx || !this.keepPitchGain) return;
    const g = this.keepPitchGain.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(1, now);
  }

  private trackQuiet(interleaved: Float32Array): void {
    let sum = 0;
    for (let i = 0; i < interleaved.length; i++) {
      const s = interleaved[i]!;
      sum += s * s;
    }
    const rms = Math.sqrt(sum / interleaved.length);
    if (rms < AudioOutput.QUIET_RMS) {
      if (this.quietSince === 0) this.quietSince = performance.now();
    } else {
      this.quietSince = 0;
    }
  }

  private maybeArmQuietCatchUp(): void {
    if (!this.quietCatchUp || this.catchUpArmed) return;
    if (this.quietSince === 0) return;
    if (performance.now() - this.quietSince < AudioOutput.QUIET_HOLD_MS) return;
    if (this.pendingSamples < AudioOutput.QUIET_MIN_LAG) return;
    this.armCatchUpFade();
  }

  /** Once a minute, fade out and drop the lag queue so audio resyncs. */
  private maybeArmTimedCatchUp(): void {
    if (this.catchUpArmed) return;
    if (performance.now() - this.lastCatchUpWall < AudioOutput.CATCH_UP_EVERY_MS) return;
    if (this.pendingSamples < APU_SAMPLE_RATE * 0.25 * 2) {
      this.lastCatchUpWall = performance.now();
      return;
    }
    this.armCatchUpFade();
  }

  private armCatchUpFade(): void {
    if (!this.ctx || !this.keepPitchGain || this.catchUpArmed) return;
    const now = this.ctx.currentTime;
    const g = this.keepPitchGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(g.value, 0.0001), now);
    g.linearRampToValueAtTime(0.0001, now + AudioOutput.FADE_OUT);
    this.catchUpAt = now + AudioOutput.FADE_OUT;
    this.catchUpArmed = true;
  }

  private finishCatchUpIfDue(): void {
    if (!this.catchUpArmed || !this.ctx || !this.keepPitchGain) return;
    if (this.ctx.currentTime < this.catchUpAt) return;

    this.clearPending();
    this.stopKeepPitch(false);
    this.quietSince = 0;

    const now = this.ctx.currentTime;
    const g = this.keepPitchGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0.0001, now);
    g.linearRampToValueAtTime(1, now + AudioOutput.FADE_IN);

    this.catchUpArmed = false;
    this.lastCatchUpWall = performance.now();
  }

  private clearPending(): void {
    this.chunks = [];
    this.chunkOffset = 0;
    this.pendingSamples = 0;
    this.rejecting = false;
  }

  private enqueueKeepPitch(interleaved: Float32Array): void {
    if (this.rejecting) {
      if (this.pendingSamples <= AudioOutput.PENDING_RESUME) {
        this.rejecting = false;
      } else {
        return;
      }
    }

    if (this.pendingSamples + interleaved.length > AudioOutput.PENDING_MAX) {
      this.rejecting = true;
      return;
    }

    this.chunks.push(Float32Array.from(interleaved));
    this.pendingSamples += interleaved.length;
  }

  private takePending(out: Float32Array): boolean {
    const need = out.length;
    if (this.pendingSamples < need) return false;

    let written = 0;
    while (written < need) {
      const head = this.chunks[0];
      if (!head) return false;
      const available = head.length - this.chunkOffset;
      const copy = Math.min(available, need - written);
      out.set(head.subarray(this.chunkOffset, this.chunkOffset + copy), written);
      written += copy;
      this.chunkOffset += copy;
      this.pendingSamples -= copy;
      if (this.chunkOffset >= head.length) {
        this.chunks.shift();
        this.chunkOffset = 0;
      }
    }
    return true;
  }

  private flushKeepPitch(): void {
    if (!this.ctx || !this.keepPitchActive || this.muted) return;
    if (this.turboSources.length > 0) this.stopTurboSources();
    if (this.catchUpArmed) return;

    const now = this.ctx.currentTime;

    if (this.keepPitchNext < now) {
      this.stopKeepPitch(false);
      this.keepPitchNext = now + AudioOutput.MIN_LEAD;
    }

    const need = AudioOutput.CHUNK_FRAMES * 2;
    const frames = AudioOutput.CHUNK_FRAMES;
    const gain = this.keepPitchGain ?? this.ensureMaster();
    const latestStart = now + AudioOutput.KEEP_LEAD;
    const scratch = new Float32Array(need);

    while (this.pendingSamples >= need && this.keepPitchNext < latestStart) {
      if (this.keepPitchNext < now) {
        this.stopKeepPitch(false);
        this.keepPitchNext = now + AudioOutput.MIN_LEAD;
      }
      if (!this.takePending(scratch)) break;

      const buffer = this.ctx.createBuffer(2, frames, APU_SAMPLE_RATE);
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      for (let i = 0; i < frames; i++) {
        left[i] = scratch[i * 2]!;
        right[i] = scratch[i * 2 + 1]!;
      }

      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = 1;
      src.connect(gain);
      src.onended = () => {
        const idx = this.keepPitchSources.indexOf(src);
        if (idx >= 0) this.keepPitchSources.splice(idx, 1);
      };
      this.keepPitchSources.push(src);

      try {
        src.start(this.keepPitchNext);
      } catch {
        this.keepPitchSources.pop();
        break;
      }
      this.keepPitchNext += buffer.duration;
    }
  }

  private scheduleTurbo(interleaved: Float32Array, rate: number): void {
    if (!this.ctx) return;
    const frames = interleaved.length >> 1;
    if (frames === 0) return;

    const now = this.ctx.currentTime;
    if (this.nextTime < now + AudioOutput.MIN_LEAD) {
      this.nextTime = now + AudioOutput.MIN_LEAD;
    }
    if (this.nextTime > now + AudioOutput.TURBO_MAX_LEAD) {
      this.stopTurboSources();
      this.nextTime = now + AudioOutput.MIN_LEAD;
    }

    const buffer = this.ctx.createBuffer(2, frames, APU_SAMPLE_RATE);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < frames; i++) {
      left[i] = interleaved[i * 2]!;
      right[i] = interleaved[i * 2 + 1]!;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(this.ensureMaster());
    src.onended = () => {
      const idx = this.turboSources.indexOf(src);
      if (idx >= 0) this.turboSources.splice(idx, 1);
    };
    this.turboSources.push(src);
    src.start(this.nextTime);
    this.nextTime += buffer.duration / rate;
  }

  private stopTurboSources(): void {
    for (const src of this.turboSources) {
      try {
        src.onended = null;
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.turboSources = [];
  }

  private stopKeepPitch(disconnectGain: boolean): void {
    for (const src of this.keepPitchSources) {
      try {
        src.onended = null;
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.keepPitchSources = [];
    if (this.ctx) {
      this.keepPitchNext = this.ctx.currentTime + AudioOutput.MIN_LEAD;
    }
    if (disconnectGain && this.keepPitchGain) {
      try {
        this.keepPitchGain.disconnect();
      } catch {
        /* already disconnected */
      }
      this.keepPitchGain = null;
    }
  }

  async close(): Promise<void> {
    this.keepPitchActive = false;
    this.stopKeepPitch(true);
    this.stopTurboSources();
    this.clearPending();
    if (this.masterGain) {
      try {
        this.masterGain.disconnect();
      } catch {
        /* already disconnected */
      }
      this.masterGain = null;
    }
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
    }
  }
}
