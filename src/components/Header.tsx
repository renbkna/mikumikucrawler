import { Heart, Music, Sparkles } from 'lucide-react';

interface HeaderProps {
  isLightTheme: boolean;
}

export function Header({ isLightTheme }: HeaderProps) {
  return (
    <div className="text-center relative py-8">
      {/* Floating Icons */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none select-none">
        <Music className="absolute top-4 left-[20%] text-miku-primary/30 w-8 h-8 animate-miku-float" />
        <Sparkles className="absolute top-10 right-[20%] text-miku-secondary/30 w-6 h-6 animate-sparkle delay-700" />
        <Heart className="absolute bottom-4 left-[30%] text-pink-400/30 w-5 h-5 animate-bounce delay-1000" />
        <Music className="absolute top-1/2 right-[15%] text-cyan-400/30 w-10 h-10 animate-miku-float delay-500" />
      </div>

      {/* Main Title */}
      <div className="relative z-10">
        <h1 className="mb-2 text-5xl md:text-6xl font-black tracking-tight drop-shadow-sm">
          <span className="inline-block hover:scale-110 transition-transform duration-300 text-miku-primary">
            Miku
          </span>
          <span className="mx-2 text-miku-secondary inline-block animate-pulse">
            ♥
          </span>
          <span className="inline-block hover:scale-110 transition-transform duration-300 delay-100 text-miku-secondary">
            Crawler
          </span>
        </h1>

        {/* Subtitle */}
        <div className="relative inline-block">
          <p className={`text-lg md:text-xl font-medium ${
            isLightTheme ? "text-slate-600" : "text-slate-300"
          } flex items-center justify-center gap-2`}>
            <span className="text-miku-primary">♪</span>
            Web crawling is cuter with Miku!
            <span className="text-miku-secondary">♪</span>
          </p>

          {/* Cute underline */}
          <div className="mt-2 h-1.5 w-full rounded-full bg-gradient-to-r from-miku-primary/50 via-miku-secondary/50 to-miku-primary/50 animate-background-pulse"></div>
        </div>
      </div>
    </div>
  );
}
