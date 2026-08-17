import { CaretRight } from "@phosphor-icons/react";
import { siteContent, siteLinks } from "../content/siteContent";

export function RecognitionSpotlight() {
  return (
    <section className="recognition section-shell" id="recognition">
      <div className="recognition__media">
        <img
          alt="中式院落网页媒体画面"
          decoding="async"
          height="822"
          loading="lazy"
          src="/assets/recognition-media.png"
          width="1913"
        />
        <div className="recognition__glass">
          <h2>{siteContent.recognition.title}</h2>
          <p>{siteContent.recognition.description}</p>
          <a className="text-link text-link--accent" href={siteLinks.extension}>
            {siteContent.recognition.action}
            <CaretRight aria-hidden="true" size={17} weight="regular" />
          </a>
        </div>
      </div>
    </section>
  );
}
