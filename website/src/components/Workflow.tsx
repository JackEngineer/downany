import { DownloadSimple, FolderOpen, LinkSimple } from "@phosphor-icons/react";
import { siteContent } from "../content/siteContent";

const workflowIcons = [LinkSimple, DownloadSimple, FolderOpen] as const;

export function Workflow() {
  return (
    <section className="workflow section-shell" id="how-it-works">
      <h2>{siteContent.workflow.title}</h2>
      <ol aria-label="使用 Downany 的步骤" className="workflow__steps">
        {siteContent.workflow.steps.map((step, index) => {
          const Icon = workflowIcons[index];
          return (
            <li className="workflow__step" key={step.title}>
              <div className="workflow__icon" aria-hidden="true">
                <Icon size={30} weight="regular" />
              </div>
              <div>
                <h3>{step.title}</h3>
                <p>{step.description}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
