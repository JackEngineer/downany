import { CaretDown } from "@phosphor-icons/react";
import { useState } from "react";
import { siteContent } from "../content/siteContent";

export function Faq() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <section className="faq section-shell" id="faq">
      <h2>{siteContent.faq.title}</h2>
      <div className="faq__list">
        {siteContent.faq.items.map((item, index) => {
          const isOpen = openIndex === index;
          const panelId = `faq-panel-${index}`;
          const triggerId = `faq-trigger-${index}`;
          return (
            <div className="faq__item" key={item.question}>
              <h3>
                <button
                  aria-controls={panelId}
                  aria-expanded={isOpen}
                  className="faq__trigger"
                  id={triggerId}
                  onClick={() => setOpenIndex(isOpen ? null : index)}
                  type="button"
                >
                  <span>{item.question}</span>
                  <CaretDown aria-hidden="true" size={18} weight="regular" />
                </button>
              </h3>
              {isOpen ? (
                <div aria-labelledby={triggerId} className="faq__panel" id={panelId} role="region">
                  <p>{item.answer}</p>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
