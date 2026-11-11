/**
 * Inline SVG flags (Windows does not draw emoji flags). Simplified at 21×14 for a menu,
 * decorative only — the language's native and English names carry the meaning.
 */
const star = (cx: number, cy: number, r: number, rot = -90) => {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * 0.4 : r;
    const a = ((rot + i * 36) * Math.PI) / 180;
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(" ");
};
const H3 = (a: string, b: string, c: string) => (<><rect width="21" height="14" fill={a} /><rect y="4.67" width="21" height="4.67" fill={b} /><rect y="9.33" width="21" height="4.67" fill={c} /></>);
const V3 = (a: string, b: string, c: string) => (<><rect width="7" height="14" fill={a} /><rect x="7" width="7" height="14" fill={b} /><rect x="14" width="7" height="14" fill={c} /></>);

const FLAGS: Record<string, React.ReactNode> = {
  gb: (<><rect width="21" height="14" fill="#012169" /><path d="M0 0 21 14M21 0 0 14" stroke="#fff" strokeWidth="2.8" /><path d="M0 0 21 14M21 0 0 14" stroke="#C8102E" strokeWidth="1" /><path d="M10.5 0v14M0 7h21" stroke="#fff" strokeWidth="4.2" /><path d="M10.5 0v14M0 7h21" stroke="#C8102E" strokeWidth="2.4" /></>),
  sa: (<><rect width="21" height="14" fill="#006C35" /><path d="M5 5.6c1.2-.9 2.4.5 3.6-.3s2.2.6 3.4-.2 2.2.4 3.4-.2" stroke="#fff" strokeWidth=".9" fill="none" /><path d="M5 9.4h11" stroke="#fff" strokeWidth=".8" /><path d="M15.2 8.8l1.4.6-1.4.6" fill="#fff" /></>),
  jp: (<><rect width="21" height="14" fill="#fff" /><circle cx="10.5" cy="7" r="4.2" fill="#BC002D" /></>),
  ph: (<><rect width="21" height="7" fill="#0038A8" /><rect y="7" width="21" height="7" fill="#CE1126" /><path d="M0 0 12.1 7 0 14Z" fill="#fff" /><circle cx="4.2" cy="7" r="1.6" fill="#FCD116" /></>),
  bd: (<><rect width="21" height="14" fill="#006A4E" /><circle cx="9.4" cy="7" r="4.2" fill="#F42A41" /></>),
  pk: (<><rect width="21" height="14" fill="#01411C" /><rect width="5.25" height="14" fill="#fff" /><circle cx="13.6" cy="7" r="3.6" fill="#fff" /><circle cx="14.6" cy="6.3" r="3.1" fill="#01411C" /><polygon points={star(15.9, 5.4, 1.2, -50)} fill="#fff" /></>),
  ru: H3("#fff", "#0039A6", "#D52B1E"),
  in: (<>{H3("#FF9933", "#fff", "#138808")}<circle cx="10.5" cy="7" r="1.8" fill="none" stroke="#000080" strokeWidth=".5" /></>),
  cn: (<><rect width="21" height="14" fill="#DE2910" /><polygon points={star(3.5, 3.5, 2.1)} fill="#FFDE00" /><polygon points={star(7, 1.4, .7)} fill="#FFDE00" /><polygon points={star(8.4, 2.8, .7)} fill="#FFDE00" /><polygon points={star(8.4, 4.9, .7)} fill="#FFDE00" /><polygon points={star(7, 6.3, .7)} fill="#FFDE00" /></>),
  kr: (<><rect width="21" height="14" fill="#fff" /><path d="M7.7 7a2.8 2.8 0 0 1 5.6 0Z" fill="#CD2E3A" /><path d="M7.7 7a2.8 2.8 0 0 0 5.6 0Z" fill="#0047A0" /><g stroke="#000" strokeWidth=".55"><path d="M3.2 3.2l1.6-1.6M3.8 3.8l1.6-1.6M4.4 4.4l1.6-1.6M15 11.4l1.6-1.6M15.6 12l1.6-1.6M16.2 12.6l1.6-1.6M15 2.6l1.6 1.6M3.2 10.8l1.6 1.6" /></g></>),
  id: (<><rect width="21" height="7" fill="#CE1126" /><rect y="7" width="21" height="7" fill="#fff" /></>),
  my: (<>{Array.from({ length: 14 }, (_, i) => <rect key={i} y={i} width="21" height="1" fill={i % 2 ? "#fff" : "#CC0001"} />)}<rect width="10.5" height="8" fill="#010066" /><circle cx="4.2" cy="4" r="2.6" fill="#FFCC00" /><circle cx="5" cy="4" r="2.2" fill="#010066" /><polygon points={star(7.6, 4, 1.4)} fill="#FFCC00" /></>),
  tr: (<><rect width="21" height="14" fill="#E30A17" /><circle cx="8" cy="7" r="3.5" fill="#fff" /><circle cx="8.9" cy="7" r="2.8" fill="#E30A17" /><polygon points={star(12.2, 7, 1.4, 180)} fill="#fff" /></>),
  fr: V3("#002395", "#fff", "#ED2939"),
  de: H3("#000", "#DD0000", "#FFCE00"),
  es: (<><rect width="21" height="14" fill="#AA151B" /><rect y="3.5" width="21" height="7" fill="#F1BF00" /></>),
  br: (<><rect width="21" height="14" fill="#009C3B" /><path d="M10.5 1.6 19.2 7 10.5 12.4 1.8 7Z" fill="#FFDF00" /><circle cx="10.5" cy="7" r="3" fill="#002776" /></>),
  it: V3("#009246", "#fff", "#CE2B37"),
};

export function Flag({ code, className = "" }: { code: string; className?: string }) {
  return (
    <svg viewBox="0 0 21 14" width="21" height="14" aria-hidden="true" className={`shrink-0 rounded-[2px] ring-1 ring-black/20 ${className}`}>
      {FLAGS[code] ?? <rect width="21" height="14" fill="#888" />}
    </svg>
  );
}
