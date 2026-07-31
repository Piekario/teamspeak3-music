import type { InstanceSummary, PlayerState, RepeatMode, Role, Track } from '@tsmusic/shared';

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

/**
 * One instance in full, as the settings screen needs it.
 *
 * Passwords are absent by design — the backend never returns them. `hasChannelPassword` and
 * `hasServerPassword` say whether one is set so the UI can show that without knowing it.
 */
export interface InstanceDetail {
  id: string;
  name: string;
  enabled: boolean;
  connection: string;
  teamspeak: {
    host: string;
    port: number;
    nickname: string;
    channel: string | null;
    homeChannelId: number | null;
  };
  hasChannelPassword?: boolean;
  hasServerPassword?: boolean;
  playback?: {
    defaultVolume?: number;
    maxTrackSeconds?: number;
    maxPerUser?: number;
    pauseWhenAlone?: boolean;
  };
  commands: { prefix: string; requireSameChannel: boolean };
  /** Optional: a backend one deploy behind the panel omits it. */
  connectionSettings?: { autoReconnect?: boolean };
  permissions: { defaultRole: Role; whitelistOnly: boolean };
  /** Optional: a backend one deploy behind the panel omits it. */
  grants?: { identities: Record<string, Role>; serverGroups: Record<string, Role> };
}

export interface UpdateInstanceBody {
  name?: string;
  teamspeak?: {
    host?: string;
    port?: number;
    nickname?: string;
    channel?: string | null;
    channelPassword?: string;
  };
  serverPassword?: string;
  playback?: { pauseWhenAlone?: boolean };
  connectionSettings?: { autoReconnect?: boolean };
  grants?: { serverGroups: Record<string, Role>; identities: Record<string, Role> };
}

export interface CreateInstanceBody {
  id: string;
  name: string;
  teamspeak: { host: string; port: number; nickname: string };
  serverPassword: string | null;
}

export interface PlaylistSummary {
  id: string;
  instanceId: string;
  name: string;
  description: string | null;
  ownerUid: string | null;
  isDefault: boolean;
  trackCount: number;
  totalDurationSec: number;
  updatedAt: string;
}

export interface PlaylistTrack {
  id: string;
  position: number;
  track: Track;
  addedAt: string;
}

export interface PlaylistDetail extends PlaylistSummary {
  tracks: PlaylistTrack[];
}

export const api = {
  health: () => request<{ status: string; at: string }>('/api/health'),

  listInstances: () => request<{ instances: InstanceSummary[] }>('/api/instances'),

  getInstance: (instanceId: string) =>
    request<InstanceDetail>(`/api/instances/${encodeURIComponent(instanceId)}`),

  updateInstance: (instanceId: string, body: UpdateInstanceBody) =>
    request<void>(`/api/instances/${encodeURIComponent(instanceId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  startInstance: (instanceId: string) =>
    request<void>(`/api/instances/${encodeURIComponent(instanceId)}/start`, { method: 'POST' }),

  stopInstance: (instanceId: string) =>
    request<void>(`/api/instances/${encodeURIComponent(instanceId)}/stop`, { method: 'POST' }),

  importPlaylist: (instanceId: string, url: string, limit = 100) =>
    request<{ title: string; queued: number; rejected: number; omitted: number }>(
      `/api/instances/${encodeURIComponent(instanceId)}/queue/playlist`,
      { method: 'POST', body: JSON.stringify({ url, limit }) },
    ),

  createInstance: (body: CreateInstanceBody) =>
    request<{ id: string }>('/api/instances', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listPlaylists: (instanceId: string) =>
    request<{ playlists: PlaylistSummary[] }>(
      `/api/instances/${encodeURIComponent(instanceId)}/playlists`,
    ),

  getPlaylist: (instanceId: string, playlistId: string) =>
    request<PlaylistDetail>(
      `/api/instances/${encodeURIComponent(instanceId)}/playlists/${encodeURIComponent(playlistId)}`,
    ),

  createPlaylist: (instanceId: string, name: string) =>
    request<PlaylistSummary>(`/api/instances/${encodeURIComponent(instanceId)}/playlists`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  savePlaylistFromQueue: (instanceId: string, name: string) =>
    request<PlaylistSummary>(
      `/api/instances/${encodeURIComponent(instanceId)}/playlists/from-queue`,
      { method: 'POST', body: JSON.stringify({ name }) },
    ),

  renamePlaylist: (instanceId: string, playlistId: string, name: string) =>
    request<PlaylistDetail>(
      `/api/instances/${encodeURIComponent(instanceId)}/playlists/${encodeURIComponent(playlistId)}`,
      { method: 'PATCH', body: JSON.stringify({ name }) },
    ),

  makePlaylistDefault: (instanceId: string, playlistId: string) =>
    request<PlaylistDetail>(
      `/api/instances/${encodeURIComponent(instanceId)}/playlists/${encodeURIComponent(playlistId)}`,
      { method: 'PATCH', body: JSON.stringify({ isDefault: true }) },
    ),

  clearDefaultPlaylist: (instanceId: string) =>
    request<void>(`/api/instances/${encodeURIComponent(instanceId)}/playlists/default`, {
      method: 'DELETE',
    }),

  deletePlaylist: (instanceId: string, playlistId: string) =>
    request<void>(
      `/api/instances/${encodeURIComponent(instanceId)}/playlists/${encodeURIComponent(playlistId)}`,
      { method: 'DELETE' },
    ),

  addToPlaylist: (instanceId: string, playlistId: string, url: string) =>
    request<{ added: number; omitted: number; playlist: PlaylistDetail }>(
      `/api/instances/${encodeURIComponent(instanceId)}/playlists/${encodeURIComponent(playlistId)}/tracks`,
      { method: 'POST', body: JSON.stringify({ url }) },
    ),

  removeFromPlaylist: (instanceId: string, playlistId: string, trackId: string) =>
    request<void>(
      `/api/instances/${encodeURIComponent(instanceId)}/playlists/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(trackId)}`,
      { method: 'DELETE' },
    ),

  loadPlaylist: (instanceId: string, playlistId: string) =>
    request<{ queued: number; rejected: number }>(
      `/api/instances/${encodeURIComponent(instanceId)}/playlists/${encodeURIComponent(playlistId)}/load`,
      { method: 'POST', body: JSON.stringify({ requestedBy: 'the panel' }) },
    ),

  deleteInstance: (instanceId: string) =>
    request<void>(`/api/instances/${encodeURIComponent(instanceId)}`, { method: 'DELETE' }),

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
