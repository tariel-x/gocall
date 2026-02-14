import { CallStatus, PeerRole } from './types';

interface StateEnvelope {
  call_id: string;
  status: CallStatus;
  participants?: {
    count: number;
  };
}

interface JoinEnvelope {
  peer_id: string;
  role?: PeerRole;
}

export interface SignalingEnvelope {
  type: string;
  data?: unknown;
  from?: string;
  to?: string;
  call_type?: string;
}

export interface SignalingCallbacks {
  onOpen?: () => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
  onReconnectFailed?: () => void;
  onJoin?: (data: JoinEnvelope) => void;
  onState?: (data: StateEnvelope) => void;
  onOffer?: (message: SignalingEnvelope) => void;
  onAnswer?: (message: SignalingEnvelope) => void;
  onIceCandidate?: (message: SignalingEnvelope) => void;
  onLeave?: (message: SignalingEnvelope) => void;
  onMessage?: (message: SignalingEnvelope) => void;
  onClose?: () => void;
  onError?: (event: Event) => void;
}

export interface SignalingClient {
  send: (message: SignalingEnvelope) => void;
  close: () => void;
}

interface SharedConnection {
  key: string;
  callId: string;
  peerId?: string;
  socket: WebSocket;
  listeners: Set<SignalingCallbacks>;
  pendingQueue: SignalingEnvelope[];
  idleTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  callEnded: boolean;
  client: SignalingClient;
  ready: boolean;
  lastJoin?: JoinEnvelope;
  lastState?: StateEnvelope;
}

export interface SignalingSubscription {
  client: SignalingClient;
  unsubscribe: () => void;
}

const sharedConnections = new Map<string, SharedConnection>();

const connectionKey = (callId: string) => callId;

const cancelIdleTimer = (connection: SharedConnection) => {
  if (connection.idleTimer) {
    clearTimeout(connection.idleTimer);
    connection.idleTimer = null;
  }
};

const scheduleIdleClose = (connection: SharedConnection) => {
  cancelIdleTimer(connection);
  connection.idleTimer = setTimeout(() => {
    connection.idleTimer = null;
    connection.client.close();
  }, 3000);
};

const clearReconnectTimer = (connection: SharedConnection) => {
  if (connection.reconnectTimer) {
    clearTimeout(connection.reconnectTimer);
    connection.reconnectTimer = null;
  }
};

const createSharedConnection = (callId: string, peerId?: string): SharedConnection => {
  const wsURL = buildWSUrl(callId, peerId);
  const listeners = new Set<SignalingCallbacks>();
  const pendingQueue: SignalingEnvelope[] = [];

  const connection: SharedConnection = {
    key: connectionKey(callId),
    callId,
    peerId,
    socket: new WebSocket(wsURL),
    listeners,
    pendingQueue,
    idleTimer: null,
    reconnectAttempts: 0,
    reconnectTimer: null,
    callEnded: false,
    client: {
      send: () => undefined,
      close: () => undefined,
    },
    ready: false,
    lastJoin: undefined,
    lastState: undefined,
  };

  const dispatch = (fn: (cb: SignalingCallbacks) => void) => {
    listeners.forEach((listener) => {
      fn(listener);
    });
  };

  const flushQueue = () => {
    if (connection.socket.readyState !== WebSocket.OPEN || pendingQueue.length === 0) {
      return;
    }
    while (pendingQueue.length > 0) {
      const next = pendingQueue.shift();
      if (!next) {
        continue;
      }
      connection.socket.send(JSON.stringify(next));
    }
  };

  const scheduleReconnect = () => {
    if (connection.callEnded) {
      return;
    }

    const attempt = connection.reconnectAttempts + 1;
    connection.reconnectAttempts = attempt;

    const delay = 2000;
    clearReconnectTimer(connection);
    connection.reconnectTimer = setTimeout(() => {
      const newSocket = new WebSocket(buildWSUrl(connection.callId, connection.peerId));
      attachSocketHandlers(newSocket);
    }, delay);
  };

  function attachSocketHandlers(socket: WebSocket) {
    connection.socket = socket;

    socket.onopen = () => {
      const wasReconnecting = connection.reconnectAttempts > 0;
      connection.ready = true;
      connection.reconnectAttempts = 0;
      clearReconnectTimer(connection);
      flushQueue();
      dispatch((listener) => listener.onOpen?.());
      if (wasReconnecting) {
        dispatch((listener) => listener.onReconnected?.());
      }
    };

    socket.onmessage = (event) => {
      try {
        const envelope: SignalingEnvelope = JSON.parse(event.data);
        if (!envelope?.type) {
          return;
        }
        switch (envelope.type) {
          case 'join':
            if (envelope.data) {
              const joinData = envelope.data as JoinEnvelope;
              connection.lastJoin = joinData;
              if (!connection.peerId && joinData?.peer_id) {
                connection.peerId = joinData.peer_id;
              }
              dispatch((listener) => listener.onJoin?.(joinData));
            }
            break;
          case 'state':
            if (envelope.data) {
              const stateData = envelope.data as StateEnvelope;
              connection.lastState = stateData;
              dispatch((listener) => listener.onState?.(stateData));
            }
            break;
          case 'offer':
            dispatch((listener) => listener.onOffer?.(envelope));
            break;
          case 'answer':
            dispatch((listener) => listener.onAnswer?.(envelope));
            break;
          case 'ice-candidate':
            dispatch((listener) => listener.onIceCandidate?.(envelope));
            break;
          case 'leave':
            dispatch((listener) => listener.onLeave?.(envelope));
            break;
          case 'ping':
            break;
          default:
            dispatch((listener) => listener.onMessage?.(envelope));
        }
      } catch (err) {
        console.warn('Failed to parse signaling message', err);
      }
    };

    socket.onclose = (event) => {
      connection.ready = false;

      const normalClosure = event.code === 1000 || event.code === 1001;
      if (connection.callEnded || normalClosure) {
        pendingQueue.length = 0;
        clearReconnectTimer(connection);
        dispatch((listener) => listener.onClose?.());
        sharedConnections.delete(connection.key);
        listeners.clear();
        return;
      }

      dispatch((listener) => listener.onReconnecting?.());
      scheduleReconnect();
    };

    socket.onerror = (event) => {
      dispatch((listener) => listener.onError?.(event));
    };
  }

  const send = (message: SignalingEnvelope) => {
    if (!message?.type) {
      return;
    }
    const socket = connection.socket;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return;
    }
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
      pendingQueue.push(message);
    }
  };

  const close = () => {
    connection.callEnded = true;
    cancelIdleTimer(connection);
    clearReconnectTimer(connection);
    listeners.clear();
    pendingQueue.length = 0;
    sharedConnections.delete(connection.key);
    const socket = connection.socket;
    if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
      return;
    }
    socket.close();
  };

  connection.client = { send, close };

  attachSocketHandlers(connection.socket);

  return connection;
};

export const subscribeToSignaling = (
  callId: string,
  peerId: string | undefined,
  callbacks: SignalingCallbacks = {}
): SignalingSubscription => {
  if (!callId) {
    throw new Error('callId is required for signaling');
  }
  const key = connectionKey(callId);
  let connection = sharedConnections.get(key);
  if (!connection) {
    connection = createSharedConnection(callId, peerId);
    sharedConnections.set(key, connection);
  } else if (peerId && !connection.peerId) {
    connection.peerId = peerId;
  }

  cancelIdleTimer(connection);
  connection.listeners.add(callbacks);

  if (connection.ready) {
    callbacks.onOpen?.();
  }
  if (connection.lastJoin) {
    callbacks.onJoin?.(connection.lastJoin);
  }
  if (connection.lastState) {
    callbacks.onState?.(connection.lastState);
  }

  const unsubscribe = () => {
    connection?.listeners.delete(callbacks);
    if (connection && connection.listeners.size === 0) {
      scheduleIdleClose(connection);
    }
  };

  return {
    client: connection.client,
    unsubscribe,
  };
};

const buildWSUrl = (callId: string, peerId?: string): string => {
  const apiAddress = (window.API_ADDRESS && window.API_ADDRESS.trim() !== '')
    ? window.API_ADDRESS
    : window.location.origin;
  const url = new URL('/api/ws', apiAddress);
  url.searchParams.set('call_id', callId);
  if (peerId) {
    url.searchParams.set('peer_id', peerId);
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};
