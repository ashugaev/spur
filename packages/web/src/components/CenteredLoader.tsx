export function CenteredLoader({ label, className = "" }: { label: string; className?: string }) {
  return (
    <div
      aria-label={label}
      className={`flex w-full items-center justify-center ${className}`}
      role="status"
    >
      <span aria-hidden="true" className="loader-centered-mark">
        <span />
        <span />
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}
