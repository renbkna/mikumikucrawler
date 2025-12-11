import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { SOCKET_CONFIG } from "../constants";
import type {
	CrawledPage,
	QueueStats,
	Stats,
	StatsPayload,
	Toast,
} from "../types";

// Connection states - exported for use in other components
export type ConnectionState = "connecting" | "connected" | "disconnected";

// Socket event handlers type
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
	socket: Socket | null;
	connectionState: ConnectionState;
	emit: <T>(event: string, data?: T) => void;
}

// Transform centralized config to socket.io format
const socketIoConfig = {
	transports: [...SOCKET_CONFIG.TRANSPORTS],
	reconnectionAttempts: SOCKET_CONFIG.RECONNECTION_ATTEMPTS,
	reconnectionDelay: SOCKET_CONFIG.RECONNECTION_DELAY,
	reconnectionDelayMax: SOCKET_CONFIG.RECONNECTION_DELAY_MAX,
	timeout: SOCKET_CONFIG.TIMEOUT,
	forceNew: SOCKET_CONFIG.FORCE_NEW,
};

export function useSocket(handlers: SocketEventHandlers): UseSocketReturn {
	const [socket, setSocket] = useState<Socket | null>(null);
	const [connectionState, setConnectionState] =
		useState<ConnectionState>("connecting");
	const socketRef = useRef<Socket | null>(null);
	const handlersRef = useRef(handlers);

	// Keep handlers ref updated
	useEffect(() => {
		handlersRef.current = handlers;
	}, [handlers]);

	useEffect(() => {
		const socketEndpoint =
			import.meta.env.VITE_BACKEND_URL || "http://localhost:3000";
		console.log(`Connecting to backend at ${socketEndpoint}`);

		let isCancelled = false;
		let cleanupSocket: (() => void) | null = null;

		const connectTimer = setTimeout(() => {
			if (isCancelled) return;

			try {
				const newSocket = io(socketEndpoint, socketIoConfig);

				const handleConnect = () => {
					console.log("Connected to backend");
					handlersRef.current.addToast(
						"success",
						"Connected to crawler backend",
					);
					setSocket(newSocket);
					setConnectionState("connected");
				};

				const handleConnectError = (err: Error) => {
					console.error("Connection error:", err);
					handlersRef.current.addToast(
						"error",
						`Connection error: ${err.message}`,
					);
					setConnectionState("disconnected");
				};

				const handleStats = (data: StatsPayload) => {
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
				};

				const handleQueueStats = (data: QueueStats) => {
					const sanitizedRate = Number.isFinite(data.pagesPerSecond)
						? data.pagesPerSecond
						: 0;
					handlersRef.current.onQueueStats({
						...data,
						pagesPerSecond: sanitizedRate,
					});
				};

				const handlePageContent = (data: CrawledPage) => {
					handlersRef.current.onPageContent(data);
				};

				// Streaming Export Handlers
				const exportBufferRef = { current: [] as string[] };
				const exportFormatRef = { current: "json" };

				const handleExportStart = (data: { format: string }) => {
					console.log("Export started, format:", data.format);
					exportBufferRef.current = [];
					exportFormatRef.current = data.format;
					handlersRef.current.addToast(
						"info",
						"Downloading export data...",
						2000,
					);
				};

				const handleExportChunk = (data: { data: string }) => {
					exportBufferRef.current.push(data.data);
				};

				const handleExportComplete = () => {
					console.log("Export complete, assembling file...");
					const fullData = exportBufferRef.current.join("");
					handlersRef.current.onExportResult({
						data: fullData,
						format: exportFormatRef.current,
					});
					exportBufferRef.current = []; // Clear memory
				};

				const handleErrorEvent = (error: { message?: string } | Error) => {
					const message =
						error instanceof Error ? error.message : error?.message;
					handlersRef.current.onError(
						message || "An unknown crawler error occurred",
					);
				};

				const handleAttackEnd = (finalStats: Stats) => {
					handlersRef.current.onAttackEnd(finalStats);
				};

				const handleDisconnect = () => {
					console.log("Disconnected from backend");
					handlersRef.current.addToast(
						"warning",
						"Disconnected from crawler backend",
					);
					setSocket(null);
					setConnectionState("disconnected");
				};

				const handleReconnect = () => {
					console.log("Reconnected to backend");
					handlersRef.current.addToast(
						"success",
						"Reconnected to crawler backend",
					);
					setConnectionState("connected");
				};

				newSocket.on("connect", handleConnect);
				newSocket.on("connect_error", handleConnectError);
				newSocket.on("stats", handleStats);
				newSocket.on("queueStats", handleQueueStats);
				newSocket.on("pageContent", handlePageContent);

				// New Streaming Events
				newSocket.on("exportStart", handleExportStart);
				newSocket.on("exportChunk", handleExportChunk);
				newSocket.on("exportComplete", handleExportComplete);

				newSocket.on("crawlError", handleErrorEvent);
				newSocket.on("error", handleErrorEvent);
				newSocket.on("attackEnd", handleAttackEnd);
				newSocket.on("disconnect", handleDisconnect);
				newSocket.io.on("reconnect", handleReconnect);

				socketRef.current = newSocket;

				cleanupSocket = () => {
					newSocket.off("connect", handleConnect);
					newSocket.off("connect_error", handleConnectError);
					newSocket.off("stats", handleStats);
					newSocket.off("queueStats", handleQueueStats);
					newSocket.off("pageContent", handlePageContent);

					newSocket.off("exportStart", handleExportStart);
					newSocket.off("exportChunk", handleExportChunk);
					newSocket.off("exportComplete", handleExportComplete);

					newSocket.off("crawlError", handleErrorEvent);
					newSocket.off("error", handleErrorEvent);
					newSocket.off("attackEnd", handleAttackEnd);
					newSocket.off("disconnect", handleDisconnect);
					newSocket.io.off("reconnect", handleReconnect);
					newSocket.close();
					if (socketRef.current === newSocket) {
						socketRef.current = null;
					}
					setSocket((prev) => (prev === newSocket ? null : prev));
				};
			} catch (error) {
				console.error("Socket initialization error:", error);
				handlersRef.current.addToast(
					"error",
					`Failed to connect to backend: ${
						error instanceof Error ? error.message : "Unknown error"
					}`,
				);
			}
		}, 500);

		return () => {
			isCancelled = true;
			clearTimeout(connectTimer);
			if (cleanupSocket) {
				cleanupSocket();
				cleanupSocket = null;
			} else if (socketRef.current) {
				socketRef.current.close();
				socketRef.current = null;
			}
			setSocket(null);
		};
	}, []);

	const emit = useCallback(
		<T>(event: string, data?: T) => {
			if (socket) {
				socket.emit(event, data);
			}
		},
		[socket],
	);

	return { socket, connectionState, emit };
}
