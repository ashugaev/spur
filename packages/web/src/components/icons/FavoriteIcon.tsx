export function FavoriteIcon({ active }: { active: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className="h-3 w-3"
      fill={active ? "currentColor" : "none"}
      viewBox="0 0 24 24"
    >
      <path
        d="m12 3 2.8 5.67 6.25.91-4.52 4.41 1.07 6.23L12 17.28l-5.6 2.94 1.07-6.23-4.52-4.41 6.25-.91L12 3Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}
