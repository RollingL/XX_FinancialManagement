// The line icons used across the screens.
export type IconName =
  | 'home'
  | 'meal'
  | 'work'
  | 'receipt'
  | 'wallet'
  | 'clock'
  | 'chart'
  | 'plus'
  | 'scan'
  | 'chevron'
  | 'bulb'
  | 'backup'
  | 'search';

export default function Icon({ name }: { name: IconName }) {
  const paths = {
    home: 'M3 10 12 3l9 7v11h-6v-7H9v7H3Z',
    meal: 'M5 3v6m4-6v6M3 3v5a4 4 0 0 0 8 0V3M7 12v9M18 3c-4 3-4 9 0 10h2V3Zm0 10v8',
    work: 'M8 7V4h8v3M3 8h18v13H3ZM3 13h18M10 12v3h4v-3',
    receipt: 'M5 3h14v18l-3-2-4 2-4-2-3 2ZM8 7h8M8 11h8M8 15h4',
    wallet: 'M4 7V4h14v3M4 7h17v14H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Zm17 5h-7v5h7m-4-3.5h.1',
    clock: 'M12 7v6l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
    chart: 'M5 20V12m7 8V4m7 16V8',
    plus: 'M12 4v16M4 12h16',
    scan: 'M8 3H4v4m12-4h4v4M4 17v4h4m12-4v4h-4M4 12h16',
    chevron: 'm9 5 7 7-7 7',
    bulb: 'M8 17c0-3-4-3-4-8a8 8 0 0 1 16 0c0 5-4 5-4 8M8 17h8m-8 3h8m-6 3h4',
    backup: 'M7 18H5a4 4 0 0 1-1-8 7 7 0 0 1 14-2 5 5 0 0 1 1 10h-2M12 12v9m-3-3 3 3 3-3',
    search: 'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  };
  return (
    <svg
      className="icon"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
