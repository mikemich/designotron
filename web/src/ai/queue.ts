/** Messages typed while Claude is busy or offline wait together, in order. */
export function queueJoin(prev: string | null | undefined, next: string): string {
  return prev ? `${prev}\n\n${next}` : next;
}
