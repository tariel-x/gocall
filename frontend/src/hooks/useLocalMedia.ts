import { useState, useEffect, useCallback } from 'react';
import { acquireLocalMedia, releaseLocalStream } from '../services/media';

/**
 * useLocalMedia Hook
 * ==================
 * 
 * Encapsulates all logic related to acquiring and managing local media streams
 * (camera/microphone). Handles:
 * - Initial media stream acquisition
 * - Error handling for permission denials
 * - Cleanup on unmount (releases all tracks)
 * 
 * This hook is independent of WebRTC or WebSocket logic,
 * making it reusable and easy to test.
 */

export interface UseLocalMediaState {
  /** Local MediaStream (camera/microphone) */
  stream: MediaStream | null;
  /** Error message if media acquisition failed */
  error: string | null;
}

export interface UseLocalMediaResult extends UseLocalMediaState {
  /** Manually initialize/acquire the local media stream */
  initMedia: () => Promise<void>;
}

/**
 * Hook for managing local media (camera/microphone).
 * 
 * @returns Object containing stream, error, and initMedia function
 * 
 * Usage:
 * ```tsx
 * const { stream, error, initMedia } = useLocalMedia();
 * 
 * useEffect(() => {
 *   initMedia();
 * }, [initMedia]);
 * ```
 * 
 * Note: Media tracks are automatically released on unmount.
 */
export function useLocalMedia(): UseLocalMediaResult {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Acquires local media (camera/microphone).
   * Sets error state if permission is denied or devices unavailable.
   */
  const initMedia = useCallback(async () => {
    try {
      const mediaStream = await acquireLocalMedia();
      setStream(mediaStream);
      setError(null);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Не удалось получить доступ к устройствам.';
      setError(errorMessage);
      setStream(null);
    }
  }, []);

  /**
   * Cleanup effect: releases all media tracks on unmount.
   * This ensures proper resource cleanup and prevents ghost tracks
   * from continuing to capture data after the component is unmounted.
   */
  useEffect(() => {
    return () => {
      // Release all tracks (stops camera/microphone capture)
      releaseLocalStream();
      setStream(null);
      setError(null);
    };
  }, []);

  return { stream, error, initMedia };
}
