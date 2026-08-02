import type { AppEvent } from '@tsmusic/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';


import { useLiveStore } from '../store/live-store.ts';

const RECONNECT_MIN_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * Owns the single WebSocket connection for the whole panel.
 *
 * One socket carries every bot, so this hook is mounted once in the shell rather than per
 * page. On every reconnect it invalidates the REST caches: the panel was blind for the
 * duration of the outage, and re-fetching is the only honest way to close that gap rather
 * than showing stale state that looks live.
 */
export function useLiveSocket(): void {
  const applyEvent = useLiveStore((state) => state.apply);
  const setConnected = useLiveStore((state) => state.setSocketConnected);
  const queryClient = useQueryClient();

  const reconnectAttempt = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);
  const disposed = useRef(false);

  useEffect(() => {
    disposed.current = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = (): void => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      // No token in the URL. A browser cannot set headers on a WebSocket handshake, but it
      // does send cookies with one — which is how the credential stopped being written into
      // every access log between here and the server.
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        reconnectAttempt.current = 0;
        setConnected(true);
        // Anything that changed while we were disconnected is invisible to us; refetch.
        void queryClient.invalidateQueries();
      });

      socket.addEventListener('message', (message) => {
        try {
          applyEvent(JSON.parse(message.data as string) as AppEvent);
        } catch {
          // A malformed frame is not worth tearing the connection down for.
        }
      });

      socket.addEventListener('close', () => {
        setConnected(false);
        socketRef.current = null;
        if (disposed.current) return;

        const delay = Math.min(
          RECONNECT_MAX_DELAY_MS,
          RECONNECT_MIN_DELAY_MS * 2 ** reconnectAttempt.current,
        );
        reconnectAttempt.current += 1;
        reconnectTimer = setTimeout(connect, delay);
      });

      socket.addEventListener('error', () => {
        // 'close' always follows, and that is where reconnection is handled.
        socket.close();
      });
    };

    connect();

    return () => {
      disposed.current = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [applyEvent, setConnected, queryClient]);
}
