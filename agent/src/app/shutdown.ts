export async function drainAndStop(
  stopNew: () => void,
  drain: () => Promise<void>,
  close: () => Promise<void>,
): Promise<void> {
  stopNew();
  await drain();
  await close();
}
