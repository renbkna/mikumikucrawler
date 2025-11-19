import React from 'react';

interface MikuBannerProps {
  active: boolean;
}

export const MikuBanner: React.FC<MikuBannerProps> = ({ active }) => {
  return (
    <div className={`relative w-full h-64 md:h-80 rounded-2xl overflow-hidden mb-6 transition-all duration-500 ${active ? 'shadow-[0_0_30px_rgba(57,197,187,0.6)] scale-105' : 'shadow-sm'}`}>
      {/* Background / Placeholder */}
      <div className="absolute inset-0 bg-gradient-to-r from-miku-teal/20 to-miku-pink/20" />

      {/* The GIF */}
      <img
        src="/miku1.gif"
        alt="Miku Beam"
        className={`w-full h-full object-cover transition-opacity duration-300 ${active ? 'opacity-100' : 'opacity-50 grayscale'}`}
      />

      {/* Overlay Effects when Active */}
      {active && (
        <>
          <div className="absolute inset-0 bg-white/20 animate-pulse mix-blend-overlay" />
          <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/50 to-transparent text-center">
            <h2 className="text-3xl font-black text-white italic tracking-tighter animate-bounce-slow drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]">
              MIKU MIKU BEAM!
            </h2>
          </div>
        </>
      )}
    </div>
  );
};
