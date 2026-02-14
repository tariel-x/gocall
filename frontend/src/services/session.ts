import { PeerRole } from './types';

const STORAGE_KEY = 'familycall-call-session';

export interface SessionState {
  callId?: string;
  peerId?: string;
  role?: PeerRole;
}

let sessionState: SessionState = readFromStorage();

function readFromStorage(): SessionState {
  if (typeof window === 'undefined' || !window.sessionStorage) {
    return {};
  }
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as SessionState;
    return parsed ?? {};
  } catch (err) {
    console.warn('Failed to read session state', err);
    return {};
  }
}

function persist(): void {
  if (typeof window === 'undefined' || !window.sessionStorage) {
    return;
  }
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(sessionState));
  } catch (err) {
    console.warn('Failed to persist session state', err);
  }
}

export function setCallContext(callId: string): void {
  sessionState.callId = callId;
  persist();
}

export function setPeerContext(peerId: string, role: PeerRole): void {
  sessionState.peerId = peerId;
  sessionState.role = role;
  persist();
}

export function getSessionState(): SessionState {
  return { ...sessionState };
}

export function resetSession(): void {
  sessionState = {};
  if (typeof window === 'undefined' || !window.sessionStorage) {
    return;
  }
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn('Failed to reset session state', err);
  }
}
