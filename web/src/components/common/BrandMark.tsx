/** The Belltower icon: public/icon-192.png, the same artwork as the Home Screen app. Decorative, as the name sits beside it. */
export function BrandMark({ size = 24 }: { size?: number }) {
  return <img src="/icon-192.png" width={size} height={size} alt="" className="brand-mark" />;
}
