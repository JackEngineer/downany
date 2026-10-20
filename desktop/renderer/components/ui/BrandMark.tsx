import mark from "../../../../assets/brand/logo-mark.svg";

/** Product identity; action icons remain in Icon.tsx. */
export function BrandMark({ size = 24 }: { size?: number }) {
  return <img className="downany-brand-mark" src={mark} width={size} height={size} alt="" aria-hidden="true" draggable={false} />;
}
