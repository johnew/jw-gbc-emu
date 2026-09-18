import { EmulatorSession } from "./session";
import { FRAME_DURATION_MS } from "../core/types";

export function mountApp(root: HTMLElement): void {
  root.innerHTML = `
    <div class="shell">
      <header class="top">
        <h1>Game Boy Color</h1>
        <p class="tagline">Load your own Pokémon Red, Blue, or Crystal ROM</p>
      </header>

      <div class="global-bar">
        <button type="button" id="add-instance">Add second game</button>
        <button type="button" id="remove-instance" hidden>Close second game</button>
        <button type="button" id="link-cable" hidden>Connect link cable</button>
        <span class="link-status" id="link-status" hidden></span>
        <span class="global-hint" id="global-hint">Click a screen to send keyboard controls there.</span>
      </div>

      <div class="sessions" id="sessions"></div>

      <aside class="help">
        <h2>Controls</h2>
        <ul>
          <li>Click a game panel to focus it — keys only go to the focused game</li>
          <li><kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> or <kbd>WASD</kbd> — D-pad</li>
          <li><kbd>Z</kbd> / <kbd>K</kbd> — A &nbsp; <kbd>X</kbd> / <kbd>J</kbd> — B</li>
          <li><kbd>Enter</kbd> — Start &nbsp; <kbd>Shift</kbd> — Select</li>
          <li><kbd>F5</kbd> / <kbd>F7</kbd> — save / load state &nbsp; <kbd>1</kbd>–<kbd>9</kbd> — slot</li>
          <li><kbd>Tab</kbd> speed · <kbd>P</kbd> shades · <kbd>F</kbd> fullscreen · <kbd>M</kbd> mute</li>
          <li><strong>Options</strong> — download / import battery saves and savestates</li>
          <li><strong>Link cable</strong> — with two games open, connect to trade (Pokémon Red/Blue Cable Club)</li>
        </ul>
        <p class="legal">Provide legally obtained ROMs only. Nothing is bundled with this app. Battery saves and savestates are stored in this browser (and can be exported from Options). Link trading works best at 1× with both players in the Pokémon Center Cable Club.</p>
      </aside>
    </div>
  `;

  const sessionsHost = root.querySelector<HTMLElement>("#sessions")!;
  const addBtn = root.querySelector<HTMLButtonElement>("#add-instance")!;
  const removeBtn = root.querySelector<HTMLButtonElement>("#remove-instance")!;
  const linkBtn = root.querySelector<HTMLButtonElement>("#link-cable")!;
  const linkStatus = root.querySelector<HTMLElement>("#link-status")!;
  const hint = root.querySelector<HTMLElement>("#global-hint")!;
  const shell = root.querySelector<HTMLElement>(".shell")!;

  const sessions: EmulatorSession[] = [];
  let focused: EmulatorSession | null = null;
  let linked = false;
  let linkAcc = 0;
  let lastTs = performance.now();

  function setFocus(session: EmulatorSession): void {
    focused = session;
    for (const s of sessions) s.setFocused(s === session);
    hint.textContent = `Controlling: ${session.emu.title || `Game ${session.id}`}`;
  }

  function syncLinkUi(): void {
    const dual = sessions.length >= 2;
    linkBtn.hidden = !dual;
    linkStatus.hidden = !dual;
    if (!dual) {
      linked = false;
      linkBtn.textContent = "Connect link cable";
      linkStatus.textContent = "";
      linkStatus.classList.remove("on");
      return;
    }
    if (linked) {
      linkBtn.textContent = "Disconnect link cable";
      linkStatus.textContent = "Link cable connected — trading enabled (lockstep 1×)";
      linkStatus.classList.add("on");
    } else {
      linkBtn.textContent = "Connect link cable";
      linkStatus.textContent = "Link cable disconnected";
      linkStatus.classList.remove("on");
    }
  }

  function syncLayout(): void {
    shell.classList.toggle("dual", sessions.length > 1);
    addBtn.hidden = sessions.length >= 2;
    removeBtn.hidden = sessions.length < 2;
    syncLinkUi();
  }

  function disconnectLink(): void {
    if (!linked) return;
    for (const s of sessions) s.emu.unlink();
    linked = false;
    linkAcc = 0;
    syncLinkUi();
  }

  function connectLink(): void {
    if (sessions.length < 2) return;
    const a = sessions[0]!;
    const b = sessions[1]!;
    if (!a.hasRom || !b.hasRom) {
      linkStatus.hidden = false;
      linkStatus.textContent = "Load a ROM in both games before connecting the link cable";
      linkStatus.classList.remove("on");
      return;
    }
    a.emu.linkWith(b.emu);
    a.refreshSpeedButton();
    b.refreshSpeedButton();
    const now = performance.now();
    a.syncClock(now);
    b.syncClock(now);
    linkAcc = 0;
    linked = true;
    syncLinkUi();
  }

  function addSession(label: string): EmulatorSession {
    const session = new EmulatorSession(sessionsHost, label, {
      onFocus: setFocus,
      onStatus: () => {
        /* status lives on the session panel */
      },
    });
    sessions.push(session);
    setFocus(session);
    syncLayout();
    return session;
  }

  function removeSecond(): void {
    if (sessions.length < 2) return;
    disconnectLink();
    const second = sessions.pop()!;
    if (focused === second) setFocus(sessions[0]!);
    second.destroy();
    syncLayout();
  }

  addSession("Game 1");

  addBtn.addEventListener("click", () => {
    if (sessions.length >= 2) return;
    addSession("Game 2");
  });
  removeBtn.addEventListener("click", removeSecond);

  linkBtn.addEventListener("click", () => {
    if (linked) disconnectLink();
    else connectLink();
  });

  function loop(now: number): void {
    const dt = Math.min(now - lastTs, 50);
    lastTs = now;

    if (linked && sessions.length === 2) {
      // Lockstep: both machines advance the same emulated time (required for stable trades)
      linkAcc += dt;
      let frames = 0;
      while (linkAcc >= FRAME_DURATION_MS && frames < 6) {
        linkAcc -= FRAME_DURATION_MS;
        sessions[0]!.lockstepFrame();
        sessions[1]!.lockstepFrame();
        frames++;
      }
      if (linkAcc > FRAME_DURATION_MS * 2) linkAcc = 0;
    } else {
      for (const s of sessions) s.tick(now);
    }

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  window.addEventListener("keydown", (e) => {
    if (!focused) return;
    focused.handleKeyDown(e);
  });
  window.addEventListener("keyup", (e) => {
    if (!focused) return;
    focused.handleKeyUp(e);
  });

  window.addEventListener("beforeunload", () => {
    disconnectLink();
    for (const s of sessions) s.flushSave();
  });
}
