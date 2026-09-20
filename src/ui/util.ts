/** Coerce unknown thrown values to a readable string. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
