export const SCREEN_WIDTH = 160;
export const SCREEN_HEIGHT = 144;
export const CYCLES_PER_FRAME = 70224;
export const CPU_HZ = 4194304;
/** Real-time length of one GB frame in milliseconds (~59.727 Hz). */
export const FRAME_DURATION_MS = (CYCLES_PER_FRAME / CPU_HZ) * 1000;

export type DmgPaletteId = "green" | "gray" | "pocket" | "brown";

export const DMG_PALETTE_IDS: DmgPaletteId[] = ["green", "gray", "pocket", "brown"];

export const DMG_PALETTE_LABELS: Record<DmgPaletteId, string> = {
  green: "Green LCD",
  gray: "Grayscale",
  pocket: "Pocket",
  brown: "Brown",
};

export const IF_VBLANK = 0x01;
export const IF_LCD = 0x02;
export const IF_TIMER = 0x04;
export const IF_SERIAL = 0x08;
export const IF_JOYPAD = 0x10;

export type Button =
  | "right"
  | "left"
  | "up"
  | "down"
  | "a"
  | "b"
  | "select"
  | "start";

export interface CartridgeHeader {
  title: string;
  cartridgeType: number;
  romSize: number;
  ramSize: number;
  cgbFlag: number;
  checksum: number;
}

export interface SaveState {
  sram: Uint8Array;
  rtc?: {
    seconds: number;
    minutes: number;
    hours: number;
    days: number;
    halt: boolean;
    dayCarry: boolean;
    latch: number;
    baseTimestamp: number;
  };
}

/** Full emulator snapshot (distinct from cartridge battery SaveState). */
export interface EmulatorSavestate {
  version: 1;
  title: string;
  checksum: number;
  createdAt: number;
  cpu: Record<string, number | boolean>;
  mmu: Record<string, number | boolean | string>;
  ppu: Record<string, number | boolean | string>;
  apu: Record<string, number | boolean | string>;
  timer: Record<string, number>;
  joypad: Record<string, number | boolean>;
  cart: Record<string, number | boolean | string | null>;
}

