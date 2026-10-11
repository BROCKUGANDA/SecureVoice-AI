/**
 * A deadline on the FIRST chunk of an async stream, and only the first.
 *
 * ── Why first-chunk and not whole-stream ─────────────────────────────────────
 * The voice path needs to know when a synthesis vendor has gone quiet: a socket
 * that accepts the request and then never returns audio leaves the customer in
 * silence for the rest of their turn, with the call still open. That is the
 * failure worth a hard timeout.
 *
 * A whole-stream deadline cannot be used for this. An ElevenLabs stream is open
 * for the entire duration of the sentence — a normal four-second utterance would
 * cross a 2000 ms ceiling on every call, so a whole-stream timer either cuts off
 * real speech or (as the previous implementation did, by leaving its
 * AbortController attached to nothing) never fires at all. Both are worse than
 * the hang being bounded by the caller's own turn logic.
 *
 * So: wait no longer than `ms` for the first byte of audio, then cancel the
 * source and let the caller fail over. Once audio has started, the stream is
 * allowed to run to completion, and barge-in remains the only thing that stops it.
 */
export async function* withFirstChunkDeadline<T>(
  source: AsyncIterable<T>,
  opts: {
    /** How long to wait for the first value before giving up. */
    ms: number;
    /** Names the deadline in the thrown message — a vendor, not a call site. */
    label: string;
    /**
     * Run when the deadline expires, BEFORE the throw propagates. This is where
     * the caller aborts the underlying request so a timed-out vendor does not
     * stay billed and open for the rest of the process's life.
     */
    onExpired?: () => void;
  },
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let isFirst = true;
  try {
    for (;;) {
      const pending = iterator.next();
      let result: IteratorResult<T>;

      if (isFirst && opts.ms > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            opts.onExpired?.();
            reject(new Error(`${opts.label} produced no audio within ${opts.ms}ms`));
          }, opts.ms);
        });
        try {
          result = await Promise.race([pending, deadline]);
        } catch (err) {
          // The losing branch of the race is still outstanding. `onExpired` has
          // already told the vendor to stop, so this settles shortly — but if it
          // settles by rejecting, nothing is attached to it and the process gains
          // an unhandled rejection on every timed-out turn.
          void pending.catch(() => {});
          throw err;
        } finally {
          clearTimeout(timer);
        }
      } else {
        result = await pending;
      }

      if (result.done) return;
      yield result.value;
      isFirst = false;
    }
  } finally {
    // The consumer broke out early (barge-in, call ended). Close the vendor
    // stream rather than leaving it draining into an abandoned iterator.
    await iterator.return?.();
  }
}
