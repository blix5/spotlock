export type Stream = "attention" | "app" | "playback";

/**
 * Owns the open/close lifecycle for one interval stream. Intervals are
 * opened on the server as soon as the state changes rather than written
 * whole when they end - a "focused" stretch can run for hours, and writing
 * only on close would lose all of it to a crash or a closed laptop.
 */
export class IntervalRecorder {
  private openId: string | null = null;
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly stream: Stream,
    private readonly sessionId: string
  ) {}

  /**
   * Close whatever is open and open a new interval for `fields`. Pass null
   * to just close (e.g. playback stopping, or the helper disconnecting).
   *
   * Calls are serialised through `inFlight` because a close needs the id
   * from its own open: at 1 fps two transitions can't realistically overlap,
   * but a slow request during a burst of state changes otherwise races.
   */
  transition(fields: Record<string, unknown> | null, at: number, sampleCount?: number): Promise<void> {
    this.inFlight = this.inFlight
      .then(() => this.run(fields, at, sampleCount))
      .catch((error) => {
        // A dropped interval shouldn't take the capture loop down with it.
        console.error(`[focus] ${this.stream} interval write failed`, error);
      });
    return this.inFlight as Promise<void>;
  }

  private async run(fields: Record<string, unknown> | null, at: number, sampleCount?: number) {
    const iso = new Date(at).toISOString();

    if (this.openId) {
      await fetch("/api/focus/intervals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stream: this.stream,
          sessionId: this.sessionId,
          id: this.openId,
          endedAt: iso,
          sampleCount,
        }),
      });
      this.openId = null;
    }

    if (!fields) return;

    const res = await fetch("/api/focus/intervals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stream: this.stream,
        sessionId: this.sessionId,
        startedAt: iso,
        ...fields,
      }),
    });

    if (!res.ok) throw new Error(`open failed: ${res.status}`);
    this.openId = (await res.json()).id;
  }

  /** Close on teardown without opening a replacement. */
  close(at = Date.now(), sampleCount?: number): Promise<void> {
    return this.transition(null, at, sampleCount);
  }
}
