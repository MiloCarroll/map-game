// UI-agnostic game state machine. Knows nothing about MapLibre or the DOM — it
// takes a Mode + a target pool and answers "is this click correct?", tracking
// ordering, skipping, mistakes, the timer, and win/lose. The renderer (main.ts)
// drives it with guess()/skip()/tick() and reads snapshot().
import distance from "@turf/distance";
import pointToLineDistance from "@turf/point-to-line-distance";
import { point, lineString } from "@turf/helpers";
import type { Mode } from "./modes";

export interface Target {
  id: string;
  name: string;
  centroid: [number, number];
  regions: { continent: string; subregion: string; regionUN: string };
  status: { inDefaultQuiz: boolean; unrecognized?: boolean; capital?: boolean; popMax?: number };
  country?: string; // cities: the country the city is in
  radiusKm?: number; // per-target accept radius/tolerance (regions, features, line targets)
  line?: number[][][]; // rivers: MultiLineString coords — hit-tested by distance to the line
  category?: string | null; // features: peak / volcano / lake / ...
  desc?: string | null; // features: short factual blurb shown when found/revealed
  kind?: "country" | "city" | "region" | "feature";
}

export type Phase = "playing" | "won" | "lost";

export interface GameSnapshot {
  phase: Phase;
  total: number;
  foundCount: number;
  revealedCount: number; // passed/given-up (shown to the player)
  mistakes: number;
  maxMistakes: number | null;
  currentTarget: Target | null; // null in free mode
  /** Ids not yet found (for reveal-on-end). */
  remainingIds: string[];
  timeLeftMs: number | null; // null when untimed
}

export type GuessOutcome =
  | { kind: "correct"; target: Target }
  | { kind: "duplicate"; target: Target } // clicked an already-found target — no penalty
  | { kind: "neutral" } // ocean or a forgiven near-miss — no point, no penalty
  | { kind: "wrong"; clickedId: string | null }
  | { kind: "noop" }; // game already over

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class GameEngine {
  readonly mode: Mode;
  private byId: Map<string, Target>;
  private queue: string[]; // prompted modes: ids still to find, in play order
  private found = new Set<string>();
  private revealed = new Set<string>();
  private remaining: Set<string>;
  private mistakes = 0;
  private phase: Phase = "playing";
  private deadline: number | null; // epoch ms

  constructor(mode: Mode, pool: Target[]) {
    this.mode = mode;
    this.byId = new Map(pool.map((t) => [t.id, t]));
    const ordered =
      mode.ordering === "random"
        ? shuffle(pool)
        : mode.ordering === "sequential"
          ? [...pool].sort((a, b) => a.name.localeCompare(b.name))
          : pool;
    this.queue = ordered.map((t) => t.id);
    this.remaining = new Set(this.queue);
    this.deadline = mode.timerSeconds != null ? Date.now() + mode.timerSeconds * 1000 : null;
  }

  private get current(): Target | null {
    if (this.mode.ordering === "free") return null;
    const id = this.queue[0];
    return id ? (this.byId.get(id) ?? null) : null;
  }

  private distKm(lng: number, lat: number, t: Target): number {
    return distance(point([lng, lat]), point(t.centroid), { units: "kilometers" });
  }

  /** A radius/line target's accept tolerance: its own radiusKm, else the mode default. */
  private radiusOf(t: Target): number {
    return t.radiusKm ?? this.mode.acceptRadiusKm;
  }

  /** Distance from a click to a target: to its line if it has one (rivers), else to its centroid. */
  private distToTargetKm(lng: number, lat: number, t: Target): number {
    if (t.line && t.line.length) {
      const p = point([lng, lat]);
      let best = Infinity;
      for (const seg of t.line) {
        if (seg.length < 2) continue;
        const d = pointToLineDistance(p, lineString(seg), { units: "kilometers" });
        if (d < best) best = d;
      }
      return best;
    }
    return this.distKm(lng, lat, t);
  }

  /** Polygon-hit feature types (clicked id must equal the target id). */
  private get isPolygon(): boolean {
    return this.mode.featureType === "countries" || this.mode.featureType === "subdivisions";
  }

  /** Does this click correctly select target t? `clickedId` is the polygon under the cursor. */
  private hits(t: Target, clickedId: string | null, lng: number, lat: number): boolean {
    if (this.isPolygon) {
      // Polygon match, or (for tiny/bad-polygon entities) within an explicit radius.
      if (clickedId === t.id) return true;
      return t.radiusKm != null && this.distKm(lng, lat, t) <= t.radiusKm;
    }
    return this.distToTargetKm(lng, lat, t) <= this.radiusOf(t);
  }

  /** Nearest target among `ids` that the click hits. */
  private pickHit(ids: Iterable<string>, clickedId: string | null, lng: number, lat: number): Target | null {
    let best: Target | null = null;
    let bestKm = Infinity;
    for (const id of ids) {
      const t = this.byId.get(id)!;
      if (!this.hits(t, clickedId, lng, lat)) continue;
      const d = this.distToTargetKm(lng, lat, t);
      if (d < bestKm) {
        best = t;
        bestKm = d;
      }
    }
    return best;
  }

  /** Forgiveness distance for a target: its tolerance (0 for polygon-only entities) + the mode's slack. */
  private forgiveDistOf(t: Target): number {
    const base = this.isPolygon && t.radiusKm == null ? 0 : this.radiusOf(t);
    return base + this.mode.forgivenessRadiusKm;
  }

  /** Is the click within forgiveness range of any target in `ids`? */
  private nearAny(ids: Iterable<string>, lng: number, lat: number): boolean {
    for (const id of ids) {
      const t = this.byId.get(id)!;
      if (this.distToTargetKm(lng, lat, t) <= this.forgiveDistOf(t)) return true;
    }
    return false;
  }

  private markFound(id: string) {
    this.found.add(id);
    this.remaining.delete(id);
    this.queue = this.queue.filter((q) => q !== id);
    if (this.found.size === this.byId.size) this.phase = "won";
  }

  private registerMistake() {
    this.mistakes++;
    if (this.mode.maxMistakes != null && this.mistakes > this.mode.maxMistakes) this.phase = "lost";
  }

  /**
   * Evaluate a click. `clickedId` is the polygon under the cursor (country for
   * country mode, subdivision for subdivision mode, else the country for ocean
   * detection); `onLand` is whether the click is on any landmass. Scoring:
   * polygon types must be hit by polygon; point types within their radius/line.
   * A non-scoring click is a mistake ONLY if it's on land AND beyond
   * forgivenessRadiusKm of the target — ocean clicks and near-misses are neutral.
   */
  guess(clickedId: string | null, lng: number, lat: number, onLand: boolean): GuessOutcome {
    if (this.phase !== "playing") return { kind: "noop" };
    // Already-found target under the click? (no penalty)
    const dup = this.pickHit(this.found, clickedId, lng, lat);

    if (this.mode.ordering === "free") {
      const target = this.pickHit(this.remaining, clickedId, lng, lat);
      if (target) {
        this.markFound(target.id);
        return { kind: "correct", target };
      }
      if (dup) return { kind: "duplicate", target: dup };
      if (!onLand) return { kind: "neutral" };
      if (this.nearAny(this.remaining, lng, lat)) return { kind: "neutral" }; // forgiven near-miss
      this.registerMistake();
      return { kind: "wrong", clickedId };
    }

    const target = this.current;
    if (!target) return { kind: "noop" };
    if (this.hits(target, clickedId, lng, lat)) {
      this.markFound(target.id);
      return { kind: "correct", target };
    }
    if (dup) return { kind: "duplicate", target: dup };
    if (!onLand) return { kind: "neutral" }; // ocean — never a mistake
    if (this.distToTargetKm(lng, lat, target) <= this.forgiveDistOf(target)) return { kind: "neutral" }; // forgiven
    this.registerMistake();
    return { kind: "wrong", clickedId };
  }

  /**
   * Pass on (give up) the current prompt: reveal it to the player and move on.
   * Distinct from skip — the target is removed for good (not retried) and does
   * NOT count as a mistake. Returns the revealed target so the UI can show it.
   */
  reveal(): Target | null {
    if (this.phase !== "playing" || this.mode.ordering === "free") return null;
    const id = this.queue.shift();
    if (id == null) return null;
    const t = this.byId.get(id)!;
    this.revealed.add(id);
    this.remaining.delete(id);
    if (this.queue.length === 0) this.phase = this.found.size === this.byId.size ? "won" : "lost";
    return t;
  }

  /** Skip the current prompt. Returns false if skipping isn't allowed/possible. */
  skip(): boolean {
    if (this.phase !== "playing" || !this.mode.allowSkip || this.mode.ordering === "free") return false;
    const id = this.queue.shift();
    if (id == null) return false;
    if (this.mode.allowReturn) {
      this.queue.push(id); // rotate to the back
    } else {
      this.remaining.delete(id); // dropped permanently (counts as missed)
      if (this.queue.length === 0) this.phase = "lost"; // ran out without finding all
    }
    return true;
  }

  /** Call periodically when timed; flips to "lost" once the clock expires. */
  tick(): void {
    if (this.phase === "playing" && this.deadline != null && Date.now() >= this.deadline) this.phase = "lost";
  }

  snapshot(): GameSnapshot {
    return {
      phase: this.phase,
      total: this.byId.size,
      foundCount: this.found.size,
      revealedCount: this.revealed.size,
      mistakes: this.mistakes,
      maxMistakes: this.mode.maxMistakes,
      currentTarget: this.current,
      remainingIds: [...this.remaining],
      timeLeftMs: this.deadline != null ? Math.max(0, this.deadline - Date.now()) : null,
    };
  }
}
