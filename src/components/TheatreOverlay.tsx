import { Fragment, memo, useEffect, useRef, useState } from "react";
import { SEQUENCE_TIMINGS } from "../constants";

const RIPPLE_ANIMATION_DURATION_MS = 1500;
const LOOP_START = 15.86;
const LOOP_END = 17.53;

interface TheatreOverlayProps {
	status: "idle" | "blackout" | "counting" | "beam" | "live";
	onComplete: () => void;
	onBeamStart: () => void;
	volume?: number;
}

/** Manages the immersive countdown and transition sequence before a crawl begins. */
export const TheatreOverlay = memo(function TheatreOverlay({
	status,
	onComplete,
	onBeamStart,
	volume = 80,
}: TheatreOverlayProps) {
	const [count, setCount] = useState<string | null>(null);
	const [ripples, setRipples] = useState<{ id: number; color: string }[]>([]);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const timeoutsRef = useRef<NodeJS.Timeout[]>([]);
	const sequenceStartedRef = useRef(false);
	const rippleCountRef = useRef(0);

	// Stable refs for callbacks to avoid effect re-runs
	const onBeamStartRef = useRef(onBeamStart);
	const onCompleteRef = useRef(onComplete);
	onBeamStartRef.current = onBeamStart;
	onCompleteRef.current = onComplete;

	// Audio should play when status is not "idle"
	const shouldPlayAudio = status !== "idle";

	/** Audio lifecycle - completely separate from countdown */
	useEffect(() => {
		// Create audio element once
		if (!audioRef.current) {
			// Cache-bust to avoid browser cache issues
			const audio = new Audio(`/audio.mp3?v=${Date.now()}`);
			audioRef.current = audio;

			// Loop handler - stays attached for component lifetime
			const handleTimeUpdate = () => {
				if (audio.currentTime > LOOP_END) {
					audio.currentTime = LOOP_START;
				}
			};
			audio.addEventListener("timeupdate", handleTimeUpdate);

			// Cleanup only on unmount
			return () => {
				audio.removeEventListener("timeupdate", handleTimeUpdate);
				audio.pause();
				audioRef.current = null;
			};
		}
	}, []); // Empty deps - only runs once

	/** Control audio play/pause based on status */
	useEffect(() => {
		const audio = audioRef.current;
		if (!audio) return;

		if (shouldPlayAudio) {
			// Only reset and play when transitioning from idle
			if (audio.paused) {
				audio.currentTime = 0;
				audio.play().catch((e) => console.error("Audio play failed", e));
			}
		} else {
			audio.pause();
			audio.currentTime = 0;
		}
	}, [shouldPlayAudio]);

	/** Volume control - separate effect */
	useEffect(() => {
		if (audioRef.current) {
			audioRef.current.volume = Math.max(0, Math.min(1, volume / 100));
		}
	}, [volume]);

	/** Reset state when returning to idle */
	useEffect(() => {
		if (status === "idle") {
			sequenceStartedRef.current = false;
			setCount(null);
			setRipples([]);
			// Clear any remaining timeouts
			for (const id of timeoutsRef.current) {
				clearTimeout(id);
			}
			timeoutsRef.current = [];
		}
	}, [status]);

	/** Ripple animation effect */
	useEffect(() => {
		if (count && count !== "READY?") {
			const id = Date.now();
			requestAnimationFrame(() => {
				const color =
					rippleCountRef.current % 2 === 0 ? "miku-pink" : "miku-teal";
				rippleCountRef.current += 1;
				setRipples((prev) => [...prev, { id, color }]);
			});

			const cleanupTimer = setTimeout(() => {
				setRipples((prev) => prev.filter((r) => r.id !== id));
			}, RIPPLE_ANIMATION_DURATION_MS + 100);

			return () => clearTimeout(cleanupTimer);
		}
	}, [count]);

	/** Countdown sequence - runs once when blackout starts */
	useEffect(() => {
		if (status !== "blackout" || sequenceStartedRef.current) {
			return;
		}

		sequenceStartedRef.current = true;

		const timeouts: NodeJS.Timeout[] = [];
		const addTimeout = (fn: () => void, delay: number) => {
			const id = setTimeout(fn, delay);
			timeouts.push(id);
		};

		addTimeout(() => setCount("1"), SEQUENCE_TIMINGS.COUNT_1);
		addTimeout(() => setCount("2"), SEQUENCE_TIMINGS.COUNT_2);
		addTimeout(() => setCount("3"), SEQUENCE_TIMINGS.COUNT_3);
		addTimeout(() => setCount("READY?"), SEQUENCE_TIMINGS.READY);

		addTimeout(() => {
			setCount(null);
			onBeamStartRef.current();
		}, SEQUENCE_TIMINGS.BEAM_START);

		addTimeout(() => {
			onCompleteRef.current();
		}, SEQUENCE_TIMINGS.COMPLETE);

		timeoutsRef.current = timeouts;

		// No cleanup - timeouts are managed by the idle effect
	}, [status]);

	if (status === "idle") return null;
	if (status === "live") return <div className="hidden" />;

	return (
		<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black overflow-hidden">
			<div className="absolute inset-0 opacity-30 pointer-events-none">
				<div className="absolute top-1/4 left-1/4 w-2 h-2 bg-miku-pink rounded-full animate-ping" />
				<div className="absolute top-3/4 right-1/4 w-3 h-3 bg-miku-teal rounded-full animate-ping delay-300" />
				<div className="absolute bottom-10 left-1/2 w-2 h-2 bg-white rounded-full animate-ping delay-700" />
			</div>

			<div className="absolute inset-0 flex items-center justify-center pointer-events-none">
				{ripples.map((ripple) => (
					<Fragment key={ripple.id}>
						<div
							className={`absolute w-[400px] h-[400px] border-4 rounded-full animate-ping`}
							style={{
								borderColor: `var(--${ripple.color})`,
								animationIterationCount: 1,
								animationDuration: "1.5s",
								animationFillMode: "forwards",
							}}
						/>
						<div
							className={`absolute w-[250px] h-[250px] border-4 rounded-full animate-ping`}
							style={{
								borderColor: `var(--${ripple.color})`,
								animationIterationCount: 1,
								animationDuration: "1.5s",
								animationDelay: "0.1s",
								animationFillMode: "forwards",
							}}
						/>
					</Fragment>
				))}
			</div>

			{count && (
				<div
					key={count}
					className="relative z-10 flex flex-col items-center justify-center"
				>
					<div className="text-9xl font-black text-white tracking-tight animate-pop">
						<span className="drop-shadow-[0_0_30px_rgba(255,183,197,0.8)] text-transparent bg-clip-text bg-gradient-to-br from-miku-pink to-white">
							{count}
						</span>
					</div>
				</div>
			)}
		</div>
	);
});

TheatreOverlay.displayName = "TheatreOverlay";
