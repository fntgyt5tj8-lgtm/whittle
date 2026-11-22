const paths = {
  setup: "M4 7h16v13H4zM8 7V4h8v3M4 11h16",
  transfer: "M3 7h16m-4-4 4 4-4 4M21 17H5m4-4-4 4 4 4",
  ejection: "M5 19h14M12 3v11m-4-4 4 4 4-4",
};

export function PlanIcon({ kind }: { kind: keyof typeof paths }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[kind]} />
    </svg>
  );
}
