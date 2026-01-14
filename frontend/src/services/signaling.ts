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

const createSharedConnection = (callId: string, peerId?: string): SharedConnection => {
  const wsURL = buildWSUrl(callId, peerId);
  const socket = new WebSocket(wsURL);
  const listeners = new Set<SignalingCallbacks>();
  const pendingQueue: SignalingEnvelope[] = [];

  const connection: SharedConnection = {
    key: connectionKey(callId),
    callId,
    peerId,
    socket,
    listeners,
    pendingQueue,
    idleTimer: null,
    client: {
      send: () => undefined,
      close: () => undefined,
    },
    ready: false,
    lastJoin: undefined,
    lastState: undefined,
  };

  const flushQueue = () => {
    if (socket.readyState !== WebSocket.OPEN || pendingQueue.length === 0) {
      return;
    }
    while (pendingQueue.length > 0) {
      const next = pendingQueue.shift();
      if (!next) {
        continue;
      }
      socket.send(JSON.stringify(next));
    }
  };

  const dispatch = (fn: (cb: SignalingCallbacks) => void) => {
    listeners.forEach((listener) => {
      fn(listener);
    });
  };

  socket.onopen = () => {
    connection.ready = true;
    flushQueue();
    dispatch((listener) => listener.onOpen?.());
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

  socket.onclose = () => {
    connection.ready = false;
    pendingQueue.length = 0;
    dispatch((listener) => listener.onClose?.());
    sharedConnections.delete(connectionKey(callId));
    listeners.clear();
  };

  socket.onerror = (event) => {
    dispatch((listener) => listener.onError?.(event));
  };

  const send = (message: SignalingEnvelope) => {
    if (!message?.type) {
      return;
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return;
    }
    if (socket.readyState === WebSocket.CONNECTING) {
      pendingQueue.push(message);
    }
  };

  const close = () => {
    cancelIdleTimer(connection);
    listeners.clear();
    pendingQueue.length = 0;
    sharedConnections.delete(connection.key);
    if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
      return;
    }
    socket.close();
  };

  connection.client = { send, close };

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
  const url = new URL('/apiv2/ws', apiAddress);
  url.searchParams.set('call_id', callId);
  if (peerId) {
    url.searchParams.set('peer_id', peerId);
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};
