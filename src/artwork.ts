/** The standalone build supplies embedded artwork so it can open as a local file. */
export function foodImage(category: string): string {
  const embedded = (globalThis as typeof globalThis & {
    __MATCHFOOD_ARTWORK__?: Record<string, string>;
  }).__MATCHFOOD_ARTWORK__;
  return embedded?.[category] || `/images/${category}.svg`;
}
