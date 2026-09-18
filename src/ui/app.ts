import { EmulatorSession } from "./session";
import { isMobileLayout, takeFrameBudget } from "./layout";

export function mountApp(root: HTMLElement): void {
  const mobile = isMobileLayout();

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
        <span class="global-hint" id="global-hint">${
          mobile
            ? "Use on-screen buttons to play. With two games, switch tabs above the screen."
            : "Tap a screen to control it. On phones, use the on-screen buttons."
        }</span>
      </div>

      <div class="session-tabs" id="session-tabs" hidden role="tablist" aria-label="Games">
        <button type="button" class="session-tab" role="tab" data-index="0" aria-selected="true">Game 1</button>
        <button type="button" class="session-tab" role="tab" data-index="1" aria-selected="false" hidden>Game 2</button>
      </div>

      <div class="sessions" id="sessions"></div>

      <aside class="help">
        <h2>Controls</h2>
        <ul>
          <li><strong>Mobile:</strong> on-screen D-pad, A/B, Start/Select · with two games, use the <strong>Game 1 / Game 2</strong> tabs to switch</li>
          <li>Tap/click a game panel to focus it (desktop dual view)</li>
          <li><kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> or <kbd>WASD</kbd> — D-pad</li>
          <li><kbd>Z</kbd> / <kbd>K</kbd> — A &nbsp; <kbd>X</kbd> / <kbd>J</kbd> — B</li>
          <li><kbd>Enter</kbd> — Start &nbsp; <kbd>Shift</kbd> — Select</li>
          <li><kbd>F5</kbd> / <kbd>F7</kbd> — save / load state &nbsp; <kbd>1</kbd>–<kbd>9</kbd> — slot</li>
          <li><kbd>Tab</kbd> speed · <kbd>P</kbd> shades · <kbd>F</kbd> fullscreen (desktop) · <kbd>M</kbd> mute</li>
          <li><strong>Options</strong> — download / import battery saves and savestates</li>
          <li><strong>Link cable</strong> — connect both games to trade (works with mobile tabs)</li>
        </ul>
        <p class="legal">Provide legally obtained ROMs only. Nothing is bundled with this app. Battery saves and savestates are stored in this browser (and can be exported from Options). Link trading works best at 1× with both players in the Pokémon Center Cable Club.</p>
      </aside>
    </div>
  `;

  const sessionsHost = root.querySelector<HTMLElement>("#sessions")!;
  const tabsBar = root.querySelector<HTMLElement>("#session-tabs")!;
  const tabButtons = [
    root.querySelector<HTMLButtonElement>('.session-tab[data-index="0"]')!,
    root.querySelector<HTMLButtonElement>('.session-tab[data-index="1"]')!,
  ];
  const addBtn = root.querySelector<HTMLButtonElement>("#add-instance")!;
  const removeBtn = root.querySelector<HTMLButtonElement>("#remove-instance")!;
  const linkBtn = root.querySelector<HTMLButtonElement>("#link-cable")!;
  const linkStatus = root.querySelector<HTMLElement>("#link-status")!;
  const hint = root.querySelector<HTMLElement>("#global-hint")!;
  const shell = root.querySelector<HTMLElement>(".shell")!;

  const sessions: EmulatorSession[] = [];
  let focused: EmulatorSession | null = null;
  let activeTab = 0;
  let linked = false;
  let linkAcc = 0;
  let lastTs = performance.now();

  const isDual = () => sessions.length === 2;

  function updateHint(session: EmulatorSession): void {
    hint.textContent = `Controlling: ${session.emu.title || `Game ${session.id}`}`;
  }

  function setFocus(session: EmulatorSession): void {
    focused = session;
    for (const s of sessions) s.setFocused(s === session);
    updateHint(session);
  }

  function showTab(index: number): void {
    if (index < 0 || index >= sessions.length) return;
    activeTab = index;
    const useTabs = mobile && isDual();
    for (let i = 0; i < sessions.length; i++) {
      const on = i === index;
      const el = sessions[i]!.root;
      el.hidden = useTabs && !on;
      el.classList.toggle("tab-hidden", useTabs && !on);
      tabButtons[i]!.setAttribute("aria-selected", on ? "true" : "false");
      tabButtons[i]!.classList.toggle("active", on);
    }
    setFocus(sessions[index]!);
  }

  function focusSession(session: EmulatorSession): void {
    const idx = sessions.indexOf(session);
    if (mobile && isDual() && idx >= 0) showTab(idx);
    else setFocus(session);
  }

  function syncLinkUi(): void {
    const dual = isDual();
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

  function refreshTabLabels(): void {
    for (let i = 0; i < sessions.length; i++) {
      tabButtons[i]!.textContent = sessions[i]!.emu.title || `Game ${i + 1}`;
      tabButtons[i]!.hidden = false;
    }
  }

  function syncLayout(): void {
    const dual = isDual();
    shell.classList.toggle("dual", !mobile && dual);
    shell.classList.toggle("mobile-tabs", mobile && dual);
    tabsBar.hidden = !(mobile && dual);
    tabButtons[1]!.hidden = !dual;
    addBtn.hidden = dual;
    removeBtn.hidden = !dual;
    refreshTabLabels();

    if (!dual) {
      for (const s of sessions) {
        s.root.hidden = false;
        s.root.classList.remove("tab-hidden");
      }
      activeTab = 0;
    } else if (mobile) {
      showTab(Math.min(activeTab, sessions.length - 1));
    }

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
    if (!isDual()) return;
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
      onFocus: focusSession,
      onStatus: refreshTabLabels,
    });
    sessions.push(session);
    if (mobile && isDual()) showTab(sessions.length - 1);
    else setFocus(session);
    syncLayout();
    return session;
  }

  function removeSecond(): void {
    if (!isDual()) return;
    disconnectLink();
    sessions.pop()!.destroy();
    activeTab = 0;
    setFocus(sessions[0]!);
    syncLayout();
  }

  addSession("Game 1");

  for (const btn of tabButtons) {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.index);
      if (Number.isFinite(idx)) showTab(idx);
    });
  }

  addBtn.addEventListener("click", () => {
    if (!isDual()) addSession("Game 2");
  });
  removeBtn.addEventListener("click", removeSecond);
  linkBtn.addEventListener("click", () => {
    if (linked) disconnectLink();
    else connectLink();
  });

  function loop(now: number): void {
    const dt = now - lastTs;
    lastTs = now;

    if (linked && isDual()) {
      const paced = takeFrameBudget(linkAcc, dt, 1);
      linkAcc = paced.accumulatorMs;
      for (let i = 0; i < paced.frames; i++) {
        sessions[0]!.lockstepFrame();
        sessions[1]!.lockstepFrame();
      }
    } else {
      for (const s of sessions) s.tick(now);
    }

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  window.addEventListener("keydown", (e) => focused?.handleKeyDown(e));
  window.addEventListener("keyup", (e) => focused?.handleKeyUp(e));
  window.addEventListener("beforeunload", () => {
    disconnectLink();
    for (const s of sessions) s.flushSave();
  });
}
