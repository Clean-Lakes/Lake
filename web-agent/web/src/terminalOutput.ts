/** Return only new PTY bytes when the server's bounded history slides forward. */
export function terminalOutputUpdate(previous: string, next: string): { text: string; reset: boolean } {
  if (next === previous) return { text: "", reset: false };
  if (next.startsWith(previous)) return { text: next.slice(previous.length), reset: false };

  // The server retains only the latest output. Replaying the whole truncated
  // snapshot on every keystroke clears the screen and makes input feel slow.
  if (previous.length >= 8192 && next.length >= 8192) {
    const prefix = new Int32Array(next.length);
    for (let i = 1, matched = 0; i < next.length; i++) {
      while (matched && next[i] !== next[matched]) matched = prefix[matched - 1]!;
      if (next[i] === next[matched]) matched++;
      prefix[i] = matched;
    }
    let overlap = 0;
    for (let i = 0; i < previous.length; i++) {
      while (overlap && next[overlap] !== previous[i]) overlap = prefix[overlap - 1]!;
      if (next[overlap] === previous[i]) overlap++;
      if (overlap === next.length && i < previous.length - 1) overlap = prefix[overlap - 1]!;
    }
    if (overlap >= previous.length / 2 && overlap < next.length) {
      return { text: next.slice(overlap), reset: false };
    }
  }
  return { text: `\x1b[2J\x1b[3J\x1b[H${next}`, reset: true };
}
