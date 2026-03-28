interface SpinnerProps {
  size?: number;
  className?: string;
}

export function Spinner({ size = 20, className = '' }: SpinnerProps) {
  return (
    <span
      className={`inline-block animate-spin rounded-full border-[1.5px] border-solid border-[var(--border-secondary)] border-t-[var(--accent)] ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
