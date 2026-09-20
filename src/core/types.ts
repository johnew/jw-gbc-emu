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

/** RGBA little-endian for ImageData / canvas preview. */
export const DMG_PALETTE_COLORS: Record<
  DmgPaletteId,
  readonly [number, number, number, number]
> = {
  green: [0xff0fbc9b, 0xff0fac8b, 0xff306230, 0xff0f380f],
  gray: [0xffffffff, 0xffaaaaaa, 0xff555555, 0xff000000],
  pocket: [0xff6fbfa4, 0xff4f8f74, 0xff2f5f44, 0xff0f2f14],
  brown: [0xff8cbcf8, 0xff548ce0, 0xff304890, 0xff101820],
};

export function dmgLightColor(id: DmgPaletteId): number {
  return DMG_PALETTE_COLORS[id][0]!;
}

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

