"use client";

export function ReleaseButton({ label }: { label: string }) {
  return (
    <button
      type="submit"
      className="text-red-600 hover:text-red-800"
      onClick={(e) => {
        if (!confirm(`Release ${label}? The number goes back to the carrier and cannot be recovered. This stops its monthly charge.`)) e.preventDefault();
      }}
    >
      Release
    </button>
  );
}
