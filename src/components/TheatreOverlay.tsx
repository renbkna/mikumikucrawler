import React, { useEffect, useRef, useState } from 'react';

// ==========================================
// 🎵 TIMING CONFIGURATION (in milliseconds)
// ==========================================
export const SEQUENCE_TIMINGS = {
  COUNT_1: 5400,      // "1" appears
  COUNT_2: 6650,      // "2" appears
  COUNT_3: 7800,      // "3" appears
  READY: 8900,        // "READY?" appears
  BEAM_START: 10200,   // Miku appears (Beam starts) - Sync this with the drop!
  COMPLETE: 10200,     // Sequence ends, UI returns
};

interface TheatreOverlayProps {
  status: 'idle' | 'blackout' | 'counting' | 'beam' | 'live';
  onComplete: () => void;
  onBeamStart: () => void;
}

export const TheatreOverlay: React.FC<TheatreOverlayProps> = ({ status, onComplete, onBeamStart }) => {
  const [count, setCount] = useState<string | null>(null);
  const [ripples, setRipples] = useState<{id: number, color: string}[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timeoutsRef = useRef<NodeJS.Timeout[]>([]);
  const hasStartedRef = useRef(false);

  // Handle state changes (Stopping audio only on IDLE)
  useEffect(() => {
    if (status === 'idle') {
      hasStartedRef.current = false;
      setCount(null);
      setRipples([]);
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
      timeoutsRef.current.forEach(clearTimeout);
      timeoutsRef.current = [];
    }
  }, [status]);

  // Trigger ripples on count change
  useEffect(() => {
    // Only trigger ripples for numbers, not for "READY?"
    if (count && count !== "READY?") {
        const id = Date.now();
        // Alternate colors
        const color = ripples.length % 2 === 0 ? "miku-pink" : "miku-teal";
        setRipples(prev => [...prev, { id, color }]);
    }
  }, [count]);

  // Handle the Sequence
  useEffect(() => {
    if (status === 'blackout' && !hasStartedRef.current) {
      hasStartedRef.current = true;

      const audio = new Audio('/audio.mp3');
      audioRef.current = audio;
      audio.volume = 0.8;

      // Restore the specific loop from the previous version
      const handleTimeUpdate = () => {
        if (audio.currentTime > 17.53) {
          audio.currentTime = 15.86;
        }
      };
      audio.addEventListener('timeupdate', handleTimeUpdate);

      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.catch(e => {
            console.error("Audio play failed", e);
        });
      }

      const addTimeout = (fn: () => void, delay: number) => {
        const id = setTimeout(fn, delay);
        timeoutsRef.current.push(id);
      };

      // Schedule the sequence based on configuration
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
    };
  }, [status, onBeamStart, onComplete]);

  if (status === 'idle' || status === 'live') return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black overflow-hidden">
      {/* Cute Sparkles Background - Persistent */}
      <div className="absolute inset-0 opacity-30 pointer-events-none">
          <div className="absolute top-1/4 left-1/4 w-2 h-2 bg-miku-pink rounded-full animate-ping" />
          <div className="absolute top-3/4 right-1/4 w-3 h-3 bg-miku-teal rounded-full animate-ping delay-300" />
          <div className="absolute bottom-10 left-1/2 w-2 h-2 bg-white rounded-full animate-ping delay-700" />
      </div>

      {/* Independent Ripples Layer */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        {ripples.map((ripple) => (
            <React.Fragment key={ripple.id}>
                <div
                    className={`absolute w-[400px] h-[400px] border-4 rounded-full animate-ping`}
                    style={{
                        borderColor: `var(--${ripple.color})`,
                        animationIterationCount: 1,
                        animationDuration: '1.5s',
                        animationFillMode: 'forwards'
                    }}
                />
                 <div
                    className={`absolute w-[250px] h-[250px] border-4 rounded-full animate-ping`}
                    style={{
                        borderColor: `var(--${ripple.color})`,
                        animationIterationCount: 1,
                        animationDuration: '1.5s',
                        animationDelay: '0.1s',
                        animationFillMode: 'forwards'
                    }}
                />
            </React.Fragment>
        ))}
      </div>

      {/* Count Text - Re-renders on count change for pop effect */}
      {count && (
        <div key={count} className="relative z-10 flex flex-col items-center justify-center">
            <div className="text-9xl font-black text-white tracking-tight animate-pop">
                <span className="drop-shadow-[0_0_30px_rgba(255,183,197,0.8)] text-transparent bg-clip-text bg-gradient-to-br from-miku-pink to-white">
                    {count}
                </span>
            </div>
        </div>
      )}
    </div>
  );
};
