/** Shared labels for the desktop global bar and per-session mobile settings. */
export interface LinkUiState {
  dual: boolean;
  linked: boolean;
  linkLabel: string;
  linkHint: string;
}

const CONNECT = "Connect link cable";
const DISCONNECT = "Disconnect link cable";

export function buildLinkUiState(opts: {
  dual: boolean;
  linked: boolean;
  /** Overrides the disconnected hint (e.g. missing ROMs). */
  errorHint?: string;
}): LinkUiState {
  if (!opts.dual) {
    return { dual: false, linked: false, linkLabel: CONNECT, linkHint: "" };
  }
  if (opts.errorHint) {
    return { dual: true, linked: false, linkLabel: CONNECT, linkHint: opts.errorHint };
  }
  if (opts.linked) {
    return {
      dual: true,
      linked: true,
      linkLabel: DISCONNECT,
      linkHint: "Link cable connected — trading enabled (lockstep 1×)",
    };
  }
  return {
    dual: true,
    linked: false,
    linkLabel: CONNECT,
    linkHint: "Link cable disconnected",
  };
}
