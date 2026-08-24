import { SPARK_GLYPH_PATH } from "@/design/colors";

// The shared Spur mark. `SPARK_GLYPH_PATH` (design/colors.ts) is the only
// definition of the glyph path — render it here instead of any literal
// glyph character, which risks a missing-font tofu box.
export function BrandGlyph() {
  return (
    <svg
      aria-label="Spur"
      className="h-[17px] w-[17px] shrink-0"
      role="img"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--color-accent)"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <path d={SPARK_GLYPH_PATH} />
    </svg>
  );
}
