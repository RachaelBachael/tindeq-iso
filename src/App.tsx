import { useCallback, useEffect, useRef, useState } from "react";
import {
  TindeqProgressor,
  UserCancelledError,
  type ForceSample,
} from "./tindeq.ts";
import { playFinalBeep, playHoldBeep, unlockAudio } from "./sounds.ts";
import {
  EXERCISES,
  EXERCISE_NAMES,
  fetchState,
  flushPending,
  getConfig,
  logEntry,
  setEndpoint,
  type Exercise,
} from "./sheetLog.ts";

// A pull that reaches this fraction of the target and is let go without a
// completed hold counts as a failed rep.
const ATTEMPT_FRACTION = 0.5;
// Pause after a set's last rep before moving to the next exercise.
const ADVANCE_DELAY_MS = 2500;

type LogStatus =
  | { kind: "off" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "sending" }
  | { kind: "saved"; at: Date }
  | { kind: "error"; message: string };

const HOLD_SECONDS = 6;
const HOLD_MS = HOLD_SECONDS * 1000;
// Reps in a set; the round counter's colour tracks progress towards it.
const SET_REPS = 6;
// The load that counts as "the user is pulling". Doubles as the floor for the
// target weight: a mistyped target this low is exceeded by almost any resting
// load, which would drop the app straight into the hold view where the field is
// hidden and the target can no longer be corrected.
const MIN_TARGET_KG = 2;

type ConnState = "disconnected" | "connecting" | "connected";
type Phase = "idle" | "waiting" | "holding" | "success";

export function App() {
  const [connState, setConnState] = useState<ConnState>("disconnected");
  const [error, setError] = useState<string | null>(null);
  // The committed target, plus the raw field text. The two diverge while the
  // field holds a rejected value (empty or below MIN_TARGET_KG): the previous
  // target stays in force so a typo can't strand the app in the hold view.
  const [targetKg, setTargetKg] = useState(20);
  const [targetText, setTargetText] = useState("20");
  const [targetError, setTargetError] = useState<string | null>(null);

  // Live values are rendered from a requestAnimationFrame loop reading refs, so
  // the incoming stream of samples never floods React with state updates.
  const [force, setForce] = useState(0);
  const [remaining, setRemaining] = useState(HOLD_MS);
  const [restMs, setRestMs] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [successes, setSuccesses] = useState(0);
  const [failures, setFailures] = useState(0);

  // Session sequence and sheet logging.
  const [exerciseIdx, setExerciseIdx] = useState(0);
  const [weights, setWeights] = useState<Partial<Record<Exercise, number>>>({});
  const [logStatus, setLogStatus] = useState<LogStatus>(
    getConfig() ? { kind: "loading" } : { kind: "off" },
  );
  const exercise = EXERCISES[exerciseIdx];
  const [setupText, setSetupText] = useState("");
  const [configVersion, setConfigVersion] = useState(0);
  // Set while a pull has got close enough to count as an attempt; cleared on release.
  const attemptArmedRef = useRef(false);
  const attemptSucceededRef = useRef(false);

  // Mutable state read inside the BLE sample handler (which is registered once).
  const targetRef = useRef(targetKg);
  const holdStartRef = useRef<number | null>(null);
  // Timestamp of when the current rest period started, or null while a rep is
  // under way. Set when the detailed screen comes back; cleared when a rep
  // starts.
  const restStartRef = useRef<number | null>(null);
  // Index of the next per-second progress beep (0..5) to play in this hold.
  const nextBeepRef = useRef(0);
  const forceRef = useRef(0);
  const phaseRef = useRef<Phase>("idle");

  const deviceRef = useRef<TindeqProgressor | null>(null);
  const targetInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    targetRef.current = targetKg;
    // Changing the target weight starts a fresh set — reset the counters.
    setSuccesses(0);
    setFailures(0);
  }, [targetKg]);

  const onTargetChange = useCallback(
    (raw: string) => {
      setTargetText(raw);
      const value = Number(raw);
      if (
        raw.trim() === "" ||
        !Number.isFinite(value) ||
        value < MIN_TARGET_KG
      ) {
        setTargetError(
          `Target weight must be at least ${MIN_TARGET_KG} kg — still using ${targetKg} kg.`,
        );
        return;
      }
      setTargetError(null);
      setTargetKg(value);
    },
    [targetKg],
  );

  const setPhaseBoth = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const handleSample = useCallback(
    (sample: ForceSample) => {
      const f = sample.weight;
      forceRef.current = f;

      const phase = phaseRef.current;
      if (phase === "idle") return; // not connected / not measuring
      const target = targetRef.current;

      // Automatic failed-rep detection: a real pull that ends without a hold.
      if (f >= target * ATTEMPT_FRACTION && f > MIN_TARGET_KG) {
        attemptArmedRef.current = true;
      } else if (f < MIN_TARGET_KG && attemptArmedRef.current) {
        if (!attemptSucceededRef.current) setFailures((n) => n + 1);
        attemptArmedRef.current = false;
        attemptSucceededRef.current = false;
      }

      switch (phase) {
        case "waiting":
          // Below target, ready. Start the countdown once force reaches target.
          // The per-second progress beeps are fired from the render loop; arming
          // beep 0 here makes it sound the instant we cross the threshold.
          if (f >= target) {
            holdStartRef.current = performance.now();
            restStartRef.current = null; // rep started — stop the rest timer
            nextBeepRef.current = 0;
            setPhaseBoth("holding");
          }
          break;
        case "holding": {
          // Counting down — check for drop-out or completion.
          const heldMs =
            holdStartRef.current === null
              ? 0
              : performance.now() - holdStartRef.current;
          if (f < target) {
            holdStartRef.current = null;
            setPhaseBoth("waiting");
            // Beeps just stop — going silent is the out-of-range cue. If the
            // user lets go without re-reaching the target, it counts as failed.
          } else if (heldMs >= HOLD_MS) {
            holdStartRef.current = null;
            setPhaseBoth("success");
            playFinalBeep(); // the emphatic 7th beep
            attemptSucceededRef.current = true;
            setSuccesses((n) => n + 1);
          }
          break;
        }
        case "success":
          // Hold completed. Wait for a release below target before arming the
          // next rep, so a sustained pull doesn't immediately re-trigger.
          if (f < target) setPhaseBoth("waiting");
          break;
      }
    },
    [setPhaseBoth],
  );

  // Render loop for smooth live force + countdown.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setForce(forceRef.current);
      if (holdStartRef.current !== null) {
        const elapsed = performance.now() - holdStartRef.current;
        setRemaining(Math.max(0, HOLD_MS - elapsed));
        // Fire the per-second progress beeps (t = 0..5s) as their marks pass.
        // The t=6s beep is the emphatic final one, played on success instead.
        while (
          nextBeepRef.current < HOLD_SECONDS &&
          elapsed >= nextBeepRef.current * 1000
        ) {
          playHoldBeep(nextBeepRef.current);
          nextBeepRef.current += 1;
        }
      } else {
        if (phaseRef.current !== "success") setRemaining(HOLD_MS);
        // Below the threshold and resting: run the count-up rest timer.
        if (restStartRef.current !== null) {
          setRestMs(performance.now() - restStartRef.current);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Move to an exercise: its target comes from the sheet, counters restart.
  const goToExercise = useCallback(
    (idx: number, w: Partial<Record<Exercise, number>>) => {
      setExerciseIdx(idx);
      const kg = w[EXERCISES[idx]];
      if (kg !== undefined && kg >= MIN_TARGET_KG) {
        const rounded = Number(kg.toFixed(1));
        setTargetKg(rounded);
        setTargetText(String(rounded));
        setTargetError(null);
      }
      setSuccesses(0);
      setFailures(0);
      attemptArmedRef.current = false;
      attemptSucceededRef.current = false;
    },
    [],
  );

  // On load: read this session's targets from the sheet, and resume at the
  // first exercise not yet logged today.
  useEffect(() => {
    if (!getConfig()) return;
    void flushPending().catch(() => {});
    fetchState()
      .then((state) => {
        const w: Partial<Record<Exercise, number>> = {};
        for (const ex of EXERCISES) {
          const v = Number(state.weights[ex]);
          if (Number.isFinite(v) && v > 0) w[ex] = v;
        }
        setWeights(w);
        const next = EXERCISES.findIndex((ex) => state.reps[ex] === "");
        goToExercise(next === -1 ? 0 : next, w);
        setLogStatus({ kind: "ready" });
      })
      .catch((e) =>
        setLogStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
      );
  }, [goToExercise, configVersion]);

  // Log every rep as it happens, so a session cut short is still recorded.
  const attempts = successes + failures;
  useEffect(() => {
    if (!getConfig() || attempts === 0) return;
    setLogStatus({ kind: "sending" });
    logEntry({ exercise, weight: targetKg, successes, attempts })
      .then(() => setLogStatus({ kind: "saved", at: new Date() }))
      .catch((e) =>
        setLogStatus({
          kind: "error",
          message: `${e instanceof Error ? e.message : String(e)} — will retry`,
        }),
      );
    // Deliberately keyed on the counts only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [successes, failures]);

  const connected = connState === "connected";
  const inRange = force >= targetKg;
  // The distraction-free view takes over as soon as there is real load on the
  // device, not just during a qualifying hold: once the user is pulling they
  // can't read the detailed layout anyway, and seeing the big number while
  // still short of the target is what tells them how much harder to pull.
  const simplified = connected && force > MIN_TARGET_KG;

  // After the set's last rep, once the device is released, move on.
  useEffect(() => {
    if (attempts < SET_REPS || simplified) return;
    if (exerciseIdx >= EXERCISES.length - 1) return;
    const t = setTimeout(() => goToExercise(exerciseIdx + 1, weights), ADVANCE_DELAY_MS);
    return () => clearTimeout(t);
  }, [attempts, simplified, exerciseIdx, weights, goToExercise]);
  const sessionDone = attempts >= SET_REPS && exerciseIdx === EXERCISES.length - 1;

  // Focus the weight field with its contents selected, so the next digit typed
  // replaces the old target instead of being appended to it.
  const selectTarget = useCallback(() => {
    const input = targetInputRef.current;
    if (!input) return;
    // Don't pull focus away from the one-time setup field.
    if (document.activeElement?.closest(".setup")) return;
    input.focus();
    input.select();
  }, []);

  // Keep the weight field focused: on first load, and whenever we return to the
  // detailed view (e.g. force drops back below the threshold after a hold).
  const detailedView = !simplified;
  const detailedViewRef = useRef(detailedView);
  detailedViewRef.current = detailedView;
  useEffect(() => {
    if (detailedView) selectTarget();
  }, [detailedView, selectTarget]);

  // …and take it back if anything else steals it (clicking a button, or
  // returning to the tab). Bounced through a frame so the click that moved
  // focus is delivered to its target first.
  const refocusTarget = useCallback(() => {
    requestAnimationFrame(() => {
      if (detailedViewRef.current) selectTarget();
    });
  }, [selectTarget]);
  useEffect(() => {
    window.addEventListener("focus", refocusTarget);
    return () => window.removeEventListener("focus", refocusTarget);
  }, [refocusTarget]);

  // Rest is the gap between pulls, so it starts when the user lets go of the
  // device and this screen comes back — not when the force dips under the
  // target, which also happens mid-rep while they're still hanging on.
  useEffect(() => {
    if (connected && detailedView) restStartRef.current = performance.now();
  }, [connected, detailedView]);

  // Space logs a failed rep. Failures aren't auto-detected, so a mistimed or
  // aborted attempt is only recorded when the user presses Space.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        // Shift+Space corrects an over-count by decrementing (floored at 0).
        if (e.shiftKey) setFailures((n) => Math.max(0, n - 1));
        else setFailures((n) => n + 1);
      } else if (e.key === "Enter") {
        // Nothing to submit — Enter just re-arms the field for a new target.
        e.preventDefault();
        selectTarget();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectTarget]);

  const connect = useCallback(async () => {
    setError(null);
    await unlockAudio();
    const dev = new TindeqProgressor({
      onSample: handleSample,
      onDisconnect: () => {
        setConnState("disconnected");
        setPhaseBoth("idle");
        holdStartRef.current = null;
        restStartRef.current = null;
      },
    });
    deviceRef.current = dev;
    try {
      setConnState("connecting");
      await dev.connect();
      // Zero the scale on every connect; tare() also starts the measurement.
      await dev.tare();
      setConnState("connected");
      holdStartRef.current = null;
      setRestMs(0); // the effect above starts the clock for the first rep
      setPhaseBoth("waiting");
    } catch (e) {
      setConnState("disconnected");
      deviceRef.current = null;
      if (e instanceof UserCancelledError) {
        // User closed the device chooser — not really an error.
        return;
      }
      console.error("[tindeq] connect failed", e);
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }, [handleSample, setPhaseBoth]);

  const tare = useCallback(async () => {
    try {
      await deviceRef.current?.tare();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    return () => {
      void deviceRef.current?.disconnect();
    };
  }, []);

  // While pulling, show the distraction-free view: just the difference from the
  // target and the integer countdown, both large. The total weight stays
  // visible underneath in a smaller font. The difference is coloured by whether
  // the target is actually met, so a short pull reads as short at a glance.
  if (simplified) {
    const countdownSec =
      phase === "success" ? 0 : Math.max(0, Math.ceil(remaining / 1000));
    // Round before picking the sign, so a hair under the target reads "+0.0"
    // rather than "−0.0".
    const excess = Number((force - targetKg).toFixed(1));
    return (
      <div className={`app phase-${phase} simplified`}>
        <div className="big-readout">
          <div className="big-stack">
            <div className={`big-value ${inRange ? "force-good" : "force-bad"}`}>
              {excess < 0 ? "−" : "+"}
              {kg1(Math.abs(excess))}
              <span className="big-unit">kg</span>
            </div>
            <div className="big-subvalue">
              {kg1(force)}
              <span className="sub-unit">kg total</span>
            </div>
          </div>
          <div className="big-value">
            {countdownSec}
            <span className="big-unit">s</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`app phase-${phase}`}>
      {/* Deliberately only in the detailed view — the hold view stays bare. */}
      <a
        className="repo-link"
        href="https://github.com/malcolmredheron/tindeq-iso/"
        target="_blank"
        rel="noreferrer"
        title="Source on GitHub"
        aria-label="Source on GitHub"
      >
        <GitHubMark />
      </a>

      <h1>Tindeq Isometric Trainer</h1>

      <nav className="exercises">
        {EXERCISES.map((ex, i) => (
          <button
            key={ex}
            className={`exercise ${i === exerciseIdx ? "current" : ""}`}
            onClick={() => goToExercise(i, weights)}
          >
            {EXERCISE_NAMES[ex]}
          </button>
        ))}
      </nav>
      {sessionDone && <p className="done">Session complete. Nice work.</p>}

      {!TindeqProgressor.isSupported() && (
        <p className="warn">
          Web Bluetooth isn't available in this browser. Use Chrome, Edge, or
          another Chromium-based browser over https:// or localhost.
        </p>
      )}

      {targetError && <p className="warn">{targetError}</p>}

      {error && <p className="warn">{error}</p>}

      <section className="readout">
        {/* The weights, as one row of tiles matching the counters below. */}
        <div className="tiles">
          <label className="tile">
            <input
              ref={targetInputRef}
              type="number"
              min={MIN_TARGET_KG}
              step="any"
              autoFocus
              value={targetText}
              aria-invalid={targetError !== null}
              onChange={(e) => onTargetChange(e.target.value)}
              onBlur={refocusTarget}
            />
            <span className="label">target (kg)</span>
          </label>

          {/* Until the device is talking to us there is no weight to read, so
              connecting takes that slot. */}
          {connected ? (
            // Connecting tares, but the reading can drift or the device may
            // have been loaded then, so a click zeroes it again.
            <button
              className="tile"
              onClick={tare}
              title="Click to tare (reset to zero). Take the load off first."
            >
              <span className="value">{kg1(force)}</span>
              <span className="label">measured (kg)</span>
            </button>
          ) : (
            <button
              className="tile connect primary"
              onClick={connect}
              disabled={connState === "connecting"}
            >
              {connState === "connecting" ? "Connecting…" : "Connect Progressor"}
            </button>
          )}
        </div>

        <div className="tiles">
          {/* Orange once a rep has failed, red if the set has run its length
              with a failure in it, green for a clean full set, otherwise
              plain. */}
          <div
            className={`tile reps ${
              failures > 0
                ? successes + failures >= SET_REPS
                  ? "set-failed"
                  : "some-failed"
                : successes >= SET_REPS
                  ? "set-succeeded"
                  : ""
            }`}
          >
            <span className="value">
              {successes}/{successes + failures}
            </span>
            <span className="label">succeeded / total</span>
          </div>
          {/* Below the threshold: count up to track rest between reps. Whole
              seconds only — a M:SS clock reads as more precision than a rest
              gap needs, and the sibling counters are bare numbers. */}
          <div className="tile rest">
            <span className="value">{Math.floor(restMs / 1000)}</span>
            <span className="label">rest (s)</span>
          </div>
        </div>

        <p className="hint">
          Holds and failed pulls are counted automatically. <kbd>Space</kbd> adds a
          missed failure, <kbd>Shift</kbd>+<kbd>Space</kbd> removes one.
        </p>
        <p className={`hint log-${logStatus.kind}`}>{logText(logStatus)}</p>
        {logStatus.kind === "off" && (
          <form
            className="setup"
            onSubmit={(e) => {
              e.preventDefault();
              if (setEndpoint(setupText)) {
                setSetupText("");
                setError(null);
                setLogStatus({ kind: "loading" });
                setConfigVersion((v) => v + 1);
              } else {
                setError("That isn't an Apps Script web-app URL (…/macros/s/…/exec).");
              }
            }}
          >
            <input
              type="url"
              placeholder="Paste your sheet's web-app URL"
              value={setupText}
              onChange={(e) => setSetupText(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <button type="submit">Save</button>
          </form>
        )}
      </section>
    </div>
  );
}

function logText(s: LogStatus): string {
  switch (s.kind) {
    case "off":
      return "Sheet logging is not set up in this browser.";
    case "loading":
      return "Loading today's targets from your sheet…";
    case "ready":
      return "Targets loaded. Reps log to your sheet automatically.";
    case "sending":
      return "Saving to sheet…";
    case "saved":
      return `Saved to sheet at ${s.at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
    case "error":
      return `Sheet: ${s.message}`;
  }
}

/** The GitHub "Octocat" mark, from https://github.com/logos. */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="24" height="24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

/**
 * Format a weight to one decimal. A tiny negative reading — sensor noise around
 * zero, or an over-generous tare — would otherwise render as "-0.0"; collapse
 * that to "0.0".
 */
function kg1(kg: number): string {
  const rounded = Number(kg.toFixed(1));
  return (rounded === 0 ? 0 : rounded).toFixed(1);
}
