import { Heart, Music2, Sparkles } from "lucide-react";

interface KawaiiIconProps {
	className?: string;
	size?: number;
	style?: React.CSSProperties;
}

export const NoteIcon = ({
	className = "",
	size = 12,
	style,
}: KawaiiIconProps) => (
	<Music2 className={`inline-block ${className}`} size={size} style={style} />
);

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

export const SparkleIcon = ({
	className = "",
	size = 12,
	style,
}: KawaiiIconProps) => (
	<Sparkles className={`inline-block ${className}`} size={size} style={style} />
);
