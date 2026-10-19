export type Health = { status: string; env: string; schema: string | null }

export async function getHealth(signal?: AbortSignal): Promise<Health> {
  const res = await fetch('/api/health', { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as Health
}
