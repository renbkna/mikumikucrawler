interface HeaderProps {
  isLightTheme: boolean;
}

export function Header({ isLightTheme }: HeaderProps) {
  return (
    <div className="text-center relative">
      {/* Decorative background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-32 h-32 bg-gradient-to-br from-pink-400/20 to-cyan-400/20 rounded-full blur-xl animate-pulse"></div>
        <div className="absolute top-8 right-1/4 w-24 h-24 bg-gradient-to-br from-emerald-400/20 to-blue-400/20 rounded-full blur-lg animate-pulse delay-1000"></div>
      </div>

      {/* Main title with enhanced styling */}
      <div className="relative z-10">
        <h1 className="mb-4 text-4xl md:text-5xl font-black drop-shadow-2xl">
          <span className="inline-block hover:scale-105 transition-transform duration-300 bg-gradient-to-r from-emerald-300 to-emerald-400 bg-clip-text text-transparent">
            Miku
          </span>
          <span className="mx-2"></span>
          <span className="inline-block hover:scale-105 transition-transform duration-300 delay-100 bg-gradient-to-r from-cyan-300 to-cyan-400 bg-clip-text text-transparent">
            Miku
          </span>
          <span className="mx-2"></span>
          <span className="inline-block hover:scale-105 transition-transform duration-300 delay-200 bg-gradient-to-r from-pink-300 to-pink-400 bg-clip-text text-transparent">
            Crawler
          </span>
        </h1>

        {/* Subtitle with enhanced styling */}
        <div className="relative">
          <p className={`text-lg md:text-xl font-medium ${
            isLightTheme
              ? "text-gray-700"
              : "text-gray-200"
          } mb-2 drop-shadow-lg`}>
            Because web crawling is cuter when Miku does it!
            <span className="inline-block animate-bounce ml-2">🌺</span>
          </p>

          {/* Decorative underline */}
          <div className="mx-auto w-32 h-1 bg-gradient-to-r from-pink-400 via-emerald-400 to-cyan-400 rounded-full opacity-60"></div>
        </div>
      </div>
    </div>
  );
}
