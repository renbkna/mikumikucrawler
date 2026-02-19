import { useCallback, useEffect, useRef, useState } from "react";
import { SOCKET_CONFIG } from "../constants";
import type {
	CrawledPage,
	QueueStats,
	Stats,
	StatsPayload,
	Toast,
} from "../types";
import type { ClientToServerEvents } from "../types/socket";

export type ConnectionState = "connecting" | "connected" | "disconnected";

interface SocketEventHandlers {
	onStatsUpdate: (stats: Stats, log?: string) => void;
	onQueueStats: (queueStats: QueueStats) => void;
	onPageContent: (page: CrawledPage) => void;
	onExportResult: (data: { data: string; format: string }) => void;
	onError: (message: string) => void;
	onAttackEnd: (finalStats: Stats) => void;
	addToast: (type: Toast["type"], message: string, timeout?: number) => void;
}

interface UseSocketReturn {
	socket: WebSocket | null;
	connectionState: ConnectionState;
	emit: <K extends keyof ClientToServerEvents>(
		event: K,
		data?: Parameters<ClientToServerEvents[K]>[0],
	) => void;
}

type WSMessage =
	| { type: "stats"; data: StatsPayload }
	| { type: "queueStats"; data: QueueStats }
	| { type: "pageContent"; data: CrawledPage }
	| { type: "exportStart"; data: { format: string; requestId: string } }
	| { type: "exportChunk"; data: { data: string; requestId: string } }
	| { type: "exportComplete"; data: { count: number; requestId: string } }
	| {
			type: "crawlError" | "error";
			data: { message: string; requestId?: string };
	  }
	| { type: "attackEnd"; data: Stats }
	| { type: "pageDetails"; data: CrawledPage | null };

interface ExportState {
	requestId: string | null;
	buffer: string[];
	format: string;
}

export function useSocket(handlers: SocketEventHandlers): UseSocketReturn {
	const [socket, setSocket] = useState<WebSocket | null>(null);
	const [connectionState, setConnectionState] =
		useState<ConnectionState>("connecting");
	const socketRef = useRef<WebSocket | null>(null);
	const handlersRef = useRef(handlers);
	const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const reconnectAttemptsRef = useRef(0);
	const isMountedRef = useRef(true);

	const exportStateRef = useRef<ExportState>({
		requestId: null,
		buffer: [],
		format: "json",
	});

	useEffect(() => {
		handlersRef.current = handlers;
	}, [handlers]);

	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	const connect = useCallback(() => {
		if (
			socketRef.current?.readyState === WebSocket.OPEN ||
			socketRef.current?.readyState === WebSocket.CONNECTING
		)
			return;

		const envUrl = import.meta.env.VITE_WS_URL;
		let socketEndpoint = "ws://localhost:3000/ws";

		if (envUrl) {
			if (envUrl.startsWith("http")) {
				socketEndpoint = envUrl.replace(/^http/, "ws");
			} else if (envUrl.startsWith("ws")) {
				socketEndpoint = envUrl;
			}
			if (!socketEndpoint.endsWith("/ws")) {
				socketEndpoint = `${socketEndpoint.replace(/\/$/, "")}/ws`;
			}
		}

		try {
			const ws = new WebSocket(socketEndpoint);

			ws.onopen = () => {
				if (!isMountedRef.current) return;
				handlersRef.current.addToast("success", "Connected to crawler backend");
				setSocket(ws);
				setConnectionState("connected");
				reconnectAttemptsRef.current = 0;
			};

			ws.onclose = () => {
				if (!isMountedRef.current) return;
				setSocket(null);
				setConnectionState("disconnected");
				socketRef.current = null;

				if (
					reconnectAttemptsRef.current >= SOCKET_CONFIG.RECONNECTION_ATTEMPTS
				) {
					handlersRef.current.addToast(
						"error",
						"Max reconnection attempts reached. Please refresh.",
					);
					return;
				}

				const delay = Math.min(
					SOCKET_CONFIG.RECONNECTION_DELAY * 2 ** reconnectAttemptsRef.current,
					SOCKET_CONFIG.RECONNECTION_DELAY_MAX,
				);

				handlersRef.current.addToast(
					"warning",
					`Disconnected. Reconnecting in ${delay / 1000}s...`,
				);

				reconnectTimeoutRef.current = setTimeout(() => {
					reconnectAttemptsRef.current++;
					connect();
				}, delay);
			};

			ws.onerror = (event) => {
				// biome-ignore lint/suspicious/noConsole: WebSocket errors should be logged
				console.error("WebSocket error:", event);
			};

			ws.onmessage = (event) => {
				try {
					const MAX_MESSAGE_SIZE = 10 * 1024 * 1024;
					if (event.data.length > MAX_MESSAGE_SIZE) {
						// biome-ignore lint/suspicious/noConsole: Security logging for message size exceeded
						console.error("WebSocket message too large, dropping");
						return;
					}

					const msg: WSMessage = JSON.parse(event.data);
					const { type, data } = msg;

					switch (type) {
						case "stats": {
							const stats: Stats = {
								pagesScanned: data.pagesScanned ?? 0,
								linksFound: data.linksFound ?? 0,
								totalData: data.totalData ?? 0,
								mediaFiles: data.mediaFiles ?? 0,
								successCount: data.successCount ?? 0,
								failureCount: data.failureCount ?? 0,
								skippedCount: data.skippedCount ?? 0,
								elapsedTime: data.elapsedTime,
								pagesPerSecond: data.pagesPerSecond,
								successRate: data.successRate,
							};
							handlersRef.current.onStatsUpdate(stats, data.log);
							break;
						}
						case "queueStats": {
							const sanitizedRate = Number.isFinite(data.pagesPerSecond)
								? data.pagesPerSecond
								: 0;
							handlersRef.current.onQueueStats({
								...data,
								pagesPerSecond: sanitizedRate,
							});
							break;
						}
						case "exportStart": {
							exportStateRef.current = {
								requestId: data.requestId,
								buffer: [],
								format: data.format,
							};
							handlersRef.current.addToast(
								"info",
								"Downloading export data...",
								2000,
							);
							break;
						}
						case "exportChunk": {
							if (data.requestId === exportStateRef.current.requestId) {
								exportStateRef.current.buffer.push(data.data);
							}
							break;
						}
						case "exportComplete": {
							if (data.requestId === exportStateRef.current.requestId) {
								const fullData = exportStateRef.current.buffer.join("");
								handlersRef.current.onExportResult({
									data: fullData,
									format: exportStateRef.current.format,
								});
								exportStateRef.current = {
									requestId: null,
									buffer: [],
									format: "json",
								};
							}
							break;
						}
						case "crawlError":
						case "error": {
							const message = data?.message || "Unknown error";
							if (
								data.requestId &&
								data.requestId === exportStateRef.current.requestId
							) {
								exportStateRef.current = {
									requestId: null,
									buffer: [],
									format: "json",
								};
							}
							handlersRef.current.onError(message);
							break;
						}
						case "attackEnd":
							handlersRef.current.onAttackEnd(data);
							break;
						case "pageDetails":
							break;
						default:
							break;
					}
				} catch (err) {
					// biome-ignore lint/suspicious/noConsole: Error logging for debugging
					console.error("Failed to parse WS message", err);
				}
			};

			socketRef.current = ws;
		} catch (error) {
			// biome-ignore lint/suspicious/noConsole: Error logging for debugging
			console.error("Socket initialization error:", error);
			const delay = SOCKET_CONFIG.RECONNECTION_DELAY;
			reconnectTimeoutRef.current = setTimeout(() => {
				connect();
			}, delay);
		}
	}, []);

	useEffect(() => {
		const timer = setTimeout(() => {
			connect();
		}, 10);

		return () => {
			clearTimeout(timer);
			if (reconnectTimeoutRef.current)
				clearTimeout(reconnectTimeoutRef.current);
			if (socketRef.current) {
				socketRef.current.close();
				socketRef.current = null;
			}
		};
	}, [connect]);

	const emit = useCallback(
		<K extends keyof ClientToServerEvents>(
			event: K,
			data?: Parameters<ClientToServerEvents[K]>[0],
		) => {
			if (socketRef.current?.readyState === WebSocket.OPEN) {
				socketRef.current.send(JSON.stringify({ type: event, data }));
			}
		},
		[],
	);

	return { socket, connectionState, emit };
}
