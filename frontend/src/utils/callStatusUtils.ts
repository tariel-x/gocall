/**
 * callStatusUtils.ts - Text & Status Utilities for Call States
 * 
 * This module centralizes all user-facing text messages, decoupling UI text
 * from business logic. All Russian strings are managed here, making it easy to:
 * - Change text without touching hook logic
 * - Implement localization (add locale parameter)
 * - Test message generation independently
 * 
 * STEP_5: Decouple UI text from application logic (KISS principle)
 */

import {
    AppCallState,
    ReconnectionState,
    CallStatus,
    WSState,
    CallSessionDetails,
    MediaRouteMode,
    WebRTCTransientStatus,
} from '../services/types';

// ============================================================================
// UI CONSTANTS & METADATA
// ============================================================================

export const STATUS_BADGES = {
    waiting: 'status-badge status-waiting',
    active: 'status-badge status-active',
    ended: 'status-badge status-ended',
    connecting: 'status-badge status-connecting',
    ready: 'status-badge status-ready',
    disconnected: 'status-badge status-disconnected',
} as const;

export type StatusTone = keyof typeof STATUS_BADGES;

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
    reconnecting: { label: 'Сигналинг переподключается', tone: 'connecting' },
    ready: { label: 'Сигналинг активен', tone: 'ready' },
    disconnected: { label: 'Сигналинг отключён', tone: 'disconnected' },
};

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

// ============================================================================
// STATUS MESSAGE LOGIC 
// ============================================================================

export interface DetailedStatusMessage {
    infoMessage: string | null;
    reconnectionLabel: string | null;
}

export function getDetailedStatusMessage(context: CallSessionDetails): DetailedStatusMessage {
    const {
        transientStatus,
        reconnectionState,
        peerDisconnected,
        callStatus,
        remoteStream,
        error,
        peerConnectionState,
        iceConnectionState,
        participants,
    } = context;

    const reconnectionLabel = getReconnectionMessage(reconnectionState);

    let infoMessage: string | null = null;

    const transientText = transientStatus?.code
        ? getTransientText(transientStatus.code, transientStatus.context)
        : null;

    if (transientText) {
        infoMessage = transientText;
    } else if (reconnectionState === 'peer-disconnected' || peerDisconnected) {
        infoMessage = 'Собеседник отключился. Ждём переподключения...';
    } else if (reconnectionState === 'reconnecting') {
        infoMessage = 'Переподключаем соединение...';
    } else if (reconnectionState === 'failed') {
        infoMessage = 'Не удалось восстановить соединение. Попробуйте перезапустить звонок.';
    } else if (callStatus === 'ended') {
        infoMessage = 'Звонок завершён.';
    } else if (remoteStream && !error) {
        infoMessage = 'Видео собеседника подключено.';
    } else if (
        !error &&
        callStatus === 'active' &&
        peerConnectionState === 'connected' &&
        (iceConnectionState === 'connected' || iceConnectionState === 'completed')
    ) {
        infoMessage = 'Соединение установлено.';
    } else if (callStatus === 'active' && participants >= 2) {
        infoMessage = 'Собеседник подключился. Устанавливаем медиасоединение...';
    } else {
        infoMessage = 'Готовим звонок…';
    }

    return { infoMessage, reconnectionLabel };
}

/**
 * Maps high-level call state to user-visible status message.
 * This is the primary function for displaying call status to the user.
 * 
 * @param state - Current application call state
 * @returns User-friendly message in Russian
 * 
 * @example
 * const message = getCallStateMessage('MEDIA_LOADING');
 * // Returns: "Запрашиваем доступ к камере и микрофону..."
 */
export function getCallStateMessage(state: AppCallState): string {
    switch (state) {
        case 'IDLE':
            return 'Инициализация...';

        case 'MEDIA_LOADING':
            return 'Запрашиваем доступ к камере и микрофону...';

        case 'SIGNALING_CONNECT':
            return 'Подключаемся к серверу...';

        case 'WAITING_FOR_PEER':
            return 'Ожидаем подключение собеседника...';

        case 'NEGOTIATING':
            return 'Устанавливаем защищенное соединение...';

        case 'ACTIVE':
            // When call is active, usually no status message is shown (video fills screen)
            return 'Звонок активен';

        case 'RECONNECTING':
            return 'Связь прервалась. Пытаемся восстановить...';

        case 'COMPLETED':
            return 'Звонок завершен.';

        case 'FAILED':
            return 'Произошла ошибка. Попробуйте обновить страницу.';

        default:
            const exhaustive: never = state;
            return exhaustive;
    }
}

/**
 * Maps reconnection state to specific reconnection-related message.
 * Used for additional context during reconnection attempts.
 * 
 * @param state - Reconnection state
 * @returns Reconnection-specific message
 * 
 * @example
 * const label = getReconnectionMessage('peer-disconnected');
 * // Returns: "Собеседник отключён"
 */
export function getReconnectionMessage(state: ReconnectionState): string {
    switch (state) {
        case 'connected':
            return '';

        case 'reconnecting':
            return 'Переподключение...';

        case 'peer-disconnected':
            return 'Собеседник отключён';

        case 'failed':
            return 'Восстановление не удалось';

        default:
            const exhaustive: never = state;
            return exhaustive;
    }
}

/**
 * Formats error messages for user display.
 * Provides friendly messages for common error scenarios.
 * 
 * @param error - Error message or null
 * @returns Formatted user-friendly error string, or empty string if no error
 * 
 * @example
 * const text = getErrorMessage('Browser does not support getUserMedia');
 * // Returns: "Браузер не поддерживает получение видео с камеры"
 */
export function getErrorMessage(error: string | null): string {
    if (!error) return '';

    // Map common error patterns to user-friendly messages
    if (error.includes('getUserMedia') || error.includes('Not supported')) {
        return 'Браузер не поддерживает получение видео с камеры';
    }

    if (error.includes('Permission denied') || error.includes('NotAllowedError')) {
        return 'Вы отказали приложению в доступе к камере или микрофону';
    }

    if (error.includes('NotFoundError') || error.includes('no device found')) {
        return 'Камера или микрофон не найдены на этом устройстве';
    }

    if (error.includes('OverconstrainedError')) {
        return 'Запрошенные параметры камеры недоступны';
    }

    // Fallback: return original error (usually technical)
    return error;
}

/**
 * Maps call state to CSS color class for UI highlighting.
 * Supports both Tailwind and custom CSS classes.
 * 
 * @param state - Current application call state
 * @returns CSS class name for styling
 * 
 * @example
 * const colorClass = getStatusColor('FAILED');
 * // Returns: "text-red-500"
 */
export function getStatusColor(state: AppCallState): string {
    switch (state) {
        case 'FAILED':
        case 'RECONNECTING':
            return 'text-red-500';

        case 'ACTIVE':
            return 'text-green-500';

        case 'IDLE':
        case 'MEDIA_LOADING':
        case 'SIGNALING_CONNECT':
        case 'WAITING_FOR_PEER':
        case 'NEGOTIATING':
            return 'text-yellow-500';

        case 'COMPLETED':
            return 'text-gray-500';

        default:
            const exhaustive: never = state;
            return exhaustive;
    }
}

/**
 * Transient status messages for real-time feedback during connection lifecycle.
 * These messages appear briefly and disappear when connection is established.
 * Used by useWebRTCManager for dynamic status updates.
 * 
 * @param trigger - Trigger that caused the status message
 * @returns Appropriate status message, or null if no message needed
 */
export function getTransientText(
    trigger: WebRTCTransientStatus,
    context?: { attempt?: number; delay?: number }
): string | null {
    switch (trigger) {
        case 'recreating-pc':
            const attempt = context?.attempt ?? 1;
            return `Пересоздаём медиасоединение (попытка ${attempt})...`;

        case 'peer-disconnected':
            return 'Собеседник отключился. Ждём переподключения...';

        case 'peer-reconnected':
            return 'Собеседник восстановил соединение.';

        case 'peer-reconnected-waiting':
            return 'Ожидаем восстановление соединения...';

        case 'renegotiate-request':
            return 'Собеседник пересоздаёт соединение, ожидаем...';

        case 'offer-sent':
            return 'Отправили новое предложение...';

        case 'answer-waiting':
            return 'Ожидаем предложение от собеседника...';

        case 'retry-scheduled':
            const delay = context?.delay ?? 0;
            const seconds = Math.ceil(delay / 1000);
            return `Повторная попытка через ${seconds} секунды...`;

        case 'signaling-wait':
            return 'Ожидаем восстановление сигналинга перед пересозданием...';

        default:
            return null;
    }
}

/**
 * Helper to determine if a state should show retry button
 */
export function canRetry(state: AppCallState): boolean {
    return state === 'FAILED' || state === 'RECONNECTING';
}

/**
 * Helper to determine if connection is stable (no need to show warnings)
 */
export function isConnectionStable(state: AppCallState): boolean {
    return state === 'ACTIVE' || state === 'COMPLETED';
}
