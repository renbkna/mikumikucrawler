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
 */
export function useTheatreMode(): UseTheatreModeReturn {
	const [theatreStatus, setTheatreStatus] = useState<TheatreStatus>("idle");

	const isUIHidden =
		theatreStatus === "blackout" || theatreStatus === "counting";

	/**
	 * Initiates the theatre blackout sequence.
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
