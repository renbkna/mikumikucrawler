import { Fragment, memo, useEffect, useRef, useState } from "react";
import { SEQUENCE_TIMINGS } from "../constants";

const RIPPLE_ANIMATION_DURATION_MS = 1500;

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
	const hasStartedRef = useRef(false);
	const rippleCountRef = useRef(0);
	const audioHandlerRef = useRef<(() => void) | null>(null);

	useEffect(() => {
		if (status === "idle") {
			hasStartedRef.current = false;
			requestAnimationFrame(() => {
				setCount(null);
				setRipples([]);
			});
			if (audioRef.current) {
				audioRef.current.pause();
				audioRef.current.currentTime = 0;
			}
			timeoutsRef.current.forEach(clearTimeout);
			timeoutsRef.current = [];
		}
	}, [status]);

	useEffect(() => {
		if (audioRef.current) {
			audioRef.current.volume = Math.max(0, Math.min(1, volume / 100));
		}
	}, [volume]);

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

	/** Orchestrates the countdown sequence synced with background audio. */
	useEffect(() => {
		if (status === "blackout" && !hasStartedRef.current) {
			hasStartedRef.current = true;

			let audio = audioRef.current;
			if (!audio) {
				audio = new Audio("/audio.mp3");
				audioRef.current = audio;
			}

			audio.currentTime = 0;
			audio.volume = Math.max(0, Math.min(1, volume / 100));

			if (audioHandlerRef.current && audio) {
				audio.removeEventListener("timeupdate", audioHandlerRef.current);
			}

			/** Loops specific high-energy section of the audio track. */
			const handleTimeUpdate = () => {
				if (audio && audio.currentTime > 17.53) {
					audio.currentTime = 15.86;
				}
			};

			audioHandlerRef.current = handleTimeUpdate;
			audio.addEventListener("timeupdate", handleTimeUpdate);

			const playPromise = audio.play();
			if (playPromise !== undefined) {
				playPromise.catch((e) => {
					console.error("Audio play failed", e);
				});
			}

			const addTimeout = (fn: () => void, delay: number) => {
				const id = setTimeout(fn, delay);
				timeoutsRef.current.push(id);
			};

			addTimeout(() => setCount("1"), SEQUENCE_TIMINGS.COUNT_1);
			addTimeout(() => setCount("2"), SEQUENCE_TIMINGS.COUNT_2);
			addTimeout(() => setCount("3"), SEQUENCE_TIMINGS.COUNT_3);
			addTimeout(() => setCount("READY?"), SEQUENCE_TIMINGS.READY);

			addTimeout(() => {
				setCount(null);
				onBeamStart();
			}, SEQUENCE_TIMINGS.BEAM_START);

			addTimeout(() => {
				onComplete();
			}, SEQUENCE_TIMINGS.COMPLETE);
		}

		return () => {
			timeoutsRef.current.forEach(clearTimeout);
			if (audioHandlerRef.current && audioRef.current) {
				audioRef.current.removeEventListener(
					"timeupdate",
					audioHandlerRef.current,
				);
				audioHandlerRef.current = null;
			}
		};
	}, [status, onBeamStart, onComplete, volume]);

	if (status === "idle" || status === "live") return null;

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
