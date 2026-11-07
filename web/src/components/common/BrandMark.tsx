/**
 * The Belltower icon: public/icon-192.png, the same artwork as the Home Screen app. Decorative, as the name sits beside it.
 * BASE_URL is "/" in the app (so this is "/icon-192.png"); the GitHub Pages demo lives under /Belltower/.
 */
export function BrandMark({ size = 24 }: { size?: number }) {
  return <img src={`${import.meta.env.BASE_URL}icon-192.png`} width={size} height={size} alt="" className="brand-mark" />;
}
