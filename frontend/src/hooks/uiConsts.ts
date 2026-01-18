import type { WSState } from './useSignaling';
import { CallStatus, PeerRole } from '../services/types';

const STATUS_BADGES = {
  waiting: 'status-badge status-waiting',
  active: 'status-badge status-active',
  ended: 'status-badge status-ended',
  connecting: 'status-badge status-connecting',
  ready: 'status-badge status-ready',
  disconnected: 'status-badge status-disconnected',
} as const;

type StatusTone = keyof typeof STATUS_BADGES;

export const CALL_STATUS_TEXT: Record<CallStatus, string> = {
  waiting: 'Ждём подключение',
  active: 'Звонок идёт',
  ended: 'Звонок завершён',
};

export const CALL_STATUS_TONE: Record<CallStatus, StatusTone> = {
  waiting: 'waiting',
  active: 'active',
  ended: 'ended',
};

export const WS_STATE_META: Record<WSState, { label: string; tone: StatusTone }> = {
  connecting: { label: 'Сигналинг подключается', tone: 'connecting' },
  ready: { label: 'Сигналинг активен', tone: 'ready' },
  disconnected: { label: 'Сигналинг отключён', tone: 'disconnected' },
};

export type MediaRouteMode = 'unknown' | 'direct' | 'relay';

export const MEDIA_ROUTE_META: Record<MediaRouteMode, { label: string; tone: StatusTone }> = {
  unknown: { label: 'Маршрут определяется', tone: 'waiting' },
  direct: { label: 'Напрямую (P2P)', tone: 'ready' },
  relay: { label: 'Через TURN', tone: 'ready' },
};

export const getPeerStateMeta = (state: RTCPeerConnectionState | 'new'): { label: string; tone: StatusTone } => {
  switch (state) {
    case 'connected':
      return { label: 'WebRTC подключён', tone: 'ready' };
    case 'connecting':
      return { label: 'WebRTC подключается', tone: 'connecting' };
    case 'disconnected':
      return { label: 'WebRTC отключён', tone: 'disconnected' };
    case 'failed':
    case 'closed':
      return { label: 'WebRTC завершён', tone: 'ended' };
    default:
      return { label: 'Ожидание WebRTC', tone: 'waiting' };
  }
};

export const getIceStateMeta = (state: RTCIceConnectionState | 'new'): { label: string; tone: StatusTone } => {
  switch (state) {
    case 'connected':
    case 'completed':
      return { label: 'ICE подключён', tone: 'ready' };
    case 'checking':
      return { label: 'ICE проверяет маршруты', tone: 'connecting' };
    case 'disconnected':
      return { label: 'ICE отключён', tone: 'disconnected' };
    case 'failed':
    case 'closed':
      return { label: 'ICE завершён', tone: 'ended' };
    default:
      return { label: 'Ожидание ICE', tone: 'waiting' };
  }
};

export const getBadgeClass = (tone: StatusTone) => STATUS_BADGES[tone] || STATUS_BADGES.waiting;
