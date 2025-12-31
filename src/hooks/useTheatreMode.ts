import { useCallback, useState } from "react";

export type TheatreStatus = "idle" | "blackout" | "counting" | "beam" | "live";

export interface UseTheatreModeReturn {
	theatreStatus: TheatreStatus;
	isUIHidden: boolean;
	startTheatre: (skipAnimation?: boolean) => void;
	handleBeamStart: () => void;
	handleTheatreComplete: () => void;
	resetTheatre: () => void;
}

/**
 * Manages the immersive "Theatre Mode" state transitions and UI blackout.
 *
 * This hook acts as a simple state machine:
 * idle -> blackout (UI hide) -> beam (Animation) -> live (Show stats)
 *
 * We use 'blackout' to hide all potentially distracting UI elements before
 * the Miku Beam animation starts, ensuring a clean visual experience.
 */
export function useTheatreMode(): UseTheatreModeReturn {
	const [theatreStatus, setTheatreStatus] = useState<TheatreStatus>("idle");

	const isUIHidden =
		theatreStatus === "blackout" || theatreStatus === "counting";

	/**
	 * Initiates the theatre blackout sequence.
	 * If skipAnimation is true, we jump directly to 'live' (useful for quick restarts).
	 */
	const startTheatre = useCallback((skipAnimation = false) => {
		if (skipAnimation) {
			setTheatreStatus("live");
		} else {
			setTheatreStatus("blackout");
		}
	}, []);

	/**
	 * Transitions to the "Beam" animation phase.
	 * Triggered after the countdown/blackout completes.
	 */
	const handleBeamStart = useCallback(() => {
		setTheatreStatus("beam");
	}, []);

	/**
	 * Completes the animation and shows the live crawler UI.
	 */
	const handleTheatreComplete = useCallback(() => {
		setTheatreStatus("live");
	}, []);

	/**
	 * Resets the theatre state to its idle (hidden) status.
	 * Used when the crawl is stopped or reset.
	 */
	const resetTheatre = useCallback(() => {
		setTheatreStatus("idle");
	}, []);

	return {
		theatreStatus,
		isUIHidden,
		startTheatre,
		handleBeamStart,
		handleTheatreComplete,
		resetTheatre,
	};
}
