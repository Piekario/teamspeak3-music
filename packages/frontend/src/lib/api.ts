import type { InstanceSummary, PlayerState, RepeatMode, Track } from '@tsmusic/shared';

/**
 * The REST client.
 *
 * Every mutation goes through here rather than over the WebSocket, which stays read-only.
 * That means there is one place where the token is attached and one place where an error
 * response becomes a thrown `ApiError` carrying the backend's own message — so the UI can
 * show "YouTube blocked the request: …" instead of a generic failure.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly kind: string | undefined;

  constructor(status: number, message: string, kind?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
  }
}

const TOKEN_STORAGE_KEY = 'tsmusic.token';

export function readStoredToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = readStoredToken();
  const headers = new Headers(init.headers);
  if (token !== null) headers.set('Authorization', `Bearer ${token}`);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');

  const response = await fetch(path, { ...init, headers });

  if (response.status === 204) return undefined as T;

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { message?: string; kind?: string; issues?: string[] } }
      | null;

    const detail = body?.error;
    const message =
      detail?.issues?.join('; ') ?? detail?.message ?? `request failed (${response.status})`;
    throw new ApiError(response.status, message, detail?.kind);
  }

  return (await response.json()) as T;
}

export interface TrackRequestBody {
  url?: string;
  query?: string;
  position?: number;
}

export const api = {
  health: () => request<{ status: string; at: string }>('/api/health'),

  listInstances: () => request<{ instances: InstanceSummary[] }>('/api/instances'),

  getPlayer: (instanceId: string) =>
    request<PlayerState>(`/api/instances/${encodeURIComponent(instanceId)}/player`),

  enqueue: (instanceId: string, body: TrackRequestBody) =>
    request<{ track: Track }>(`/api/instances/${encodeURIComponent(instanceId)}/queue`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  removeFromQueue: (instanceId: string, itemId: string) =>
    request<void>(
      `/api/instances/${encodeURIComponent(instanceId)}/queue/${encodeURIComponent(itemId)}`,
      { method: 'DELETE' },
    ),

  moveInQueue: (instanceId: string, itemId: string, toIndex: number) =>
    request<void>(`/api/instances/${encodeURIComponent(instanceId)}/queue/move`, {
      method: 'POST',
      body: JSON.stringify({ itemId, toIndex }),
    }),

  shuffleQueue: (instanceId: string) =>
    request<void>(`/api/instances/${encodeURIComponent(instanceId)}/queue/shuffle`, {
      method: 'POST',
    }),

  clearQueue: (instanceId: string) =>
    request<void>(`/api/instances/${encodeURIComponent(instanceId)}/queue/clear`, {
      method: 'POST',
    }),

  skip: (instanceId: string) => post(instanceId, 'skip'),
  pause: (instanceId: string) => post(instanceId, 'pause'),
  resume: (instanceId: string) => post(instanceId, 'resume'),
  stop: (instanceId: string) => post(instanceId, 'stop'),

  seek: (instanceId: string, positionSec: number) =>
    request<{ positionSec: number }>(
      `/api/instances/${encodeURIComponent(instanceId)}/player/seek`,
      { method: 'POST', body: JSON.stringify({ positionSec }) },
    ),

  setVolume: (instanceId: string, volume: number) =>
    request<void>(`/api/instances/${encodeURIComponent(instanceId)}/player/volume`, {
      method: 'POST',
      body: JSON.stringify({ volume }),
    }),

  setRepeat: (instanceId: string, mode: RepeatMode) =>
    request<void>(`/api/instances/${encodeURIComponent(instanceId)}/player/repeat`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),

  search: (instanceId: string, query: string, limit = 5) =>
    request<{ results: Track[] }>(
      `/api/instances/${encodeURIComponent(instanceId)}/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),
};

function post(instanceId: string, action: string): Promise<void> {
  return request<void>(`/api/instances/${encodeURIComponent(instanceId)}/player/${action}`, {
    method: 'POST',
  });
}
