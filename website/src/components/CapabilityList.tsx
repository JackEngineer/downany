import {
  CaretRight,
  ClockCounterClockwise,
  ListBullets,
  PauseCircle,
  PuzzlePiece,
  Scan,
  TelegramLogo,
} from "@phosphor-icons/react";
import { siteContent } from "../content/siteContent";

const capabilityIcons = [
  Scan,
  ListBullets,
  PauseCircle,
  ClockCounterClockwise,
  PuzzlePiece,
  TelegramLogo,
] as const;

export function CapabilityList() {
  return (
    <section className="capabilities section-shell" id="features">
      <h2>{siteContent.capabilities.title}</h2>
      <ul aria-label="Downany 功能" className="capabilities__list">
        {siteContent.capabilities.items.map((item, index) => {
          const Icon = capabilityIcons[index];
          const external = item.href.startsWith("http");
          return (
            <li id={item.id} key={item.id}>
              <a
                className="capability-row"
                href={item.href}
                rel={external ? "noreferrer" : undefined}
                target={external ? "_blank" : undefined}
              >
                <span className="capability-row__icon" aria-hidden="true">
                  <Icon size={22} weight="regular" />
                </span>
                <span className="capability-row__title">{item.title}</span>
                <span className="capability-row__description">{item.description}</span>
                <CaretRight
                  aria-hidden="true"
                  className="capability-row__arrow"
                  size={17}
                  weight="regular"
                />
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
