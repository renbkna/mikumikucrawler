import { Heart, Music2, Sparkles, Star } from "lucide-react";

interface KawaiiIconProps {
	className?: string;
	size?: number;
	style?: React.CSSProperties;
}

// Musical note ♪
export const NoteIcon = ({
	className = "",
	size = 12,
	style,
}: KawaiiIconProps) => (
	<Music2 className={`inline-block ${className}`} size={size} style={style} />
);

// Heart ♥
export const HeartIcon = ({
	className = "",
	size = 12,
	style,
}: KawaiiIconProps) => (
	<Heart
		className={`inline-block ${className}`}
		size={size}
		fill="currentColor"
		style={style}
	/>
);

// Sparkle ✧
export const SparkleIcon = ({
	className = "",
	size = 12,
	style,
}: KawaiiIconProps) => (
	<Sparkles className={`inline-block ${className}`} size={size} style={style} />
);

// Star ★
export const StarIcon = ({
	className = "",
	size = 12,
	style,
}: KawaiiIconProps) => (
	<Star
		className={`inline-block ${className}`}
		size={size}
		fill="currentColor"
		style={style}
	/>
);

// Cherry blossom 🌸 - custom SVG
export const SakuraIcon = ({ className = "", size = 14 }: KawaiiIconProps) => (
	<svg
		viewBox="0 0 24 24"
		width={size}
		height={size}
		className={`inline-block ${className}`}
		fill="currentColor"
		role="img"
		aria-label="Cherry blossom"
	>
		<title>Cherry blossom</title>
		<path d="M12 2C12 2 9 5 9 8C9 9.5 10 11 12 12C14 11 15 9.5 15 8C15 5 12 2 12 2Z" />
		<path d="M12 22C12 22 9 19 9 16C9 14.5 10 13 12 12C14 13 15 14.5 15 16C15 19 12 22 12 22Z" />
		<path d="M2 12C2 12 5 9 8 9C9.5 9 11 10 12 12C11 14 9.5 15 8 15C5 15 2 12 2 12Z" />
		<path d="M22 12C22 12 19 9 16 9C14.5 9 13 10 12 12C13 14 14.5 15 16 15C19 15 22 12 22 12Z" />
		<circle cx="12" cy="12" r="2" />
	</svg>
);

// Decorative dot
export const DotIcon = ({ className = "", size = 8 }: KawaiiIconProps) => (
	<span
		className={`inline-block rounded-full bg-current ${className}`}
		style={{ width: size, height: size }}
	/>
);
