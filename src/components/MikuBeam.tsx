import React from 'react';

interface MikuBeamProps {
  active: boolean;
}

export const MikuBeam: React.FC<MikuBeamProps> = ({ active }) => {
  if (!active) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center pointer-events-none">
      {/* Intense Flash Overlay */}
      <div className="absolute inset-0 bg-white animate-beam-flash opacity-0" />

      {/* Beam Container */}
      <div className="relative animate-shake">
        {/* Massive Glow behind Miku */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-miku-teal rounded-full blur-[100px] opacity-40 mix-blend-screen" />

        {/* Miku GIF */}
        <img
          src="/miku1.gif"
          alt="Miku Beam"
          className="relative z-10 w-auto h-[80vh] object-contain drop-shadow-[0_0_50px_rgba(57,197,187,0.6)]"
        />
      </div>

      {/* Text Overlay */}
      <div className="absolute bottom-10 left-0 right-0 text-center z-20">
        <h1 className="text-6xl md:text-8xl font-black text-white italic transform -skew-x-6 animate-pulse drop-shadow-[0_4px_0_rgba(224,80,157,1)]">
          MIKU MIKU BEAM!
        </h1>
      </div>
    </div>
  );
};
