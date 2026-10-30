// Minimal Jev client (TypeSafe System One), from harness/extensions/jev-bash/core/client.ts: one call answers a few
// bounded questions about a JSON state in a few hundred milliseconds.
export type JevQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };
export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };

const RETRY = new Set([429, 502, 503, 529]);

/**
 * `openRouterKey` is where pi keeps its OpenRouter credential (auth.json, or pi's own environment lookup); the
 * `OPENROUTER_API_KEY` variable is the fallback when there is no pi to ask. `TYPESAFE_API_KEY` goes to TypeSafe directly.
 */
export async function askJev(
  state: unknown,
  questions: Record<string, JevQuestion>,
  signal?: AbortSignal,
  openRouterKey?: () => Promise<string | undefined>,
): Promise<Record<string, JevAnswer>> {
  const piKey = process.env.TYPESAFE_API_KEY ? undefined : await openRouterKey?.().catch(() => undefined);
  const [endpoint, key, model] = process.env.TYPESAFE_API_KEY
    ? ["https://api.typesafe.ai/v1/systemone", process.env.TYPESAFE_API_KEY, "jev-latest"]
    : (piKey ?? process.env.OPENROUTER_API_KEY)
      ? ["https://openrouter.ai/api/alpha/decisions", (piKey ?? process.env.OPENROUTER_API_KEY)!, "~typesafe/jev-latest"]
      : [];
  if (!endpoint) throw Error("Jev needs TYPESAFE_API_KEY, or an OpenRouter key in pi's auth.json (or OPENROUTER_API_KEY)");
  const body = JSON.stringify({ model, state, questions });
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (RETRY.has(res.status) && attempt < 3) {
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw Error(`Jev HTTP ${res.status}`);
    const data = (await res.json()) as { answers?: Record<string, JevAnswer> };
    for (const [id, q] of Object.entries(questions))
      if (data.answers?.[id]?.type !== q.type) throw Error(`Jev answer missing: ${id}`);
    return data.answers!;
  }
}
