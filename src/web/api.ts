export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** The request never got an answer (offline, server down). */
export class NetworkError extends Error {
  constructor() {
    super('No connection to the server');
  }
}

export function uid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export async function api<T = unknown>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  opts: { key?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['idempotency-key'] = opts.key ?? uid();
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new NetworkError();
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const e = (
      json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null
    )?.error;
    throw new ApiError(
      res.status,
      e?.code ?? 'error',
      e?.message ?? `Request failed (${res.status})`,
      e?.details,
    );
  }
  return json as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body: unknown = {}, key?: string) =>
  api<T>('POST', path, body, key ? { key } : {});
export const del = <T>(path: string) => api<T>('DELETE', path);
