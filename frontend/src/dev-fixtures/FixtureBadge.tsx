// DEV FIXTURE badge. Only loaded in development builds (see ExplorerPage).
export default function FixtureBadge() {
  return (
    <div
      className="pointer-events-none absolute right-2 top-2 z-10 rounded-md border border-warning bg-hud px-2 py-1 text-caption-12 font-semibold text-warning"
      title="Synthetic frames for development only. This is not SPHEREx data."
      data-testid="dev-fixture-badge"
    >
      DEV FIXTURE
    </div>
  );
}
